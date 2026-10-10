import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire('C:/Users/jeffe/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/runtime.cjs');
const { chromium } = require('playwright');
const executable = path.join(process.env.LOCALAPPDATA, 'Tsuki Mod Manager/tsukimodmanagerapp.exe');
const backup = path.resolve('D:/TsukiReleaseQualification/dependency-preferences-' + Date.now());
fs.mkdirSync(backup, { recursive: true });
const profiles = [...new Set(JSON.parse(fs.readFileSync(new URL('../src/data/dependencies.json', import.meta.url), 'utf8')).flatMap(d => d.games))];
const child = spawn(executable, [], { windowsHide: true, stdio: 'ignore', env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9449' } });
let browser;
try {
  for (let i = 0; i < 60; i++) {
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:9449'); break; } catch { await new Promise(r => setTimeout(r, 1000)); }
  }
  assert(browser);
  let page;
  for (let i = 0; i < 60; i++) {
    page = browser.contexts()[0].pages().find(p => p.url().includes('tauri.localhost'));
    if (page) break; await new Promise(r => setTimeout(r, 500));
  }
  assert(page);
  const invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
  const settings = await invoke('get_app_settings');
  fs.writeFileSync(path.join(backup, 'global-settings.json'), JSON.stringify(settings, null, 2));
  const originalProfiles = [];
  for (const profileId of profiles) originalProfiles.push({ profileId, settings: await invoke('get_profile_settings', { profileId }) });
  fs.writeFileSync(path.join(backup, 'profile-settings.json'), JSON.stringify(originalProfiles, null, 2));
  await invoke('save_app_settings', { settings: { ...settings, profileDefaultDependencySetup: 'auto' } });
  for (const profile of originalProfiles) await invoke('save_profile_settings', { profileId: profile.profileId, settings: { ...profile.settings, dependencySetup: 'auto' } });
  assert.equal((await invoke('get_app_settings')).profileDefaultDependencySetup, 'auto');
  for (const profile of originalProfiles) {
    const current = await invoke('get_profile_settings', { profileId: profile.profileId });
    assert.equal(current.dependencySetup, 'auto');
    assert.equal(current.gameRootOverride, profile.settings.gameRootOverride);
    assert.equal(current.gameVersion, profile.settings.gameVersion);
  }
  console.log(JSON.stringify({ automaticProfiles: profiles.length, backup, gamePathsPreserved: true }));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (child?.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
}
