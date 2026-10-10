"""Test real downloaded payloads with the signed backend in an isolated game."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

contents, folder, backend, private_root = map(Path, sys.argv[1:5])
workspace = Path(os.environ.get('TSUKI_OUTLAST_QA_ROOT', 'D:/TsukiReleaseQualification/outlast-full-catalog')).resolve()
folder, contents = folder.resolve(), contents.resolve()
if not folder.is_relative_to(workspace / 'files') or not contents.is_relative_to(folder):
    raise ValueError('Qualification paths must stay inside the explicit test workspace')
inspect_only = '--inspect-only' in sys.argv[5:]
sys.path.insert(0, str(private_root))
sys.path.insert(0, str(Path(os.environ.get('TSUKI_OUTLAST_LOADER_SOURCE', 'D:/SteamLibrary/steamapps/common/The Outlast Trials/NativePakLoader')).resolve()))
from test_pak_archive import ArchiveTests
from mod_archive import load_mod, is_movie
from pak_archive import Pak
from movie_mods import validate_movie

report = {'status': 'pending', 'liveGameVerified': False, 'checks': [], 'unsupportedFiles': []}
report['coverage'] = 'PAK and native movie payload transport only; not full package runtime compatibility'


def sha256(file):
    digest = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()

root = folder / 'sandbox'
if root.exists():
    # Keep failed-run artifacts intact and never reuse a possibly applied baseline.
    import uuid
    root = folder / ('sandbox-' + uuid.uuid4().hex[:8])
root.mkdir()
paks = root / 'OPP/Content/Paks'
paks.mkdir(parents=True)
native = root / 'NativePakLoader'
native.mkdir()
base, _, _ = ArchiveTests().fixture(paks)
main = paks / 'OPP-WindowsClient.pak'
base.rename(main)
original = main.read_bytes()
image = bytearray(512)
image[:2] = b'MZ'
image[0x3c:0x40] = (128).to_bytes(4, 'little')
image[128:132] = b'PE\0\0'
exe = root / 'OPP/Binaries/Win64/TOTClient-Win64-Shipping.exe'
exe.parent.mkdir(parents=True)
exe.write_bytes(image)
bundle = native / 'Mods/Qualification'
bundle.mkdir(parents=True)
pak_bundle = paks / 'Qualification'
pak_bundle.mkdir()
sources = []
args = []
try:
    for source in contents.rglob('*'):
        if source.is_symlink():
            raise ValueError('Extracted symlink rejected')
        if not source.is_file():
            continue
        suffix = source.suffix.lower()
        if suffix not in ('.pak', '.bk2', '.srt'):
            report['unsupportedFiles'].append(source.relative_to(contents).as_posix())
            continue
        if suffix == '.pak':
            target = pak_bundle / source.relative_to(contents)
        else:
            parts = source.relative_to(contents).parts
            positions = [i for i, part in enumerate(parts) if part.lower() == 'movies']
            relative = Path(*parts[positions[-1] + 1:]) if positions else Path(source.name)
            target = bundle / 'Movies' / relative
        if inspect_only:
            target = source
        else:
            if target.exists():
                raise ValueError('Two authored payloads route to the same destination')
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        sources.append(target)
        args.extend(['--managed-pak' if suffix == '.pak' else '--managed-movie', str(target)])
    report['sourceFiles'] = [{'path': str(p.relative_to(contents if inspect_only else root)), 'sha256': sha256(p)} for p in sources]
    report['containers'] = []
    for source in sources:
        if source.suffix.lower() == '.pak':
            container = load_mod(source)
            report['containers'].append({'name': source.name, 'version': container.version, 'entries': len(container.entries),
                                         'compression': list(container.methods)})
            for name, entry in container.entries.items():
                if is_movie(name) and container.methods[entry.method] not in ('None', 'Zlib', 'Gzip'):
                    raise ValueError('Packed movie uses an unsupported extraction codec: ' + name)
        else:
            validate_movie(source)
    report['requiresOtherFormatReview'] = any(Path(name).suffix.lower() in ('.dll', '.asi', '.ini', '.bnk', '.utoc', '.ucas', '.mp4') for name in report['unsupportedFiles'])
    if not sources or any(Path(name).suffix.lower() in ('.utoc', '.ucas') for name in report['unsupportedFiles']):
        report['status'] = 'unsupported'
    elif inspect_only:
        report['status'] = 'deferred'
        report['checks'].append('source containers parsed; apply deferred while game is running')
    else:
        def run(action, managed=False):
            result = subprocess.run([str(backend), '--game-root', str(root), *(args if managed else []), action], capture_output=True, text=True, timeout=600)
            value = json.loads(result.stdout)
            if result.returncode:
                raise ValueError(value.get('message', result.stderr[-800:]))
            return value

        run('apply', True)
        installed = Pak(main)
        winners = {}
        overlaps = 0
        for source in sorted(sources, key=lambda p: p.relative_to(paks).as_posix().casefold() if p.is_relative_to(paks) else p.as_posix().casefold()):
            if source.suffix.lower() == '.pak':
                pak = load_mod(source)
                for name in pak.entries:
                    if not is_movie(name):
                        if name.casefold() in winners:
                            overlaps += 1
                        winners[name.casefold()] = (pak, name)
        lookup = {name.casefold(): name for name in installed.entries}
        for key, (source, name) in winners.items():
            actual = lookup.get(key)
            if actual is None:
                raise ValueError('Installed PAK is missing a source payload: ' + name)
            a, b = source.entries[name], installed.entries[actual]
            if source.data_record(name)[a.header_size:] != installed.data_record(actual)[b.header_size:]:
                raise ValueError('Installed payload bytes differ: ' + name)
            if source.methods[a.method] != installed.methods[b.method]:
                raise ValueError('Installed compression method differs: ' + name)
        report['verifiedPayloads'] = len(winners)
        report['overriddenPayloads'] = overlaps
        movie_state = native / 'movie-backup/state.json'
        if movie_state.exists():
            for record in json.loads(movie_state.read_text())['files'].values():
                if record.get('active') and sha256(root / 'OPP/Content/Movies' / record['target']) != record['installed_sha256']:
                    raise ValueError('Installed movie bytes differ: ' + record['target'])
        report['checks'].append('apply and installed payload readback')
        run('restore')
        if main.read_bytes() != original:
            raise ValueError('Original PAK was not restored')
        if any(p.is_file() for p in (root / 'OPP/Content/Movies').rglob('*')):
            raise ValueError('Added movie was not removed on restore')
        report['checks'].append('restore exact baseline and remove added movies')
        run('apply', True)
        disabled = root / 'DisabledQualification'
        bundle.rename(disabled)
        disabled_paks = root / 'DisabledQualificationPaks'
        pak_bundle.rename(disabled_paks)
        run('apply')
        if main.read_bytes() != original:
            raise ValueError('Disable did not restore baseline')
        report['checks'].append('disable and reapply baseline')
        disabled.rename(bundle)
        disabled_paks.rename(pak_bundle)
        run('apply', True)
        run('restore')
        if main.read_bytes() != original:
            raise ValueError('Reenable/restore changed baseline')
        report['checks'].append('reenable and restore exact baseline')
        if overlaps:
            pak_sources = [source for source in sources if source.suffix.lower() == '.pak']
            report['individualVariants'] = []
            original_args = args
            for candidate in pak_sources:
                hidden = root / 'VariantDisabled'
                hidden.mkdir(exist_ok=True)
                moved = []
                try:
                    for other in pak_sources:
                        if other == candidate:
                            continue
                        destination = hidden / other.relative_to(paks)
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        other.rename(destination)
                        moved.append((destination, other))
                    args = ['--managed-pak', str(candidate)]
                    for movie in sources:
                        if movie.suffix.lower() in ('.bk2', '.srt'):
                            args.extend(['--managed-movie', str(movie)])
                    run('apply', True)
                    actual = Pak(main)
                    container = load_mod(candidate)
                    names = {name.casefold(): name for name in actual.entries}
                    checked = 0
                    for name, expected in container.entries.items():
                        if is_movie(name):
                            continue
                        target = names.get(name.casefold())
                        if target is None:
                            raise ValueError('An isolated variant payload is missing: ' + name)
                        entry = actual.entries[target]
                        if container.data_record(name)[expected.header_size:] != actual.data_record(target)[entry.header_size:]:
                            raise ValueError('An isolated variant payload differs: ' + name)
                        if container.methods[expected.method] != actual.methods[entry.method]:
                            raise ValueError('An isolated variant compression method differs: ' + name)
                        checked += 1
                    run('restore')
                    if main.read_bytes() != original:
                        raise ValueError('An isolated variant did not restore the baseline')
                    report['individualVariants'].append({'pak': candidate.name, 'verifiedPayloads': checked})
                finally:
                    args = original_args
                    for source, target in moved:
                        source.rename(target)
            report['checks'].append('overlapping PAK variants independently applied, read back and restored')
        report['status'] = 'passed'
except Exception as error:
    report['status'] = 'deferred' if 'Close the game and its launcher' in str(error) else 'failed'
    report['error'] = str(error)[:1600]
finally:
    report['sandbox'] = str(root)
    if inspect_only or report['status'] in ('passed', 'unsupported'):
        if root.resolve().parent != folder or not root.name.startswith('sandbox'):
            raise ValueError('Unsafe test-copy cleanup path')
        try:
            shutil.rmtree(root)
            report['testCopiesRemoved'] = True
        except OSError as error:
            report['testCopiesRemoved'] = False
            report['cleanupError'] = str(error)
    (folder / 'loader-test.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps({'status': report['status'], 'checks': report['checks']}))
