import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const game = 'D:/SteamLibrary/steamapps/common/The Outlast Trials';
const destination = 'D:/TsukiReleaseQualification/outlast-full-catalog/current-mods-baseline.json';
const check = process.argv.includes('--check');
async function hash(file) {
  const digest = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
function files(folder) {
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap(item => {
    const full = path.join(folder, item.name);
    if (item.isSymbolicLink()) throw new Error('A mod snapshot path is a link; review required');
    return item.isDirectory() ? files(full) : item.isFile() ? [full] : [];
  });
}
if (check) {
  const baseline = JSON.parse(fs.readFileSync(destination, 'utf8'));
  const changed = [];
  for (const row of baseline.files) {
    if (!fs.existsSync(row.path) || await hash(row.path) !== row.sha256) changed.push(row.path);
  }
  const report = { checkedAt: new Date().toISOString(), checkedFiles: baseline.files.length, changed, passed: !changed.length };
  fs.writeFileSync(destination.replace('.json', '-check.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  process.exitCode = changed.length ? 1 : 0;
} else {
  if (fs.existsSync(destination)) throw new Error('Baseline already exists; use --check instead of replacing it');
  const owned = path.join(process.env.APPDATA, 'Tsuki Mod Manager/profile-data/builtin.outlast-trials');
  const selection = ['loader-profile.json', 'mod-selection.json'].map(name => path.join(game, 'NativePakLoader', name)).filter(file => fs.existsSync(file));
  const selected = [
    ...files(path.join(game, 'OPP/Content/Paks')).filter(file => path.basename(file).toLowerCase() !== 'opp-windowsclient.pak'),
    ...files(path.join(game, 'NativePakLoader/Mods')),
    ...files(path.join(owned, 'receipts')), ...files(path.join(owned, 'disabled-state')),
    ...selection, path.join(game, 'OPP/Binaries/Win64/TOTClient-Win64-Shipping.exe'),
  ];
  const rows = [];
  for (const file of selected) rows.push({ path: file, size: fs.statSync(file).size, sha256: await hash(file) });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify({ createdAt: new Date().toISOString(), game, files: rows }, null, 2), { flag: 'wx' });
  console.log(`Preservation manifest: ${rows.length} existing files, ${destination}`);
}
