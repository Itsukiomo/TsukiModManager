import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const require = createRequire('C:/Users/jeffe/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/runtime.cjs');
const { chromium } = require('playwright');
const root = path.resolve('D:/TsukiReleaseQualification/dependencies-' + Date.now());
const key = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'Tsuki Mod Manager/settings.json'), 'utf8')).nexusApiKey;
const executable = path.resolve(process.argv[2] ?? 'src-tauri/target/release/tsukimodmanagerapp.exe');
const debugPort = Number(process.env.TSUKI_DEPENDENCY_DEBUG_PORT ?? 9447);
fs.mkdirSync(root, { recursive: true });
const report = { root, cases: [], errors: [], checks: [], passed: false };
let browser, fixtureBrowser, child, invoke;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fixtures = [
  ['builtin.payday2', 'PAYDAY2.exe', 0x8664, ['pd2-legendary-armour-skins']],
  ['builtin.payday3', 'PAYDAY3/Binaries/Win64/PAYDAY3Client-Win64-Shipping.exe', 0x8664, ['pd3-ue5-ue4ss-allow-pak']],
  ['builtin.payday-the-heist', 'payday_win32_release.exe', 0x14c, ['pdth-mod-overrides']],
  ['builtin.borderlands', 'Binaries/Borderlands.exe', 0x14c, ['borderlands-willow1-classic']],
  ['builtin.borderlands', 'Binaries/Win64/BorderlandsGOTY.exe', 0x8664, ['borderlands-willow1-enhanced']],
  ['builtin.borderlands2', 'Binaries/Win32/Borderlands2.exe', 0x14c, ['borderlands2-willow2']],
  ['builtin.borderlands3', 'OakGame/Binaries/Win64/Borderlands3.exe', 0x8664, ['borderlands3-oak', 'borderlands-open-hotfix-loader']],
  ['builtin.tiny-tinas-wonderlands', 'OakGame/Binaries/Win64/Wonderlands.exe', 0x8664, ['borderlands3-oak', 'borderlands-open-hotfix-loader']],
  ['builtin.borderlands4', 'OakGame/Binaries/Win64/Borderlands4.exe', 0x8664, ['borderlands4-oak2']],
  ['builtin.resident-evil-7', 're7.exe', 0x8664, ['re-reframework']],
  ['builtin.resident-evil-village', 're8.exe', 0x8664, ['re-reframework']],
  ['builtin.resident-evil-requiem', 're9.exe', 0x8664, ['re-reframework']],
  ['builtin.monster-hunter-wilds', 'MonsterHunterWilds.exe', 0x8664, ['mhw-reframework-nexus', 'mhw-catlib']],
  ['builtin.cyberpunk2077', 'bin/x64/Cyberpunk2077.exe', 0x8664, [
    'cyberpunk-cet', 'cyberpunk-red4ext', 'cyberpunk-redscript', 'cyberpunk-archivexl', 'cyberpunk-tweakxl',
    'cyberpunk-codeware', 'cyberpunk-native-settings-ui', 'cyberpunk-input-loader', 'cyberpunk-mod-settings',
    'cyberpunk-equipment-ex', 'cyberpunk-virtual-atelier', 'cyberpunk-appearance-menu-mod',
  ]],
];
function writePe(target, machine) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const bytes = Buffer.alloc(256); bytes.write('MZ'); bytes.writeUInt32LE(128, 0x3c); bytes.write('PE\0\0', 128); bytes.writeUInt16LE(machine, 132);
  fs.writeFileSync(target, bytes);
}
try {
  fixtureBrowser = await chromium.launch({ channel: 'msedge', headless: true });
  const fixture = await fixtureBrowser.newPage();
  await fixture.goto('http://localhost:1420/scripts/profile-card-layout-preview.html');
  const profiles = await fixture.evaluate(async () => (await import('/src/models/gameProfiles.ts')).BUILTIN_GAME_PROFILES);
  await fixtureBrowser.close(); fixtureBrowser = null;
  child = spawn(executable, [], { windowsHide: true, stdio: 'ignore', env: {
    ...process.env, APPDATA: path.join(root, 'roaming'), LOCALAPPDATA: path.join(root, 'local'),
    WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + debugPort,
  }});
  for (let i = 0; i < 60; i++) {
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:' + debugPort); break; } catch { await new Promise(r => setTimeout(r, 1000)); }
  }
  assert(browser);
  let page;
  for (let i = 0; i < 60; i++) {
    page = browser.contexts()[0].pages().find(p => p.url().includes('tauri.localhost'));
    if (page) break; await new Promise(r => setTimeout(r, 500));
  }
  assert(page);
  invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
  await page.waitForFunction(() => window.__TAURI_INTERNALS__?.invoke);
  await invoke('save_app_settings', { settings: { ...await invoke('get_app_settings'), nexusApiKey: key, autoUpdateChecks: false } });
  let paydayGame;
  async function installLoona() {
    const profileId = 'builtin.payday2';
    const detail = await invoke('fetch_nexus_mod_detail', { profileId, gameDomain: 'payday2', modId: '896' });
    const file = detail.files.find(f => f.id === '1577');
    assert(file, 'Current Loona 1.1 main file must be exposed');
    const staged = await invoke('stage_source_file_download', {
      source: 'nexus', modId: '896', fileId: file.id, fileName: file.name, downloadUrl: null,
      modName: detail.name, description: detail.description, gameDomain: 'payday2', profileId,
      installDependencies: true, dependencyNames: [],
    });
    assert(staged.canInstallLater, staged.warnings.join('\n'));
    assert(staged.entries.filter(e => e.routeKind !== 'folder').every(e => e.destination.toLowerCase().replaceAll('\\', '/').includes('/assets/mod_overrides/loona las/')));
    const result = await invoke('install_staged_file_to_game', {
      stagedFilePath: staged.stagedFilePath, modName: detail.name, source: 'nexus', modId: '896', fileId: file.id,
      sourceFileName: file.name, sourceFileCategory: file.fileType, sourceFileUploadedAt: file.uploadedAt, sourceFileVersion: file.version,
      version: file.version, author: detail.author, thumbnailUrl: null, bannerUrl: null, pageUrl: detail.pageUrl,
      description: detail.description, replaceFileNames: [], profileId,
    });
    assert(result.installedFiles.length > 0);
    const receipt = JSON.parse(fs.readFileSync(result.receiptPath, 'utf8'));
    for (const installed of receipt.files) assert.equal(hash(fs.readFileSync(installed.relativePath)), installed.sha256);
    report.checks.push({ name: 'Fresh Loona LAS 1.1 automatically installs its full dependency chain', files: result.installedFiles.length, archiveSha256: hash(fs.readFileSync(staged.stagedFilePath)) });
  }
  for (let index = 0; index < fixtures.length; index++) {
    const [profileId, marker, machine, ids] = fixtures[index];
    if (process.env.TSUKI_DEPENDENCY_PROFILES && !process.env.TSUKI_DEPENDENCY_PROFILES.split(',').includes(profileId)) continue;
    const game = path.join(root, 'games', index + '-' + profileId);
    writePe(path.join(game, marker), machine);
    if (profileId === 'builtin.payday2') paydayGame = game;
    await invoke('save_profile_settings', { profileId, settings: { ...await invoke('get_profile_settings', { profileId }), gameRootOverride: game } });
    const runtime = await invoke('activate_game_profile_runtime', { profileId, profile: profiles.find(p => p.profileId === profileId) });
    if (profileId === 'builtin.payday2') {
      try { await installLoona(); } catch (error) { report.errors.push({ profileId, dependencyId: 'Loona LAS', error: String(error) }); console.log(JSON.stringify(report.errors.at(-1))); }
    }
    for (const dependencyId of ids) {
      try {
        const result = await invoke('install_profile_dependency', { profileId, dependencyId });
        report.cases.push({ profileId, dependencyId, messages: result.messages });
        console.log(JSON.stringify(report.cases.at(-1)));
      } catch (error) {
        report.errors.push({ profileId, dependencyId, error: String(error) });
        console.log(JSON.stringify(report.errors.at(-1)));
      }
    }
    const storage = runtime.storagePath;
    if (storage) {
      const receipts = fs.readdirSync(path.join(storage, 'dependencies'), { withFileTypes: true }).filter(e => e.isDirectory());
      for (const entry of receipts) {
        const receiptPath = path.join(storage, 'dependencies', entry.name, 'receipt.json');
        if (!fs.existsSync(receiptPath)) continue;
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        if (path.resolve(receipt.gameRoot) !== path.resolve(game)) continue;
        for (const file of receipt.files) assert.equal(hash(fs.readFileSync(path.join(game, file.path))), file.sha256);
      }
    }
    const installed = await invoke('list_install_receipts', { profileId });
    if (!report.errors.some(e => e.profileId === profileId)) assert(installed.some(r => r.source === 'tsuki-managed-dependency'), 'Managed frameworks must appear in normal Installed receipts');
    if (profileId === 'builtin.payday2') {
      const receiptId = 'dependency-pd2-beardlib';
      await invoke('set_managed_install_enabled', { profileId, receiptId, enabled: false });
      assert.equal((await invoke('list_install_receipts', { profileId })).find(r => r.id === receiptId).enabled, false);
      await assert.rejects(invoke('install_profile_dependency', { profileId, dependencyId: 'pd2-beardlib' }), /disabled/);
      await invoke('set_managed_install_enabled', { profileId, receiptId, enabled: true });
      assert(fs.existsSync(path.join(game, 'mods/BeardLib/mod.txt')));
      await assert.rejects(invoke('uninstall_managed_install', { profileId, receiptId }), /shared game dependency/);
      report.checks.push({ name: 'Dependency Installed visibility, real disable/enable, no silent reactivation, shared uninstall protection' });
    }
  }
  const profileId = 'builtin.payday2';
  if (paydayGame) {
    await invoke('save_profile_settings', { profileId, settings: { ...await invoke('get_profile_settings', { profileId }), gameRootOverride: paydayGame } });
    await invoke('activate_game_profile_runtime', { profileId, profile: profiles.find(p => p.profileId === profileId) });
    await assert.rejects(invoke('install_profile_dependency', { profileId: 'builtin.payday2', dependencyId: 'cyberpunk-cet' }), /approved dependency identity/);
    report.checks.push({ name: 'Cross-game dependency rejected' });
  }
  report.passed = report.errors.length === 0;
} finally {
  if (invoke) try { await invoke('save_app_settings', { settings: { ...await invoke('get_app_settings'), nexusApiKey: null } }); } catch {}
  const settingsPath = path.join(root, 'roaming/Tsuki Mod Manager/settings.json');
  if (fs.existsSync(settingsPath)) { const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); settings.nexusApiKey = null; fs.writeFileSync(settingsPath, JSON.stringify(settings)); }
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  if (browser) await browser.close().catch(() => {});
  if (fixtureBrowser) await fixtureBrowser.close().catch(() => {});
  if (child?.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
}
console.log(JSON.stringify({ report: path.join(root, 'report.json'), passed: report.passed, cases: report.cases.length, errors: report.errors.length }));
assert(report.passed, 'All approved dependency recipes must pass; inspect the sandbox report');
