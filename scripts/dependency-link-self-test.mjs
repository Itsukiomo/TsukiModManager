import assert from "node:assert/strict";
import fs from "node:fs";

const catalog = JSON.parse(fs.readFileSync(new URL("../src/data/dependencies.json", import.meta.url), "utf8"));
const frontend = fs.readFileSync(new URL("../src/models/dependency.ts", import.meta.url), "utf8");
const backend = fs.readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");

const primaryUrl = (dep) => {
  const source = dep.preferredSource ?? dep.sourceKind;
  if (source === "nexus" && dep.nexus) return `https://www.nexusmods.com/${dep.nexus.gameDomain}/mods/${dep.nexus.modId}`;
  if (source === "modworkshop" && dep.modworkshop) return `https://modworkshop.net/mod/${dep.modworkshop.modId}`;
  if (source === "github" && dep.github) return `https://github.com/${dep.github.owner}/${dep.github.repo}`;
  if (source === "official") return dep.official?.canonicalUrl ?? null;
  if (source === "external") return dep.external?.canonicalUrl ?? null;
  return null;
};

const byId = new Map(catalog.map((dep) => [dep.id, dep]));
assert.equal(byId.size, catalog.length, "dependency IDs must be unique");
for (const dep of catalog) {
  assert.ok(dep.id && dep.name && Array.isArray(dep.games), `invalid dependency record: ${dep.id}`);
  assert.ok(primaryUrl(dep) || dep.sourceUnverified, `${dep.name} must have a usable primary source or sourceUnverified=true`);
  for (const requiredId of dep.requires ?? []) assert.ok(byId.has(requiredId), `${dep.name} references missing dependency ${requiredId}`);
  assert.equal(Boolean(dep.automaticInstallSafe && !dep.installableByTsuki), false, `${dep.name} cannot be automatic-install safe without a Tsuki installer`);
}

const expectUrl = (id, expected) => assert.equal(primaryUrl(byId.get(id)), expected, id);
expectUrl("cyberpunk-archivexl", "https://www.nexusmods.com/cyberpunk2077/mods/4198");
expectUrl("outlast-iris", "https://www.nexusmods.com/theoutlasttrials/mods/219");
expectUrl("pdth-dahm", "https://modworkshop.net/mod/14267");
expectUrl("pd2-beardlib", "https://modworkshop.net/mod/14924");
expectUrl("pd3-logic-mod-loader", "https://modworkshop.net/mod/44049");
expectUrl("re-fluffy-mod-manager", "https://www.nexusmods.com/site/mods/818");
expectUrl("spiderman-overstrike-remastered", "https://www.nexusmods.com/marvelsspidermanremastered/mods/4199");
expectUrl("mhw-catlib", "https://www.nexusmods.com/monsterhunterwilds/mods/65");
assert.notEqual(primaryUrl(byId.get("spiderman-overstrike-remastered")), "https://www.nexusmods.com/marvelsspiderman2/mods/4199");

const clickCoverage = {
  "builtin.cyberpunk2077": "cyberpunk-red4ext",
  "builtin.outlast-trials": "outlast-iris",
  "builtin.payday-the-heist": "pdth-dahm",
  "builtin.payday2": "pd2-beardlib",
  "builtin.payday3": "pd3-logic-mod-loader",
  "builtin.resident-evil-7": "re-reframework",
  "builtin.resident-evil-village": "re-fluffy-mod-manager",
  "builtin.resident-evil-requiem": "re-reframework",
  "builtin.borderlands": "borderlands-willow1-classic",
  "builtin.borderlands2": "borderlands2-willow2",
  "builtin.borderlands3": "borderlands-open-hotfix-loader",
  "builtin.borderlands4": "borderlands4-oak2",
  "builtin.tiny-tinas-wonderlands": "borderlands-open-hotfix-loader",
  "builtin.spider-man-remastered": "spiderman-overstrike-remastered",
  "builtin.spider-man-2": "spiderman-overstrike-remastered",
  "builtin.monster-hunter-wilds": "mhw-catlib",
};
for (const [profileId, dependencyId] of Object.entries(clickCoverage)) {
  const dep = byId.get(dependencyId);
  assert.ok(dep?.games.includes(profileId), `${dependencyId} must be attached to ${profileId}`);
  assert.ok(primaryUrl(dep), `${dependencyId} click target must resolve`);
}

assert.match(frontend, /getDependencyPrimaryUrl/);
assert.match(frontend, /buildDependencyGraph/);
assert.match(frontend, /migrateDependencyNames/);
assert.match(backend, /source_dependencies_from_value/);
assert.match(backend, /modworkshop_dependencies_from_html/);
console.log(`Dependency link self-test passed: ${catalog.length} catalog records, ${Object.keys(clickCoverage).length} profile click targets.`);
