import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require = createRequire('C:/Users/jeffe/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/runtime.cjs');
const {chromium} = require('playwright');
const executable = path.resolve(process.argv[2]);
const game = 'D:/SteamLibrary/steamapps/common/The Outlast Trials';
const root = `D:/TsukiReleaseQualification/outlast-loader-update-${Date.now()}`;
const runtime = `${game}/NativePakLoader/ManagedRuntime`;
const installed = JSON.parse(fs.readFileSync(`${runtime}/installed.json`, 'utf8'));
const manifest = JSON.parse(Buffer.from(installed.manifest).toString('utf8'));
assert.equal(manifest.version, '1.0.2');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const files = [...manifest.files.map(file => `${runtime}/${file.path}`), `${runtime}/installed.json`, `${runtime}/tsuki-managed-receipt.json`];
const hashes = files.map(hash);
for (const name of ['roaming', 'local']) fs.mkdirSync(`${root}/${name}`, {recursive: true});
const child = spawn(executable, [], {windowsHide: true, stdio: 'ignore', env: {...process.env,
  APPDATA: `${root}/roaming`, LOCALAPPDATA: `${root}/local`, WEBVIEW2_USER_DATA_FOLDER: `${root}/webview`,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9450'}});
const report = {root, checks: [], published: false};
let browser;
try {
  for (let i = 0; i < 90; i++) {
    try {browser = await chromium.connectOverCDP('http://localhost:9450'); break;}
    catch {await new Promise(resolve => setTimeout(resolve, 1000));}
  }
  assert(browser);
  const page = browser.contexts()[0].pages()[0];
  await page.waitForFunction(() => window.__TAURI_INTERNALS__?.invoke);
  const invoke = (command, args = {}) => page.evaluate(({command, args}) => window.__TAURI_INTERNALS__.invoke(command, args), {command, args});
  const profileId = 'builtin.outlast-trials';
  const settings = await invoke('get_profile_settings', {profileId});
  await invoke('save_profile_settings', {profileId, settings: {...settings, gameRootOverride: game}});
  await invoke('managed_loader_action', {action: 'authorize'});
  const status = await invoke('managed_loader_status');
  assert.equal(status.state, 'ready');
  assert.equal(status.version, '1.0.2');
  report.checks.push('new packaged app validates installed signed backend 1.0.2');
  const update = await invoke('managed_loader_action', {action: 'update'});
  assert.equal(update.state, 'ready');
  assert.equal(update.version, '1.0.2');
  files.forEach((file, i) => assert.equal(hash(file), hashes[i]));
  report.checks.push('real public release update retains newer local runtime and every payload hash');
  report.passed = true;
} catch (error) {report.error = String(error.stack ?? error); process.exitCode = 1;}
finally {
  if (browser) await browser.close();
  if (child.pid) spawnSync('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${child.pid} -ErrorAction SilentlyContinue`], {windowsHide: true});
  fs.writeFileSync(`${root}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
