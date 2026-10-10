import { readFile, writeFile } from "node:fs/promises";

const manifestPath = new URL("./game-profile-research.json", import.meta.url);

const specs = {
  "builtin.cyberpunk2077": {
    folder: "Cyberpunk 2077", executables: ["bin/x64/Cyberpunk2077.exe", "redprelauncher.exe"], engine: "REDengine 4", domain: "cyberpunk2077", nexusId: "3333",
    modTypes: [["archive", "Cyberpunk archive asset", "archive/pc/mod"], ["redscript", "redscript source", "r6/scripts"], ["manager", "Framework and REDmod package handoff", null]],
    loader: ["redscript", "redscript", "engine/tools", "https://github.com/jac3km4/redscript"],
    note: "Direct routing is limited to unambiguous .archive and .reds files. CET, RED4ext, ArchiveXL, TweakXL and REDmod retain their own compatibility/dependency contracts.",
    evidence: ["https://steamdb.info/app/1091500/config/", "https://github.com/maximegmd/CyberEngineTweaks", "https://github.com/WopsS/RED4ext", "https://www.nexusmods.com/cyberpunk2077"],
    unverified: ["GOG and Epic identifiers are read from installed launcher manifests.", "Current framework release compatibility must be resolved at install time."],
  },
  "builtin.outlast-trials": {
    folder: "The Outlast Trials", executables: ["start_protected_game.exe", "OPP/Binaries/Win64/TOTClient.exe"], engine: "Unreal Engine", domain: "theoutlasttrials", nexusId: "5376",
    modTypes: [["pak", "Standard Unreal PAK", "OPP/Content/Paks"], ["manager", "Iris, Janus, Odessa and movie/audio handoff", null]],
    note: "Never modifies Easy Anti-Cheat. BK2 and audio workflows remain manager handoffs with original-file backups.",
    evidence: ["https://steamdb.info/app/1304930/config/", "https://www.nexusmods.com/theoutlasttrials/mods/219", "https://www.nexusmods.com/theoutlasttrials"],
    unverified: ["Exact engine minor version and non-Steam storefront identifiers."],
  },
  "builtin.payday3": {
    folder: "PAYDAY3", executables: ["PAYDAY3.exe", "PAYDAY3/Binaries/Win64/PAYDAY3-Win64-Shipping.exe"], engine: "Unreal Engine 5 family", domain: "payday3", nexusId: "5717", modworkshop: ["payday-3", "853"],
    modTypes: [["pak", "PAK or complete IoStore companion set", "PAYDAY3/Content/Paks"], ["ue4ss", "Current compatible UE4SS folder", "PAYDAY3/Binaries/Win64"]],
    note: "PAK/IoStore companions stay together. No third-party loader is treated as universally required.",
    evidence: ["https://steamdb.info/app/1272080/config/", "https://www.nexusmods.com/payday3", "https://modworkshop.net/game/payday-3"],
    unverified: ["The recommended third-party UE5 loader build remains release-sensitive."],
  },
  "builtin.resident-evil-requiem": {
    folder: "RESIDENT EVIL requiem BIOHAZARD requiem", executables: ["re9.exe"], engine: "RE Engine", domain: "residentevilrequiem", nexusId: "8863",
    modTypes: [["lua", "REFramework Lua", "reframework/autorun"], ["plugin", "REFramework plugin", "reframework/plugins"], ["manager", "Fluffy asset package handoff", null]],
    loader: ["reframework", "REFramework", ".", "https://github.com/praydog/REFramework"],
    note: "RE8 asset paths are never reused. REFramework content requires the root loader; Fluffy packages use the Requiem manager profile.",
    evidence: ["https://steamdb.info/app/3764200/config/", "https://www.nexusmods.com/residentevilrequiem", "https://github.com/praydog/REFramework"],
    unverified: ["Asset replacement paths remain package-specific and manager-owned."],
  },
  "builtin.borderlands3": {
    folder: "Borderlands 3", executables: ["OakGame/Binaries/Win64/Borderlands3.exe"], engine: "Unreal Engine", domain: "borderlands3", nexusId: "2953",
    modTypes: [["hotfix", "OpenHotfixLoader text hotfix", "OakGame/Binaries/Win64/Plugins/ohl-mods"], ["plugin", "Compatible Oak plugin", "OakGame/Binaries/Win64/Plugins"], ["manager", "Oak SDK/Python package handoff", null]],
    loader: ["open-hotfix-loader", "OpenHotfixLoader", "OakGame/Binaries/Win64/Plugins", "https://github.com/apple1417/OpenHotfixLoader"],
    note: "Hotfixes and plugins require their detected loaders. Shared d3d11.dll/PluginLoader is never removed while dependents remain.",
    evidence: ["https://steamdb.info/app/397540/config/", "https://github.com/bl-sdk", "https://github.com/apple1417/OpenHotfixLoader", "https://www.nexusmods.com/borderlands3"],
    unverified: [],
  },
  "builtin.borderlands4": {
    folder: "Borderlands 4", executables: ["OakGame/Binaries/Win64/Borderlands4.exe"], engine: "Unreal Engine", domain: "borderlands4", nexusId: "8148",
    modTypes: [["sdkmod", "Oak2 SDK .sdkmod", "sdk_mods"], ["manager", "Oak2 Python/plugin/content handoff", null]],
    loader: ["oak2-mod-manager", "Oak2 Mod Manager", "OakGame/Binaries/Win64/Plugins", "https://github.com/bl-sdk"],
    note: "Only .sdkmod routing is enabled after the Oak2 SDK marker is found. Proxy/runtime filenames are resolved from the current release.",
    evidence: ["https://steamdb.info/app/1285190/config/", "https://github.com/bl-sdk", "https://www.nexusmods.com/borderlands4"],
    unverified: ["The exact current Oak2 proxy/runtime filename is release-sensitive and is not auto-installed."],
  },
  "builtin.tiny-tinas-wonderlands": {
    folder: "Tiny Tina's Wonderlands", executables: ["OakGame/Binaries/Win64/Wonderlands.exe"], engine: "Unreal Engine", domain: "tinytinaswonderlands", nexusId: "4394",
    modTypes: [["hotfix", "OpenHotfixLoader text hotfix", "OakGame/Binaries/Win64/Plugins/ohl-mods"], ["plugin", "Compatible Oak plugin", "OakGame/Binaries/Win64/Plugins"], ["manager", "Oak SDK/Python package handoff", null]],
    loader: ["open-hotfix-loader", "OpenHotfixLoader", "OakGame/Binaries/Win64/Plugins", "https://github.com/apple1417/OpenHotfixLoader"],
    note: "Wonderlands Redux is never universal. Hotfix/plugin installs require the matching loader markers.",
    evidence: ["https://steamdb.info/app/1286680/config/", "https://github.com/apple1417/OpenHotfixLoader", "https://github.com/bl-sdk", "https://www.nexusmods.com/tinytinaswonderlands"],
    unverified: [],
  },
  "builtin.spider-man-remastered": {
    folder: "Marvel's Spider-Man Remastered", executables: ["Spider-Man.exe"], engine: "Insomniac/Nixxes engine", domain: "marvelsspidermanremastered", nexusId: "4536",
    modTypes: [["overstrike", "Overstrike-supported package handoff", null]],
    loader: ["overstrike", "Overstrike", ".", "https://www.nexusmods.com/marvelsspidermanremastered/mods/4199"],
    note: ".smpcmod, .suit, .stage, .modular and .script are handed to Overstrike; Tsuki does not guess their proprietary activation format.",
    evidence: ["https://steamdb.info/app/1817070/config/", "https://www.nexusmods.com/marvelsspidermanremastered/mods/4199"],
    unverified: ["Overstrike CLI invocation remains an external-manager integration step."],
  },
  "builtin.spider-man-2": {
    folder: "Marvel's Spider-Man 2", executables: ["Spider-Man2.exe", "SpiderMan2.exe"], engine: "Insomniac/Nixxes engine", domain: "marvelsspiderman2", nexusId: "6082",
    modTypes: [["overstrike", "Game-matched Overstrike package handoff", null]],
    loader: ["overstrike", "Overstrike", ".", "https://www.nexusmods.com/marvelsspidermanremastered/mods/4199"],
    note: "Matching extensions do not imply cross-game compatibility. Tsuki preserves the canonical API domain and hands activation to Overstrike.",
    evidence: ["https://steamdb.info/app/2651280/config/", "https://www.nexusmods.com/marvelsspiderman2", "https://www.nexusmods.com/marvelsspidermanremastered/mods/4199"],
    unverified: ["Any pretty browser alias remains separate from the canonical API domain."],
  },
  "builtin.monster-hunter-wilds": {
    folder: "MonsterHunterWilds", executables: ["MonsterHunterWilds.exe"], engine: "RE Engine", domain: "monsterhunterwilds", nexusId: "6993",
    modTypes: [["lua", "REFramework Lua", "reframework/autorun"], ["plugin", "REFramework plugin", "reframework/plugins"], ["manager", "Fluffy or patch-PAK handoff", null]],
    loader: ["reframework", "REFramework", ".", "https://github.com/praydog/REFramework"],
    note: "No DRM or online protection is modified. Fluffy packages and numbered patch PAKs remain blocked until an exact safe manager/slot operation is proven.",
    evidence: ["https://steamdb.info/app/2246340/", "https://github.com/praydog/REFramework", "https://www.nexusmods.com/site/mods/818", "https://www.nexusmods.com/monsterhunterwilds"],
    unverified: ["Custom patch-PAK slot allocation remains disabled."],
  },
};

function verifiedRecord(existing, spec) {
  const evidence = spec.evidence.map((url, index) => ({
    id: `${existing.profileId.replace(/[^a-z0-9]+/gi, "-")}-${index + 1}`,
    type: url.includes("steamdb") ? "store-metadata" : "official-or-primary-project",
    url,
    description: `Research packet evidence for ${existing.displayName}.`,
  }));
  const sources = [{ provider: "nexus", domain: spec.domain, numericGameId: spec.nexusId, gameUrl: `https://www.nexusmods.com/${spec.domain}`, browseModes: ["api", "webview_window", "external"] }];
  if (spec.modworkshop) sources.unshift({ provider: "modworkshop", domain: "modworkshop.net", slug: spec.modworkshop[0], numericGameId: spec.modworkshop[1], gameUrl: `https://modworkshop.net/g/${spec.modworkshop[0]}/mods`, browseModes: ["api", "webview_window", "external"] });
  const knownLoaders = spec.loader ? [{ dependencyId: spec.loader[0], name: spec.loader[1], installRoot: spec.loader[2], sourceUrl: spec.loader[3], installPolicy: "detect-or-external-handoff" }] : [];
  return {
    profileId: existing.profileId,
    displayName: existing.displayName,
    researchStatus: "verified",
    lastVerified: "2026-09-04",
    platforms: { steamAppIds: existing.steamAppIds ?? [], epicCatalogIdentifiers: [] },
    detection: { gameRoots: [{ store: "steam", folderName: spec.folder }], executables: spec.executables.map((path, index) => ({ path, role: index === 0 ? "primary" : "alternate" })), processNames: spec.executables.map((path) => path.split("/").at(-1).replace(/\.exe$/i, "")), minimumMarkers: [spec.executables[0]] },
    engine: { name: spec.engine, version: "patch-dependent", confidence: "research-packet" },
    sources,
    otherMajorSources: [],
    knownLoaders,
    knownFrameworks: [],
    knownModManagers: [],
    knownDependencyFrameworks: knownLoaders.map((loader) => loader.dependencyId),
    modTypes: spec.modTypes.map(([id, name, installRoot]) => ({ id, name, installRoot, packageInspection: "archive-contents-and-relative-paths", safety: spec.note })),
    installRoots: [...new Set(spec.modTypes.map((type) => type[2]).filter(Boolean).concat("."))].map((path) => ({ path, ownership: path === "." ? "shared-game-root" : "receipt-owned-files-only" })),
    enableDisable: { strategy: "move receipt-owned files only", disabledStorage: "profile-scoped", sharedLoaders: "never toggled per mod" },
    loadOrder: { strategy: "authoritative loader/manager semantics only", lexicalFallback: false },
    archiveHandling: { inspectContents: true, supportedContainers: ["zip", "folder", "loose-file"], unsupportedContainers: ["7z", "rar"], rejectTraversal: true },
    updateUninstall: { receiptsRequired: true, backupBeforeOverwrite: true, blockSharedDependencyRemoval: true, revalidateAfterGameUpdate: true },
    validation: { gameRootMarkers: [spec.executables[0]], sourceIdentityFields: ["profileId", "sourceId", "domain", "numericGameId"], directInstallBoundary: spec.note },
    evidence,
    unverified: spec.unverified,
  };
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.games = manifest.games.map((game) => specs[game.profileId] ? verifiedRecord(game, specs[game.profileId]) : game);
manifest.completion = { verified: manifest.games.filter((game) => game.researchStatus === "verified").length, total: manifest.games.length };
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Applied packet records to ${Object.keys(specs).length} profiles.`);
