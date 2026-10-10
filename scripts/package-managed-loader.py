"""Package compiled external runtimes; proprietary source and private keys stay outside this repo."""
import argparse
import base64
import hashlib
import json
import re
from pathlib import Path
import zipfile

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def package(args):
    source = args.runtime.resolve(strict=True)
    output = args.output.resolve()
    if source == output or source in output.parents:
        raise ValueError('Release output must be outside the runtime directory')
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', args.repository):
        raise ValueError('Expected repository owner/name')
    if not re.fullmatch(r'[A-Za-z0-9_.-]+', args.version):
        raise ValueError('Invalid release version')
    files = []
    for path in sorted(source.rglob('*')):
        if path.is_symlink() or getattr(path.lstat(), 'st_file_attributes', 0) & 0x400:
            raise ValueError('Runtime contains a link')
        if path.is_dir():
            continue
        if path.suffix.lower() not in {'.exe', '.dll', '.pyd', '.dat', '.txt', '.json', '.bin'}:
            raise ValueError(f'Refusing source, debug or unsupported file: {path.name}')
        contents = path.read_bytes()
        files.append({'path': path.relative_to(source).as_posix(), 'size': len(contents),
                      'sha256': hashlib.sha256(contents).hexdigest()})
    if args.entry_point not in {item['path'] for item in files}:
        raise ValueError('Compiled entry point is missing')
    key = serialization.load_pem_private_key(args.signing_key.read_bytes(), password=None)
    if not isinstance(key, Ed25519PrivateKey):
        raise ValueError('An Ed25519 private signing key is required')
    output.mkdir(parents=True, exist_ok=True)
    archive = output / 'outlast-native-pak-win64.zip'
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
        for item in files:
            bundle.write(source / item['path'], item['path'])
    manifest = {'loaderId': 'outlast-native-pak', 'version': args.version, 'protocol': 1,
                'releaseTag': f'v{args.version}',
                'archiveUrl': f'https://github.com/{args.repository}/releases/download/v{args.version}/{archive.name}',
                'archiveSha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
                'archiveSize': archive.stat().st_size, 'entryPoint': args.entry_point, 'files': files}
    raw = json.dumps(manifest, indent=2).encode('utf-8')
    (output / 'manifest.json').write_bytes(raw)
    (output / 'manifest.sig').write_text(base64.b64encode(key.sign(raw)).decode('ascii'), encoding='ascii')
    public = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    print(json.dumps({'publicKey': base64.b64encode(public).decode('ascii'),
                      'files': len(files), 'archiveSha256': manifest['archiveSha256']}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--repository', required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--entry-point', default='TsukiOutlastLoader.exe')
    parser.add_argument('--signing-key', type=Path, required=True)
    package(parser.parse_args())
