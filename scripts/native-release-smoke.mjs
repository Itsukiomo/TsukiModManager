import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';

const require = createRequire('C:/Users/jeffe/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/runtime.cjs');
const {chromium} = require('playwright');
const [exeArg, mode = 'clean', rootArg] = process.argv.slice(2);
const releaseVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
assert(exeArg, 'Pass the packaged executable');
const executable = fs.realpathSync(exeArg);
const approved = path.resolve(process.env.TSUKI_RELEASE_QA_ROOT ?? 'src-tauri/target/release-qualification');
const root = path.resolve(rootArg ?? path.join(approved, `${mode}-${Date.now()}`));
assert(root.startsWith(`${approved}${path.sep}`));
fs.mkdirSync(root, {recursive: true});
const roaming = path.join(root, 'roaming');
const local = path.join(root, 'local');
fs.mkdirSync(roaming, {recursive: true});
fs.mkdirSync(local, {recursive: true});
const port = mode === 'legacy' ? 9431 : 9432;
const processHandle = spawn(executable, [], {
  windowsHide: true,
  env: {...process.env, APPDATA: roaming, LOCALAPPDATA: local,
    WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`},
  stdio: 'ignore',
});
let browser;
const report = {mode, executable, root, checks: []};
try {
  for (let attempt = 0; attempt < 90; attempt++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
  }
  assert(browser, 'Packaged WebView did not start');
  const context = browser.contexts()[0];
  let page;
  for (let attempt = 0; attempt < 60; attempt++) {
    page = context.pages().find(candidate => /tauri\.localhost|tauri:\/\//.test(candidate.url()));
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert(page, 'No packaged app page');
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.__TAURI_INTERNALS__?.invoke && document.body.innerText.includes('Tsuki'), {timeout: 60000});
  const invoke = (command, args = {}) => page.evaluate(({command, args}) => window.__TAURI_INTERNALS__.invoke(command, args), {command, args});
  const dismissSetup = async () => {
    await page.getByRole('button', {name: /Installed/}).first().waitFor({timeout: 60000});
    await page.waitForTimeout(750);
    const wizard = page.locator('.setup-wizard-overlay');
    if (await wizard.isVisible()) await wizard.getByRole('button', {name: 'Skip', exact: true}).click();
  };
  await dismissSetup();
  report.checks.push('packaged WebView startup');
  console.log(JSON.stringify({mode, url: page.url(), text: (await page.locator('body').innerText()).slice(0, 2200)}));
  const settings = await invoke('get_app_settings');
  if (mode === 'legacy') {
    await invoke('save_theme', {themeId: 'moonveil'});
    await invoke('save_cache_settings', {keepDownloadedArchives: true});
    await page.evaluate(() => localStorage.setItem('tsuki-release-migration-sentinel', '1.8.2-preserved'));
    report.checks.push('actual 1.8.2 settings and WebView storage written');
  } else {
    assert.equal((await invoke('check_app_update', {manifestUrl: 'http://127.0.0.1:1/unreachable'})).currentVersion, releaseVersion);
    report.checks.push(`native version ${releaseVersion}`);
    assert(await page.locator('.sidebar').innerText().then(text => text.includes(`v${releaseVersion}`)), 'Sidebar release version');
    report.checks.push('sidebar release version matches native version');
    if (mode === 'upgrade') {
      assert.equal(settings.keepDownloadedArchives, true);
      assert.equal(await page.evaluate(() => localStorage.getItem('tsuki-release-migration-sentinel')), '1.8.2-preserved');
      report.checks.push('1.8.2 settings and WebView storage preserved');
    }
    if (mode === 'loader') {
      const game = path.join(root, 'simulated-outlast');
      const bin = path.join(game, 'OPP/Binaries/Win64');
      fs.mkdirSync(bin, {recursive: true});
      fs.writeFileSync(path.join(bin, 'TOTClient-Win64-Shipping.exe'), 'isolated identity marker, not a game');
      fs.mkdirSync(path.join(game, 'OPP/Content/Paks'), {recursive: true});
      const profileId = 'builtin.outlast-trials';
      const profile = await invoke('get_profile_settings', {profileId});
      await invoke('save_profile_settings', {profileId, settings: {...profile, gameRootOverride: game}});
      const initial = await invoke('managed_loader_status');
      assert.equal(initial.state, 'disclosure');
      await invoke('save_app_settings', {settings: {...settings, activeGameProfileId: profileId, currentGameProfileId: profileId, autoUpdateChecks: false}});
      await page.reload();
      await dismissSetup();
      await page.getByRole('button', {name: 'Enable Support', exact: true}).waitFor({timeout: 60000});
      await page.getByRole('button', {name: 'Enable Support', exact: true}).click();
      await page.getByRole('button', {name: 'Repair', exact: true}).waitFor({timeout: 90000});
      const ready = await invoke('managed_loader_status');
      assert.equal(ready.state, 'ready');
      assert.equal(ready.version, '1.0.0');
      report.checks.push('actual Outlast profile UI consent, production GitHub download and verified install');
      const entry = path.join(game, 'NativePakLoader/ManagedRuntime/TsukiOutlastLoader.exe');
      const before = fs.statSync(entry).mtimeMs;
      assert.equal((await invoke('managed_loader_action', {action: 'ensure'})).state, 'ready');
      assert.equal(fs.statSync(entry).mtimeMs, before);
      report.checks.push('intact reopen does not reinstall');
      fs.appendFileSync(entry, 'corruption fixture');
      assert.equal((await invoke('managed_loader_status')).state, 'missing');
      await page.getByRole('button', {name: 'Repair', exact: true}).click();
      await page.getByRole('button', {name: 'Repair', exact: true}).waitFor({timeout: 90000});
      assert.equal((await invoke('managed_loader_status')).state, 'ready');
      await page.getByRole('button', {name: 'Update Native PAK loader', exact: true}).click();
      await page.getByRole('button', {name: 'Repair', exact: true}).waitFor({timeout: 90000});
      assert.equal((await invoke('managed_loader_status')).state, 'ready');
      report.checks.push('actual repair and signed update UI actions');
    }
    if (mode === 'ui') {
      for (const name of ['Installed', 'Profiles', 'Backups', 'Settings', 'Home']) {
        await page.locator('.sidebar .nav-button').filter({hasText: new RegExp(`^${name}$`)}).click();
        await page.waitForTimeout(1000);
        assert((await page.locator('main.app-main').innerText()).trim().length > 10, `${name} page is blank`);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name} overflows`);
        await page.screenshot({path: path.join(root, `${name.toLowerCase()}.png`)});
      }
      const dependencies = await invoke('get_dependency_report', {profileId: 'builtin.payday3'});
      assert(dependencies.warnings.some(warning => warning.includes('could not patch')), 'Known AllowModsMod failure is not disclosed');
      report.checks.push('packaged Installed, Profiles, Backups, Settings and Home navigation');
      report.checks.push('actual dependency report discloses recorded PAYDAY 3 patch failure');
    }
    if (mode === 'profile-layout') {
      const version = page.getByRole('combobox', {name: 'PAYDAY 3 game version'});
      await page.waitForFunction(() => document.querySelector('select[aria-label="PAYDAY 3 game version"]') || document.querySelector('.sidebar .current-game-card'));
      if (!(await version.isVisible())) await page.locator('.sidebar .current-game-card').click();
      await version.waitFor();
      const assertLayout = async () => {
        const boxes = await page.locator('article.game-profile-card').evaluateAll(nodes => nodes.map(node => {
          const card = node.getBoundingClientRect(), surface = node.querySelector('.game-profile-select-surface').getBoundingClientRect();
          const select = node.querySelector('select')?.getBoundingClientRect();
          const image = node.querySelector('.game-profile-artwork-frame').getBoundingClientRect();
          const spans = [...node.querySelectorAll('.game-profile-card-meta > span')].map(span => span.getBoundingClientRect());
          return {height: card.height, width: card.width, imageHeight: image.height, contained: !select || (select.bottom <= card.bottom && select.top >= Math.max(...spans.map(span => span.bottom)))};
        }));
        assert(boxes.length > 3);
        assert(Math.max(...boxes.map(box => box.height)) - Math.min(...boxes.map(box => box.height)) < 1);
        assert(Math.max(...boxes.map(box => box.imageHeight)) - Math.min(...boxes.map(box => box.imageHeight)) < 1);
        assert(boxes.every(box => box.contained));
      };
      for (const value of ['UE4.27', 'UE5.5']) {
        await version.selectOption(value);
        await page.waitForFunction(value => document.querySelector('select[aria-label="PAYDAY 3 game version"]')?.value === value, value);
        await page.waitForTimeout(750);
        await assertLayout();
      }
      const settingsAfter = await invoke('get_profile_settings', {profileId: 'builtin.payday3'});
      assert.equal(settingsAfter.gameVersion, 'UE5.5');
      report.checks.push('packaged profile cards have equal heights, contained controls and persisted UE4/UE5 selection');
      await page.screenshot({path: path.join(root, 'game-profiles.png')});
    }
    if (mode === 'performance') {
      const profileId = 'builtin.payday2';
      const game = path.join(root, 'simulated-payday2');
      fs.mkdirSync(path.join(game, 'mods'), {recursive: true});
      fs.writeFileSync(path.join(game, 'PAYDAY2.exe'), 'identity marker, not executable');
      const profile = await invoke('get_profile_settings', {profileId});
      await invoke('save_profile_settings', {profileId, settings: {...profile, gameRootOverride: game}});
      const indexRoot = path.join(roaming, 'Tsuki Mod Manager', 'profile-data', profileId, 'source-index');
      fs.mkdirSync(indexRoot, {recursive: true});
      const records = {}, archives = {};
      const catalogCount = 40000, installedCount = 1000;
      for (let i = 0; i < catalogCount; i++) {
        const id = String(i + 1), fileName = `fixture-${id}.lua`;
        const summary = {source: 'nexus', sourceId: id, name: `Performance fixture ${id}`, tags: [], pageUrl: `https://www.nexusmods.com/payday2/mods/${id}`};
        records[`nexus-${id}`] = {source: 'nexus', sourceId: id, summary, indexedAtUnix: 1, fileNames: [fileName], fileIds: [id]};
        if (i < installedCount) {
          const contents = Buffer.from(`-- isolated performance fixture ${id}\n`);
          fs.writeFileSync(path.join(game, 'mods', fileName), contents);
          archives[id] = {source: 'nexus', game: 'payday2', modId: id, fileId: id, status: 'hashed', fileName: `${id}.zip`, fileEntries: [{fileName, fileSize: contents.length, sha256: createHash('sha256').update(contents).digest('hex')}]};
        }
      }
      fs.writeFileSync(path.join(indexRoot, 'source-index.json'), JSON.stringify({version: 1, records}));
      fs.writeFileSync(path.join(indexRoot, 'file-hashes.json'), JSON.stringify({version: 1, archives}));
      report.performance = {catalogCount, installedCount, timings: []};
      for (let run = 0; run < 3; run++) {
        const started = performance.now();
        const identities = await invoke('match_installed_source_index_v2', {profileId});
        report.performance.timings.push(performance.now() - started);
        assert.equal(identities.length, installedCount);
        assert(identities.every(identity => identity.matchInfo.confidence === 100 && identity.matchInfo.matchKind === 'sha256'));
      }
      fs.unlinkSync(path.join(game, 'mods', 'fixture-1.lua'));
      const changed = path.join(game, 'mods', 'fixture-2.lua');
      fs.writeFileSync(changed, Buffer.alloc(fs.statSync(changed).size, 88));
      fs.utimesSync(changed, new Date(), new Date(Date.now() + 5000));
      const reconciled = await invoke('match_installed_source_index_v2', {profileId});
      assert.equal(reconciled.length, installedCount - 2);
      assert(!reconciled.some(identity => ['1', '2'].includes(identity.sourceMod.sourceId)));
      report.checks.push('40,000 catalog / 1,000 real payload exact-hash matching');
      report.checks.push('external removal and changed contents invalidate installed identity');
      await invoke('save_app_settings', {settings: {...settings, activeGameProfileId: profileId, currentGameProfileId: profileId, autoUpdateChecks: false}});
      await page.reload();
      await dismissSetup();
      const started = performance.now();
      await page.locator('.sidebar .nav-button').filter({hasText: /^Installed$/}).click();
      await page.getByText('Performance fixture 10', {exact: true}).first().waitFor({timeout: 120000});
      report.performance.firstIndexedCardMs = performance.now() - started;
      const more = page.getByRole('button', {name: 'Show More', exact: true});
      if (await more.count()) {
        assert.equal(await page.locator('.installed-library-grid > article').count(), 48);
        await more.click();
        assert.equal(await page.locator('.installed-library-grid > article').count(), 96);
        await page.getByPlaceholder('Search installed mods...').fill('Performance fixture 1000');
        await page.getByText('Performance fixture 1000', {exact: true}).first().waitFor();
        assert.equal(await page.locator('.installed-library-grid > article').count(), 1);
        await page.getByPlaceholder('Search installed mods...').fill('');
        await page.getByRole('button', {name: /^(Select Filtered|Select Visible)$/}).click();
        assert((await page.locator('.mass-select-bar').innerText()).includes('998 cards selected'));
        await page.getByRole('button', {name: 'Clear', exact: true}).click();
        await page.screenshot({path: path.join(root, 'installed.png')});
        report.checks.push('48-card initial render, Show More, full-library search and filtered bulk selection');
        fs.unlinkSync(path.join(game, 'mods', 'fixture-1000.lua'));
        await page.locator('.sidebar .nav-button').filter({hasText: /^Home$/}).click();
        await page.locator('.sidebar .nav-button').filter({hasText: /^Installed$/}).click();
        await page.waitForFunction(() => document.querySelector('.installed-toolbar-counts button strong')?.textContent === '997', {timeout: 60000});
        await page.getByPlaceholder('Search installed mods...').fill('Performance fixture 1000');
        assert.equal(await page.locator('.installed-library-grid > article').count(), 0);
        await page.getByPlaceholder('Search installed mods...').fill('');
        report.checks.push('cached-page reopen rechecks disk and removes an externally deleted mod');
      }
      report.checks.push('packaged Installed page renders indexed cards');
      console.log(JSON.stringify(report.performance));
    }
  }
  if (mode !== 'profile-layout') await page.getByRole('button', {name: /Installed/}).first().waitFor({timeout: 60000});
  if (mode !== 'performance') await page.screenshot({path: path.join(root, `${mode}.png`)});
  assert.deepEqual(errors, [], 'Packaged frontend exceptions');
  report.checks.push('no captured frontend exceptions');
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error.stack ?? error);
  process.exitCode = 1;
  console.error(report.error);
} finally {
  if (browser) await browser.close();
  if (processHandle.pid) spawnSync('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${processHandle.pid} -ErrorAction SilentlyContinue`], {windowsHide: true});
  fs.writeFileSync(path.join(root, `${mode}-report.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
