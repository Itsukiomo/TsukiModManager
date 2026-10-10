import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const require = createRequire('C:/Users/jeffe/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/runtime.cjs');
const { chromium } = require('playwright');
const root = path.resolve('D:/TsukiReleaseQualification/tool-downloads-' + Date.now());
const key = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'Tsuki Mod Manager/settings.json'))).nexusApiKey;
const report = { root, cases: [], errors: [] };
fs.mkdirSync(root, { recursive: true });
let child, browser, invoke;
try {
  child = spawn(path.resolve('src-tauri/target/release/tsukimodmanagerapp.exe'), [], { windowsHide: true, stdio: 'ignore', env: { ...process.env,
    APPDATA: path.join(root, 'roaming'), LOCALAPPDATA: path.join(root, 'local'), WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9452',
  }});
  for (let i = 0; i < 60; i++) {
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:9452'); break; } catch { await new Promise(r => setTimeout(r, 1000)); }
  }
  assert(browser);
  let page;
  for (let i = 0; i < 60; i++) {
    page = browser.contexts()[0].pages().find(p => p.url().includes('tauri.localhost'));
    if (page) break;
    await new Promise(r => setTimeout(r, 500));
  }
  assert(page);
  await page.waitForFunction(() => window.__TAURI_INTERNALS__?.invoke);
  invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
  await invoke('save_app_settings', { settings: { ...await invoke('get_app_settings'), nexusApiKey: key, autoUpdateChecks: false } });
  const cases = [
    ['builtin.outlast-trials', 'outlast-iris'], ['builtin.outlast-trials', 'outlast-janus'], ['builtin.outlast-trials', 'outlast-odessa'],
    ['builtin.resident-evil-7', 're-fluffy-mod-manager'], ['builtin.spider-man-remastered', 'spiderman-overstrike-remastered'],
    ['builtin.borderlands2', 'borderlands2-openblcmm'],
  ];
  for (const [profileId, dependencyId] of cases) {
    if (process.env.TSUKI_TOOL_IDS && !process.env.TSUKI_TOOL_IDS.split(',').includes(dependencyId)) continue;
    try {
      // Overrides simulate installation identity without writing to the real games.
      const game = path.join(root, 'games', profileId); fs.mkdirSync(game, { recursive: true });
      const markers = { 'builtin.outlast-trials': 'OPP/Binaries/Win64/OPP-Win64-Shipping.exe', 'builtin.resident-evil-7': 're7.exe',
        'builtin.spider-man-remastered': 'Spider-Man.exe', 'builtin.borderlands2': 'Binaries/Win32/Borderlands2.exe' };
      const marker = path.join(game, markers[profileId]); fs.mkdirSync(path.dirname(marker), { recursive: true }); fs.writeFileSync(marker, 'fixture');
      await invoke('save_profile_settings', { profileId, settings: { ...await invoke('get_profile_settings', { profileId }), gameRootOverride: game } });
      const result = await invoke('download_profile_dependency_tool', { profileId, dependencyId });
      const folders = fs.readdirSync(path.join(root, 'roaming/Tsuki Mod Manager'), { recursive: true }).filter(p => p.endsWith('download.json'));
      const manifest = folders.map(p => JSON.parse(fs.readFileSync(path.join(root, 'roaming/Tsuki Mod Manager', p)))).find(m => m.dependencyId === dependencyId);
      assert(manifest); assert.equal(manifest.installed, false);
      assert.equal(createHash('sha256').update(fs.readFileSync(manifest.archive)).digest('hex'), manifest.sha256);
      report.cases.push({ profileId, dependencyId, version: manifest.version, messages: result.messages });
    } catch (error) { report.errors.push({ profileId, dependencyId, error: String(error) }); }
    console.log(JSON.stringify(report.cases.at(-1) ?? report.errors.at(-1)));
  }
} finally {
  if (invoke) await invoke('save_app_settings', { settings: { ...await invoke('get_app_settings'), nexusApiKey: '' } }).catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (child?.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ root, passed: report.cases.length, errors: report.errors }));
}
if (report.errors.length) process.exitCode = 1;
