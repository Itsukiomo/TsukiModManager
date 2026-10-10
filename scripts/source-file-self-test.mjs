import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync("src/pages/Browse/BrowsePage.tsx", "utf8");
const ast = ts.createSourceFile("BrowsePage.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ["newestFiles", "isImageAssetFile", "isGenericModWorkshopPlaceholder", "fileHasRouteHint", "filterModWorkshopFileChoices", "isInstallableSourceFile", "installableFiles", "sourceFileDateValue", "fileVersionScore", "compareSourceFilesNewest", "normalizedFileSeries", "sourceFileKind", "groupedSourceFiles", "defaultSelectedFileIds"];
const selected = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
assert.equal(selected.length, names.length);
const js = ts.transpileModule(selected.map((node) => node.getText(ast)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const context = vm.createContext({});
vm.runInContext(js, context);
const old = { id: "10", name: "Example.zip", uploadedAt: "2025-01-01T00:00:00Z", version: "1.0" };
const latest = { ...old, id: "11", uploadedAt: "2026-10-09T10:00:00Z", version: "2.0" };
assert.equal(context.installableFiles([old, latest], "modworkshop")[0].id, "11");
assert.equal(context.defaultSelectedFileIds([old, latest], "modworkshop")[0], "11");
const placeholder = { id: "latest", name: "Latest ModWorkshop file", downloadUrl: "https://api.modworkshop.net/mods/12/files/latest/download" };
assert.equal(context.filterModWorkshopFileChoices([placeholder]).length, 1);
assert.equal(context.filterModWorkshopFileChoices([{ ...placeholder, downloadUrl: undefined }]).length, 0);
const optional = { ...latest, id: "12", uploadedAt: "2026-10-09T11:00:00Z", fileType: "OPTIONAL" };
assert.equal(context.defaultSelectedFileIds([{ ...old, fileType: "OLD_VERSION" }, { ...latest, fileType: "MAIN" }, optional], "nexus")[0], "11");
assert.equal(context.newestFiles([{ ...old, uploadedAt: "999999999" }, { ...latest, uploadedAt: "1000000000" }])[0].id, "11");
assert(source.includes('!selectedMatch?.installed ? { key: "install"'));
const cleanModsNode = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "cleanMods");
assert(cleanModsNode);
const cleanerContext = vm.createContext({
  sourceShouldShowInTsukiBrowser: () => true,
  normalizeNexusId: (value) => value ?? null,
  displayAuthor: (mod) => mod.author,
  rememberSourceAuthor: () => {},
  displayModTitle: (mod) => mod.name,
});
vm.runInContext(ts.transpileModule(cleanModsNode.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, cleanerContext);
assert.equal(cleanerContext.cleanMods([{ source: "modworkshop", sourceId: "59443", name: "SimpleHUD", gameId: "payday-3", tags: ["UE4SS"] }])[0].gameId, "payday-3");
assert(source.includes('onClick: () => { setInstallPickerReplacementFiles([]); setSelectedFileIds'));
console.log("Source file selection: latest dates, MAIN categories, optional files, valid latest endpoints and multi-file Install action passed.");
