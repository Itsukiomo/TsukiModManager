import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function importTypeScript(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  const source = fs.readFileSync(absolutePath, "utf8");
  let output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
    fileName: absolutePath,
  }).outputText;
  output = output.replace('from "dompurify"', `from ${JSON.stringify(import.meta.resolve("dompurify"))}`);

  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

function createStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    clear() {
      values.clear();
    },
  };
}

globalThis.window = {
  localStorage: createStorage(),
  location: { href: "https://tsuki.local/" },
};
delete globalThis.document;

const authorCache = await importTypeScript("src/utils/sourceAuthorCache.ts");
const categoryCache = await importTypeScript("src/utils/modWorkshopCategoryCache.ts");
const installedThumbnail = await importTypeScript("src/utils/installedThumbnail.ts");
const richHtml = await importTypeScript("src/utils/richHtmlSanitizer.ts");
const profileSources = await importTypeScript("src/models/profileSources.ts");
const builtinProfileSources = await importTypeScript("src/models/builtinProfileSources.ts");

{
  const classic = builtinProfileSources.createNexusSourcePair({
    idPrefix: "borderlands",
    gameName: "Borderlands Game of the Year",
    domain: "borderlands",
    numericGameId: "360",
    labelSuffix: "Classic",
  });
  const enhanced = builtinProfileSources.createNexusSourcePair({
    idPrefix: "borderlands-enhanced",
    gameName: "Borderlands Game of the Year Enhanced",
    domain: "borderlandsgotyenhanced",
    numericGameId: "2776",
    labelSuffix: "Enhanced",
  });
  const borderlands2 = builtinProfileSources.createNexusSourcePair({
    idPrefix: "borderlands2",
    gameName: "Borderlands 2",
    domain: "borderlands2",
    numericGameId: "428",
  });

  assert.deepEqual(classic.map((source) => source.id), ["borderlands-nexus-api", "borderlands-nexus-browser"]);
  assert.deepEqual(enhanced.map((source) => source.providerSlug), ["borderlandsgotyenhanced", "borderlandsgotyenhanced"]);
  assert.deepEqual(enhanced.map((source) => source.providerGameId), ["2776", "2776"]);
  assert.deepEqual(borderlands2.map((source) => source.providerSlug), ["borderlands2", "borderlands2"]);
  assert.deepEqual(borderlands2.map((source) => source.providerGameId), ["428", "428"]);
  assert.equal(new Set([...classic, ...enhanced].map((source) => source.id)).size, 4);
}

{
  const modworkshop = builtinProfileSources.createModWorkshopSourcePair({
    idPrefix: "payday2",
    gameName: "PAYDAY 2",
    slug: "payday-2",
    numericGameId: "1",
  });
  assert.deepEqual(modworkshop.map((source) => source.id), ["payday2-modworkshop-api", "payday2-modworkshop-browser"]);
  assert(modworkshop.every((source) => source.providerSlug === "payday-2" && source.providerGameId === "1"));
  assert.equal(modworkshop[1].browseMode, "webview_window");
}

{
  const configured = profileSources.profileSourcesFromConfig({
    sources: [
      { id: "source-payday2-modworkshop-api", displayName: "ModWorkshop", provider: "modworkshop", enabled: true, browseMode: "api", gameName: "PAYDAY 2", providerSlug: "payday-2", providerGameId: "1", gamePageUrl: "https://modworkshop.net/g/payday-2/mods", startUrl: "https://modworkshop.net/g/payday-2/mods", allowedDomains: ["modworkshop.net"], captureDownloads: true },
      { id: "source-payday2-nexus-api", displayName: "Nexus Mods", provider: "nexus", enabled: true, browseMode: "api", gameName: "PAYDAY 2", providerSlug: "payday2", providerGameId: "648", gamePageUrl: "https://www.nexusmods.com/payday2", startUrl: "https://www.nexusmods.com/payday2/mods", allowedDomains: ["nexusmods.com"], captureDownloads: true },
      { id: "source-payday2-modworkshop-browser", displayName: "ModWorkshop Browser", provider: "modworkshop", enabled: true, browseMode: "webview_window", gameName: "PAYDAY 2", providerSlug: "payday-2", providerGameId: "1", gamePageUrl: "https://modworkshop.net/g/payday-2/mods", startUrl: "https://modworkshop.net/g/payday-2/mods", allowedDomains: ["modworkshop.net"], captureDownloads: true },
      { id: "source-payday2-nexus-browser", displayName: "Nexus Browser", provider: "nexus", enabled: true, browseMode: "webview_window", gameName: "PAYDAY 2", providerSlug: "payday2", providerGameId: "648", gamePageUrl: "https://www.nexusmods.com/payday2", startUrl: "https://www.nexusmods.com/payday2/mods", allowedDomains: ["nexusmods.com"], captureDownloads: true },
    ],
  }, "PAYDAY 2");
  assert.equal(configured.length, 4, "all four source instances must survive normalization");
  assert.equal(new Set(configured.map((source) => source.id)).size, 4, "source IDs must remain unique");
  assert.deepEqual(configured.map((source) => source.displayName), ["ModWorkshop", "Nexus Mods", "ModWorkshop Browser", "Nexus Browser"]);
  assert.equal(configured.filter((source) => source.provider === "nexus").length, 2, "two Nexus sources must not overwrite each other");
  assert.equal(configured.filter((source) => source.provider === "modworkshop").length, 2, "two ModWorkshop sources must not overwrite each other");
  assert.equal(configured[1].gameName, "PAYDAY 2");
  assert.equal(configured[1].providerSlug, "payday2");
  assert.equal(configured[1].gamePageUrl, "https://www.nexusmods.com/payday2");
  assert.notEqual(
    profileSources.profileSourceCacheIdentity("draft.payday2", configured[1]),
    profileSources.profileSourceCacheIdentity("builtin.payday3", { ...configured[1], id: "source-payday3-nexus-api", providerSlug: "payday3", providerGameId: "2670" }),
    "PAYDAY 2 Nexus cache identity must never match PAYDAY 3",
  );

  const spacedNames = profileSources.profileSourcesFromConfig({ sources: [
    { ...configured[1], id: "source-ron", gameName: "Ready or Not", providerSlug: "readyornot" },
    { ...configured[1], id: "source-outlast", gameName: "The Outlast Trials", providerSlug: "theoutlasttrials" },
  ] }, "Fallback");
  assert.equal(spacedNames[0].gameName, "Ready or Not");
  assert.equal(spacedNames[1].gameName, "The Outlast Trials");
}

{
  const mod = {
    source: "modworkshop",
    sourceId: "123",
    name: "HUD Icons by Actual Author",
    author: "853",
    authorUsername: "actual_author",
    authorUserId: "77",
    authorProfileUrl: "https://modworkshop.net/user/77",
    authorAvatarUrl: "https://storage.modworkshop.net/users/images/thumbnail_avatar.webp",
  };

  assert.equal(authorCache.displaySourceAuthor(mod), "actual_author");
  assert.equal(authorCache.displaySourceTitle({ ...mod, author: "Actual Author" }), "HUD Icons");

  authorCache.rememberSourceAuthorMetadata(mod);
  const hydrated = authorCache.applyKnownSourceAuthor({
    source: "modworkshop",
    sourceId: "other-mod",
    name: "Another HUD",
    author: null,
    authorUsername: null,
    authorUserId: "77",
    authorProfileUrl: null,
    authorAvatarUrl: null,
  });

  assert.equal(hydrated.author, "actual_author");
  assert.equal(hydrated.authorProfileUrl, "https://modworkshop.net/user/77");
}

{
  const payday3Key = categoryCache.modWorkshopCategoryCacheKey("builtin.payday3", "payday-3");
  const payday2Key = categoryCache.modWorkshopCategoryCacheKey("draft.payday2", "payday-2");
  assert.notEqual(payday3Key, payday2Key);

  categoryCache.writeModWorkshopCategoryCache("draft.payday2", "payday-2", [{ id: "5", label: "Audio" }]);
  assert.deepEqual(categoryCache.readModWorkshopCategoryCache("draft.payday2", "payday-2"), [{ id: "5", label: "Audio" }]);

  window.localStorage.setItem(payday2Key, JSON.stringify({
    version: categoryCache.CATEGORY_CACHE_VERSION,
    savedAt: Date.now() - categoryCache.CATEGORY_CACHE_TTL_MS - 1,
    categories: [{ id: "7", label: "HUD" }],
  }));
  const staleEntry = categoryCache.readModWorkshopCategoryCacheEntry("draft.payday2", "payday-2");
  assert.equal(staleEntry?.stale, true);
  assert.deepEqual(staleEntry?.categories, [{ id: "7", label: "HUD" }]);
}

{
  assert.equal(installedThumbnail.resolveInstalledThumbnailUrl({
    receiptThumbnail: "  https://receipt.example/thumb.webp  ",
    exactSourceThumbnail: "https://source.example/thumb.webp",
  }), "https://receipt.example/thumb.webp");
  assert.equal(installedThumbnail.resolveInstalledThumbnailUrl({
    receiptThumbnail: "",
    exactSourceThumbnail: "https://source.example/thumb.webp",
    manualThumbnail: "https://manual.example/thumb.webp",
  }), "https://source.example/thumb.webp");
  assert.equal(installedThumbnail.resolveInstalledThumbnailUrl({
    manualThumbnail: "https://manual.example/thumb.webp",
    cachedSourceThumbnail: "https://cache.example/thumb.webp",
  }), "https://manual.example/thumb.webp");
  assert.equal(installedThumbnail.installedSourceFallbackLabel("modworkshop"), "MW");
  assert.equal(installedThumbnail.installedSourceFallbackLabel("nexus"), "NX");
  assert.equal(installedThumbnail.installedSourceFallbackLabel("local", "Bigger Lobbies"), "BI");
}

{
  const sanitized = richHtml.sanitizeRichHtml(
    "<p>Hello s=\"leaked\" crossorigin nonce=\"abc\">ok</p><script>alert(1)</script><iframe src=\"https://bad.example\"></iframe><img src=\"javascript:alert(1)\" onerror=\"boom\">",
  );
  assert(!/script|iframe|onerror|javascript:|nonce|crossorigin|s="leaked"/i.test(sanitized), sanitized);
  assert(sanitized.includes("Hello") && sanitized.includes("ok"));
}

{
  const unifiedSource = fs.readFileSync(path.join(repoRoot, "src/components/UnifiedModPage.tsx"), "utf8");
  const baseInfoBlock = unifiedSource.match(/const baseInfoItems[\s\S]*?const developerItems/)?.[0] ?? "";
  assert(!baseInfoBlock.includes("Source ID"), "Source ID should not be shown in primary metadata");
  assert(unifiedSource.includes("ArrowLeft") && unifiedSource.includes("ArrowRight"), "Tab keyboard navigation should support arrow keys");
  assert(unifiedSource.includes("pageIdentityRef"), "Tab state should reset only when the detail page identity changes");
}

{
  const rustSource = fs.readFileSync(path.join(repoRoot, "src-tauri/src/lib.rs"), "utf8");
  assert(rustSource.includes(".plugin(tauri_plugin_dialog::init())"), "Tauri dialog plugin must be registered for native pickers");
  assert(rustSource.includes("open_embedded_browser_window"), "Tauri should expose a native embedded browser window command");
  assert(rustSource.includes("customBrowserSources"), "Draft source config must preserve custom browser mappings");
  assert(rustSource.includes("customBrowserStartUrl"), "Draft source config must preserve custom browser start URLs");
  assert(rustSource.includes("sourceConfigMigrationVersion"), "Draft source config migration should be marked");
  assert(rustSource.includes("nexusGamePageUrl"), "Draft source config must preserve Nexus full game URLs");
  assert(rustSource.includes("modworkshopGamePageUrl"), "Draft source config must preserve ModWorkshop full game URLs");
  assert(rustSource.includes("fetch_nexus_mods_page_for_domain"), "Nexus browsing must use a profile-specific domain");
  assert(!rustSource.includes("if !is_builtin_payday3_profile(profile_id.as_deref()) {\r\n        return Ok(Vec::new());\r\n    }\r\n\r\n    tauri::async_runtime::spawn_blocking(move || fetch_source_mods_page_sync"), "Source Browse must not silently disable non-PAYDAY 3 profiles");
}

{
  const creatorSource = fs.readFileSync(path.join(repoRoot, "src/pages/ProfileCreator/ProfileCreatorPage.tsx"), "utf8");
  assert(creatorSource.includes('extensions: ["png", "jpg", "jpeg", "webp"]'), "Profile artwork chooser should only accept supported image formats");
  assert(creatorSource.includes("tsuki-profile-creator-picker-error"), "Profile Creator picker failures should surface in the UI");
  assert(creatorSource.includes("chooseDestinationFolder?.(index)"), "Folder mapping Browse must update the edited row");
  assert(creatorSource.includes('"Human Game Name"'), "Source editor must keep human game names separate from slugs");
  assert(creatorSource.includes('"Nexus Game Page URL"'), "Source editor must accept a full Nexus game page URL");
  assert(creatorSource.includes('"ModWorkshop Game Page URL"'), "Source editor must accept a full ModWorkshop game page URL");
  assert(creatorSource.includes("parseNexusGameUrl"), "Source editor must parse Nexus URLs safely");
  assert(creatorSource.includes("parseModWorkshopGameUrl"), "Source editor must parse ModWorkshop URLs safely");
}

{
  const appSource = fs.readFileSync(path.join(repoRoot, "src/App.tsx"), "utf8");
  const settingsSource = fs.readFileSync(path.join(repoRoot, "src/pages/Settings/SettingsPage.tsx"), "utf8");
  assert(appSource.includes("previousSettingsPageRef"), "App should remember the page that opened Settings");
  assert(!appSource.includes("payday2Draft?.profileId"), "Custom PAYDAY 2 drafts must not be hidden behind the official profile");
  assert(settingsSource.includes("onBack?: () => void"), "Settings should accept a generic back handler");
  assert(settingsSource.includes("{onBack && <Button onClick={onBack}>Back</Button>}"), "Settings header should render the Back button");
}

{
  const browseSource = fs.readFileSync(path.join(repoRoot, "src/pages/Browse/BrowsePage.tsx"), "utf8");
  assert(browseSource.includes('type BrowseTab = ModSourceKind | "custom"'), "Browse should expose a custom browser tab");
  assert(browseSource.includes("embedded-browser-panel"), "Browse should render an embedded custom browser panel");
  assert(browseSource.includes('"open_embedded_browser_window"'), "Browse should call the native embedded browser command");
  assert(browseSource.includes("browserUrlAllowed"), "Custom browser URLs should be checked against allowed domains");
  assert(browseSource.includes("parseNexusDomainFromUrl"), "Browse should derive Nexus domains from full URLs");
  assert(browseSource.includes("parseModWorkshopSlugFromUrl"), "Browse should derive ModWorkshop slugs from full URLs");
  assert(browseSource.includes("openActiveSourceEmbeddedWindow"), "Browse should expose embedded windows for configured source URLs");
  assert(browseSource.includes("configuredSources.map"), "Browse tabs should render every configured source instance");
  assert(browseSource.includes("key={source.id}"), "Browse tabs should be keyed by exact source ID");
  assert(!browseSource.includes("Cache cannot decide page order or membership"), "Browse should surface the real live source error");
}

{
  const homeSource = fs.readFileSync(path.join(repoRoot, "src/pages/Home/HomePage.tsx"), "utf8");
  assert(homeSource.includes("profileSourcesFromConfig(runtimeSourceConfig"), "Home must normalize exact configured source instances");
  assert(homeSource.includes("sourceId: homeNexusSource.id"), "Home Nexus loads must pass the exact source ID");
  assert(homeSource.includes("sourceId: homeModWorkshopSource.id"), "Home ModWorkshop loads must pass the exact source ID");
}

{
  const artworkSource = fs.readFileSync(path.join(repoRoot, "src/components/ProfileArtwork.tsx"), "utf8");
  assert(artworkSource.includes("convertFileSrc"), "Profile artwork preview should convert managed local paths to Tauri asset URLs");
  assert(artworkSource.includes('"resolve_profile_artwork_image_src"'), "Managed artwork should have a secure backend rendering path");
  const imageReference = { kind: "managed_local", value: "C:\\Users\\tester\\AppData\\Roaming\\Tsuki Mod Manager\\profile-data\\draft.payday2\\artwork\\cover.png", updatedAt: "2026-08-22T00:00:00Z" };
  const restoredDraft = JSON.parse(JSON.stringify({ artwork: { imageUrl: imageReference.value, imageReference } }));
  assert.deepEqual(restoredDraft.artwork.imageReference, imageReference, "draft reload must preserve managed profile image metadata");
  const tauriConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, "src-tauri/tauri.conf.json"), "utf8"));
  assert.equal(tauriConfig.app.security.assetProtocol.enable, true, "managed artwork requires Tauri's asset protocol");
  assert(tauriConfig.app.security.assetProtocol.scope.some((entry) => entry.includes("profile-data")), "asset scope must include managed profile artwork");
}

{
  const selectorSource = fs.readFileSync(path.join(repoRoot, "src/pages/GameSelector/GameSelectorPage.tsx"), "utf8");
  assert(selectorSource.includes("repairMojibakeText"), "Game selector should repair mojibake labels before display");
}

console.log("Profile workflow frontend regression self-test passed.");
