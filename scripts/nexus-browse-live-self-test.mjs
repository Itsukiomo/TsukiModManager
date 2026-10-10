import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';

const require = createRequire('C:/Users/jeffe/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/runtime.cjs');
const {chromium} = require('playwright');
const key = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'Tsuki Mod Manager/settings.json'), 'utf8')).nexusApiKey;
assert(key, 'Live tests require the saved Nexus API key; it is never logged.');
const root = path.resolve('D:/TsukiReleaseQualification/nexus-browse-live-' + Date.now());
fs.mkdirSync(root, {recursive: true});
const executable = path.resolve(process.argv[2] ?? 'src-tauri/target/release/tsukimodmanagerapp.exe');
const child = spawn(executable, [], {windowsHide: true, stdio: 'ignore', env: {
  ...process.env, APPDATA: path.join(root, 'roaming'), LOCALAPPDATA: path.join(root, 'local'),
  WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9444',
}});
let browser, fixtureBrowser, invoke;
const report = {root, cases: [], checks: [], passed: false};
try {
  fixtureBrowser = await chromium.launch({channel: 'msedge', headless: true});
  const fixture = await fixtureBrowser.newPage();
  await fixture.goto('http://localhost:1420/scripts/profile-card-layout-preview.html');
  const profiles = await fixture.evaluate(async () => (await import('/src/models/gameProfiles.ts')).BUILTIN_GAME_PROFILES);
  await fixtureBrowser.close(); fixtureBrowser = null;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {browser = await chromium.connectOverCDP('http://127.0.0.1:9444'); break;}
    catch {await new Promise(resolve => setTimeout(resolve, 1000));}
  }
  assert(browser);
  let page;
  for (let attempt = 0; attempt < 60; attempt++) {
    page = browser.contexts()[0].pages().find(candidate => candidate.url().includes('tauri.localhost'));
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  await page.waitForFunction(() => window.__TAURI_INTERNALS__?.invoke);
  invoke = (command, args = {}) => page.evaluate(({command, args}) => window.__TAURI_INTERNALS__.invoke(command, args), {command, args});
  const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  assert.equal((await invoke('check_app_update', {manifestUrl: 'http://127.0.0.1:1/unreachable'})).currentVersion, version);
  report.checks.push(`native version ${version}`);
  const settings = await invoke('get_app_settings');
  await invoke('save_app_settings', {settings: {...settings, nexusApiKey: key, autoUpdateChecks: false}});
  for (const profile of profiles) {
    const sources = profile.sourceConfig?.sources?.filter(source => source.provider === 'nexus' && source.browseMode === 'api' && source.enabled);
    if (!sources?.length) continue;
    await invoke('activate_game_profile_runtime', {profileId: profile.profileId, profile});
    for (const source of sources) {
      const pages = [];
      for (const number of [1, 2]) {
        const result = await invoke('fetch_nexus_browse_page', {page: number, sort: 'updated', profileId: profile.profileId, sourceId: source.id});
        assert.equal(result.page, number);
        assert(result.mods.length <= 20);
        assert(result.mods.every(mod => new URL(mod.pageUrl).pathname.startsWith(`/${source.providerSlug}/mods/`)));
        if (result.totalCount !== null) assert.equal(result.hasMore, number * 20 < result.totalCount);
        pages.push(result);
      }
      const firstIds = new Set(pages[0].mods.map(mod => mod.sourceId));
      assert(pages[1].mods.every(mod => !firstIds.has(mod.sourceId)), `${source.id} repeated page one`);
      const entry = {profileId: profile.profileId, sourceId: source.id, domain: source.providerSlug, counts: pages.map(result => result.mods.length), total: pages[0].totalCount};
      report.cases.push(entry); console.log(JSON.stringify(entry));
    }
  }
  const profile = profiles.find(profile => profile.profileId === 'builtin.payday2');
  await invoke('activate_game_profile_runtime', {profileId: profile.profileId, profile});
  const uiSettings = await invoke('get_app_settings');
  await invoke('save_app_settings', {settings: {...uiSettings, startupDestination: 'browse'}});
  await page.reload();
  await page.locator('.sidebar .nav-button').filter({hasText: /^Browse$/}).waitFor({timeout: 60000});
  const wizard = page.locator('.setup-wizard-overlay');
  if (await wizard.isVisible()) await wizard.getByRole('button', {name: 'Skip', exact: true}).click();
  await page.getByRole('button', {name: 'Nexus Mods', exact: true}).click();
  await page.waitForFunction(() => document.body.innerText.includes('Page 1') && document.querySelectorAll('.tsuki-mod-card-body h3').length > 0, null, {timeout: 60000});
  const titles = () => page.locator('.tsuki-mod-card-body h3').allTextContents();
  const first = await titles();
  await page.getByRole('button', {name: 'Next Page', exact: true}).click();
  await page.waitForFunction(() => document.body.innerText.includes('Page 2') && !document.body.innerText.includes('Loading...'), {timeout: 60000});
  const second = await titles();
  assert(second.length > 0 && JSON.stringify(first) !== JSON.stringify(second));
  await page.getByRole('button', {name: 'Previous Page', exact: true}).click();
  await page.waitForFunction(() => document.body.innerText.includes('Page 1') && !document.body.innerText.includes('Loading...'), {timeout: 60000});
  assert.deepEqual(await titles(), first);
  report.checks.push('actual packaged PAYDAY 2 Nexus UI Next Page and Previous Page');
  await invoke('save_app_settings', {settings: {...await invoke('get_app_settings'), nexusApiKey: null}});
  for (const command of ['fetch_nexus_browse_page', 'fetch_source_mods_page']) {
    await assert.rejects(invoke(command, {source: 'nexus', page: 1, sort: 'updated', profileId: profile.profileId, sourceId: 'payday2-nexus-api'}), error => /API key/.test(String(error)));
  }
  report.checks.push('missing credentials fail explicitly despite populated source-index cache');
  report.passed = true;
} catch (error) {
  report.error = String(error.stack ?? error); process.exitCode = 1; console.error(report.error);
} finally {
  if (invoke) {try {await invoke('save_app_settings', {settings: {...await invoke('get_app_settings'), nexusApiKey: null}});} catch {}}
  if (fixtureBrowser) await fixtureBrowser.close();
  if (browser) await browser.close();
  if (child.pid) spawnSync('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${child.pid} -ErrorAction SilentlyContinue`], {windowsHide: true});
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
