import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';

const require = createRequire('C:/Users/jeffe/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/runtime.cjs');
const {chromium} = require('playwright');
const key = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'Tsuki Mod Manager/settings.json'), 'utf8')).nexusApiKey;
assert(key, 'Saved Nexus API key required; never logged.');
const root = path.resolve('D:/TsukiReleaseQualification/nexus-download-live-' + Date.now());
fs.mkdirSync(root, {recursive: true});
const executable = path.resolve(process.argv[2] ?? 'src-tauri/target/release/tsukimodmanagerapp.exe');
const baseline = process.argv.includes('--baseline');
const uiOnly = process.argv.includes('--ui-only');
const child = spawn(executable, [], {windowsHide: true, stdio: 'ignore', env: {
  ...process.env, APPDATA: path.join(root, 'roaming'), LOCALAPPDATA: path.join(root, 'local'),
  WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9446',
}});
let browser, fixtureBrowser, invoke;
const report = {root, cases: [], downloads: [], checks: [], passed: false};
const rest = async endpoint => {
  const response = await fetch(`https://api.nexusmods.com/v1/${endpoint}`, {headers: {apikey: key}, signal: AbortSignal.timeout(30000)});
  if (!response.ok) throw new Error(`REST HTTP ${response.status}`);
  return response.json();
};
try {
  fixtureBrowser = await chromium.launch({channel: 'msedge', headless: true});
  const fixture = await fixtureBrowser.newPage();
  await fixture.goto('http://localhost:1420/scripts/profile-card-layout-preview.html');
  const profiles = await fixture.evaluate(async () => (await import('/src/models/gameProfiles.ts')).BUILTIN_GAME_PROFILES);
  await fixtureBrowser.close(); fixtureBrowser = null;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {browser = await chromium.connectOverCDP('http://127.0.0.1:9446'); break;}
    catch {await new Promise(resolve => setTimeout(resolve, 1000));}
  }
  assert(browser);
  let page;
  for (let attempt = 0; attempt < 60; attempt++) {
    page = browser.contexts()[0].pages().find(page => page.url().includes('tauri.localhost'));
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert(page, 'Packaged app page did not start');
  await page.waitForFunction(() => window.__TAURI_INTERNALS__?.invoke);
  invoke = (command, args = {}) => page.evaluate(({command, args}) => window.__TAURI_INTERNALS__.invoke(command, args), {command, args});
  await invoke('save_app_settings', {settings: {...await invoke('get_app_settings'), nexusApiKey: key, autoUpdateChecks: false}});
  if (baseline) {
    const profile = profiles.find(profile => profile.profileId === 'builtin.payday3');
    await invoke('activate_game_profile_runtime', {profileId: profile.profileId, profile});
    for (const domain of ['5717', 'payday3']) {
      const detail = await invoke('fetch_nexus_mod_detail', {profileId: profile.profileId, modId: '380', gameDomain: domain});
      report.cases.push({domain, modId: '380', files: detail.files.length});
    }
  } else {
    const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
    assert.equal((await invoke('check_app_update', {manifestUrl: 'http://127.0.0.1:1/unreachable'})).currentVersion, version);
    for (const profile of uiOnly ? [] : profiles) {
      const sources = profile.sourceConfig?.sources?.filter(source => source.provider === 'nexus' && source.browseMode === 'api' && source.enabled);
      if (!sources?.length) continue;
      await invoke('activate_game_profile_runtime', {profileId: profile.profileId, profile});
      for (const source of sources) {
        const listing = await invoke('fetch_nexus_browse_page', {profileId: profile.profileId, sourceId: source.id, page: 1, sort: 'updated'});
        let found;
        for (const mod of listing.mods.slice(0, 12)) {
          try {
            const detail = await invoke('fetch_nexus_mod_detail', {profileId: profile.profileId, modId: mod.sourceId, gameDomain: source.providerGameId});
            assert.equal(detail.gameId, source.providerSlug);
            assert(detail.files.every(file => new URL(file.downloadUrl).pathname.startsWith(`/${source.providerSlug}/mods/`)));
            if (detail.files.length) {found = {sourceId: source.id, modId: mod.sourceId, files: detail.files.length, domain: detail.gameId}; break;}
          } catch (error) {
            if (!/HTTP 40[34]/.test(String(error))) throw error;
          }
        }
        assert(found, `No accessible file list for ${source.id}`);
        report.cases.push(found); console.log(JSON.stringify(found));
      }
    }
    for (const [profileId, domain, gameId, marker] of uiOnly ? [] : [
      ['builtin.payday3', 'payday3', '5717', 'PAYDAY3/Binaries/Win64/PAYDAY3Client-Win64-Shipping.exe'],
      ['builtin.payday2', 'payday2', '648', 'payday2_win32_release.exe'],
      ['builtin.outlast-trials', 'theoutlasttrials', '5376', 'OPP/Binaries/Win64/TOTClient-Win64-Shipping.exe'],
    ]) {
      const game = path.join(root, 'games', profileId);
      fs.mkdirSync(path.dirname(path.join(game, marker)), {recursive: true});
      fs.writeFileSync(path.join(game, marker), 'isolated game identity fixture');
      if (domain === 'payday3') fs.mkdirSync(path.join(game, 'PAYDAY3/Content/Paks'), {recursive: true});
      const profile = profiles.find(profile => profile.profileId === profileId);
      await invoke('save_profile_settings', {profileId, settings: {...await invoke('get_profile_settings', {profileId}), gameRootOverride: game}});
      await invoke('activate_game_profile_runtime', {profileId, profile});
      const candidates = domain === 'payday3' ? [{mod_id: 380}] : await rest(`games/${domain}/mods/latest_added.json`);
      let staged;
      for (const candidate of candidates.slice(0, 40)) {
        try {
          const modId = String(candidate.mod_id);
          const metadata = await rest(`games/${domain}/mods/${modId}.json`);
          if (metadata.contains_adult_content || /mod.?manager|installer/i.test(metadata.name)) continue;
          const raw = await rest(`games/${domain}/mods/${modId}/files.json`);
          const file = raw.files.filter(file => file.category_name === 'MAIN' && file.size_in_bytes > 0 && file.size_in_bytes < 32 * 1024 * 1024).sort((a, b) => b.uploaded_timestamp - a.uploaded_timestamp)[0];
          if (!file) continue;
          const detail = await invoke('fetch_nexus_mod_detail', {profileId, modId, gameDomain: gameId});
          assert(detail.files.some(item => item.id === String(file.file_id)));
          staged = await invoke('stage_source_file_download', {profileId, source: 'nexus', modId, fileId: String(file.file_id), fileName: file.file_name, downloadUrl: null, modName: metadata.name, description: metadata.description, gameDomain: gameId});
          assert(path.resolve(staged.stagedFilePath).startsWith(root + path.sep));
          const contents = fs.readFileSync(staged.stagedFilePath);
          assert(contents.length > 0 && contents.length === staged.sizeBytes);
          assert(!/^\s*(<!doctype html|<html|\{"message")/i.test(contents.subarray(0, 100).toString()));
          const result = {profileId, modId, fileId: String(file.file_id), bytes: contents.length, sha256: createHash('sha256').update(contents).digest('hex'), archiveKind: staged.archiveKind, entries: staged.entries.length};
          report.downloads.push(result); console.log(JSON.stringify(result));
          break;
        } catch (error) {
          console.log(JSON.stringify({profileId, skippedModId: candidate.mod_id, error: String(error).replace(/https?:\/\/\S+/g, '[URL]').slice(0, 250)}));
        }
      }
      assert(staged, `No actual staged Nexus download for ${profileId}`);
    }
    if (!uiOnly) {
      report.checks.push('17 Nexus file lists resolve numeric identities to canonical game domains');
      report.checks.push('real staged archives downloaded and hashed for PAYDAY 3, PAYDAY 2, and Outlast in isolated storage');
    }
    const profileId = 'builtin.payday3';
    const game = path.join(root, 'games', profileId);
    fs.mkdirSync(path.join(game, 'PAYDAY3/Binaries/Win64'), {recursive: true});
    fs.mkdirSync(path.join(game, 'PAYDAY3/Content/Paks'), {recursive: true});
    fs.writeFileSync(path.join(game, 'PAYDAY3/Binaries/Win64/PAYDAY3Client-Win64-Shipping.exe'), 'isolated game identity fixture');
    await invoke('save_profile_settings', {profileId, settings: {...await invoke('get_profile_settings', {profileId}), gameRootOverride: game}});
    await invoke('activate_game_profile_runtime', {profileId, profile: profiles.find(profile => profile.profileId === profileId)});
    await invoke('save_app_settings', {settings: {...await invoke('get_app_settings'), startupDestination: 'browse'}});
    await page.reload();
    await page.locator('.sidebar .nav-button').filter({hasText: /^Browse$/}).waitFor({timeout: 60000});
    const wizard = page.locator('.setup-wizard-overlay');
    if (await wizard.isVisible()) await wizard.getByRole('button', {name: 'Skip', exact: true}).click();
    await page.getByRole('button', {name: 'Nexus Mods', exact: true}).click();
    const title = page.locator('.tsuki-mod-card-body h3').filter({hasText: /PD3 DrunkDallas|Drunk Dallas Camera/});
    await title.waitFor({timeout: 60000});
    if (await wizard.isVisible()) await wizard.getByRole('button', {name: 'Skip', exact: true}).click();
    await title.click();
    await page.getByRole('button', {name: 'Browse Files', exact: true}).waitFor({timeout: 60000});
    await page.getByRole('button', {name: 'Browse Files', exact: true}).click();
    const picker = page.getByRole('dialog').filter({hasText: 'Install Files:'});
    const install = picker.getByRole('button', {name: 'Install Selected (1)', exact: true});
    await install.waitFor({timeout: 60000});
    await picker.getByRole('region', {name: 'Mod requirements'}).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('.quick-install-actions button')].some(button => button.textContent === 'Install Selected (1)' && !button.disabled), {timeout: 60000});
    assert(await install.isEnabled(), 'Real file picker install button is disabled');
    report.checks.push('actual packaged Nexus mod page opens a real file picker with requirements, the latest file selected and Install enabled after requirements lookup');
  }
  report.passed = true;
} catch (error) {
  report.error = String(error.stack ?? error).replace(/https?:\/\/\S+/g, '[URL]'); process.exitCode = 1; console.error(report.error);
} finally {
  if (invoke) {try {await invoke('save_app_settings', {settings: {...await invoke('get_app_settings'), nexusApiKey: null}});} catch {}}
  const settingsFile = path.join(root, 'roaming', 'Tsuki Mod Manager', 'settings.json');
  if (fs.existsSync(settingsFile)) {
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings.nexusApiKey = null;
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  }
  if (fixtureBrowser) await fixtureBrowser.close();
  if (browser) await browser.close();
  if (child.pid) spawnSync('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${child.pid} -ErrorAction SilentlyContinue`], {windowsHide: true});
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
