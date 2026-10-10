import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require = createRequire('C:/Users/jeffe/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/runtime.cjs');
const {chromium} = require('playwright');
const executable = path.resolve(process.argv[2]);
const noIntro = process.argv.includes('--no-intro');
const root = `D:/TsukiReleaseQualification/outlast-movies-${Date.now()}`;
const game = 'D:/SteamLibrary/steamapps/common/The Outlast Trials';
const backend = `${game}/NativePakLoader/ManagedRuntime/TsukiOutlastLoader.exe`;
const profileId = 'builtin.outlast-trials';
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const selectionFile = `${game}/NativePakLoader/loader-profile.json`;
const originalSelection = fs.readFileSync(selectionFile);
const names = noIntro ? ['RedBarrelsLogo.bk2', 'TOT_ThirdParty.bk2'] : ['RedBarrelsLogo.bk2'];
const targets = names.map(name => `${game}/OPP/Content/Movies/${name}`);
const originals = targets.map(digest);
for (const name of ['roaming', 'local', 'source/Movies']) fs.mkdirSync(`${root}/${name}`, {recursive: true});
fs.writeFileSync(`${root}/loader-profile.before-test.json`, originalSelection, {flag: 'wx'});
// A known valid, non-adult Bink from this owned game tests real container bytes; nothing is distributed.
for (const name of names) {
  const source = noIntro
    ? `D:/TsukiReleaseQualification/outlast-full-catalog/files/1-19/contents/OPP/Content/Movies/${name}`
    : `${game}/OPP/Content/Movies/AE_Tv_Loop-01.bk2`;
  fs.copyFileSync(source, `${root}/source/Movies/${name}`);
  if (noIntro) assert.equal(fs.statSync(source).size, 0);
}
const replacements = names.map(name => digest(`${root}/source/Movies/${name}`));
for (let i = 0; i < names.length; i++) assert.notEqual(originals[i], replacements[i]);
const assertMovies = hashes => targets.forEach((target, i) => assert.equal(digest(target), hashes[i]));
const report = {root, noIntro, movies: names.map((name, i) => ({name, originalSha256: originals[i], replacementSha256: replacements[i]})), checks: []};
const child = spawn(executable, [], {windowsHide: true, stdio: 'ignore', env: {...process.env,
  APPDATA: `${root}/roaming`, LOCALAPPDATA: `${root}/local`, WEBVIEW2_USER_DATA_FOLDER: `${root}/webview`,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9449'}});
let browser, invoke, receipt;
const apply = paths => {
  const result = spawnSync(backend, ['--game-root', game, ...paths.flatMap(file => ['--managed-movie', file]), 'apply'], {windowsHide: true, encoding: 'utf8', timeout: 180000});
  assert.equal(result.status, 0, `${result.stdout} ${result.stderr}`);
  assert.equal(JSON.parse(result.stdout).state, 'applied');
};
const gameRunning = () => spawnSync('powershell', ['-NoProfile', '-Command',
  "if (Get-Process TOTClient-Win64-Shipping -ErrorAction SilentlyContinue) { exit 1 }"],
  {windowsHide: true}).status !== 0;
const closeTestGame = async () => {
  spawnSync('powershell', ['-NoProfile', '-Command',
    'Get-Process TOTClient-Win64-Shipping -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null }'],
    {windowsHide: true});
  for (let i = 0; i < 30 && gameRunning(); i++) await new Promise(resolve => setTimeout(resolve, 1000));
  assert(!gameRunning(), 'Game did not close gracefully; leave recovery files intact');
};
try {
  for (let i = 0; i < 90; i++) {
    try {browser = await chromium.connectOverCDP('http://localhost:9449'); break;}
    catch {await new Promise(resolve => setTimeout(resolve, 1000));}
  }
  assert(browser);
  const page = browser.contexts()[0].pages()[0];
  await page.waitForFunction(() => window.__TAURI_INTERNALS__?.invoke);
  invoke = (command, args = {}) => page.evaluate(({command, args}) => window.__TAURI_INTERNALS__.invoke(command, args), {command, args});
  const settings = await invoke('get_profile_settings', {profileId});
  await invoke('save_profile_settings', {profileId, settings: {...settings, gameRootOverride: game}});
  const analysis = await invoke('analyze_drag_drop_install', {profileId, paths: [`${root}/source`]});
  assert.equal(analysis.items.length, 1);
  assert.equal(analysis.items[0].blocked, false);
  const result = await invoke('install_drag_drop_item', {request: {item: analysis.items[0], installAsLocal: true,
    displayName: noIntro ? 'Tsuki No-Intro lifecycle test' : 'Tsuki Bink lifecycle test', selectedMatch: null, versionOverride: null, thumbnailOverride: null, notes: 'Temporary owner-authorized test', allowOverwrite: false}});
  receipt = JSON.parse(fs.readFileSync(result.receiptPath, 'utf8'));
  assert(receipt.files.every(file => file.relativePath.replaceAll('\\', '/').includes('/NativePakLoader/Mods/')));
  assertMovies(originals);
  report.checks.push('actual packaged movie import stages outside game movies');
  const files = receipt.files.map(file => file.relativePath);
  apply(files);
  assertMovies(replacements);
  report.checks.push('signed compiled backend applies real Bink bytes with original backup');
  await invoke('set_source_install_enabled', {profileId, source: receipt.source, sourceId: receipt.sourceModId ?? receipt.id, receiptId: receipt.id, enabled: false});
  apply([]);
  assertMovies(originals);
  report.checks.push('receipt disable plus apply restores original movie hash');
  await invoke('set_local_win64_matched_files_enabled', {profileId, filePaths: files, enabled: true});
  apply(files);
  assertMovies(replacements);
  report.checks.push('receipt enable plus apply restores replacement movie hash');
  if (noIntro) {
    assert(!gameRunning(), 'Game must be closed before startup verification');
    const steam = process.env.TSUKI_QA_STEAM_EXE;
    assert(steam && fs.existsSync(steam), 'Explicit existing Steam executable required');
    const startedAt = Date.now();
    const steamChild = spawn(steam, ['-applaunch', '1304930'], {windowsHide: true, stdio: 'ignore'});
    let spawnError;
    steamChild.on('error', error => {spawnError = error;});
    try {
      const logFile = path.join(process.env.LOCALAPPDATA, 'OPP/Saved/Logs/OPP.log');
      let mainMenu = false;
      for (let i = 0; i < 90; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (spawnError) throw spawnError;
        if (fs.existsSync(logFile) && fs.statSync(logFile).mtimeMs >= startedAt && gameRunning()) {
          const log = fs.readFileSync(logFile, 'utf8');
          assert(!log.includes('Steam API failed to initialize'));
          if (log.includes('Bringing World /Game/Maps/Global/MainMenu.MainMenu up for play')) {
            fs.copyFileSync(logFile, `${root}/startup-game.log`);
            mainMenu = true;
            break;
          }
        }
      }
      assert(mainMenu, 'No fresh live main-menu log observed within 90 seconds');
      assertMovies(replacements);
      report.checks.push('real Steam launch reaches main menu with both empty startup replacements active');
      report.startupVerified = true;
    } finally {await closeTestGame();}
  }
  await invoke('uninstall_managed_install', {profileId, receiptId: receipt.id});
  receipt = null;
  apply([]);
  assertMovies(originals);
  report.checks.push('uninstall plus apply restores original movie hash');
  report.passed = true;
} catch (error) {report.error = String(error.stack ?? error); process.exitCode = 1;}
finally {
  if (receipt && invoke) {
    try {await invoke('uninstall_managed_install', {profileId, receiptId: receipt.id}); apply([]);}
    catch (error) {report.recoveryError = String(error); process.exitCode = 1;}
  }
  report.finalOriginalRestored = targets.every((target, i) => digest(target) === originals[i]);
  assert(report.finalOriginalRestored, 'Original movie restoration requires attention');
  const previous = JSON.parse(originalSelection);
  const after = JSON.parse(fs.readFileSync(selectionFile, 'utf8'));
  // Discard this test's selection only; never overwrite changes to other mods.
  const withoutTest = value => ({...value, order: value.order.filter(id => id !== 'mods/Tsuki-source'),
    enabled: Object.fromEntries(Object.entries(value.enabled).filter(([id]) => id !== 'mods/Tsuki-source'))});
  if (JSON.stringify(withoutTest(previous)) === JSON.stringify(withoutTest(after))) {
    fs.writeFileSync(selectionFile, originalSelection);
    report.originalSelectionRestored = true;
  } else {
    report.originalSelectionRestored = false;
    report.selectionRecoveryError = 'Other selections changed; preserved for review instead of overwriting';
    process.exitCode = 1;
  }
  if (browser) await browser.close();
  if (child.pid) spawnSync('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${child.pid} -ErrorAction SilentlyContinue`], {windowsHide: true});
  fs.writeFileSync(`${root}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
