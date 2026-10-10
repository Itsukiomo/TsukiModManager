import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';

const require = createRequire('C:/Users/jeffe/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/runtime.cjs');
const {chromium} = require('playwright');
const [executable, mode = 'running'] = process.argv.slice(2);
assert(executable);
assert(['running', 'launch'].includes(mode));
const root = `D:/TsukiReleaseQualification/outlast-launch-${Date.now()}`;
for (const name of ['roaming', 'local']) fs.mkdirSync(path.join(root, name), {recursive: true});
const child = spawn(path.resolve(executable), [], {windowsHide: true, stdio: 'ignore', env: {...process.env,
  APPDATA: path.join(root, 'roaming'), LOCALAPPDATA: path.join(root, 'local'),
  WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'webview'),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9447'}});
let browser;
const report = {root, mode, checks: []};
try {
  for (let i = 0; i < 90; i++) {
    try {browser = await chromium.connectOverCDP('http://localhost:9447'); break;}
    catch {await new Promise(resolve => setTimeout(resolve, 1000));}
  }
  assert(browser);
  const page = browser.contexts()[0].pages()[0];
  await page.waitForFunction(() => window.__TAURI_INTERNALS__?.invoke);
  const invoke = (command, args = {}) => page.evaluate(({command, args}) => window.__TAURI_INTERNALS__.invoke(command, args), {command, args});
  const profileId = 'builtin.outlast-trials';
  const settings = await invoke('get_profile_settings', {profileId});
  await invoke('save_profile_settings', {profileId, settings: {...settings, gameRootOverride: 'D:/SteamLibrary/steamapps/common/The Outlast Trials'}});
  if (mode === 'launch') {
    // Only consent is copied; the production signed runtime and original game recovery remain authoritative.
    const consent = path.join(root, 'roaming/Tsuki Mod Manager/profile-data/builtin.outlast-trials/dependencies/native-pak-loader');
    fs.mkdirSync(consent, {recursive: true});
    fs.writeFileSync(path.join(consent, 'consent-v1'), 'Authorized local launch regression test');
    const response = await invoke('launch_active_profile_modded', {profileId});
    assert(response.includes('through Steam'));
    report.checks.push('packaged command requested normal Steam launch');
    await assert.rejects(invoke('launch_active_profile_modded', {profileId}), /already launching or running/);
    report.checks.push('second command blocked while launch is pending');
    await page.waitForTimeout(60000);
    const log = fs.readFileSync(path.join(process.env.LOCALAPPDATA, 'OPP/Saved/Logs/OPP.log'), 'utf8');
    assert(log.includes('Bringing World /Game/Maps/Global/MainMenu.MainMenu up for play'));
    assert(!log.includes('Steam API failed to initialize'));
    report.checks.push('real game log reached main menu without Steam initialization failure');
  } else {
    await assert.rejects(invoke('launch_active_profile_modded', {profileId}), /already running/);
    report.checks.push('packaged command rejects already-running game before applying PAKs');
  }
  report.passed = true;
} catch (error) {report.error = String(error.stack ?? error); process.exitCode = 1;}
finally {
  if (browser) await browser.close();
  if (child.pid) spawnSync('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${child.pid} -ErrorAction SilentlyContinue`], {windowsHide: true});
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
