import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

async function load(file) {
  const output = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

const sources = await load("src/models/profileSources.ts");
const settings = await load("src/models/profileSettings.ts");
const source = { id: "pd3", displayName: "PAYDAY 3", provider: "modworkshop", enabled: true, browseMode: "api", providerSlug: "payday-3", providerGameId: "853", gameVersion: "UE5.5", allowedDomains: ["modworkshop.net"], captureDownloads: true };
const normalized = sources.profileSourcesFromConfig({ sources: [source] }, "PAYDAY 3")[0];
assert.equal(normalized.gameVersion, "UE5.5");
assert.notEqual(sources.profileSourceCacheIdentity("builtin.payday3", normalized), sources.profileSourceCacheIdentity("builtin.payday3", { ...normalized, gameVersion: "UE4.27" }));
const saved = settings.normalizeProfileSettings({ gameVersion: " UE4.27 " }, "builtin.payday3");
assert.equal(saved.gameVersion, "UE4.27");
assert.equal(settings.normalizeProfileSettings(JSON.parse(JSON.stringify(saved)), "builtin.payday3").gameVersion, "UE4.27");
assert.notEqual(sources.profileBrowseSessionIdentity("builtin.payday3", "UE5.5", {}), sources.profileBrowseSessionIdentity("builtin.payday3", "UE4.27", {}));
assert.notEqual(sources.profileBrowseSessionIdentity("builtin.payday3", "UE5.5", { sources: [source] }), sources.profileBrowseSessionIdentity("builtin.payday3", "UE5.5", { sources: [{ ...source, providerGameId: "1" }] }));
assert(sources.modWorkshopCardMatchesSource("853", ["UE4SS"], source, "payday-3"));
assert(!sources.modWorkshopCardMatchesSource("1", ["UE4.27"], { ...source, gameVersion: "UE4.27" }, "853"));
assert(!sources.modWorkshopCardMatchesSource(null, [], source, "853"));
assert(!sources.modWorkshopCardMatchesSource("853", ["UE4.27"], source, "853"));
assert(sources.modWorkshopCardMatchesSource("853", ["UE4.27"], { ...source, gameVersion: "UE4.27" }, "853"));
assert.equal(sources.canonicalModWorkshopRoute("2"), "pdth");
console.log("Profile version persistence and cache isolation tests passed.");
