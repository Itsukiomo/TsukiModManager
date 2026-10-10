import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';

const require = createRequire('C:/Users/jeffe/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/runtime.cjs');
const {chromium} = require('playwright');
const key = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'Tsuki Mod Manager/settings.json'), 'utf8')).nexusApiKey;
assert(key, 'A connected Nexus account is required; credentials are never logged.');
const root = path.resolve('D:/TsukiReleaseQualification/profile-creator-203-' + Date.now());
fs.mkdirSync(root, {recursive: true});
const child = spawn(path.resolve(process.argv[2] ?? 'src-tauri/target/release/tsukimodmanagerapp.exe'), [], {windowsHide: true, stdio: 'ignore', env: {...process.env, APPDATA:path.join(root,'roaming'), LOCALAPPDATA:path.join(root,'local'), WEBVIEW2_USER_DATA_FOLDER:path.join(root,'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9446'}});
let browser, invoke;
const report = {root, checks: [], passed:false};
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
try {
  for (let attempt=0; attempt<60; attempt++) {
    try {browser=await chromium.connectOverCDP('http://127.0.0.1:9446'); break;} catch {await new Promise(resolve=>setTimeout(resolve,1000));}
  }
  assert(browser);
  let page;
  for (let attempt=0; attempt<60; attempt++) {
    page=browser.contexts()[0].pages().find(page=>page.url().includes('tauri.localhost'));
    if(page) break;
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  assert(page);
  await page.waitForFunction(()=>window.__TAURI_INTERNALS__?.invoke);
  invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
  await invoke('save_app_settings',{settings:{...await invoke('get_app_settings'),nexusApiKey:key,autoUpdateChecks:false}});
  const profileId='user.creator-wilds';
  const game=path.join(root,'game');
  fs.mkdirSync(game,{recursive:true});
  fs.writeFileSync(path.join(game,'MonsterHunterWilds.exe'),'SIMULATED GAME - NOT EXECUTABLE');
  fs.writeFileSync(path.join(game,'dinput8.dll'),'SIMULATED LOADER - NOT EXECUTABLE');
  const fields=values=>Object.entries(values).map(([label,value])=>({label,value}));
  const draft={profileId,profileType:'user_custom',overview:{profileTitle:'Creator Wilds validation',gameId:'monster-hunter-wilds'},customTest:{sampleGameRoot:game},customFileTypes:await invoke('get_profile_creator_install_rules',{templateId:'reframework'}),sections:{
    sources:[{id:'creator-nexus',title:'Nexus Mods',enabled:true,fields:fields({'Source Type':'Nexus Mods','Nexus Domain':'monsterhunterwilds','Nexus Game ID':'6993','Browse Mode':'API','Nexus Game Page URL':'https://www.nexusmods.com/monsterhunterwilds'})}],
    dependencies:[{id:'reframework',title:'REFramework',enabled:true,fields:fields({'Marker Filenames':'dinput8.dll'})}],
  }};
  await invoke('save_game_profile_draft',{profileId,draft});
  await invoke('save_profile_settings',{profileId,settings:{...await invoke('get_profile_settings',{profileId}),gameRootOverride:game}});
  await invoke('open_game_profile_draft_runtime',{profileId,draft});
  const detail=await invoke('fetch_nexus_mod_detail',{profileId,modId:'5102',gameDomain:'6993'});
  assert.equal(detail.gameId,'monsterhunterwilds');
  const file=detail.files.find(file=>file.id==='25407');
  assert(file,'Previously validated source file is unavailable');
  const staged=await invoke('stage_source_file_download',{profileId,source:'nexus',modId:'5102',fileId:file.id,fileName:file.name,downloadUrl:null,modName:detail.name,description:detail.description,gameDomain:'6993',installDependencies:false});
  assert(path.resolve(staged.stagedFilePath).startsWith(root+path.sep));
  assert(staged.canInstallLater,JSON.stringify(staged.warnings));
  const args={profileId,source:'nexus',modId:'5102',fileId:file.id,stagedFilePath:staged.stagedFilePath,modName:detail.name,description:detail.description,replaceFileNames:[],sourceFileName:file.name,sourceFileCategory:'main',sourceFileUploadedAt:file.uploadedAt,sourceFileVersion:file.version,pageUrl:detail.pageUrl};
  const first=await invoke('install_staged_file_to_game',args);
  let receipt=JSON.parse(fs.readFileSync(first.receiptPath,'utf8'));
  assert(receipt.files.some(file=>file.relativePath.replaceAll('\\','/').endsWith('/reframework/autorun/ArtianReroll.lua')));
  assert(receipt.files.some(file=>file.relativePath.replaceAll('\\','/').endsWith('/reframework/plugins/ArtianRerollRng.dll')));
  assert.equal(receipt.sourceFileId,file.id);
  assert.equal(receipt.sourceFileUploadedAt,file.uploadedAt);
  await invoke('set_source_install_enabled',{profileId,source:'nexus',sourceId:'5102',receiptId:receipt.id,enabled:false});
  assert(receipt.files.every(file=>!fs.existsSync(file.relativePath)));
  await invoke('set_local_win64_matched_files_enabled',{profileId,filePaths:receipt.files.map(file=>file.relativePath),enabled:true});
  assert(receipt.files.every(file=>digest(file.relativePath)===file.sha256));
  const second=await invoke('install_staged_file_to_game',{...args,replaceFileNames:receipt.files.map(file=>file.relativePath),replaceReceiptId:receipt.id});
  receipt=JSON.parse(fs.readFileSync(second.receiptPath,'utf8'));
  assert(receipt.files.every(file=>digest(file.relativePath)===file.sha256));
  assert(second.warnings.some(warning=>warning.includes('recovery receipt')));
  await invoke('update_install_receipt_metadata',{profileId,update:{receiptId:receipt.id,displayName:'Creator edited fixture',notes:'Actual packaged app validation'}});
  assert.equal(JSON.parse(fs.readFileSync(second.receiptPath,'utf8')).displayName,'Creator edited fixture');
  const logo=fs.readFileSync('src/assets/tsuki-lunar-logo-v2-ui.png');
  const thumbnail=await invoke('save_custom_receipt_thumbnail',{profileId,receiptId:receipt.id,fileName:'logo.png',bytes:[...logo]});
  assert((await invoke('load_managed_thumbnail_data_url',{path:thumbnail.path})).startsWith('data:image/png;base64,'));
  await invoke('uninstall_source_install',{profileId,source:'nexus',sourceId:'5102'});
  assert(receipt.files.every(file=>!fs.existsSync(file.relativePath)));
  report.checks.push('saved Creator source resolves numeric Nexus game ID','real archive downloaded through packaged app','shared Lua and DLL routes install to autorun/plugins','source file identity/date persisted','disable/restore hashes match','receipt-backed replacement keeps recovery copy','metadata edit and managed thumbnail round trip','uninstall removes current receipt-owned files');
  report.passed=true;
} catch(error) {
  report.error=String(error.stack??error).replace(/https?:\/\/\S+/g,'[URL]');console.error(report.error);process.exitCode=1;
} finally {
  if(invoke) {try {await invoke('save_app_settings',{settings:{...await invoke('get_app_settings'),nexusApiKey:null}});} catch {}}
  const settingsFile=path.join(root,'roaming','Tsuki Mod Manager','settings.json');
  if(fs.existsSync(settingsFile)) {const settings=JSON.parse(fs.readFileSync(settingsFile,'utf8'));settings.nexusApiKey=null;fs.writeFileSync(settingsFile,JSON.stringify(settings));}
  if(browser) await browser.close();
  if(child.pid) spawnSync('powershell',['-NoProfile','-Command',`Stop-Process -Id ${child.pid} -ErrorAction SilentlyContinue`],{windowsHide:true});
  fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}
