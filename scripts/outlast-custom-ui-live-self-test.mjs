import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require = createRequire('C:/Users/jeffe/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/runtime.cjs');
const {chromium} = require('playwright');
const executable = path.resolve(process.argv[2]);
const root = `D:/TsukiReleaseQualification/outlast-custom-ui-${Date.now()}`;
fs.mkdirSync(root, {recursive: true});
const game = 'D:/SteamLibrary/steamapps/common/The Outlast Trials';
const originalUi = `${game}/OPP/Content/Paks/CustomUI_P.pak`;
const plusUi = `${game}/OPP/Content/Paks/CustomUI_Plus_Hawk_P.pak`;
const profileId = 'builtin.outlast-trials';
// Uses the owner's real receipt store so the selected alternative stays disabled on later launches.
const child = spawn(executable, [], {windowsHide: true, stdio: 'ignore', env: {...process.env,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9448'}});
let browser;
const report = {root, checks: [], selectedUi: 'CustomUI Plus Hawk', visualUiVerified: false};
try {
  for (let i = 0; i < 90; i++) {
    try {browser = await chromium.connectOverCDP('http://localhost:9448'); break;}
    catch {await new Promise(resolve => setTimeout(resolve, 1000));}
  }
  assert(browser);
  const page = browser.contexts()[0].pages()[0];
  await page.waitForFunction(() => window.__TAURI_INTERNALS__?.invoke);
  const invoke = (command, args = {}) => page.evaluate(({command, args}) => window.__TAURI_INTERNALS__.invoke(command, args), {command, args});
  const status = await invoke('managed_loader_status');
  assert.equal(status.state, 'ready');
  assert.equal(status.version, '1.0.1');
  assert(fs.existsSync(plusUi));
  if (fs.existsSync(originalUi)) {
    await invoke('set_pak_mod_files_enabled', {profileId, fileNames: [originalUi], enabled: false});
  }
  assert(!fs.existsSync(originalUi));
  assert(fs.existsSync(plusUi));
  report.checks.push('original Custom UI disabled through real receipt/file toggle, Plus Hawk retained');
  const response = await invoke('launch_active_profile_modded', {profileId});
  assert(response.includes('through Steam'));
  await assert.rejects(invoke('launch_active_profile_modded', {profileId}), /already launching or running/);
  await page.waitForTimeout(60000);
  const log = fs.readFileSync(path.join(process.env.LOCALAPPDATA, 'OPP/Saved/Logs/OPP.log'), 'utf8');
  assert(log.includes('Bringing World /Game/Maps/Global/MainMenu.MainMenu up for play'));
  assert(!log.includes('Steam API failed to initialize'));
  report.checks.push('Plus Hawk selection launched through signed backend and Steam to main menu');
  report.passed = true;
} catch (error) {report.error = String(error.stack ?? error); process.exitCode = 1;}
finally {
  if (browser) await browser.close();
  if (child.pid) spawnSync('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${child.pid} -ErrorAction SilentlyContinue`], {windowsHide: true});
  fs.writeFileSync(`${root}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
