import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const root = path.resolve(process.env.TSUKI_OUTLAST_QA_ROOT || 'D:/TsukiReleaseQualification/outlast-full-catalog');
const liveGame = path.resolve('D:/SteamLibrary/steamapps/common/The Outlast Trials');
const appData = path.resolve(process.env.APPDATA, 'Tsuki Mod Manager');
if ([liveGame, appData].some(protectedRoot => root.toLowerCase() === protectedRoot.toLowerCase() || root.toLowerCase().startsWith(`${protectedRoot.toLowerCase()}${path.sep}`))) {
  throw new Error('Qualification workspace must be separate from the live game and app data');
}
const stateFile = path.join(root, 'report.json');
const sevenZip = 'C:/Program Files/7-Zip/7z.exe';
const privateRoot = 'C:/Users/jeffe/Documents/TsukiPrivateLoaderBuild';
const python = path.join(privateRoot, '.venv/Scripts/python.exe');
const backend = 'D:/SteamLibrary/steamapps/common/The Outlast Trials/NativePakLoader/ManagedRuntime/TsukiOutlastLoader.exe';
const key = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'Tsuki Mod Manager/settings.json'), 'utf8')).nexusApiKey;
if (!key) throw new Error('A configured Nexus API key is required');
fs.mkdirSync(root, { recursive: true });
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {
  version: 1, scope: 'Every currently available Nexus Outlast file, separately; no live game writes',
  mods: {}, files: {}, catalogComplete: false, liveGameVerified: false,
};
for (const row of Object.values(state.files)) {
  if (row.status === 'tested' && row.loader?.status !== 'passed') row.status = row.loader?.status || 'error';
}
function save() {
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(state, null, 2));
  fs.renameSync(`${stateFile}.tmp`, stateFile);
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function gameIsRunning() {
  return spawnSync('powershell.exe', ['-NoProfile', '-Command', 'if (Get-Process TOTClient-Win64-Shipping -ErrorAction SilentlyContinue) { exit 1 }'], { windowsHide: true }).status !== 0;
}
const gameInitiallyRunning = gameIsRunning();
async function api(url, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, {
      headers: { apikey: key, 'User-Agent': 'TsukiModManager/2.0.3', 'Content-Type': 'application/json' },
      method: body ? 'POST' : 'GET', body: body && JSON.stringify(body), signal: AbortSignal.timeout(60000),
    });
    if (response.status === 429) throw new Error('Nexus rate limit reached; resume this runner later');
    if (response.status >= 500 && attempt < 2) { await pause(3000 * (attempt + 1)); continue; }
    if (!response.ok) throw new Error(`Nexus HTTP ${response.status}`);
    const result = await response.json();
    if (result.errors?.length) throw new Error(result.errors.map(e => e.message).join('; '));
    await pause(200);
    return result;
  }
}
async function hash(file) {
  const value = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) value.update(chunk);
  return value.digest('hex');
}
function reserve(bytes = 0) {
  const volume = fs.statfsSync(root);
  if (volume.bavail * volume.bsize < bytes + 8 * 1024 ** 3) throw new Error('D: qualification storage reserve reached; resume after freeing space');
}
function safeName(value) { return String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || 'download.bin'; }
async function download(uri, target, expectedSize) {
  if (new URL(uri).protocol !== 'https:') throw new Error('Insecure provider download rejected');
  const controller = new AbortController();
  let idle;
  const armIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(new Error('Download stalled for 60 seconds')), 60000);
  };
  const deadline = setTimeout(() => controller.abort(new Error('Download exceeded 20 minutes')), 1200000);
  let received = 0, checked = 0;
  try {
    armIdle();
    const response = await fetch(uri, { signal: controller.signal });
    if (!response.ok || /text\/html|application\/json/i.test(response.headers.get('content-type') || '')) throw new Error(`Download rejected: HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _, done) {
      received += chunk.length;
      if (received > (expectedSize || 8 * 1024 ** 3)) return done(new Error('Download exceeded expected size bound'));
      if (received - checked >= 64 * 1024 ** 2) {
        try { reserve(); } catch (error) { return done(error); }
        checked = received;
      }
      armIdle(); done(null, chunk);
    } }), fs.createWriteStream(`${target}.partial`, { flags: 'w' }), { signal: controller.signal });
    if (expectedSize && received !== expectedSize) throw new Error('Download size mismatch');
    fs.renameSync(`${target}.partial`, target);
  } finally { clearTimeout(idle); clearTimeout(deadline); }
}
function extract(archive, destination) {
  const listing = spawnSync(sevenZip, ['l', '-slt', archive], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 ** 2 });
  if (listing.status !== 0) throw new Error('Archive listing failed');
  const records = listing.stdout.split('----------').slice(1).join('----------').split(/\r?\n\r?\n/)
    .map(block => Object.fromEntries(block.split(/\r?\n/).filter(line => line.includes(' = ')).map(line => {
      const n = line.indexOf(' = '); return [line.slice(0, n), line.slice(n + 3)];
    })));
  const names = new Set();
  for (const item of records.filter(item => item.Path)) {
    const parts = item.Path.split(/[\\/]/);
    if (path.isAbsolute(item.Path) || parts.some(p => !p || /^[. ]+$/.test(p) || /[:<>|?*\x00-\x1f]/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))
        || item['Symbolic Link'] || item['Hard Link'] || /L/.test(item.Attributes || '')) throw new Error('Unsafe archive entry rejected');
    const canonical = parts.join('/').toLowerCase();
    if (names.has(canonical)) throw new Error('Duplicate archive entry rejected');
    names.add(canonical);
  }
  reserve(records.reduce((sum, item) => sum + Number(item.Size || 0), 0) * 3);
  fs.mkdirSync(destination, { recursive: true });
  const result = spawnSync(sevenZip, ['x', '-y', '-bd', `-o${destination}`, archive], { encoding: 'utf8', windowsHide: true, timeout: 1200000, maxBuffer: 1024 ** 2 });
  if (result.status !== 0) throw new Error('Archive extraction failed');
}
function qualify(contents, folder) {
  const result = spawnSync(python, [path.resolve('scripts/outlast-package-loader-test.py'), contents, folder, backend, privateRoot, ...(gameIsRunning() ? ['--inspect-only'] : [])], {
    encoding: 'utf8', windowsHide: true, timeout: 1200000, maxBuffer: 4 * 1024 ** 2,
  });
  const report = path.join(folder, 'loader-test.json');
  if (!fs.existsSync(report)) throw new Error(`Isolated loader test did not produce a report: ${(result.stderr || '').slice(-800)}`);
  return JSON.parse(fs.readFileSync(report, 'utf8'));
}
try {
  if (process.argv.includes('--record-closed-game-gate')) {
    if (!gameIsRunning()) throw new Error('Outlast is already closed; run lifecycle qualification instead');
    state.pausedReason = 'Waiting for Outlast to close before validating the compiled install/restore harness and continuing the full catalog pass';
    state.downloadPassComplete = false;
    state.isolatedLifecyclePassComplete = false;
  } else if (process.argv.includes('--test-downloaded')) {
    if (gameIsRunning()) throw new Error('Close Outlast before the compiled backend lifecycle pass');
    for (const row of Object.values(state.files).filter(row => row.archive && row.status !== 'unsupported')) {
      const folder = path.dirname(row.archive);
      if (!folder.startsWith(`${path.join(root, 'files')}${path.sep}`)) throw new Error('Unsafe saved qualification path');
      if (await hash(row.archive) !== row.sha256) throw new Error('Downloaded archive changed: ' + row.fileId);
      row.loader = qualify(path.join(folder, 'contents'), folder);
      row.status = row.loader.status === 'passed' ? 'tested' : row.loader.status;
      save();
      console.log(`${row.modId}-${row.fileId}: ${row.loader.status}`);
      if (row.loader.status === 'deferred') throw new Error('Outlast was started; lifecycle checks deferred');
    }
    state.isolatedLifecyclePassComplete = true;
  } else {
  const query = 'query TsukiOutlastQualification($offset: Int) { mods(filter: {gameDomainName: [{value: "theoutlasttrials", op: EQUALS}]}, sort: [{createdAt: {direction: ASC}}], count: 60, offset: $offset) { nodes { modId gameId name version } totalCount } }';
  const current = {};
  for (let offset = 0; ; offset += 60) {
    const result = (await api('https://api.nexusmods.com/v2/graphql', { query, variables: { offset } })).data.mods;
    for (const mod of result.nodes) {
      if (String(mod.gameId) !== '5376') throw new Error('Wrong-game catalog response rejected');
      if (current[mod.modId]) throw new Error('Repeated catalog pagination rejected');
      current[mod.modId] = mod;
    }
    state.catalogTotal = result.totalCount;
    console.log(`Catalog ${Object.keys(current).length}/${result.totalCount}`);
    if (Object.keys(current).length >= result.totalCount) break;
    if (!result.nodes.length) throw new Error('Incomplete catalog pagination');
  }
  state.mods = current;
  state.catalogComplete = true;
  save();
  for (const mod of Object.values(current)) {
    let files;
    try { files = (await api(`https://api.nexusmods.com/v1/games/theoutlasttrials/mods/${mod.modId}/files.json`)).files; }
    catch (error) {
      mod.fileListError = error.message; save();
      if (/rate limit/.test(error.message)) throw error;
      continue;
    }
    mod.availableFiles = files.filter(file => ![6, 7].includes(file.category_id)).map(file => file.file_id);
    async function processFile(file) {
      const id = `${mod.modId}-${file.file_id}`;
      const previous = state.files[id];
      if (previous?.status === 'tested' || previous?.status === 'unsupported'
          || (gameInitiallyRunning && previous?.status === 'deferred' && previous.loader?.containers)) return;
      const folder = path.join(root, 'files', id);
      fs.mkdirSync(folder, { recursive: true });
      const row = state.files[id] = { modId: mod.modId, modName: mod.name, fileId: file.file_id, name: file.file_name, version: file.version, status: 'pending' };
      save();
      try {
        reserve(Number(file.size_in_bytes || 0) * 4);
        const archive = path.join(folder, safeName(file.file_name));
        if (!fs.existsSync(archive)) {
          const links = await api(`https://api.nexusmods.com/v1/games/theoutlasttrials/mods/${mod.modId}/files/${file.file_id}/download_link.json`);
          if (!links[0]?.URI) throw new Error('No direct download available');
          let failure;
          for (const link of links.slice(0, 3)) {
            try { await download(link.URI, archive, Number(file.size_in_bytes || 0)); failure = null; break; }
            catch (error) { failure = error; if (/storage reserve/.test(error.message)) throw error; }
          }
          if (failure) throw failure;
        }
        row.archive = archive;
        row.sha256 = await hash(archive);
        const contents = path.join(folder, 'contents');
        if (/\.(zip|rar|7z)$/i.test(archive)) extract(archive, contents);
        else { fs.mkdirSync(contents, { recursive: true }); fs.copyFileSync(archive, path.join(contents, path.basename(archive))); }
        row.loader = qualify(contents, folder);
        row.status = row.loader.status === 'passed' ? 'tested' : row.loader.status;
        console.log(`${id}: ${row.loader.status} (${mod.name})`);
      } catch (error) {
        row.status = 'error'; row.error = error.message;
        console.log(`${id}: ${row.error}`);
        if (/rate limit|storage reserve/.test(error.message)) throw error;
      } finally { save(); }
    }
    const available = files.filter(file => ![6, 7].includes(file.category_id));
    for (let offset = 0; offset < available.length; offset += 2) {
      const batch = await Promise.allSettled(available.slice(offset, offset + 2).map(processFile));
      const failure = batch.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    }
  }
  state.downloadPassComplete = true;
  }
} catch (error) { state.pausedReason = error.message; process.exitCode = 2; console.log(`Paused: ${error.message}`); }
finally {
  state.counts = Object.values(state.files).reduce((counts, row) => { counts[row.status] = (counts[row.status] || 0) + 1; return counts; }, {});
  save();
  console.log(`Report: ${stateFile}; ${JSON.stringify(state.counts)}`);
}
