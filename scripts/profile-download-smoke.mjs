import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const modules = new Map();
function load(file) {
  file = path.resolve(file);
  if (modules.has(file)) return modules.get(file);
  const module = { exports: {} };
  modules.set(file, module.exports);
  const js = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const require = (name) => {
    if (/\.(png|jpg)$/.test(name)) return name;
    if (name.endsWith("profileArtwork")) return { profileImageReferenceFromValue: () => null };
    return load(path.resolve(path.dirname(file), `${name}.ts`));
  };
  vm.runInNewContext(js, { module, exports: module.exports, require }, { filename: file });
  modules.set(file, module.exports);
  return module.exports;
}

const { BUILTIN_GAME_PROFILES } = load("src/models/gameProfiles.ts");
const root = path.resolve("src-tauri/target/profile-smoke", new Date().toISOString().replace(/[:.]/g, "-"));
fs.mkdirSync(root, { recursive: true });
const profiles = BUILTIN_GAME_PROFILES.map((profile) => ({
  profileId: profile.profileId,
  displayName: profile.displayName,
  sources: profile.sourceConfig.sources.filter((source) => source.browseMode === "api"),
}));
const payday3 = profiles.find((profile) => profile.profileId === "builtin.payday3");
const workshop = payday3.sources.find((source) => source.provider === "modworkshop");
workshop.gameVersion = "UE5.5";
const paydayIndex = path.join(process.env.APPDATA, "Tsuki Mod Manager/profile-data/builtin.payday3/source-index/source-index.json");
if (fs.existsSync(paydayIndex)) {
  const catalog = JSON.parse(fs.readFileSync(paydayIndex, "utf8"));
  const nexus = payday3.sources.find(source => source.provider === "nexus");
  nexus.candidateModIds = Object.values(catalog.records).filter(record => record.source === "nexus").map(record => record.sourceId).sort((a,b)=>Number(b)-Number(a));
}
const requested = process.argv.slice(2);
const selected = requested.length ? profiles.filter((profile) => requested.includes(profile.profileId)) : profiles;
fs.writeFileSync(path.join(root, "profiles.json"), JSON.stringify(selected, null, 2));
console.log(`Isolated game simulation: ${root}`);
const result = spawnSync("cargo", ["test", "--lib", "live_profile_download_sandbox", "--", "--ignored", "--nocapture", "--test-threads=1"], {
  cwd: "src-tauri", stdio: "inherit", env: { ...process.env, TSUKI_PROFILE_TEST_ROOT: root },
});
console.log(`Download and routing report: ${path.join(root, "report.json")}`);
process.exitCode = result.status ?? 1;
