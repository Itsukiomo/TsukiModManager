use super::*;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Component;
#[cfg(test)]
#[path = "profile_download_smoke.rs"]
mod profile_download_smoke;

const MAX_UNIVERSAL_FILE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_UNIVERSAL_INSTALL_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct ProfileFileTypeRule {
    id: String,
    name: String,
    kind: String,
    extension: String,
    extensions: Vec<String>,
    filename_pattern: String,
    folder_marker: String,
    exact_filenames: Vec<String>,
    folder_markers: Vec<String>,
    file_match_mode: String,
    custom_match_rule: String,
    destination: String,
    preserve_structure: bool,
    flatten_wrapper: bool,
    required_dependency: String,
    conflict_policy: String,
    priority: i64,
    confidence: i64,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct ProfileCustomPath {
    id: String,
    base_root: String,
    relative_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DragDropMatchCandidate {
    source: String,
    source_id: String,
    file_id: Option<String>,
    game_id: Option<String>,
    mod_name: String,
    file_name: String,
    version: Option<String>,
    author: Option<String>,
    thumbnail_url: Option<String>,
    page_url: Option<String>,
    sha256: Option<String>,
    confidence: u32,
    confidence_level: String,
    match_kind: String,
    reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DragDropAnalysisItem {
    id: String,
    dropped_path: String,
    display_name: String,
    archive_kind: String,
    profile_id: String,
    game_id: String,
    original_sha256: Option<String>,
    entries: Vec<ArchiveInspectEntry>,
    match_candidates: Vec<DragDropMatchCandidate>,
    suggested_match: Option<DragDropMatchCandidate>,
    confidence_level: String,
    suggested_install_target: Option<String>,
    destination_preview: Vec<String>,
    warnings: Vec<String>,
    conflict_count: usize,
    requires_overwrite_confirmation: bool,
    conflict_summary: Vec<String>,
    blocked: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DragDropAnalysisResult {
    profile_id: String,
    game_id: String,
    items: Vec<DragDropAnalysisItem>,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DragDropInstallRequest {
    item: DragDropAnalysisItem,
    selected_match: Option<DragDropMatchCandidate>,
    install_as_local: bool,
    display_name: String,
    version_override: Option<String>,
    thumbnail_override: Option<String>,
    notes: Option<String>,
    #[serde(default)]
    allow_overwrite: bool,
}

#[derive(Debug, Clone)]
struct ProfileInstallContext {
    profile_id: String,
    game_id: String,
    game_root: PathBuf,
    executable_dir: PathBuf,
    draft: serde_json::Value,
    rules: Vec<ProfileFileTypeRule>,
}

pub(super) fn indexed_game_root(profile_id: &str) -> Result<PathBuf, String> {
    Ok(load_profile_context(profile_id)?.game_root)
}

#[derive(Debug, Clone)]
struct ProfileSourceEntry {
    relative_path: String,
    size_bytes: u64,
}

fn profile_field(label: &str, value: &str) -> serde_json::Value {
    serde_json::json!({ "label": label, "value": value })
}

fn willow_dependency(
    id: &str,
    title: &str,
    marker_files: &[&str],
    release_url: &str,
) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "title": title,
        "summary": "External SDK runtime required by .sdkmod packages. Tsuki detects it but does not install or remove the shared runtime automatically.",
        "enabled": true,
        "fields": [
            profile_field("Dependency ID", id),
            profile_field("Dependency Type", "Mod Loader / Framework"),
            profile_field("Required", "Optional / Recommended"),
            profile_field("Detection Method", "All selected markers exist"),
            profile_field("Marker Filenames", &marker_files.join("|")),
            profile_field("Approved Remote Source", release_url),
            profile_field("Install Method", "Open external manager"),
            profile_field("Manual Install Instructions", "Install the matching official Willow SDK release for this exact game variant, then run dependency detection again."),
            profile_field("Removal Safety", "Never remove while dependent SDK mods remain installed."),
        ]
    })
}

fn willow_sdkmod_rule(id: &str, dependency: &str) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "name": "Willow SDK mod package",
        "kind": "custom_extension",
        "extension": ".sdkmod",
        "extensions": [".sdkmod"],
        "filenamePattern": "*.sdkmod",
        "folderMarker": "",
        "exactFilenames": [],
        "folderMarkers": [],
        "fileMatchMode": "file",
        "customMatchRule": "*.sdkmod",
        "destination": "${GAME_ROOT}/sdk_mods",
        "preserveStructure": false,
        "flattenWrapper": true,
        "requiredDependency": dependency,
        "conflictPolicy": "Ask before replacing an existing receipt-owned package",
        "priority": 100,
        "confidence": 100
    })
}

fn builtin_dependency(
    id: &str,
    title: &str,
    marker_files: &[&str],
    release_url: &str,
    summary: &str,
) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "title": title,
        "summary": summary,
        "enabled": true,
        "fields": [
            profile_field("Dependency ID", id),
            profile_field("Dependency Type", "Mod Loader / Framework"),
            profile_field("Required", "Optional / Recommended"),
            profile_field("Detection Method", "All selected markers exist"),
            profile_field("Marker Filenames", &marker_files.join("|")),
            profile_field("Approved Remote Source", release_url),
            profile_field("Install Method", "Open official source or external manager"),
            profile_field("Manual Install Instructions", &format!("Install the current game-compatible {} release, then run dependency detection again.", title)),
            profile_field("Removal Safety", "Never remove a shared loader while dependent mods remain installed."),
        ]
    })
}

fn builtin_file_rule(
    id: &str,
    name: &str,
    extensions: &[&str],
    destination: &str,
    dependency: &str,
    confidence: i64,
) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "name": name,
        "kind": "custom_extension",
        "extension": extensions.first().copied().unwrap_or(""),
        "extensions": extensions,
        "filenamePattern": extensions.iter().map(|extension| format!("*{}", extension)).collect::<Vec<_>>().join("|"),
        "folderMarker": "",
        "exactFilenames": [],
        "folderMarkers": [],
        "fileMatchMode": "file",
        "customMatchRule": "",
        "destination": destination,
        "preserveStructure": false,
        "flattenWrapper": true,
        "requiredDependency": dependency,
        "conflictPolicy": "Ask before replacing an existing untracked file",
        "priority": 100,
        "confidence": confidence
    })
}

fn builtin_folder_rule(
    id: &str,
    name: &str,
    exact_marker: &str,
    destination: &str,
    dependency: &str,
    confidence: i64,
) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "name": name,
        "kind": "folder_based",
        "extension": "",
        "extensions": [],
        "filenamePattern": "",
        "folderMarker": "",
        "exactFilenames": [exact_marker],
        "folderMarkers": [],
        "fileMatchMode": "folder",
        "customMatchRule": "",
        "destination": destination,
        "preserveStructure": true,
        "flattenWrapper": true,
        "requiredDependency": dependency,
        "conflictPolicy": "Ask before replacing an existing untracked file",
        "priority": 100,
        "confidence": confidence
    })
}

fn builtin_profile_draft(
    profile_id: &str,
    game_key: &str,
    rules: Vec<serde_json::Value>,
    dependencies: Vec<serde_json::Value>,
    manager_note: &str,
) -> serde_json::Value {
    let mod_types = rules.iter().map(|rule| {
        let id = json_string(rule, "id").unwrap_or_else(|| "builtin-rule".to_string());
        let title = json_string(rule, "name").unwrap_or_else(|| "Built-in mod type".to_string());
        let destination = json_string(rule, "destination").unwrap_or_default();
        serde_json::json!({
            "id": id,
            "title": title,
            "summary": "A research-backed direct route with receipt ownership and reversible enable/disable.",
            "fields": [profile_field("Destination", &destination)]
        })
    }).collect::<Vec<_>>();
    serde_json::json!({
        "profileId": profile_id,
        "overview": { "gameKey": game_key, "gameName": game_key },
        "customPaths": [],
        "customFileTypes": rules,
        "sections": {
            "modTypes": mod_types,
            "installBehavior": [{
                "id": format!("{}-safe-install", game_key),
                "title": "Receipt-owned direct install",
                "summary": manager_note,
                "fields": [
                    profile_field("Track receipt ownership", "Yes"),
                    profile_field("Unsupported package behavior", "Block and hand off to the authoritative manager")
                ]
            }],
            "enableDisable": [{
                "id": format!("{}-toggle", game_key),
                "title": "Receipt-owned file state",
                "summary": "Move only files owned by one Tsuki receipt into profile-scoped disabled storage.",
                "fields": [
                    profile_field("Disable Method", "Move Every Installed File"),
                    profile_field("Enable Method", "Restore Every Installed File To Its Exact Receipt Path")
                ]
            }],
            "dependencies": dependencies,
            "conflicts": [{
                "id": format!("{}-conflicts", game_key),
                "title": "Receipt-owned path collision",
                "summary": "Tracked files are never overwritten; untracked files require confirmation and backup.",
                "fields": [profile_field("Policy", "Ask before changing installed files")]
            }]
        }
    })
}

fn builtin_non_willow_profile_draft(profile_id: &str) -> Option<serde_json::Value> {
    let reframework = || builtin_dependency(
        "reframework",
        "REFramework",
        &["dinput8.dll"],
        "https://github.com/praydog/REFramework/releases",
        "Required only for REFramework Lua and native plugin content; game-patch compatibility remains external.",
    );
    let reframework_rules = || vec![
        builtin_tree_rule("reframework-tree", "REFramework authored script tree", "reframework/autorun", "${GAME_ROOT}/reframework/autorun", "REFramework"),
        builtin_tree_rule("reframework-data", "REFramework authored data tree", "reframework/data", "${GAME_ROOT}/reframework/data", "REFramework"),
        builtin_tree_rule("reframework-images", "REFramework authored image assets", "reframework/images", "${GAME_ROOT}/reframework/images", "REFramework"),
        builtin_file_rule("reframework-lua", "REFramework Lua script", &[".lua"], "${GAME_ROOT}/reframework/autorun", "REFramework", 95),
        builtin_file_rule("reframework-plugin", "REFramework native plugin", &[".dll"], "${GAME_ROOT}/reframework/plugins", "REFramework", 85),
    ];
    match profile_id {
        "builtin.cyberpunk2077" => Some(builtin_profile_draft(
            profile_id,
            "cyberpunk-2077",
            vec![
                builtin_tree_rule("cyberpunk-script-tree", "Authored redscript tree", "r6/scripts", "${GAME_ROOT}/r6/scripts", "redscript"),
                builtin_file_rule("cyberpunk-archive", "Cyberpunk archive asset", &[".archive"], "${GAME_ROOT}/archive/pc/mod", "", 100),
                builtin_file_rule("cyberpunk-archivexl", "ArchiveXL sidecar", &[".xl"], "${GAME_ROOT}/archive/pc/mod", "ArchiveXL", 100),
                builtin_file_rule("cyberpunk-redscript", "Cyberpunk redscript", &[".reds"], "${GAME_ROOT}/r6/scripts", "redscript", 95),
            ],
            vec![builtin_dependency("archivexl", "ArchiveXL", &["red4ext/plugins/ArchiveXL/ArchiveXL.dll"], "https://github.com/psiberx/cp2077-archive-xl", "Required for .archive.xl sidecar configuration."), builtin_dependency(
                "redscript",
                "redscript",
                &["engine/tools/scc.exe"],
                "https://github.com/jac3km4/redscript/releases",
                "Required for .reds scripts and checked independently from RED4ext or CET.",
            )],
            "Direct routes preserve authored redscript trees and install .archive assets and loader-guarded ArchiveXL sidecars. Other runtime/REDmod packages remain manager handoffs.",
        )),
        "builtin.outlast-trials" => Some(builtin_profile_draft(
            profile_id,
            "outlast-trials",
            vec![builtin_file_rule("outlast-pak", "Outlast Trials PAK", &[".pak"], "${GAME_ROOT}/OPP/Content/Paks", "", 100)],
            Vec::new(),
            "Direct install supports standard PAK files only. Movie replacements, audio workflows, Iris, Janus and Odessa remain explicit external-manager handoffs.",
        )),
        "builtin.payday-the-heist" => Some(builtin_profile_draft(
            profile_id,
            "payday-the-heist",
            vec![builtin_folder_rule("pdth-blt-folder", "PAYDAY: The Heist BLT mod folder", "mod.txt", "${GAME_ROOT}/mods", "PDTH BLT", 95),
                builtin_tree_rule("pdth-overrides", "Authored PDTH mod_overrides tree", "assets/mod_overrides", "${GAME_ROOT}/assets/mod_overrides", "PDTHModOverrides"),
                builtin_file_rule("pdth-asset-package", "PDTH asset override package", &[".model", ".object", ".unit", ".texture", ".material_config", ".animation", ".effect"], "${GAME_ROOT}/assets/mod_overrides", "PDTHModOverrides", 90)],
            vec![builtin_dependency("pdth-blt", "PDTH BLT", &["IPHLPAPI.dll"], "https://github.com/simon-wh/Payday-The-Heist-BLT", "Lua routing requires the documented PDTH BLT proxy, not PAYDAY 2's SuperBLT DLL."),
                builtin_dependency("pdth-overrides", "PDTHModOverrides", &["DINPUT8.dll", "PDTHModOverrides.dll"], "https://github.com/HW12Dev/PDTHModOverrides", "Required for asset override trees; do not treat the generic BLT hook as an override loader.")],
            "PDTHModOverrides trees and legacy .pdmod packages require their documented manager workflow; loose Lua is guarded by BLT detection.",
        )),
        "builtin.payday2" => Some(builtin_profile_draft(
            profile_id,
            "payday-2",
            vec![builtin_folder_rule("payday2-blt-folder", "PAYDAY 2 SuperBLT mod folder", "mod.txt", "${GAME_ROOT}/mods", "SuperBLT", 95),
                builtin_folder_rule("payday2-superblt-assets", "PAYDAY 2 SuperBLT asset folder", "supermod.xml", "${GAME_ROOT}/mods", "SuperBLT", 95),
                builtin_tree_rule("payday2-overrides", "Authored PAYDAY 2 mod_overrides tree", "assets/mod_overrides", "${GAME_ROOT}/assets/mod_overrides", "")],
            vec![builtin_dependency("superblt", "SuperBLT", &["WSOCK32.dll"], "https://superblt.znix.xyz/", "The installed loader must match the active 64-bit or legacy 32-bit game branch.")],
            "Loose Lua routing is guarded by SuperBLT detection. BeardLib and mod_overrides package trees remain manager-aware handoffs unless their authored root is preserved.",
        )),
        "builtin.resident-evil-7" => Some(builtin_profile_draft(profile_id, "resident-evil-7", reframework_rules(), vec![reframework()], "REFramework scripts/plugins are direct and receipt-owned. Fluffy asset archives remain an external-manager handoff.")),
        "builtin.resident-evil-village" => Some(builtin_profile_draft(profile_id, "resident-evil-village", reframework_rules(), vec![reframework()], "REFramework scripts/plugins are direct and receipt-owned. Fluffy asset archives remain an external-manager handoff.")),
        "builtin.resident-evil-requiem" => Some(builtin_profile_draft(profile_id, "resident-evil-requiem", reframework_rules(), vec![reframework()], "REFramework scripts/plugins are direct and receipt-owned. RE8 asset paths are never reused; Fluffy packages stay manager handoffs.")),
        "builtin.borderlands3" | "builtin.tiny-tinas-wonderlands" => {
            let (game_key, executable_name) = if profile_id == "builtin.borderlands3" { ("borderlands-3", "Borderlands3.exe") } else { ("tiny-tinas-wonderlands", "Wonderlands.exe") };
            let pak_rule = (profile_id == "builtin.tiny-tinas-wonderlands").then(|| builtin_file_rule("wonderlands-pak", "Wonderlands content PAK", &[".pak"], "${GAME_ROOT}/OakGame/Content/Paks", "", 95));
            Some(builtin_profile_draft(
                profile_id,
                game_key,
                vec![
                    willow_sdkmod_rule("oak-sdkmod", "Oak SDK"),
                    builtin_folder_rule("oak-sdk-folder", "Oak SDK Python mod folder", "pyproject.toml", "${GAME_ROOT}/sdk_mods", "Oak SDK", 95),
                    builtin_file_rule("oak-hotfix", "OpenHotfixLoader hotfix", &[".txt"], "${GAME_ROOT}/OakGame/Binaries/Win64/Plugins/ohl-mods", "OpenHotfixLoader", 90),
                    builtin_file_rule("oak-plugin", "Oak native plugin", &[".dll"], "${GAME_ROOT}/OakGame/Binaries/Win64/Plugins", "PluginLoader", 80),
                ].into_iter().chain(pak_rule).collect(),
                vec![
                    builtin_dependency("oak-sdk", "Oak SDK", &["OakGame/Binaries/Win64/dsound.dll", "OakGame/Binaries/Win64/Plugins/unrealsdk.dll", "OakGame/Binaries/Win64/Plugins/pyunrealsdk.dll", "OakGame/Binaries/Win64/Plugins/unrealsdk.toml"], "https://bl-sdk.github.io/oak-mod-db/", "Install the matching BL3 or Wonderlands SDK release. SDK packages remain intact in sdk_mods; runtime DLLs are never installed as plugins."),
                    builtin_dependency("plugin-loader", "PluginLoader", &["OakGame/Binaries/Win64/d3d11.dll"], "https://github.com/bl-sdk", &format!("Required for compatible {} native plugins.", executable_name)),
                    builtin_dependency("open-hotfix-loader", "OpenHotfixLoader", &["OakGame/Binaries/Win64/Plugins/OpenHotfixLoader.dll"], "https://github.com/apple1417/OpenHotfixLoader/releases", "Required for .txt hotfix mods in Plugins/ohl-mods."),
                ],
                "Direct installs support dependency-guarded Oak SDK packages, authored Python mod folders, compatible plugin DLLs, and OpenHotfixLoader text mods. Runtime proxies and save files require explicit manual review.",
            ))
        }
        "builtin.borderlands4" => Some(builtin_profile_draft(
            profile_id,
            "borderlands-4",
            vec![willow_sdkmod_rule("borderlands4-sdkmod", "Oak2 Mod Manager")],
            vec![builtin_dependency("oak2-mod-manager", "Oak2 Mod Manager", &["OakGame/Binaries/Win64/Plugins/unrealsdk.dll"], "https://github.com/bl-sdk", "The release-sensitive Oak2 proxy is not installed by Tsuki; this marker only unlocks .sdkmod routing after the SDK is present.")],
            "Only .sdkmod packages are routed automatically, and only after the Oak2 SDK marker is detected. Proxy/runtime binaries remain an external-manager install.",
        )),
        "builtin.spider-man-remastered" | "builtin.spider-man-2" => {
            let game_key = if profile_id == "builtin.spider-man-remastered" { "spider-man-remastered" } else { "spider-man-2" };
            Some(builtin_profile_draft(
                profile_id,
                game_key,
                Vec::new(),
                vec![builtin_dependency("overstrike", "Overstrike", &[], "https://www.nexusmods.com/marvelsspidermanremastered/mods/4199", "Overstrike is authoritative for .smpcmod, .suit, .stage, .modular and .script activation.")],
                "All proprietary Spider-Man package formats are intentionally blocked from direct extraction and must be handed to Overstrike with matching game metadata.",
            ))
        }
        "builtin.monster-hunter-wilds" => Some(builtin_profile_draft(
            profile_id,
            "monster-hunter-wilds",
            reframework_rules(),
            vec![reframework()],
            "REFramework scripts/plugins are direct and receipt-owned. Fluffy archives and numbered patch PAKs remain blocked until their exact manager/slot contract is proven.",
        )),
        _ => None,
    }
}

fn builtin_tree_rule(id: &str, name: &str, marker: &str, destination: &str, dependency: &str) -> serde_json::Value {
    let mut rule = builtin_file_rule(id, name, &[], destination, dependency, 100);
    rule["folderMarkers"] = serde_json::json!([marker]);
    rule["preserveStructure"] = serde_json::json!(true);
    rule["priority"] = serde_json::json!(50);
    rule
}

fn builtin_willow_profile_draft(profile_id: &str, game_root: &Path) -> Option<serde_json::Value> {
    let (game_key, dependency, rule_id) = match profile_id {
        "builtin.borderlands" if game_root.join("Binaries/Win64/BorderlandsGOTY.exe").is_file() => (
            "borderlands-goty-enhanced",
            willow_dependency(
                "willow1-mod-manager-enhanced",
                "Willow1 Mod Manager - Enhanced",
                &["Binaries/Win64/dinput8.dll", "Binaries/Win64/Plugins/unrealsdk.dll"],
                "https://github.com/bl-sdk/willow1-mod-manager/releases/latest",
            ),
            "borderlands-enhanced-sdkmod",
        ),
        "builtin.borderlands" => (
            "borderlands-goty-classic",
            willow_dependency(
                "willow1-mod-manager-classic",
                "Willow1 Mod Manager - Classic",
                &["Binaries/dsound.dll", "Binaries/Plugins/unrealsdk.dll"],
                "https://github.com/bl-sdk/willow1-mod-manager/releases/latest",
            ),
            "borderlands-classic-sdkmod",
        ),
        "builtin.borderlands2" => (
            "borderlands-2",
            willow_dependency(
                "willow2-mod-manager",
                "Willow2 Mod Manager",
                &["Binaries/Win32/ddraw.dll", "Binaries/Win32/Plugins/unrealsdk.dll"],
                "https://github.com/bl-sdk/willow2-mod-manager/releases/latest",
            ),
            "borderlands2-sdkmod",
        ),
        _ => return None,
    };
    let dependency_title = dependency
        .get("title")
        .and_then(|value| value.as_str())
        .unwrap_or("Willow SDK")
        .to_string();
    Some(serde_json::json!({
        "profileId": profile_id,
        "overview": { "gameKey": game_key, "gameName": game_key },
        "customPaths": [],
        "customFileTypes": [willow_sdkmod_rule(rule_id, &dependency_title)],
        "sections": {
            "modTypes": [{
                "id": rule_id,
                "title": "Willow SDK .sdkmod",
                "summary": "Receipt-owned .sdkmod files installed only after the matching Willow runtime is detected.",
                "fields": [profile_field("Destination", "${GAME_ROOT}/sdk_mods")]
            }],
            "installBehavior": [{
                "id": format!("{}-install", rule_id),
                "title": "Install Willow SDK package",
                "summary": "Copy only the selected .sdkmod file and track it in a profile receipt.",
                "fields": [
                    profile_field("Destination", "${GAME_ROOT}/sdk_mods"),
                    profile_field("Track receipt ownership", "Yes")
                ]
            }],
            "enableDisable": [{
                "id": format!("{}-toggle", rule_id),
                "title": "Willow SDK package state",
                "summary": "Move only receipt-owned .sdkmod files to profile-scoped disabled storage.",
                "fields": [
                    profile_field("Disable Method", "Move Every Installed File"),
                    profile_field("Enable Method", "Restore Every Installed File To Its Exact Receipt Path")
                ]
            }],
            "dependencies": [dependency],
            "conflicts": [{
                "id": format!("{}-conflicts", rule_id),
                "title": "Receipt-owned path collision",
                "summary": "Require explicit overwrite approval when another receipt owns the same destination.",
                "fields": [profile_field("Policy", "Ask before changing installed files")]
            }]
        }
    }))
}

pub(crate) fn detected_builtin_game_root(profile_id: &str) -> Option<PathBuf> {
    let probe = GameProfileInstallationProbe {
        profile_id: profile_id.to_string(),
        steam_app_ids: builtin_profile_steam_app_ids(profile_id)
            .iter()
            .map(|value| (*value).to_string())
            .collect(),
    };
    detect_profile_installation(probe, &discovered_steam_libraries())
        .game_root
        .map(PathBuf::from)
}

pub(crate) fn builtin_install_definition(profile_id: &str, game_root: Option<&Path>) -> Option<serde_json::Value> {
    builtin_willow_profile_draft(profile_id, game_root.unwrap_or(Path::new("")))
        .or_else(|| builtin_non_willow_profile_draft(profile_id))
}

pub(crate) fn inspect_profile_source_file(profile_id: &str, path: &Path) -> Result<(String, Vec<ArchiveInspectEntry>, Vec<String>), String> {
    let context = load_profile_context(profile_id)?;
    let mut analysis = analyze_custom_profile_path(&context, path)?;
    let mut warnings = analysis.warnings;
    if analysis.blocked {
        warnings.push("Installation blocked by this profile's routing or dependency rules; no partial package will be installed.".to_string());
        for entry in &mut analysis.entries { if entry.route_kind != "folder" { entry.blocked = true; } }
    }
    Ok((analysis.archive_kind, analysis.entries, warnings))
}

pub(crate) fn install_profile_source_file(profile_id: &str, path: &Path, source: &str, mod_id: &str, file_id: &str, name: &str, version: Option<String>, author: Option<String>, thumbnail: Option<String>, page_url: Option<String>) -> Result<InstallApplyResult, String> {
    let context = load_profile_context(profile_id)?;
    let item = analyze_custom_profile_path(&context, path)?;
    let selected_match = DragDropMatchCandidate {
        source: source.to_string(), source_id: mod_id.to_string(), file_id: Some(file_id.to_string()),
        game_id: Some(context.game_id), mod_name: name.to_string(), file_name: path.file_name().unwrap_or_default().to_string_lossy().to_string(),
        version: version.clone(), author, thumbnail_url: thumbnail.clone(), page_url, sha256: item.original_sha256.clone(),
        confidence: 100, confidence_level: "verified".to_string(), match_kind: "source-download".to_string(), reason: "Selected live source file".to_string(),
    };
    install_drag_drop_item(DragDropInstallRequest {
        item, selected_match: Some(selected_match), install_as_local: false, display_name: name.to_string(),
        version_override: version, thumbnail_override: thumbnail, notes: None, allow_overwrite: false,
    })
}

pub(crate) fn builtin_profile_executable_markers(profile_id: &str) -> &'static [&'static str] {
    match profile_id {
        "builtin.cyberpunk2077" => &["bin/x64/Cyberpunk2077.exe"],
        "builtin.outlast-trials" => &["start_protected_game.exe", "OPP/Binaries/Win64/TOTClient-Win64-Shipping.exe", "OPP/Binaries/Win64/TOTClient.exe"],
        "builtin.payday-the-heist" => &["payday_win32_release.exe"],
        "builtin.payday2" => &["PAYDAY2.exe", "payday2_win32_release.exe"],
        "builtin.payday3" => &["PAYDAY3.exe", "PAYDAY3/Binaries/Win64/PAYDAY3Client-Win64-Shipping.exe", "PAYDAY3/Binaries/Win64/PAYDAY3-Win64-Shipping.exe", "Content/PAYDAY3/Binaries/WinGDK/PAYDAY3-WinGDK-Shipping.exe"],
        "builtin.resident-evil-7" => &["re7.exe"],
        "builtin.resident-evil-village" => &["re8.exe"],
        "builtin.resident-evil-requiem" => &["re9.exe"],
        "builtin.borderlands" => &["Binaries/Borderlands.exe", "Binaries/Win64/BorderlandsGOTY.exe"],
        "builtin.borderlands2" => &["Binaries/Win32/Borderlands2.exe"],
        "builtin.borderlands3" => &["OakGame/Binaries/Win64/Borderlands3.exe"],
        "builtin.borderlands4" => &["OakGame/Binaries/Win64/Borderlands4.exe"],
        "builtin.tiny-tinas-wonderlands" => &["OakGame/Binaries/Win64/Wonderlands.exe"],
        "builtin.spider-man-remastered" => &["Spider-Man.exe"],
        "builtin.spider-man-2" => &["Spider-Man2.exe", "SpiderMan2.exe"],
        "builtin.monster-hunter-wilds" => &["MonsterHunterWilds.exe"],
        _ => &[],
    }
}

pub(crate) fn detected_builtin_launch_executable(profile_id: &str) -> Option<PathBuf> {
    let root = detected_builtin_game_root(profile_id)?;
    builtin_profile_executable_markers(profile_id)
        .iter()
        .map(|marker| root.join(marker))
        .find(|path| path.is_file())
}

pub(crate) fn validate_builtin_profile_root(profile_id: &str, game_root: &Path) -> Result<(), String> {
    let markers = builtin_profile_executable_markers(profile_id);
    if markers.is_empty() { return Ok(()); }
    if markers.iter().any(|marker| game_root.join(marker).is_file()) {
        Ok(())
    } else {
        Err(format!(
            "The configured folder is not a recognized {} installation. Expected one of: {}.",
            profile_id,
            markers.join(", ")
        ))
    }
}

#[derive(Debug, Clone)]
struct OverwriteBackup {
    original_path: String,
    backup_path: String,
}

fn clean_text(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
    })
}

fn profile_receipts_dir(profile_id: &str) -> Result<PathBuf, String> {
    if is_builtin_payday3_profile(Some(profile_id)) {
        receipts_dir()
    } else {
        Ok(ensure_profile_data_dirs(profile_id)?.join("receipts"))
    }
}

fn profile_disabled_root(profile_id: &str, receipt_id: &str) -> Result<PathBuf, String> {
    Ok(ensure_profile_data_dirs(profile_id)?
        .join("disabled-state")
        .join(sanitize_file_component(receipt_id)))
}

fn profile_disabled_manifest_path(profile_id: &str, receipt_id: &str) -> Result<PathBuf, String> {
    Ok(profile_disabled_root(profile_id, receipt_id)?.join("tsuki-disabled.json"))
}

fn profile_installed_state_path(profile_id: &str) -> Result<PathBuf, String> {
    Ok(ensure_profile_data_dirs(profile_id)?
        .join("installed-state")
        .join("installed-state.json"))
}

fn profile_receipt_path(profile_id: &str, receipt_id: &str) -> Result<PathBuf, String> {
    Ok(profile_receipts_dir(profile_id)?.join(format!("{}.json", sanitize_file_component(receipt_id))))
}

fn load_profile_context(profile_id: &str) -> Result<ProfileInstallContext, String> {
    let profile_id = clean_profile_id(profile_id)?;
    let saved_draft = read_game_profile_draft(&profile_id).ok();
    let settings = load_profile_settings_internal(&profile_id);
    let game_root = settings
        .game_root_override
        .clone()
        .or_else(|| saved_draft.as_ref().and_then(|draft| draft_game_root(Some(draft))))
        .or_else(|| detected_builtin_game_root(&profile_id).map(|path| path.display().to_string()))
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "Set this profile's Game Root in Settings before installing mods.".to_string())?;

    if !game_root.is_dir() {
        return Err(format!("The configured game root does not exist: {}", game_root.display()));
    }
    validate_builtin_profile_root(&profile_id, &game_root)?;
    let draft = builtin_willow_profile_draft(&profile_id, &game_root)
        .or_else(|| builtin_non_willow_profile_draft(&profile_id))
        .or(saved_draft)
        .ok_or_else(|| format!("Open and save {} in Profile Creator before installing mods.", profile_id))?;

    let executable_dir = settings
        .executable_override
        .as_deref()
        .map(Path::new)
        .and_then(Path::parent)
        .map(PathBuf::from)
        .or_else(|| draft_executable(Some(&draft)).and_then(|value| {
            let path = PathBuf::from(value);
            if path.is_absolute() { path.parent().map(PathBuf::from) } else { game_root.join(path).parent().map(PathBuf::from) }
        }))
        .unwrap_or_else(|| game_root.clone());

    let rules = draft
        .get("customFileTypes")
        .cloned()
        .and_then(|value| serde_json::from_value::<Vec<ProfileFileTypeRule>>(value).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|rule| !rule.destination.trim().is_empty())
        .collect::<Vec<_>>();

    let game_id = draft_overview_string(&draft, "gameKey")
        .or_else(|| draft_overview_string(&draft, "gameName"))
        .unwrap_or_else(|| profile_id.clone());

    Ok(ProfileInstallContext { profile_id, game_id, game_root, executable_dir, draft, rules })
}

fn custom_paths(draft: &serde_json::Value) -> Vec<ProfileCustomPath> {
    draft
        .get("customPaths")
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

fn path_has_parent_component(path: &Path) -> bool {
    path.components().any(|component| matches!(component, Component::ParentDir))
}

fn safe_relative_path(value: &str) -> Result<PathBuf, String> {
    let normalized = value.trim().replace('\\', "/");
    if normalized.is_empty() {
        return Ok(PathBuf::new());
    }
    let path = PathBuf::from(&normalized);
    if path.is_absolute() || path_has_parent_component(&path) {
        return Err(format!("Unsafe relative path: {}", value));
    }
    Ok(path)
}

fn documents_dir() -> Result<PathBuf, String> {
    env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .map(|path| path.join("Documents"))
        .ok_or_else(|| "The current user's Documents folder could not be resolved.".to_string())
}

fn local_app_data_dir() -> Result<PathBuf, String> {
    env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| "LOCALAPPDATA is unavailable.".to_string())
}

fn resolve_base_root(context: &ProfileInstallContext, base_root: &str) -> Result<PathBuf, String> {
    match base_root.trim().to_ascii_lowercase().as_str() {
        "game_root" => Ok(context.game_root.clone()),
        "game_exe_dir" => Ok(context.executable_dir.clone()),
        "profile_data" | "profile_disabled_storage" | "profile_backup_storage" | "profile_cache" => ensure_profile_data_dirs(&context.profile_id),
        "documents" => documents_dir(),
        "appdata" => app_data_dir(),
        "localappdata" => local_app_data_dir(),
        "user_selected_folder" => Err("This profile uses a user-selected destination that has not been captured in profile settings yet.".to_string()),
        other => Err(format!("Unsupported profile root: {}", other)),
    }
}

fn split_expression(expression: &str) -> Result<(String, String), String> {
    let trimmed = expression.trim();
    if !trimmed.starts_with("${") {
        return Err("Install destinations must start with an approved profile variable.".to_string());
    }
    let end = trimmed.find('}').ok_or_else(|| format!("Invalid destination variable: {}", expression))?;
    let variable = trimmed[2..end].to_string();
    let tail = trimmed[end + 1..].trim_start_matches(['/', '\\']).to_string();
    Ok((variable, tail))
}

fn resolve_destination_root(context: &ProfileInstallContext, expression: &str) -> Result<PathBuf, String> {
    let (variable, tail) = split_expression(expression)?;
    let root = if let Some(path_id) = variable.strip_prefix("PATH:") {
        let path = custom_paths(&context.draft)
            .into_iter()
            .find(|path| path.id.eq_ignore_ascii_case(path_id))
            .ok_or_else(|| format!("Profile path {} is not defined.", path_id))?;
        let base = resolve_base_root(context, &path.base_root)?;
        base.join(safe_relative_path(&path.relative_path)?)
    } else {
        match variable.as_str() {
            "GAME_ROOT" => context.game_root.clone(),
            "GAME_EXE_DIR" => context.executable_dir.clone(),
            "DOCUMENTS" => documents_dir()?,
            "APP_DATA" => app_data_dir()?,
            "LOCAL_APP_DATA" => local_app_data_dir()?,
            other if other.starts_with("USER_SELECTED_PATH:") => return Err("User-selected destination variables are not available until the profile stores that selected path.".to_string()),
            other => return Err(format!("Unsupported destination variable: {}", other)),
        }
    };
    Ok(root.join(safe_relative_path(&tail)?))
}

fn allowed_profile_roots(context: &ProfileInstallContext) -> Result<Vec<PathBuf>, String> {
    let mut roots = vec![context.game_root.clone(), context.executable_dir.clone(), ensure_profile_data_dirs(&context.profile_id)?];
    for rule in &context.rules {
        if let Ok(root) = resolve_destination_root(context, &rule.destination) {
            if !roots.iter().any(|existing| existing == &root) {
                roots.push(root);
            }
        }
    }
    Ok(roots)
}

fn destination_is_allowed(destination: &Path, roots: &[PathBuf]) -> bool {
    destination.is_absolute()
        && !path_has_parent_component(destination)
        && roots.iter().any(|root| destination.starts_with(root))
}

fn split_list(value: &str) -> Vec<String> {
    value
        .split(['|', ',', ';'])
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

#[derive(Debug, Clone)]
struct ProfileDependencyEvaluation {
    id: String,
    label: String,
    aliases: Vec<String>,
    required: String,
    found: bool,
    status: String,
    path: Option<String>,
    details: String,
    recommendation: String,
}

fn dependency_marker_values(item: &serde_json::Value, plural: &str, singular: &str) -> Vec<String> {
    let mut values = item_field_value(item, plural).map(|value| split_list(&value)).unwrap_or_default();
    if let Some(value) = item_field_value(item, singular).and_then(|value| clean_text(Some(value))) {
        values.extend(split_list(&value));
    }
    values
        .into_iter()
        .map(|value| value.replace('\\', "/"))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn portable_executable_machine(path: &Path) -> Option<u16> {
    let mut file = File::open(path).ok()?;
    let mut header = [0u8; 64];
    file.read_exact(&mut header).ok()?;
    if &header[..2] != b"MZ" { return None; }
    let offset = u32::from_le_bytes(header[60..64].try_into().ok()?) as u64;
    std::io::Seek::seek(&mut file, std::io::SeekFrom::Start(offset)).ok()?;
    let mut pe = [0u8; 6];
    file.read_exact(&mut pe).ok()?;
    if &pe[..4] != b"PE\0\0" { return None; }
    Some(u16::from_le_bytes([pe[4], pe[5]]))
}

fn dependency_marker_candidates(context: &ProfileInstallContext, destination: Option<&Path>, marker: &str) -> Vec<PathBuf> {
    let marker = marker.trim();
    if marker.is_empty() { return Vec::new(); }
    if marker.starts_with("${") {
        return resolve_destination_root(context, marker).ok().into_iter().collect();
    }
    let Ok(relative) = safe_relative_path(marker) else { return Vec::new(); };
    let mut roots = Vec::new();
    if let Some(destination) = destination { roots.push(destination.to_path_buf()); }
    roots.push(context.game_root.clone());
    roots.push(context.executable_dir.clone());
    roots
        .into_iter()
        .map(|root| root.join(&relative))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn evaluate_profile_dependencies(context: &ProfileInstallContext) -> Vec<ProfileDependencyEvaluation> {
    draft_section_items(&context.draft, "dependencies")
        .into_iter()
        .filter(|item| item.get("enabled").and_then(|value| value.as_bool()) != Some(false))
        .map(|item| {
            let label = item_title(item)
                .or_else(|| item_field_value(item, "Dependency Type"))
                .unwrap_or_else(|| "Unnamed dependency".to_string());
            let id = item_field_value(item, "Dependency ID")
                .or_else(|| json_string(item, "id"))
                .unwrap_or_else(|| sanitize_file_component(&label));
            let dependency_type = item_field_value(item, "Dependency Type").unwrap_or_default();
            let required = item_field_value(item, "Required").unwrap_or_else(|| "Optional / Recommended".to_string());
            let detection = item_field_value(item, "Detection Method").unwrap_or_else(|| "Known dependency preset".to_string());
            let destination = item_field_value(item, "Destination")
                .and_then(|value| clean_text(Some(value)))
                .and_then(|value| resolve_destination_root(context, &value).ok());
            let file_markers = dependency_marker_values(item, "Marker Filenames", "Marker File");
            let folder_markers = dependency_marker_values(item, "Marker Folders", "Marker Folder");
            let file_candidates = file_markers.iter().flat_map(|marker| dependency_marker_candidates(context, destination.as_deref(), marker)).collect::<Vec<_>>();
            let folder_candidates = folder_markers.iter().flat_map(|marker| dependency_marker_candidates(context, destination.as_deref(), marker)).collect::<Vec<_>>();
            let found_files = file_candidates.iter().filter(|path| path.is_file()).cloned().collect::<Vec<_>>();
            let found_folders = folder_candidates.iter().filter(|path| path.is_dir()).cloned().collect::<Vec<_>>();
            let found_specific_folder = folder_markers.iter().filter(|marker| marker.contains('/')).any(|marker| dependency_marker_candidates(context, destination.as_deref(), marker).iter().any(|path| path.is_dir()));
            let lower_detection = detection.to_ascii_lowercase();
            let configured = !file_markers.is_empty() || !folder_markers.is_empty();
            let mut found = if lower_detection.contains("all selected") {
                configured
                    && file_markers.iter().all(|marker| dependency_marker_candidates(context, destination.as_deref(), marker).iter().any(|path| path.is_file()))
                    && folder_markers.iter().all(|marker| dependency_marker_candidates(context, destination.as_deref(), marker).iter().any(|path| path.is_dir()))
            } else if lower_detection.contains("file exists") {
                !file_markers.is_empty() && !found_files.is_empty()
            } else if lower_detection.contains("folder exists") {
                !folder_markers.is_empty() && !found_folders.is_empty()
            } else if lower_detection.contains("known dependency preset") && !file_markers.is_empty() {
                !found_files.is_empty() || found_specific_folder
            } else {
                !found_files.is_empty() || !found_folders.is_empty()
            };
            let architecture_error = if found && id == "superblt" {
                let game_machine = builtin_profile_executable_markers("builtin.payday2").iter()
                    .find_map(|marker| portable_executable_machine(&context.game_root.join(marker)));
                game_machine.and_then(|machine| {
                    let loader_machine = portable_executable_machine(&context.game_root.join("WSOCK32.dll"));
                    if loader_machine == Some(machine) { None } else {
                        Some("SuperBLT is present but its PE architecture does not match the PAYDAY 2 executable. Install the matching 64-bit or legacy 32-bit loader.".to_string())
                    }
                })
            } else { None };
            if architecture_error.is_some() { found = false; }
            let found_path = found_files.first().or_else(|| found_folders.first()).cloned();
            let expected_path = file_candidates.first().or_else(|| folder_candidates.first()).cloned();
            let status = if found { "found" } else if configured { "missing" } else { "unconfigured" }.to_string();
            let details = if let Some(error) = architecture_error { error } else if found {
                format!("Detected using {}.", detection)
            } else if configured {
                format!("No configured {} marker was found.", detection)
            } else {
                "No file or folder detection marker is configured for this dependency.".to_string()
            };
            let recommendation = if found {
                "No action is required.".to_string()
            } else {
                item_field_value(item, "Manual Install Instructions")
                    .and_then(|value| clean_text(Some(value)))
                    .unwrap_or_else(|| format!("Install or repair {} before installing mods that require it.", label))
            };
            let aliases = [label.clone(), dependency_type, id.clone()]
                .into_iter()
                .filter(|value| !value.trim().is_empty())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            ProfileDependencyEvaluation {
                id,
                label,
                aliases,
                required,
                found,
                status,
                path: found_path.or(expected_path).map(|path| path.display().to_string()),
                details,
                recommendation,
            }
        })
        .collect()
}

fn dependency_name_matches(evaluation: &ProfileDependencyEvaluation, name: &str) -> bool {
    evaluation.aliases.iter().any(|alias| alias.eq_ignore_ascii_case(name.trim()))
}

fn missing_dependencies_for_install(context: &ProfileInstallContext, required_names: &BTreeSet<String>) -> Vec<String> {
    let evaluations = evaluate_profile_dependencies(context);
    let mut missing = Vec::new();
    for evaluation in &evaluations {
        let globally_required = evaluation.required.eq_ignore_ascii_case("Required for profile");
        let selected = required_names.iter().any(|name| dependency_name_matches(evaluation, name));
        if (globally_required || selected) && !evaluation.found {
            missing.push(evaluation.label.clone());
        }
    }
    for name in required_names {
        if !evaluations.iter().any(|evaluation| dependency_name_matches(evaluation, name)) {
            missing.push(format!("{} (not defined in Dependencies)", name));
        }
    }
    missing.sort_by_key(|value| value.to_ascii_lowercase());
    missing.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
    missing
}

pub(crate) fn get_profile_dependency_report(profile_id: &str) -> Result<DependencyReport, String> {
    let context = load_profile_context(profile_id)?;
    let evaluations = evaluate_profile_dependencies(&context);
    let mut warnings = Vec::new();
    for dependency in &evaluations {
        if !dependency.found && dependency.required.eq_ignore_ascii_case("Required for profile") {
            warnings.push(format!("Required dependency is not ready: {}.", dependency.label));
        }
    }
    if evaluations.is_empty() && profile_id != managed_loaders::PROFILE {
        warnings.push("This profile has no dependency rules to validate.".to_string());
    }
    let mut items = evaluations.into_iter().map(|dependency| DependencyStatusItem {
        id: dependency.id,
        label: dependency.label,
        status: dependency.status,
        found: dependency.found,
        path: dependency.path,
        details: format!("{} Requirement: {}", dependency.details, dependency.required),
        recommendation: dependency.recommendation,
    }).collect::<Vec<_>>();
    if profile_id == managed_loaders::PROFILE { items.push(managed_loaders::dependency_item()); }
    Ok(DependencyReport {
        game_root: context.game_root.display().to_string(),
        win64: context.executable_dir.display().to_string(),
        mods_folder: context.game_root.join("mods").display().to_string(),
        items,
        warnings,
    })
}

fn normalized_extensions(rule: &ProfileFileTypeRule) -> Vec<String> {
    let mut values = split_list(&rule.extension);
    values.extend(rule.extensions.iter().cloned());
    values
        .into_iter()
        .map(|value| if value.starts_with('.') { value.to_ascii_lowercase() } else { format!(".{}", value.to_ascii_lowercase()) })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn wildcard_matches(pattern: &str, value: &str) -> bool {
    let pattern = pattern.trim().replace('\\', "/").to_ascii_lowercase();
    let value = value.replace('\\', "/").to_ascii_lowercase();
    if pattern == "**/*" || pattern == "*" || pattern == "*.*" {
        return true;
    }
    let pattern = pattern.as_bytes();
    let value = value.as_bytes();
    let (mut p, mut v, mut star, mut retry) = (0usize, 0usize, None, 0usize);
    while v < value.len() {
        if p < pattern.len() && (pattern[p] == b'?' || pattern[p] == value[v]) {
            p += 1;
            v += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            while p < pattern.len() && pattern[p] == b'*' { p += 1; }
            star = Some(p);
            retry = v;
        } else if let Some(after_star) = star {
            retry += 1;
            v = retry;
            p = after_star;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == b'*' { p += 1; }
    p == pattern.len()
}

fn path_has_marker(path: &str, marker: &str) -> bool {
    let path = path.replace('\\', "/").to_ascii_lowercase();
    let marker = marker.trim().replace('\\', "/").trim_matches('/').to_ascii_lowercase();
    if marker.is_empty() { return false; }
    let leaf = path.rsplit('/').next().unwrap_or(&path);
    leaf == marker || path.split('/').any(|segment| segment == marker) || path.ends_with(&format!("/{}", marker))
        || path.starts_with(&format!("{}/", marker)) || path.contains(&format!("/{}/", marker))
}

fn rule_markers(rule: &ProfileFileTypeRule) -> Vec<String> {
    let mut markers = split_list(&rule.folder_marker);
    markers.extend(rule.folder_markers.iter().cloned());
    markers.extend(rule.exact_filenames.iter().cloned());
    markers.into_iter().collect::<BTreeSet<_>>().into_iter().collect()
}

fn rule_matches_path(rule: &ProfileFileTypeRule, path: &str) -> bool {
    let lower = path.replace('\\', "/").to_ascii_lowercase();
    let leaf = lower.rsplit('/').next().unwrap_or(&lower);
    if normalized_extensions(rule).iter().any(|extension| lower.ends_with(extension)) { return true; }
    if rule.exact_filenames.iter().any(|name| leaf == name.trim().to_ascii_lowercase()) { return true; }
    if rule_markers(rule).iter().any(|marker| path_has_marker(&lower, marker)) { return true; }
    split_list(&rule.filename_pattern)
        .iter()
        .chain(split_list(&rule.custom_match_rule).iter())
        .any(|pattern| wildcard_matches(pattern, &lower) || (!pattern.contains(['/', '\\']) && wildcard_matches(pattern, leaf)))
}

fn best_rule_for_paths<'a>(rules: &'a [ProfileFileTypeRule], paths: &[String]) -> Option<&'a ProfileFileTypeRule> {
    rules
        .iter()
        .filter(|rule| {
            let folder_rule = rule.kind.eq_ignore_ascii_case("folder_based") || matches!(rule.file_match_mode.as_str(), "folder" | "whole_folder");
            if folder_rule {
                let markers = rule_markers(rule);
                !markers.is_empty() && paths.iter().any(|path| markers.iter().any(|marker| path_has_marker(path, marker)))
            } else {
                false
            }
        })
        .max_by(|left, right| left.confidence.cmp(&right.confidence).then_with(|| right.priority.cmp(&left.priority)))
}

fn best_rule_for_path<'a>(rules: &'a [ProfileFileTypeRule], path: &str) -> Option<&'a ProfileFileTypeRule> {
    rules
        .iter()
        .filter(|rule| rule_matches_path(rule, path))
        .max_by(|left, right| left.confidence.cmp(&right.confidence).then_with(|| right.priority.cmp(&left.priority)))
}

fn package_root_for_rule(rule: &ProfileFileTypeRule, paths: &[String], source_path: &str) -> Option<String> {
    let source_path = source_path.replace('\\', "/");
    let mut roots = Vec::new();
    for exact in &rule.exact_filenames {
        for path in paths {
            let normalized = path.replace('\\', "/");
            let leaf = normalized.rsplit('/').next().unwrap_or(&normalized);
            if leaf.eq_ignore_ascii_case(exact.trim()) {
                let root = normalized.rsplit_once('/').map(|(parent, _)| parent.to_string()).unwrap_or_default();
                if root.is_empty() || source_path.starts_with(&format!("{}/", root)) {
                    roots.push(root);
                }
            }
        }
    }
    roots.into_iter().max_by_key(String::len)
}

fn route_relative_path(rule: &ProfileFileTypeRule, source_path: &str, all_paths: &[String], display_name: &str) -> String {
    let normalized = source_path.replace('\\', "/");
    if rule.id == "pdth-asset-package" {
        let parts = normalized.split('/').collect::<Vec<_>>();
        if let Some(index) = parts.iter().position(|part| ["units", "guis", "textures", "effects", "anims", "soundbanks"].iter().any(|root| part.eq_ignore_ascii_case(root))) {
            let package = index.checked_sub(1).map(|index| parts[index]).unwrap_or(display_name);
            return format!("{}/{}", sanitize_file_component(package), parts[index..].join("/"));
        }
    }
    let folder_rule = rule.kind.eq_ignore_ascii_case("folder_based") || matches!(rule.file_match_mode.as_str(), "folder" | "whole_folder");
    if folder_rule {
        if let Some(package_root) = package_root_for_rule(rule, all_paths, source_path) {
            let package_name = if package_root.is_empty() {
                sanitize_file_component(display_name)
            } else {
                package_root.rsplit('/').next().unwrap_or(&package_root).to_string()
            };
            let tail = if package_root.is_empty() { normalized.clone() } else { normalized.strip_prefix(&format!("{}/", package_root)).unwrap_or(&normalized).to_string() };
            return format!("{}/{}", package_name, tail);
        }
    }
    // Authored game-relative trees retain subdirectories without duplicating the destination prefix.
    if rule.preserve_structure {
        if let Some((_, suffix)) = rule.destination.split_once("}/") {
            let suffix = suffix.replace('\\', "/").trim_matches('/').to_string();
            let needle = format!("{}/", suffix);
            let lower = normalized.to_ascii_lowercase();
            if let Some(offset) = lower.find(&needle.to_ascii_lowercase()).filter(|offset| *offset == 0 || lower.as_bytes()[offset - 1] == b'/') {
                return normalized[offset + needle.len()..].to_string();
            }
        }
    }
    let stripped = if rule.flatten_wrapper {
        strip_common_root(&normalized, common_archive_root(all_paths).as_deref())
    } else {
        normalized
    };
    if rule.preserve_structure { stripped } else { stripped.rsplit('/').next().unwrap_or(&stripped).to_string() }
}

fn inspect_profile_source(path: &Path) -> Result<(String, Vec<ProfileSourceEntry>, Vec<String>), String> {
    if path.is_dir() {
        let entries = collect_files_recursive(path)?
            .into_iter()
            .map(|(relative_path, _, size_bytes)| ProfileSourceEntry { relative_path, size_bytes })
            .collect::<Vec<_>>();
        validate_install_sizes(&entries)?;
        return Ok(("folder".to_string(), entries, Vec::new()));
    }
    if !path.is_file() {
        return Err(format!("Dropped path was not found: {}", path.display()));
    }
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    if extension == "zip" && file_has_zip_magic(path) {
        let file = File::open(path).map_err(|error| format!("Failed to open ZIP {}: {}", path.display(), error))?;
        let mut archive = ZipArchive::new(file).map_err(|error| format!("Failed to read ZIP {}: {}", path.display(), error))?;
        let mut entries = Vec::new();
        for index in 0..archive.len() {
            let item = archive.by_index(index).map_err(|error| format!("Failed to inspect ZIP entry {}: {}", index, error))?;
            if item.is_dir() { continue; }
            let relative_path = normalize_archive_path(item.name());
            safe_relative_path(&relative_path)?;
            entries.push(ProfileSourceEntry { relative_path, size_bytes: item.size() });
        }
        validate_install_sizes(&entries)?;
        return Ok(("zip".to_string(), entries, Vec::new()));
    }
    if matches!(extension.as_str(), "7z" | "rar" | "tar" | "gz" | "xz") {
        let extracted = extract_external_archive(path, "profile-inspect")?;
        let result = inspect_profile_source(&extracted);
        let mut warnings = Vec::new();
        cleanup_temp_extraction_folder(&extracted, &mut warnings);
        let (_, entries, mut inspection_warnings) = result?;
        inspection_warnings.extend(warnings);
        return Ok((extension, entries, inspection_warnings));
    }
    let file_name = path.file_name().and_then(|value| value.to_str()).unwrap_or("dropped-file").to_string();
    let size_bytes = fs::metadata(path).map(|metadata| metadata.len()).unwrap_or(0);
    let entries = vec![ProfileSourceEntry { relative_path: file_name, size_bytes }];
    validate_install_sizes(&entries)?;
    Ok(("file".to_string(), entries, Vec::new()))
}

fn validate_install_sizes(entries: &[ProfileSourceEntry]) -> Result<(), String> {
    if let Some(entry) = entries.iter().find(|entry| entry.size_bytes > MAX_UNIVERSAL_FILE_BYTES) {
        return Err(format!("{} is larger than the 512 MB per-file safety limit.", entry.relative_path));
    }
    let total = entries.iter().try_fold(0u64, |sum, entry| sum.checked_add(entry.size_bytes)).ok_or_else(|| "Install size overflowed its safety counter.".to_string())?;
    if total > MAX_UNIVERSAL_INSTALL_BYTES {
        return Err("The dropped content is larger than the 2 GB universal-install safety limit.".to_string());
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProfileConflictPolicy {
    Ask,
    BackupReplace,
    Block,
}

fn profile_conflict_policy(value: &str) -> ProfileConflictPolicy {
    let lower = value.trim().to_ascii_lowercase();
    if lower.contains("block") || lower.contains("keep existing") || lower.contains("side by side") {
        ProfileConflictPolicy::Block
    } else if lower.contains("backup") || lower.contains("replace") || lower.contains("prefer new") {
        ProfileConflictPolicy::BackupReplace
    } else {
        ProfileConflictPolicy::Ask
    }
}

fn receipt_owner_map(profile_id: &str) -> Result<BTreeMap<String, String>, String> {
    let mut owners = BTreeMap::new();
    for receipt in list_profile_receipts_internal(profile_id)? {
        for file in receipt.files {
            owners.insert(file.relative_path.to_ascii_lowercase(), receipt.display_name.clone());
        }
    }
    Ok(owners)
}

fn analyze_destination_conflict(
    destination: &Path,
    owner: Option<&str>,
    policy: ProfileConflictPolicy,
) -> Option<(bool, bool, String)> {
    if let Some(owner) = owner {
        return Some((true, false, format!("Already owned by the tracked install '{}'. Uninstall that mod before replacing this path.", owner)));
    }
    if !destination.exists() { return None; }
    match policy {
        ProfileConflictPolicy::Block => Some((true, false, "An untracked file already exists here and this Mod Type blocks replacement.".to_string())),
        ProfileConflictPolicy::Ask => Some((false, true, "An untracked file already exists here. Confirm backup and replacement before installing.".to_string())),
        ProfileConflictPolicy::BackupReplace => Some((false, false, "An untracked file already exists here. Tsuki will move it to receipt-owned backup storage before installing.".to_string())),
    }
}

fn block_duplicate_destinations(entries: &mut [ArchiveInspectEntry]) -> Vec<String> {
    let mut counts = BTreeMap::<String, usize>::new();
    for entry in entries.iter().filter(|entry| !entry.blocked && entry.route_kind != "folder") {
        *counts.entry(entry.destination.to_ascii_lowercase()).or_default() += 1;
    }
    let duplicates = counts.into_iter().filter_map(|(path, count)| (count > 1).then_some(path)).collect::<BTreeSet<_>>();
    if duplicates.is_empty() { return Vec::new(); }
    let mut display_paths = BTreeSet::new();
    for entry in entries.iter_mut() {
        if duplicates.contains(&entry.destination.to_ascii_lowercase()) {
            entry.blocked = true;
            entry.reason.push_str(" Multiple source files resolve to this same destination.");
            display_paths.insert(entry.destination.clone());
        }
    }
    display_paths.into_iter().collect()
}

fn analyze_custom_profile_path(context: &ProfileInstallContext, path: &Path) -> Result<DragDropAnalysisItem, String> {
    let display_name = path.file_stem().and_then(|value| value.to_str()).or_else(|| path.file_name().and_then(|value| value.to_str())).unwrap_or("Dropped Mod").to_string();
    let (archive_kind, source_entries, mut warnings) = inspect_profile_source(path)?;
    let all_paths = source_entries.iter().map(|entry| entry.relative_path.clone()).collect::<Vec<_>>();
    let mut entries = Vec::new();
    let mut matched_names = BTreeSet::new();
    let mut required_dependencies = BTreeSet::new();
    let receipt_owners = receipt_owner_map(&context.profile_id)?;
    let mut conflict_count = 0usize;
    let mut requires_overwrite_confirmation = false;
    let mut conflict_summary = Vec::new();
    for source in source_entries {
        let package_rules = context.rules.iter().filter(|rule| {
            (rule.kind.eq_ignore_ascii_case("folder_based") || matches!(rule.file_match_mode.as_str(), "folder" | "whole_folder"))
                && package_root_for_rule(rule, &all_paths, &source.relative_path).is_some()
        }).cloned().collect::<Vec<_>>();
        let companion_rule = if source.relative_path.to_ascii_lowercase().ends_with(".ini") {
            let dll = format!("{}.dll", &source.relative_path[..source.relative_path.len() - 4]);
            all_paths.iter().any(|path| path.eq_ignore_ascii_case(&dll))
                .then(|| best_rule_for_path(&context.rules, &dll)).flatten()
                .filter(|rule| rule.id == "oak-plugin")
        } else { None };
        let rule = best_rule_for_paths(&package_rules, &all_paths).or_else(|| best_rule_for_path(&context.rules, &source.relative_path)).or(companion_rule);
        let Some(rule) = rule else {
            let leaf = source.relative_path.rsplit('/').next().unwrap_or(&source.relative_path).to_ascii_lowercase();
            let documentation = (["readme", "license", "licence", "changelog", "credits"].iter().any(|name| leaf.starts_with(name))
                && [".txt", ".md", ".html", ".pdf"].iter().any(|extension| leaf.ends_with(extension)))
                || ["modinfo.ini", "preview.png", "preview.jpg", "preview.jpeg"].contains(&leaf.as_str());
            entries.push(ArchiveInspectEntry {
                archive_path: source.relative_path,
                route_kind: if documentation { "folder" } else { "unmatched" }.to_string(),
                destination: if documentation { "Documentation skipped" } else { "Needs a matching Mod Type in Profile Creator" }.to_string(),
                confidence: "none".to_string(),
                reason: "No enabled profile Mod Type matched this file.".to_string(),
                blocked: !documentation,
                size_bytes: source.size_bytes,
            });
            continue;
        };
        let leaf = source.relative_path.rsplit('/').next().unwrap_or(&source.relative_path);
        if rule.id == "pdth-asset-package" && !source.relative_path.split('/').any(|part| ["units", "guis", "textures", "effects", "anims", "soundbanks"].iter().any(|root| part.eq_ignore_ascii_case(root))) {
            entries.push(ArchiveInspectEntry { archive_path: source.relative_path, route_kind:"unmatched".into(), destination:"Needs an authored Diesel asset tree".into(), confidence:"none".into(), reason:"A file extension alone does not identify a safe asset override layout.".into(), blocked:true, size_bytes:source.size_bytes });
            continue;
        }
        if ["dinput8.dll", "dxgi.dll", "dwmapi.dll", "version.dll", "winmm.dll", "dsound.dll", "d3d11.dll", "d3d9.dll", "unrealsdk.dll", "pyunrealsdk.dll"].iter().any(|name| leaf.eq_ignore_ascii_case(name))
            && (rule.destination.ends_with("/reframework/plugins") || rule.id == "oak-plugin") {
            entries.push(ArchiveInspectEntry { archive_path: source.relative_path, route_kind: "external-loader".into(), destination: "Install the matching runtime through its official installer".into(), confidence: "high".into(), reason: "A proxy/shared runtime DLL is not an ordinary mod plugin. Select the correct game/engine loader variant through its official installer.".into(), blocked: true, size_bytes: source.size_bytes });
            continue;
        }
        match resolve_destination_root(context, &rule.destination) {
            Ok(root) => {
                let relative = route_relative_path(rule, &source.relative_path, &all_paths, &display_name);
                let destination = root.join(safe_relative_path(&relative)?);
                matched_names.insert(if rule.name.trim().is_empty() { rule.id.clone() } else { rule.name.clone() });
                if !rule.required_dependency.trim().is_empty() && !rule.required_dependency.eq_ignore_ascii_case("none") {
                    required_dependencies.insert(rule.required_dependency.trim().to_string());
                }
                let owner = receipt_owners.get(&destination.display().to_string().to_ascii_lowercase()).map(String::as_str);
                let conflict = analyze_destination_conflict(&destination, owner, profile_conflict_policy(&rule.conflict_policy));
                let (blocked, confirmation, conflict_reason) = conflict.clone().unwrap_or((false, false, String::new()));
                if let Some((_, _, summary)) = conflict {
                    conflict_count += 1;
                    requires_overwrite_confirmation |= confirmation;
                    conflict_summary.push(format!("{}: {}", destination.display(), summary));
                }
                entries.push(ArchiveInspectEntry {
                    archive_path: source.relative_path,
                    route_kind: rule.id.clone(),
                    destination: destination.display().to_string(),
                    confidence: if rule.confidence >= 80 { "high" } else if rule.confidence >= 50 { "medium" } else { "low" }.to_string(),
                    reason: format!("Matched profile Mod Type '{}'.{}", if rule.name.trim().is_empty() { &rule.id } else { &rule.name }, if conflict_reason.is_empty() { String::new() } else { format!(" {}", conflict_reason) }),
                    blocked,
                    size_bytes: source.size_bytes,
                });
            }
            Err(error) => entries.push(ArchiveInspectEntry {
                archive_path: source.relative_path,
                route_kind: rule.id.clone(),
                destination: "Unresolved profile destination".to_string(),
                confidence: "none".to_string(),
                reason: error,
                blocked: true,
                size_bytes: source.size_bytes,
            }),
        }
    }
    if context.rules.is_empty() {
        warnings.push("This profile has no configured custom Mod Types with destinations.".to_string());
    }
    let duplicate_destinations = block_duplicate_destinations(&mut entries);
    if !duplicate_destinations.is_empty() {
        warnings.push(format!("Install blocked because multiple source files resolve to the same destination: {}.", duplicate_destinations.join(", ")));
    }
    let missing_dependencies = missing_dependencies_for_install(context, &required_dependencies);
    if !missing_dependencies.is_empty() {
        for entry in &mut entries {
            if !entry.blocked && entry.route_kind != "folder" {
                entry.blocked = true;
                entry.reason.push_str(&format!(" Install blocked until required dependencies are ready: {}.", missing_dependencies.join(", ")));
            }
        }
        warnings.push(format!("Install blocked by missing or unconfigured dependencies: {}.", missing_dependencies.join(", ")));
    }
    if conflict_count > 0 {
        warnings.push(format!("{} destination conflict(s) found. Tracked receipt ownership is never overwritten; eligible untracked files are backed up before replacement.", conflict_count));
    }
    let installable = entries.iter().filter(|entry| !entry.blocked && entry.route_kind != "folder").count();
    let incomplete_package = entries.iter().any(|entry| entry.blocked);
    let destination_preview = entries.iter().filter(|entry| !entry.blocked).map(|entry| entry.destination.clone()).collect::<BTreeSet<_>>().into_iter().collect::<Vec<_>>();
    let suggested_install_target = if matched_names.len() == 1 { matched_names.into_iter().next() } else if matched_names.len() > 1 { Some("Multiple profile Mod Types".to_string()) } else { None };
    let id = format!("drop-{}", SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_nanos()).unwrap_or(0));
    Ok(DragDropAnalysisItem {
        id,
        dropped_path: path.display().to_string(),
        display_name,
        archive_kind,
        profile_id: context.profile_id.clone(),
        game_id: context.game_id.clone(),
        original_sha256: if path.is_file() { sha256_file(path).ok() } else { None },
        entries,
        match_candidates: Vec::new(),
        suggested_match: None,
        confidence_level: if installable > 0 { "high" } else { "none" }.to_string(),
        suggested_install_target,
        destination_preview,
        warnings,
        conflict_count,
        requires_overwrite_confirmation,
        conflict_summary,
        blocked: installable == 0 || incomplete_package,
    })
}

fn analyze_builtin_payday3_path(path: &Path) -> Result<DragDropAnalysisItem, String> {
    let paths = detect_payday3_paths_internal().ok_or_else(|| "PAYDAY 3 was not detected. Set its game path first.".to_string())?;
    if path.is_dir() {
        return Err("PAYDAY 3 folder drops are not supported by the legacy router yet. Drop a ZIP or loose mod file.".to_string());
    }
    let display_name = path.file_stem().and_then(|value| value.to_str()).unwrap_or("Dropped Mod").to_string();
    let (archive_kind, mut entries, mut warnings) = inspect_staged_file(&paths, path, "Local drag-and-drop install")?;
    if let Err(error) = validate_payday_ue5_dependencies(&paths, &entries) {
        warnings.push(error.clone());
        for entry in &mut entries { if entry.route_kind != "folder" && !entry.blocked { entry.blocked = true; entry.reason = error.clone(); } }
    }
    let receipt_owners = receipt_owner_map(BUILTIN_PAYDAY3_PROFILE_ID)?;
    let mut conflict_count = 0usize;
    let mut requires_overwrite_confirmation = false;
    let mut conflict_summary = Vec::new();
    for entry in &mut entries {
        if entry.blocked || entry.route_kind == "folder" { continue; }
        let destination = PathBuf::from(&entry.destination);
        let owner = receipt_owners.get(&entry.destination.to_ascii_lowercase()).map(String::as_str);
        if let Some((blocked, confirmation, summary)) = analyze_destination_conflict(&destination, owner, ProfileConflictPolicy::Block) {
            entry.blocked |= blocked;
            entry.reason.push_str(&format!(" {}", summary));
            conflict_count += 1;
            requires_overwrite_confirmation |= confirmation;
            conflict_summary.push(format!("{}: {}", destination.display(), summary));
        }
    }
    if conflict_count > 0 {
        warnings.push(format!("{} destination conflict(s) found. Tracked receipt ownership is never overwritten.", conflict_count));
    }
    let duplicate_destinations = block_duplicate_destinations(&mut entries);
    if !duplicate_destinations.is_empty() {
        warnings.push(format!("Install blocked because multiple source files resolve to the same destination: {}.", duplicate_destinations.join(", ")));
    }
    let installable = entries.iter().filter(|entry| !entry.blocked && entry.route_kind != "folder").count();
    let destination_preview = entries.iter().filter(|entry| !entry.blocked && entry.route_kind != "folder").map(|entry| entry.destination.clone()).collect::<BTreeSet<_>>().into_iter().collect();
    Ok(DragDropAnalysisItem {
        id: format!("drop-{}", SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_nanos()).unwrap_or(0)),
        dropped_path: path.display().to_string(),
        display_name,
        archive_kind,
        profile_id: BUILTIN_PAYDAY3_PROFILE_ID.to_string(),
        game_id: "payday3".to_string(),
        original_sha256: sha256_file(path).ok(),
        entries,
        match_candidates: Vec::new(),
        suggested_match: None,
        confidence_level: if installable > 0 { "high" } else { "none" }.to_string(),
        suggested_install_target: Some("PAYDAY 3 detected paths".to_string()),
        destination_preview,
        warnings,
        conflict_count,
        requires_overwrite_confirmation,
        conflict_summary,
        blocked: installable == 0,
    })
}

#[tauri::command]
pub(crate) fn analyze_drag_drop_install(paths: Vec<String>, profile_id: String) -> Result<DragDropAnalysisResult, String> {
    let profile_id = clean_profile_id(&profile_id)?;
    if paths.is_empty() { return Err("Drop at least one file, folder, or ZIP archive.".to_string()); }
    let mut items = Vec::new();
    let mut warnings = Vec::new();
    let custom_context = if is_builtin_payday3_profile(Some(&profile_id)) { None } else { Some(load_profile_context(&profile_id)?) };
    for raw in paths {
        let path = PathBuf::from(raw.trim());
        let result = if let Some(context) = custom_context.as_ref() { analyze_custom_profile_path(context, &path) } else { analyze_builtin_payday3_path(&path) };
        match result {
            Ok(item) => items.push(item),
            Err(error) => warnings.push(format!("{}: {}", path.display(), error)),
        }
    }
    if items.is_empty() { return Err(warnings.join(" | ")); }
    let game_id = items.first().map(|item| item.game_id.clone()).unwrap_or_else(|| profile_id.clone());
    Ok(DragDropAnalysisResult { profile_id, game_id, items, warnings })
}

fn read_entry_bytes(item: &DragDropAnalysisItem, entry: &ArchiveInspectEntry) -> Result<Vec<u8>, String> {
    let source = PathBuf::from(&item.dropped_path);
    let relative = safe_relative_path(&entry.archive_path)?;
    match item.archive_kind.as_str() {
        "folder" => {
            let path = source.join(relative);
            if !path.starts_with(&source) { return Err(format!("Unsafe folder entry: {}", entry.archive_path)); }
            fs::read(&path).map_err(|error| format!("Failed to read {}: {}", path.display(), error))
        }
        "zip" => {
            let file = File::open(&source).map_err(|error| format!("Failed to open ZIP {}: {}", source.display(), error))?;
            let mut archive = ZipArchive::new(file).map_err(|error| format!("Failed to read ZIP {}: {}", source.display(), error))?;
            for index in 0..archive.len() {
                let mut archived = archive.by_index(index).map_err(|error| format!("Failed to read ZIP entry {}: {}", index, error))?;
                if normalize_archive_path(archived.name()) == entry.archive_path {
                    let mut bytes = Vec::with_capacity(archived.size().min(32 * 1024 * 1024) as usize);
                    archived.read_to_end(&mut bytes).map_err(|error| format!("Failed to extract {}: {}", entry.archive_path, error))?;
                    return Ok(bytes);
                }
            }
            Err(format!("ZIP entry was not found: {}", entry.archive_path))
        }
        "file" => fs::read(&source).map_err(|error| format!("Failed to read {}: {}", source.display(), error)),
        "7z" | "rar" | "tar" | "gz" | "xz" => {
            let extracted = extract_external_archive(&source, "profile-install")?;
            let result = fs::read(extracted.join(relative)).map_err(|error| format!("Failed to extract {}: {}", entry.archive_path, error));
            let mut warnings = Vec::new();
            cleanup_temp_extraction_folder(&extracted, &mut warnings);
            result
        }
        other => Err(format!("{} installs are not enabled for universal profiles yet.", other.to_ascii_uppercase())),
    }
}

fn write_profile_receipt(
    profile_id: &str,
    request: &DragDropInstallRequest,
    files: &[AppliedInstallFile],
    backups: &[OverwriteBackup],
) -> Result<String, String> {
    let source = request.selected_match.as_ref().map(|value| value.source.clone()).filter(|_| !request.install_as_local).unwrap_or_else(|| "local".to_string());
    let source_mod_id = request.selected_match.as_ref().map(|value| value.source_id.clone()).filter(|_| !request.install_as_local).or_else(|| Some(request.item.id.clone()));
    let source_file_id = request.selected_match.as_ref().and_then(|value| value.file_id.clone()).filter(|_| !request.install_as_local);
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_nanos()).unwrap_or(0);
    let receipt_id = format!("{}_{}_{}", sanitize_file_component(&source), sanitize_file_component(&request.display_name), stamp);
    let receipt = InstallReceipt {
        id: receipt_id.clone(),
        display_name: request.display_name.trim().to_string(),
        source: source.clone(),
        mod_type: request.item.suggested_install_target.clone().unwrap_or_else(|| "profile-install".to_string()),
        source_mod_id,
        source_file_id,
        source_file_name: Path::new(&request.item.dropped_path).file_name().and_then(|value| value.to_str()).map(ToOwned::to_owned),
        source_file_category: None,
        source_file_uploaded_at: None,
        source_file_version: None,
        version: clean_text(request.version_override.clone()).or_else(|| request.selected_match.as_ref().and_then(|value| value.version.clone())),
        author: request.selected_match.as_ref().and_then(|value| value.author.clone()),
        thumbnail_url: clean_text(request.thumbnail_override.clone()).or_else(|| request.selected_match.as_ref().and_then(|value| value.thumbnail_url.clone())),
        banner_url: None,
        page_url: request.selected_match.as_ref().and_then(|value| value.page_url.clone()),
        installed_at_unix: Some(now_unix_seconds()),
        enabled: Some(true),
        profile_id: Some(profile_id.to_string()),
        notes: clean_text(request.notes.clone()),
        files: files.iter().map(|file| InstallReceiptFile {
            relative_path: file.destination.clone(),
            size_bytes: Some(file.size_bytes),
            sha256: sha256_file(Path::new(&file.destination)).ok(),
            original_path: backups.iter().find(|backup| backup.original_path.eq_ignore_ascii_case(&file.destination)).map(|backup| backup.original_path.clone()),
            backup_path: backups.iter().find(|backup| backup.original_path.eq_ignore_ascii_case(&file.destination)).map(|backup| backup.backup_path.clone()),
        }).collect(),
    };
    let path = profile_receipt_path(profile_id, &receipt_id)?;
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|error| format!("Failed to create profile receipt folder: {}", error))?; }
    let contents = serde_json::to_string_pretty(&receipt).map_err(|error| format!("Failed to serialize profile receipt: {}", error))?;
    fs::write(&path, contents).map_err(|error| format!("Failed to write profile receipt {}: {}", path.display(), error))?;
    let _ = source_catalog::index_receipt(profile_id, &receipt);
    Ok(path.display().to_string())
}

fn rollback_profile_install(files: &[AppliedInstallFile], backups: &[OverwriteBackup]) -> Vec<String> {
    let mut errors = Vec::new();
    for file in files.iter().rev() {
        let path = Path::new(&file.destination);
        if path.is_file() {
            if let Err(error) = fs::remove_file(path) {
                errors.push(format!("Failed to remove {} during rollback: {}", path.display(), error));
            }
        }
    }
    for backup in backups.iter().rev() {
        let original = PathBuf::from(&backup.original_path);
        let stored = PathBuf::from(&backup.backup_path);
        if original.is_file() {
            if let Err(error) = fs::remove_file(&original) {
                errors.push(format!("Failed to clear {} before rollback restore: {}", original.display(), error));
                continue;
            }
        }
        if stored.is_file() {
            if let Err(error) = move_file_to_target(&stored, &original) {
                errors.push(format!("Failed to restore {} from backup: {}", original.display(), error));
            }
        }
    }
    errors
}

#[tauri::command]
pub(crate) fn install_drag_drop_item(request: DragDropInstallRequest) -> Result<InstallApplyResult, String> {
    if let Some(message) = runtime_mutation_locked_message() { return Err(message); }
    let profile_id = clean_profile_id(&request.item.profile_id)?;
    if request.display_name.trim().is_empty() { return Err("A display name is required before installing.".to_string()); }
    if request.item.blocked { return Err("Install blocked: the package contains unsupported files, unresolved routes, dependencies or conflicts. Review the archive before installing.".to_string()); }
    let custom_context = if is_builtin_payday3_profile(Some(&profile_id)) { None } else { Some(load_profile_context(&profile_id)?) };
    let roots = if is_builtin_payday3_profile(Some(&profile_id)) {
        let paths = detect_payday3_paths_internal().ok_or_else(|| "PAYDAY 3 was not detected.".to_string())?;
        validate_payday_ue5_dependencies(&paths, &request.item.entries)?;
        vec![paths.game_root, paths.pak_mods, paths.win64]
    } else {
        allowed_profile_roots(custom_context.as_ref().expect("custom profile context"))?
    };
    let installable = request.item.entries.iter().filter(|entry| !entry.blocked && entry.route_kind != "folder").collect::<Vec<_>>();
    if installable.is_empty() { return Err("This drop has no safe, matched files to install.".to_string()); }
    if let Some(context) = custom_context.as_ref() {
        let required = installable.iter().filter_map(|entry| context.rules.iter().find(|rule| rule.id == entry.route_kind)).filter_map(|rule| clean_text(Some(rule.required_dependency.clone()))).filter(|value| !value.eq_ignore_ascii_case("none")).collect::<BTreeSet<_>>();
        let missing = missing_dependencies_for_install(context, &required);
        if !missing.is_empty() { return Err(format!("Install blocked because required dependencies are missing or unconfigured: {}.", missing.join(", "))); }
    }
    let receipt_owners = receipt_owner_map(&profile_id)?;
    let mut planned_destinations = BTreeSet::new();
    for entry in &installable {
        let destination = PathBuf::from(&entry.destination);
        if !destination_is_allowed(&destination, &roots) { return Err(format!("Refused destination outside approved profile roots: {}", destination.display())); }
        let destination_key = entry.destination.to_ascii_lowercase();
        if !planned_destinations.insert(destination_key.clone()) { return Err(format!("The install contains more than one file routed to {}. Adjust the profile Mod Type so every source file has a unique destination.", destination.display())); }
        if let Some(owner) = receipt_owners.get(&destination_key) { return Err(format!("{} is already owned by the tracked install '{}'. Uninstall that mod before replacing this path.", destination.display(), owner)); }
        if destination.is_dir() { return Err(format!("The install target is an existing folder, not a file: {}", destination.display())); }
        if destination.is_file() {
            let policy = custom_context.as_ref()
                .and_then(|context| context.rules.iter().find(|rule| rule.id == entry.route_kind))
                .map(|rule| profile_conflict_policy(&rule.conflict_policy))
                .unwrap_or(ProfileConflictPolicy::Block);
            if policy == ProfileConflictPolicy::Block { return Err(format!("A file already exists at {} and this Mod Type blocks replacement.", destination.display())); }
            if policy == ProfileConflictPolicy::Ask && !request.allow_overwrite { return Err(format!("Confirm backup and replacement before overwriting {}.", destination.display())); }
        }
    }
    let mut installed_files = Vec::new();
    let mut backups = Vec::new();
    let backup_root = ensure_profile_data_dirs(&profile_id)?
        .join("backups")
        .join("install-overwrites")
        .join(format!("{}-{}", sanitize_file_component(&request.display_name), current_timestamp()));
    // External formats are extracted once per transaction, not once per installed file.
    let extracted = if matches!(request.item.archive_kind.as_str(), "7z" | "rar" | "tar" | "gz" | "xz") {
        Some(extract_external_archive(Path::new(&request.item.dropped_path), "profile-install")?)
    } else { None };
    let result = (|| -> Result<(), String> {
        for (index, entry) in installable.into_iter().enumerate() {
            let destination = PathBuf::from(&entry.destination);
            let bytes = if let Some(root) = extracted.as_ref() {
                fs::read(root.join(safe_relative_path(&entry.archive_path)?)).map_err(|error| format!("Failed to read extracted file {}: {}", entry.archive_path, error))?
            } else { read_entry_bytes(&request.item, entry)? };
            if destination.is_file() {
                let backup_path = backup_root.join(format!("{:04}", index)).join(destination.file_name().unwrap_or_default());
                move_file_to_target(&destination, &backup_path)?;
                backups.push(OverwriteBackup { original_path: destination.display().to_string(), backup_path: backup_path.display().to_string() });
            }
            if let Some(parent) = destination.parent() { fs::create_dir_all(parent).map_err(|error| format!("Failed to create {}: {}", parent.display(), error))?; }
            fs::write(&destination, bytes).map_err(|error| format!("Failed to install {}: {}", destination.display(), error))?;
            installed_files.push(AppliedInstallFile { archive_path: entry.archive_path.clone(), destination: destination.display().to_string(), size_bytes: entry.size_bytes });
        }
        Ok(())
    })();
    if let Some(root) = extracted.as_ref() { cleanup_temp_extraction_folder(root, &mut Vec::new()); }
    if let Err(error) = result {
        let rollback_errors = rollback_profile_install(&installed_files, &backups);
        return Err(format!("Install rolled back after an error: {}{}", error, if rollback_errors.is_empty() { String::new() } else { format!(" Rollback errors: {}", rollback_errors.join(" | ")) }));
    }
    let receipt_path = match write_profile_receipt(&profile_id, &request, &installed_files, &backups) {
        Ok(path) => path,
        Err(error) => {
            let rollback_errors = rollback_profile_install(&installed_files, &backups);
            return Err(format!("Install rolled back because the receipt could not be written: {}{}", error, if rollback_errors.is_empty() { String::new() } else { format!(" Rollback errors: {}", rollback_errors.join(" | ")) }));
        }
    };
    if !is_builtin_payday3_profile(Some(&profile_id)) { let _ = sync_profile_installed_state(&profile_id); } else { let _ = sync_installed_state_database(); }
    let replaced_files = backups.iter().map(|backup| backup.original_path.clone()).collect::<Vec<_>>();
    let mut warnings = vec![format!("Installed with profile-scoped receipt ownership for {}.", profile_id)];
    if !backups.is_empty() { warnings.push(format!("Backed up {} replaced file(s); uninstall restores them to their exact original paths.", backups.len())); }
    Ok(InstallApplyResult { mod_name: request.display_name.trim().to_string(), installed_files, replaced_files, receipt_path, warnings })
}

pub(crate) fn list_profile_receipts_internal(profile_id: &str) -> Result<Vec<InstallReceipt>, String> {
    let profile_id = clean_profile_id(profile_id)?;
    if is_builtin_payday3_profile(Some(&profile_id)) {
        let paths = detect_payday3_paths_internal();
        let mut receipts = list_install_receipts_internal()?;
        for receipt in &mut receipts {
            receipt.profile_id.get_or_insert_with(|| BUILTIN_PAYDAY3_PROFILE_ID.to_string());
            receipt.enabled = paths.as_ref().map(|paths| receipt_enabled_internal(paths, receipt));
        }
        return Ok(receipts);
    }
    let root = profile_receipts_dir(&profile_id)?;
    fs::create_dir_all(&root).map_err(|error| format!("Failed to create profile receipt folder: {}", error))?;
    let mut receipts = Vec::new();
    for entry in fs::read_dir(&root).map_err(|error| format!("Failed to read profile receipts: {}", error))? {
        let path = entry.map_err(|error| format!("Failed to read profile receipt entry: {}", error))?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") { continue; }
        let Ok(contents) = fs::read_to_string(&path) else { continue; };
        let Ok(mut receipt) = serde_json::from_str::<InstallReceipt>(&contents) else { continue; };
        if receipt.profile_id.as_deref().is_some_and(|owner| owner != profile_id) { continue; }
        receipt.profile_id = Some(profile_id.clone());
        receipt.enabled = Some(profile_receipt_enabled(&profile_id, &receipt));
        receipts.push(receipt);
    }
    receipts.sort_by(|left, right| left.display_name.to_ascii_lowercase().cmp(&right.display_name.to_ascii_lowercase()));
    Ok(receipts)
}

pub(crate) fn enabled_profile_receipt_ids(profile_id: &str) -> Result<Vec<String>, String> {
    Ok(list_profile_receipts_internal(profile_id)?
        .into_iter()
        .filter(|receipt| receipt.enabled.unwrap_or_else(|| profile_receipt_enabled(profile_id, receipt)))
        .map(|receipt| receipt.id)
        .collect())
}

fn disabled_manifest(profile_id: &str, receipt: &InstallReceipt) -> Option<DisabledInstallManifest> {
    profile_disabled_manifest_path(profile_id, &receipt.id).ok().and_then(|path| read_disabled_manifest(&path))
}

pub(crate) fn profile_receipt_enabled(profile_id: &str, receipt: &InstallReceipt) -> bool {
    if disabled_manifest(profile_id, receipt).is_some() { return false; }
    receipt.files.iter().any(|file| Path::new(&file.relative_path).is_file())
}

fn validate_receipt_paths(receipt: &InstallReceipt, roots: &[PathBuf]) -> Result<(), String> {
    for file in &receipt.files {
        let path = PathBuf::from(&file.relative_path);
        if !destination_is_allowed(&path, roots) { return Err(format!("Receipt contains a path outside approved profile roots: {}", path.display())); }
    }
    Ok(())
}

fn toggle_receipt_files(receipt: &InstallReceipt, disabled_root: &Path, roots: &[PathBuf], enabled: bool) -> Result<usize, String> {
    validate_receipt_paths(receipt, roots)?;
    let manifest_path = disabled_root.join("tsuki-disabled.json");
    if enabled {
        let manifest = read_disabled_manifest(&manifest_path).ok_or_else(|| format!("{} is already enabled or its disabled manifest is missing.", receipt.display_name))?;
        for record in &manifest.files {
            let source = PathBuf::from(&record.disabled_path);
            let destination = PathBuf::from(&record.original_path);
            if !source.starts_with(disabled_root) { return Err(format!("Disabled file escaped profile storage: {}", source.display())); }
            if !destination_is_allowed(&destination, roots) { return Err(format!("Restore destination escaped approved roots: {}", destination.display())); }
            if destination.exists() { return Err(format!("Cannot enable because a file already exists at {}.", destination.display())); }
        }
        let mut moved_records: Vec<(PathBuf, PathBuf)> = Vec::new();
        for record in &manifest.files {
            let source = PathBuf::from(&record.disabled_path);
            let destination = PathBuf::from(&record.original_path);
            if !source.exists() { continue; }
            if let Err(error) = move_file_to_target(&source, &destination) {
                let mut rollback_errors = Vec::new();
                for moved in moved_records.iter().rev() {
                    if let Err(rollback_error) = move_file_to_target(&moved.1, &moved.0) {
                        rollback_errors.push(rollback_error);
                    }
                }
                return Err(format!("Enable failed while restoring {}: {}{}", destination.display(), error, if rollback_errors.is_empty() { String::new() } else { format!(" Rollback errors: {}", rollback_errors.join(" | ")) }));
            }
            moved_records.push((source, destination));
        }
        let _ = fs::remove_file(&manifest_path);
        return Ok(moved_records.len());
    }
    if manifest_path.exists() { return Ok(0); }
    let mut records = Vec::new();
    for (index, file) in receipt.files.iter().enumerate() {
        let source = PathBuf::from(&file.relative_path);
        if !source.is_file() { continue; }
        let file_name = source.file_name().and_then(|value| value.to_str()).unwrap_or("file");
        let destination = disabled_root.join(format!("{:04}", index)).join(file_name);
        records.push(DisabledInstallFileRecord { original_path: source.display().to_string(), disabled_path: destination.display().to_string() });
    }
    if records.is_empty() { return Err(format!("No installed files for {} were found at their receipt paths.", receipt.display_name)); }
    let mut moved_records: Vec<(PathBuf, PathBuf)> = Vec::new();
    for record in &records {
        let source = PathBuf::from(&record.original_path);
        let destination = PathBuf::from(&record.disabled_path);
        if let Err(error) = move_file_to_target(&source, &destination) {
            let mut rollback_errors = Vec::new();
            for moved in moved_records.iter().rev() {
                if let Err(rollback_error) = move_file_to_target(&moved.1, &moved.0) {
                    rollback_errors.push(rollback_error);
                }
            }
            return Err(format!("Disable failed while moving {}: {}{}", source.display(), error, if rollback_errors.is_empty() { String::new() } else { format!(" Rollback errors: {}", rollback_errors.join(" | ")) }));
        }
        moved_records.push((source, destination));
    }
    write_disabled_manifest(&manifest_path, &DisabledInstallManifest { receipt_id: receipt.id.clone(), display_name: receipt.display_name.clone(), disabled_at_unix: now_unix_seconds(), files: records.clone() })?;
    Ok(records.len())
}

pub(crate) fn set_profile_receipt_enabled_internal(profile_id: &str, receipt_id: &str, enabled: bool) -> Result<String, String> {
    if let Some(message) = runtime_mutation_locked_message() { return Err(message); }
    let context = load_profile_context(profile_id)?;
    let receipt = list_profile_receipts_internal(&context.profile_id)?.into_iter().find(|receipt| receipt.id == receipt_id).ok_or_else(|| format!("Profile receipt was not found: {}", receipt_id))?;
    let roots = allowed_profile_roots(&context)?;
    let disabled_root = profile_disabled_root(&context.profile_id, &receipt.id)?;
    let moved = toggle_receipt_files(&receipt, &disabled_root, &roots, enabled)?;
    sync_profile_installed_state(&context.profile_id)?;
    Ok(format!("{} {} by moving {} tracked file(s).", if enabled { "Enabled" } else { "Disabled" }, receipt.display_name, moved))
}

pub(crate) fn apply_profile_receipt_selection(profile_id: &str, enabled_receipt_ids: &[String]) -> Result<usize, String> {
    if let Some(message) = runtime_mutation_locked_message() { return Err(message); }
    let context = load_profile_context(profile_id)?;
    let roots = allowed_profile_roots(&context)?;
    let receipts = list_profile_receipts_internal(&context.profile_id)?;
    let mut changed = Vec::<(InstallReceipt, bool)>::new();
    for receipt in receipts {
        let was_enabled = receipt.enabled.unwrap_or_else(|| profile_receipt_enabled(&context.profile_id, &receipt));
        let should_enable = enabled_receipt_ids.iter().any(|id| id == &receipt.id);
        if was_enabled == should_enable { continue; }
        let disabled_root = profile_disabled_root(&context.profile_id, &receipt.id)?;
        if let Err(error) = toggle_receipt_files(&receipt, &disabled_root, &roots, should_enable) {
            let mut rollback_errors = Vec::new();
            for (changed_receipt, previous_state) in changed.iter().rev() {
                let root = profile_disabled_root(&context.profile_id, &changed_receipt.id)?;
                if let Err(rollback_error) = toggle_receipt_files(changed_receipt, &root, &roots, *previous_state) {
                    rollback_errors.push(rollback_error);
                }
            }
            let _ = sync_profile_installed_state(&context.profile_id);
            return Err(format!("Profile apply stopped at {}: {}{}", receipt.display_name, error, if rollback_errors.is_empty() { String::new() } else { format!(" Rollback errors: {}", rollback_errors.join(" | ")) }));
        }
        changed.push((receipt, was_enabled));
    }
    sync_profile_installed_state(&context.profile_id)?;
    Ok(changed.len())
}

pub(crate) fn remove_profile_receipt_internal(profile_id: &str, receipt_id: &str) -> Result<String, String> {
    let receipt = list_profile_receipts_internal(profile_id)?.into_iter().find(|receipt| receipt.id == receipt_id).ok_or_else(|| format!("Profile receipt was not found: {}", receipt_id))?;
    if receipt.files.iter().any(|file| file.backup_path.is_some()) {
        return Err(format!("{} owns overwrite backups. Uninstall it to restore those files before removing its receipt.", receipt.display_name));
    }
    let path = profile_receipt_path(profile_id, &receipt.id)?;
    if path.exists() { fs::remove_file(&path).map_err(|error| format!("Failed to remove receipt {}: {}", path.display(), error))?; }
    let _ = sync_profile_installed_state(profile_id);
    Ok(format!("Removed receipt for {}. Installed files were not deleted.", receipt.display_name))
}

pub(crate) fn uninstall_profile_receipt_internal(profile_id: &str, receipt_id: &str) -> Result<String, String> {
    if let Some(message) = runtime_mutation_locked_message() { return Err(message); }
    let context = load_profile_context(profile_id)?;
    let receipt = list_profile_receipts_internal(&context.profile_id)?.into_iter().find(|receipt| receipt.id == receipt_id).ok_or_else(|| format!("Profile receipt was not found: {}", receipt_id))?;
    let allowed_roots = allowed_profile_roots(&context)?;
    validate_receipt_paths(&receipt, &allowed_roots)?;
    let holding = ensure_profile_data_dirs(&context.profile_id)?.join("uninstalled").join(format!("{}-{}", sanitize_file_component(&receipt.display_name), current_timestamp()));
    let backup_root = ensure_profile_data_dirs(&context.profile_id)?.join("backups").join("install-overwrites");
    for file in &receipt.files {
        let (Some(original_path), Some(backup_path)) = (file.original_path.as_deref(), file.backup_path.as_deref()) else { continue; };
        let original = PathBuf::from(original_path);
        let backup = PathBuf::from(backup_path);
        if !destination_is_allowed(&original, &allowed_roots) { return Err(format!("Overwrite restore destination escaped approved profile roots: {}", original.display())); }
        if !backup.starts_with(&backup_root) { return Err(format!("Overwrite backup escaped profile backup storage: {}", backup.display())); }
        if !backup.is_file() { return Err(format!("Overwrite backup is missing; uninstall was not started: {}", backup.display())); }
    }
    let mut removed = 0usize;
    let mut restored = 0usize;
    let mut candidates = receipt.files.iter().map(|file| PathBuf::from(&file.relative_path)).collect::<Vec<_>>();
    if let Some(manifest) = disabled_manifest(&context.profile_id, &receipt) { candidates.extend(manifest.files.into_iter().map(|record| PathBuf::from(record.disabled_path))); }
    for path in candidates {
        if !path.is_file() { continue; }
        if keep_uninstalled_mods_enabled() {
            let target = holding.join(format!("{:04}", removed)).join(path.file_name().unwrap_or_default());
            move_file_to_target(&path, &target)?;
        } else {
            fs::remove_file(&path).map_err(|error| format!("Failed to remove {}: {}", path.display(), error))?;
        }
        removed += 1;
    }
    for file in &receipt.files {
        let (Some(original_path), Some(backup_path)) = (file.original_path.as_deref(), file.backup_path.as_deref()) else { continue; };
        let original = PathBuf::from(original_path);
        let backup = PathBuf::from(backup_path);
        if original.exists() { return Err(format!("Cannot restore overwrite backup because a file now exists at {}.", original.display())); }
        move_file_to_target(&backup, &original)?;
        restored += 1;
    }
    let receipt_path = profile_receipt_path(&context.profile_id, &receipt.id)?;
    let _ = fs::remove_file(receipt_path);
    let disabled_root = profile_disabled_root(&context.profile_id, &receipt.id)?;
    let _ = fs::remove_dir_all(disabled_root);
    sync_profile_installed_state(&context.profile_id)?;
    Ok(format!("Uninstalled {}. {} tracked file(s) {}; {} overwritten file(s) restored.", receipt.display_name, removed, if keep_uninstalled_mods_enabled() { "moved to profile uninstalled storage" } else { "deleted" }, restored))
}

pub(crate) fn find_profile_receipt_by_source(profile_id: &str, source: &str, source_id: &str) -> Result<InstallReceipt, String> {
    list_profile_receipts_internal(profile_id)?.into_iter().find(|receipt| receipt.source.eq_ignore_ascii_case(source) && receipt.source_mod_id.as_deref() == Some(source_id)).ok_or_else(|| format!("No {} receipt was found for source id {}.", source, source_id))
}

pub(crate) fn list_profile_managed_installs_internal(profile_id: &str) -> Result<Vec<ManagedInstallInfo>, String> {
    let mut installs = list_profile_receipts_internal(profile_id)?.into_iter().map(|receipt| {
        let file_count = receipt.files.len();
        ManagedInstallInfo {
            id: receipt.id.clone(),
            display_name: receipt.display_name.clone(),
            source: receipt.source.clone(),
            source_mod_id: receipt.source_mod_id.clone(),
            source_file_id: receipt.source_file_id.clone(),
            page_url: receipt.page_url.clone(),
            enabled: receipt.enabled.unwrap_or(false),
            file_count,
            pak_file_count: receipt.files.iter().filter(|file| receipt_is_pak_file_path(&file.relative_path)).count(),
            non_pak_file_count: receipt.files.iter().filter(|file| !receipt_is_pak_file_path(&file.relative_path)).count(),
            disabled_folder: profile_disabled_root(profile_id, &receipt.id).map(|path| path.display().to_string()).unwrap_or_default(),
        }
    }).collect::<Vec<_>>();
    installs.sort_by(|left, right| left.display_name.to_ascii_lowercase().cmp(&right.display_name.to_ascii_lowercase()));
    Ok(installs)
}

fn installed_record_from_profile_receipt(profile_id: &str, receipt: &InstallReceipt) -> InstalledStateRecord {
    let manifest = disabled_manifest(profile_id, receipt);
    let files = receipt.files.iter().map(|file| {
        let path = PathBuf::from(&file.relative_path);
        let disabled = manifest.as_ref().is_some_and(|manifest| manifest.files.iter().any(|record| record.original_path.eq_ignore_ascii_case(&file.relative_path) && Path::new(&record.disabled_path).is_file()));
        InstalledStateFile {
            relative_path: file.relative_path.clone(),
            location: path.parent().map(|parent| parent.display().to_string()).unwrap_or_else(|| "unknown".to_string()),
            file_name: path.file_name().and_then(|value| value.to_str()).unwrap_or("unknown").to_string(),
            file_type: installed_state_file_type(&file.relative_path),
            size_bytes: file.size_bytes,
            sha256: file.sha256.clone(),
            live: path.is_file() || disabled,
        }
    }).collect::<Vec<_>>();
    let first = files.first();
    InstalledStateRecord {
        uid: receipt.id.clone(),
        id: receipt.source_mod_id.clone().unwrap_or_else(|| receipt.id.clone()),
        name: receipt.display_name.clone(),
        source: receipt.source.clone(),
        version: receipt.version.clone(),
        author: receipt.author.clone(),
        filename: first.map(|file| file.file_name.clone()).unwrap_or_else(|| receipt.display_name.clone()),
        file_id: receipt.source_file_id.clone(),
        file_type: first.map(|file| file.file_type.clone()).unwrap_or_else(|| "unknown".to_string()),
        sha256: first.and_then(|file| file.sha256.clone()),
        folder_id: sanitize_file_component(&receipt.display_name),
        location: first.map(|file| file.location.clone()).unwrap_or_else(|| "unknown".to_string()),
        receipt_id: Some(receipt.id.clone()),
        source_mod_id: receipt.source_mod_id.clone(),
        source_file_id: receipt.source_file_id.clone(),
        source_file_name: receipt.source_file_name.clone(),
        source_file_category: receipt.source_file_category.clone(),
        source_file_uploaded_at: receipt.source_file_uploaded_at.clone(),
        source_file_version: receipt.source_file_version.clone(),
        page_url: receipt.page_url.clone(),
        thumbnail_url: receipt.thumbnail_url.clone(),
        banner_url: receipt.banner_url.clone(),
        enabled: receipt.enabled.unwrap_or(false),
        installed_at_unix: receipt.installed_at_unix,
        files,
    }
}

pub(crate) fn sync_profile_installed_state(profile_id: &str) -> Result<Vec<InstalledStateRecord>, String> {
    let receipts = list_profile_receipts_internal(profile_id)?;
    let mut records = receipts.iter().map(|receipt| installed_record_from_profile_receipt(profile_id, receipt))
        .filter(|record| record.files.iter().any(|file| file.live)).collect::<Vec<_>>();
    records.sort_by(|left, right| left.name.to_ascii_lowercase().cmp(&right.name.to_ascii_lowercase()));
    let database = InstalledStateDatabase { version: 1, records: records.clone() };
    let path = profile_installed_state_path(profile_id)?;
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|error| format!("Failed to create installed-state folder: {}", error))?; }
    fs::write(&path, serde_json::to_string_pretty(&database).map_err(|error| format!("Failed to serialize installed state: {}", error))?).map_err(|error| format!("Failed to write {}: {}", path.display(), error))?;
    Ok(records)
}

fn external_manager_for_profile(profile_id: &str) -> Option<&'static str> {
    match profile_id {
        "builtin.spider-man-remastered" | "builtin.spider-man-2" => Some("Overstrike"),
        "builtin.resident-evil-7" | "builtin.resident-evil-village" | "builtin.resident-evil-requiem" | "builtin.monster-hunter-wilds" => Some("Fluffy Mod Manager"),
        "builtin.borderlands2" => Some("OpenBLCMM"),
        "builtin.payday-the-heist" => Some("PDMod conversion"),
        _ => None,
    }
}

fn external_manager_for_package(profile_id: &str, file: &Path) -> Option<&'static str> {
    let manager = external_manager_for_profile(profile_id)?;
    if manager == "Fluffy Mod Manager" {
        if let Ok((_, entries, _)) = inspect_profile_source(file) {
            if entries.iter().any(|entry| entry.relative_path.rsplit('/').next().is_some_and(|leaf| ["dinput8.dll", "dxgi.dll"].iter().any(|name| leaf.eq_ignore_ascii_case(name)))) {
                return Some("REFramework runtime review");
            }
        }
    }
    if profile_id == "builtin.borderlands2" || profile_id == "builtin.payday-the-heist" {
        let (_, entries, _) = inspect_profile_source(file).ok()?;
        if profile_id == "builtin.payday-the-heist" && entries.iter().any(|entry| entry.relative_path.to_ascii_lowercase().ends_with("/mod.lua"))
            && entries.iter().any(|entry| entry.relative_path.to_ascii_lowercase().contains("/assets/mod_overrides/")) {
            return Some("Mod Organizer 2 (PDTH)");
        }
        let extension = if profile_id == "builtin.borderlands2" { ".blcm" } else { ".pdmod" };
        if !entries.iter().any(|entry| entry.relative_path.to_ascii_lowercase().ends_with(extension)) { return None; }
        if entries.iter().any(|entry| entry.relative_path.to_ascii_lowercase().ends_with(".sav")) { return None; }
    }
    Some(manager)
}

#[tauri::command]
pub(crate) async fn get_external_manager_target(profile_id: String, staged_file_path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
    let profile_id = clean_profile_id(&profile_id)?;
    let staging = downloads_cache_dir()?.join(sanitize_file_component(&profile_id)).canonicalize().map_err(|error| error.to_string())?;
    let file = Path::new(&staged_file_path).canonicalize().map_err(|error| error.to_string())?;
    if !file.is_file() || !file.starts_with(staging) { return Err("This package does not belong to the current profile.".into()); }
    Ok(external_manager_for_package(&profile_id, &file).map(str::to_owned))
    }).await.map_err(|error| error.to_string())?
}

fn prepare_external_handoff_internal(profile_id: &str, file: &Path) -> Result<PathBuf, String> {
    let profile_id = clean_profile_id(profile_id)?;
    let staging = downloads_cache_dir()?.join(sanitize_file_component(&profile_id)).canonicalize()
        .map_err(|error| format!("Profile staging is unavailable: {}", error))?;
    let source = file.canonicalize().map_err(|error| format!("Downloaded package is unavailable: {}", error))?;
    if !source.starts_with(&staging) || !source.is_file() { return Err("Only a downloaded file belonging to this profile can be handed off.".into()); }
    let manager = external_manager_for_package(&profile_id, &source).ok_or("This package has no supported external-manager handoff.")?;
    if !matches!(source.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase().as_str(), "zip" | "rar" | "7z" | "smpcmod" | "suit" | "stage" | "modular" | "script" | "blcm" | "pdmod") {
        return Err("This file is not a supported external-manager package.".into());
    }
    let hash = sha256_file(&source)?;
    let folder = ensure_profile_data_dirs(&profile_id)?.join("manager-handoffs").join(&hash[..16]);
    fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
    let destination = folder.join(source.file_name().ok_or("Package has no filename.")?);
    if destination.exists() {
        if sha256_file(&destination)? != hash { return Err("Existing handoff package differs; refusing to overwrite it.".into()); }
    } else {
        fs::copy(&source, &destination).map_err(|error| format!("Could not copy the manager package: {}", error))?;
        if sha256_file(&destination)? != hash { return Err("Manager package hash verification failed.".into()); }
    }
    let instructions = match manager {
        "Mod Organizer 2 (PDTH)" => "Import the original mixed DAHM/override archive into Mod Organizer 2 with the PAYDAY: The Heist plugin configured. Install the required DAHM and PDTHModOverrides runtimes separately. Preserve both the authored mods and assets/mod_overrides trees. See https://wiki.modworkshop.net/books/using-mo2-with-games/page/payday-1-payday-2-and-raid-wwii . This archive has not been installed by Tsuki.",
        "REFramework runtime review" => "Choose the correct game and engine variant from https://github.com/praydog/REFramework/releases. The root proxy is not a Fluffy asset mod or a reframework/plugins DLL. This archive has not been installed by Tsuki.",
        "OpenBLCMM" => "Open the contained .blcm file in OpenBLCMM, select the matching Borderlands 2 configuration, and export a patch following that manager's instructions. Do not copy .blcm files into sdk_mods or overwrite saves.",
        "PDMod conversion" => "Follow https://modworkshop.net/mod/53474 for the author's legacy PDMod-to-mod_overrides conversion. The encrypted package must be converted before use; install the matching PDTHModOverrides loader first. Tsuki has preserved the original archive, not converted or installed it.",
        _ => "Import the unchanged archive into the named manager with the matching game selected. This copy is not an installed mod.",
    };
    let manifest = serde_json::json!({"profileId": profile_id, "manager": manager, "source": source, "package": destination, "sha256": hash, "state": "awaiting-external-import", "installed": false, "instructions":instructions});
    fs::write(folder.join("IMPORT-INSTRUCTIONS.txt"), instructions).map_err(|error| error.to_string())?;
    fs::write(folder.join("handoff.json"), serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
    Ok(folder)
}

#[tauri::command]
pub(crate) async fn prepare_external_manager_handoff(profile_id: String, staged_file_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder = prepare_external_handoff_internal(&profile_id, Path::new(&staged_file_path))?;
        open_folder_in_explorer(&folder, "external manager package")?;
        let manifest: serde_json::Value = serde_json::from_slice(&fs::read(folder.join("handoff.json")).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
        Ok(format!("Package ready for {} in {}. Follow IMPORT-INSTRUCTIONS.txt; it has not been installed by Tsuki.", manifest["manager"].as_str().unwrap_or("external manager"), folder.display()))
    }).await.map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pdth_assets_preserve_the_package_root_and_require_override_loader() {
        let root = temp_root("pdth-assets");
        let game = root.join("game");
        let package = root.join("package");
        fs::create_dir_all(&game).unwrap();
        fs::create_dir_all(package.join("release/Heavier SWAT/units/characters")).unwrap();
        fs::write(package.join("release/Heavier SWAT/units/characters/swat.model"), b"fixture-asset").unwrap();
        let draft = builtin_install_definition("builtin.payday-the-heist", Some(&game)).unwrap();
        let rules = serde_json::from_value(draft["customFileTypes"].clone()).unwrap();
        let context = ProfileInstallContext { profile_id:"test.pdth-assets".into(), game_id:"pdth".into(), game_root:game.clone(), executable_dir:game.clone(), draft, rules };
        assert!(analyze_custom_profile_path(&context, &package).unwrap().blocked);
        for name in ["DINPUT8.dll", "PDTHModOverrides.dll"] { fs::write(game.join(name), b"fixture-loader").unwrap(); }
        let analysis = analyze_custom_profile_path(&context, &package).unwrap();
        assert!(!analysis.blocked);
        assert_eq!(PathBuf::from(&analysis.entries[0].destination), game.join("assets/mod_overrides/Heavier SWAT/units/characters/swat.model"));
        let loose = root.join("unsafe.model");
        fs::write(&loose, b"unknown-layout").unwrap();
        assert!(analyze_custom_profile_path(&context, &loose).unwrap().blocked);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_handoffs_are_content_aware_and_do_not_classify_saves_as_blcmm() {
        let root = temp_root("legacy-handoffs");
        fs::create_dir_all(&root).unwrap();
        let blcm = root.join("patch.blcm");
        fs::write(&blcm, b"fixture-blcm").unwrap();
        assert_eq!(external_manager_for_package("builtin.borderlands2", &blcm), Some("OpenBLCMM"));
        let save = root.join("Save0001.sav");
        fs::write(&save, b"fixture-save").unwrap();
        assert_eq!(external_manager_for_package("builtin.borderlands2", &save), None);
        let pdmod = root.join("legacy.pdmod");
        fs::write(&pdmod, b"fixture-encrypted-package").unwrap();
        assert_eq!(external_manager_for_package("builtin.payday-the-heist", &pdmod), Some("PDMod conversion"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn oak_sdk_and_plugin_companions_are_dependency_guarded() {
        for profile in ["builtin.borderlands3", "builtin.tiny-tinas-wonderlands"] {
            let root = temp_root("oak-formats");
            let game = root.join("game");
            fs::create_dir_all(&game).unwrap();
            let draft = builtin_install_definition(profile, Some(&game)).unwrap();
            let rules = serde_json::from_value(draft["customFileTypes"].clone()).unwrap();
            let context = ProfileInstallContext { profile_id:format!("test.{}",profile), game_id:profile.into(), game_root:game.clone(), executable_dir:game.clone(), draft, rules };
            let package = root.join("Example.sdkmod");
            fs::write(&package, b"unchanged-sdk-package").unwrap();
            assert!(analyze_custom_profile_path(&context, &package).unwrap().blocked);
            for marker in ["OakGame/Binaries/Win64/dsound.dll", "OakGame/Binaries/Win64/Plugins/unrealsdk.dll", "OakGame/Binaries/Win64/Plugins/pyunrealsdk.dll", "OakGame/Binaries/Win64/Plugins/unrealsdk.toml", "OakGame/Binaries/Win64/d3d11.dll"] {
                let path = game.join(marker);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, b"fixture-runtime").unwrap();
            }
            let analysis = analyze_custom_profile_path(&context, &package).unwrap();
            assert!(!analysis.blocked);
            assert_eq!(PathBuf::from(&analysis.entries[0].destination), game.join("sdk_mods/Example.sdkmod"));
            let plugin = root.join("plugin");
            fs::create_dir_all(&plugin).unwrap();
            fs::write(plugin.join("Example.dll"), b"fixture-plugin").unwrap();
            fs::write(plugin.join("Example.ini"), b"fixture-config").unwrap();
            assert!(!analyze_custom_profile_path(&context, &plugin).unwrap().blocked);
            fs::write(plugin.join("unrelated.ini"), b"do-not-guess").unwrap();
            assert!(analyze_custom_profile_path(&context, &plugin).unwrap().blocked);
            fs::write(plugin.join("dsound.dll"), b"runtime-must-not-be-plugin").unwrap();
            assert!(analyze_custom_profile_path(&context, &plugin).unwrap().entries.iter().any(|entry| entry.route_kind == "external-loader" && entry.blocked));
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn zipped_packages_preserve_multiple_mod_roots_and_skip_outer_readme() {
        let root = temp_root("zip-packages");
        fs::create_dir_all(&root).unwrap();
        let game = root.join("game");
        fs::create_dir_all(&game).unwrap();
        fs::write(game.join("WSOCK32.dll"), b"fixture-loader").unwrap();
        let draft = builtin_install_definition("builtin.payday2", Some(&game)).unwrap();
        let rules = serde_json::from_value(draft["customFileTypes"].clone()).unwrap();
        let context = ProfileInstallContext { profile_id:"test.zip-packages".into(), game_id:"payday2".into(), game_root:game.clone(), executable_dir:game.clone(), draft, rules };
        let path = root.join("sample.zip");
        let mut zip = zip::ZipWriter::new(File::create(&path).unwrap());
        for name in ["release/First/mod.txt", "release/First/lua/init.lua", "release/Second/mod.txt", "release/Second/lua/init.lua", "README.md"] {
            zip.start_file(name, SimpleFileOptions::default()).unwrap();
            zip.write_all(b"fixture-content").unwrap();
        }
        zip.finish().unwrap();
        let item = analyze_custom_profile_path(&context, &path).unwrap();
        assert!(!item.blocked, "{:?}", item.warnings);
        assert_eq!(item.entries.iter().filter(|e|e.route_kind != "folder").count(),4);
        for entry in item.entries.iter().filter(|e|e.route_kind != "folder") {
            let package = if entry.archive_path.contains("/First/") { "First" } else { "Second" };
            assert!(Path::new(&entry.destination).starts_with(game.join("mods").join(package)));
            assert_eq!(read_entry_bytes(&item, entry).unwrap(),b"fixture-content");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn authored_tree_keeps_nested_support_files_without_duplicate_prefix() {
        let root = temp_root("authored-tree");
        let game = root.join("game");
        fs::create_dir_all(&game).unwrap();
        fs::write(game.join("dinput8.dll"), b"fixture-loader").unwrap();
        let source = root.join("download");
        let nested = source.join("wrapper/reframework/autorun/example/data/settings.json");
        fs::create_dir_all(nested.parent().unwrap()).unwrap();
        fs::write(nested,b"{}").unwrap();
        let draft = builtin_install_definition("builtin.resident-evil-village",Some(&game)).unwrap();
        let rules = serde_json::from_value(draft["customFileTypes"].clone()).unwrap();
        let context = ProfileInstallContext { profile_id:"test.authored-tree".into(), game_id:"village".into(), game_root:game.clone(), executable_dir:game.clone(), draft, rules };
        let item = analyze_custom_profile_path(&context,&source).unwrap();
        assert!(!item.blocked);
        assert_eq!(PathBuf::from(&item.entries[0].destination),game.join("reframework/autorun/example/data/settings.json"));
        fs::write(source.join("unresolved.bin"),b"required-unknown-content").unwrap();
        assert!(analyze_custom_profile_path(&context,&source).unwrap().blocked,"A partial package must not be called installable");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn seven_zip_source_inspection_and_extraction_preserve_bytes() {
        let root = temp_root("7z-source");
        let source = root.join("source");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("sample.pak"),b"fixture-pak-bytes").unwrap();
        let path = root.join("sample.7z");
        sevenz_rust::compress_to_path(&source,&path).unwrap();
        let game = root.join("game");
        fs::create_dir_all(&game).unwrap();
        let draft = builtin_install_definition("builtin.outlast-trials",Some(&game)).unwrap();
        let rules = serde_json::from_value(draft["customFileTypes"].clone()).unwrap();
        let context = ProfileInstallContext { profile_id:"test.7z-source".into(),game_id:"outlast".into(),game_root:game.clone(),executable_dir:game.clone(),draft,rules };
        let item = analyze_custom_profile_path(&context,&path).unwrap();
        assert!(!item.blocked);
        assert_eq!(read_entry_bytes(&item,&item.entries[0]).unwrap(),b"fixture-pak-bytes");
        fs::remove_dir_all(root).unwrap();
    }

    fn temp_root(label: &str) -> PathBuf {
        env::temp_dir().join(format!("tsuki-profile-install-{}-{}", label, SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()))
    }

    #[test]
    fn wildcard_and_rule_matching_are_profile_driven() {
        let rule = ProfileFileTypeRule { extension: ".lua".to_string(), filename_pattern: "mod_*.json".to_string(), ..Default::default() };
        assert!(rule_matches_path(&rule, "scripts/test.lua"));
        assert!(rule_matches_path(&rule, "data/mod_settings.json"));
        assert!(!rule_matches_path(&rule, "readme.md"));
    }

    #[test]
    fn receipt_toggle_round_trip_restores_exact_path() {
        let root = temp_root("toggle");
        let game = root.join("game");
        let disabled = root.join("disabled");
        let installed = game.join("mods").join("sample.lua");
        fs::create_dir_all(installed.parent().unwrap()).unwrap();
        fs::write(&installed, b"sample").unwrap();
        let receipt = InstallReceipt {
            id: "sample".to_string(), display_name: "Sample".to_string(), source: "local".to_string(), mod_type: "test".to_string(), source_mod_id: None, source_file_id: None, source_file_name: None, source_file_category: None, source_file_uploaded_at: None, source_file_version: None, version: None, author: None, thumbnail_url: None, banner_url: None, page_url: None, installed_at_unix: None, enabled: Some(true), profile_id: Some("test".to_string()), notes: None,
            files: vec![InstallReceiptFile { relative_path: installed.display().to_string(), size_bytes: Some(6), sha256: None, original_path: None, backup_path: None }],
        };
        assert_eq!(toggle_receipt_files(&receipt, &disabled, std::slice::from_ref(&game), false).unwrap(), 1);
        assert!(!installed.exists());
        assert_eq!(toggle_receipt_files(&receipt, &disabled, std::slice::from_ref(&game), true).unwrap(), 1);
        assert_eq!(fs::read(&installed).unwrap(), b"sample");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn folder_mod_keeps_its_package_folder_under_profile_destination() {
        let root = temp_root("folder-route");
        let game = root.join("game");
        let dropped = root.join("Sample BLT Mod");
        fs::create_dir_all(&game).unwrap();
        fs::create_dir_all(dropped.join("lua")).unwrap();
        fs::write(dropped.join("mod.txt"), b"{}").unwrap();
        fs::write(dropped.join("lua").join("main.lua"), b"return true").unwrap();
        let context = ProfileInstallContext {
            profile_id: "test.profile".to_string(),
            game_id: "test-game".to_string(),
            game_root: game.clone(),
            executable_dir: game.clone(),
            draft: serde_json::json!({ "customPaths": [] }),
            rules: vec![ProfileFileTypeRule {
                id: "blt".to_string(),
                name: "BLT Mod".to_string(),
                kind: "folder_based".to_string(),
                exact_filenames: vec!["mod.txt".to_string()],
                file_match_mode: "folder".to_string(),
                destination: "${GAME_ROOT}/mods".to_string(),
                preserve_structure: true,
                flatten_wrapper: true,
                confidence: 100,
                ..Default::default()
            }],
        };
        let analysis = analyze_custom_profile_path(&context, &dropped).unwrap();
        assert!(!analysis.blocked);
        assert_eq!(analysis.entries.len(), 2);
        let expected_root = game.join("mods").join("Sample BLT Mod");
        assert!(analysis.entries.iter().all(|entry| Path::new(&entry.destination).starts_with(&expected_root)));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn profile_dependency_markers_gate_required_installs() {
        let root = temp_root("dependency");
        let game = root.join("game");
        fs::create_dir_all(&game).unwrap();
        let context = ProfileInstallContext {
            profile_id: "test.profile".to_string(),
            game_id: "test-game".to_string(),
            game_root: game.clone(),
            executable_dir: game.clone(),
            draft: serde_json::json!({
                "customPaths": [],
                "sections": { "dependencies": [{
                    "id": "dependency-bepinex",
                    "title": "BepInEx",
                    "fields": [
                        { "label": "Dependency ID", "value": "bepinex" },
                        { "label": "Required", "value": "Required by Mod Type" },
                        { "label": "Detection Method", "value": "Known dependency preset" },
                        { "label": "Marker Filenames", "value": "winhttp.dll|doorstop_config.ini" },
                        { "label": "Marker Folders", "value": "BepInEx" },
                        { "label": "Destination", "value": "${GAME_ROOT}" }
                    ]
                }] }
            }),
            rules: Vec::new(),
        };
        let required = BTreeSet::from(["BepInEx".to_string()]);
        assert_eq!(missing_dependencies_for_install(&context, &required), vec!["BepInEx"]);
        fs::write(game.join("winhttp.dll"), b"loader").unwrap();
        assert!(missing_dependencies_for_install(&context, &required).is_empty());
        let evaluation = evaluate_profile_dependencies(&context);
        assert_eq!(evaluation.len(), 1);
        assert!(evaluation[0].found);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn receipt_owned_conflicts_block_even_when_overwrite_is_allowed() {
        let destination = PathBuf::from("C:/game/mods/sample.lua");
        let owned = analyze_destination_conflict(&destination, Some("Existing Mod"), ProfileConflictPolicy::BackupReplace).unwrap();
        assert!(owned.0);
        assert!(!owned.1);
        assert!(owned.2.contains("Existing Mod"));
    }

    #[test]
    fn overwrite_rollback_restores_the_displaced_file() {
        let root = temp_root("overwrite-rollback");
        let destination = root.join("game").join("sample.dll");
        let backup = root.join("profile-data").join("backups").join("sample.dll");
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::write(&destination, b"old").unwrap();
        move_file_to_target(&destination, &backup).unwrap();
        fs::write(&destination, b"new").unwrap();
        let installed = vec![AppliedInstallFile { archive_path: "sample.dll".to_string(), destination: destination.display().to_string(), size_bytes: 3 }];
        let backups = vec![OverwriteBackup { original_path: destination.display().to_string(), backup_path: backup.display().to_string() }];
        assert!(rollback_profile_install(&installed, &backups).is_empty());
        assert_eq!(fs::read(&destination).unwrap(), b"old");
        assert!(!backup.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn destination_validation_rejects_parent_traversal() {
        assert!(safe_relative_path("mods/good/file.dll").is_ok());
        assert!(safe_relative_path("../outside.dll").is_err());
        assert!(safe_relative_path("C:/outside.dll").is_err());
    }

    #[test]
    fn borderlands_enhanced_sdkmod_uses_x64_runtime_and_receipt_destination() {
        let root = temp_root("borderlands-enhanced");
        let game = root.join("BorderlandsGOTYEnhanced");
        fs::create_dir_all(game.join("Binaries/Win64/Plugins")).unwrap();
        fs::write(game.join("Binaries/Win64/BorderlandsGOTY.exe"), b"game").unwrap();
        fs::write(game.join("Binaries/Win64/dinput8.dll"), b"loader").unwrap();
        fs::write(game.join("Binaries/Win64/Plugins/unrealsdk.dll"), b"sdk").unwrap();
        let dropped = root.join("Example.sdkmod");
        fs::write(&dropped, b"sdkmod").unwrap();

        let draft = builtin_willow_profile_draft("builtin.borderlands", &game).expect("built-in Enhanced draft");
        let rules = serde_json::from_value::<Vec<ProfileFileTypeRule>>(draft.get("customFileTypes").unwrap().clone()).unwrap();
        let context = ProfileInstallContext {
            profile_id: "test.borderlands-enhanced".to_string(),
            game_id: "borderlands-goty-enhanced".to_string(),
            game_root: game.clone(),
            executable_dir: game.join("Binaries/Win64"),
            draft,
            rules,
        };

        assert!(missing_dependencies_for_install(&context, &BTreeSet::from(["Willow1 Mod Manager - Enhanced".to_string()])).is_empty());
        let analysis = analyze_custom_profile_path(&context, &dropped).unwrap();
        assert!(!analysis.blocked);
        assert_eq!(analysis.entries.len(), 1);
        assert_eq!(PathBuf::from(&analysis.entries[0].destination), game.join("sdk_mods/Example.sdkmod"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn borderlands2_sdkmod_blocks_without_complete_willow2_runtime() {
        let root = temp_root("borderlands2-missing-runtime");
        let game = root.join("Borderlands 2");
        fs::create_dir_all(game.join("Binaries/Win32")).unwrap();
        fs::write(game.join("Binaries/Win32/Borderlands2.exe"), b"game").unwrap();
        let dropped = root.join("Example.sdkmod");
        fs::write(&dropped, b"sdkmod").unwrap();

        let draft = builtin_willow_profile_draft("builtin.borderlands2", &game).expect("built-in Borderlands 2 draft");
        let rules = serde_json::from_value::<Vec<ProfileFileTypeRule>>(draft.get("customFileTypes").unwrap().clone()).unwrap();
        let context = ProfileInstallContext {
            profile_id: "test.borderlands2".to_string(),
            game_id: "borderlands-2".to_string(),
            game_root: game.clone(),
            executable_dir: game.join("Binaries/Win32"),
            draft,
            rules,
        };

        let analysis = analyze_custom_profile_path(&context, &dropped).unwrap();
        assert!(analysis.blocked);
        assert!(analysis.warnings.iter().any(|warning| warning.contains("Willow2 Mod Manager")));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn outlast_pak_routes_only_to_the_game_paks_folder() {
        let root = temp_root("outlast-pak");
        let game = root.join("The Outlast Trials");
        fs::create_dir_all(game.join("OPP/Content/Paks")).unwrap();
        fs::write(game.join("start_protected_game.exe"), b"game").unwrap();
        let dropped = root.join("Example_P.pak");
        fs::write(&dropped, b"pak").unwrap();
        let draft = builtin_non_willow_profile_draft("builtin.outlast-trials").expect("Outlast draft");
        let rules = serde_json::from_value::<Vec<ProfileFileTypeRule>>(draft.get("customFileTypes").unwrap().clone()).unwrap();
        let context = ProfileInstallContext { profile_id: "test.outlast".to_string(), game_id: "outlast-trials".to_string(), game_root: game.clone(), executable_dir: game.clone(), draft, rules };

        let analysis = analyze_custom_profile_path(&context, &dropped).unwrap();
        assert!(!analysis.blocked);
        assert_eq!(PathBuf::from(&analysis.entries[0].destination), game.join("OPP/Content/Paks/Example_P.pak"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn every_non_payday3_builtin_exposes_install_and_toggle_policy() {
        let profiles = ["builtin.cyberpunk2077", "builtin.outlast-trials", "builtin.payday-the-heist", "builtin.payday2", "builtin.resident-evil-7", "builtin.resident-evil-village", "builtin.resident-evil-requiem", "builtin.borderlands", "builtin.borderlands2", "builtin.borderlands3", "builtin.borderlands4", "builtin.tiny-tinas-wonderlands", "builtin.spider-man-remastered", "builtin.spider-man-2", "builtin.monster-hunter-wilds"];
        for profile in profiles {
            let draft = builtin_install_definition(profile, None).expect(profile);
            assert!(!draft_section_items(&draft, "installBehavior").is_empty(), "{profile}");
            assert!(!draft_section_items(&draft, "enableDisable").is_empty(), "{profile}");
            assert!(!builtin_profile_executable_markers(profile).is_empty(), "{profile}");
            let rules: Vec<ProfileFileTypeRule> = serde_json::from_value(draft["customFileTypes"].clone()).unwrap();
            for rule in rules { assert!(rule.destination.starts_with("${GAME_ROOT}/"), "{profile}: {}", rule.destination); }
        }
    }

    #[test]
    fn outlast_shipping_marker_is_valid_and_wrong_game_folder_is_rejected() {
        let root = temp_root("outlast-current-executable");
        let game = root.join("game");
        fs::create_dir_all(game.join("OPP/Binaries/Win64")).unwrap();
        fs::write(game.join("OPP/Binaries/Win64/TOTClient-Win64-Shipping.exe"), b"fixture").unwrap();
        assert!(validate_builtin_profile_root("builtin.outlast-trials", &game).is_ok());
        assert!(validate_builtin_profile_root("builtin.payday2", &game).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn all_builtin_direct_rules_route_fixture_files_inside_their_game_root() {
        let root = temp_root("builtin-route-coverage");
        let profiles = ["builtin.cyberpunk2077", "builtin.outlast-trials", "builtin.payday-the-heist", "builtin.payday2", "builtin.resident-evil-7", "builtin.resident-evil-village", "builtin.resident-evil-requiem", "builtin.borderlands", "builtin.borderlands2", "builtin.borderlands3", "builtin.borderlands4", "builtin.tiny-tinas-wonderlands", "builtin.monster-hunter-wilds"];
        for profile in profiles {
            let game = root.join(profile);
            fs::create_dir_all(&game).unwrap();
            let draft = builtin_install_definition(profile, Some(&game)).unwrap();
            for dependency in draft_section_items(&draft, "dependencies") {
                for marker in split_list(&item_field_value(dependency, "Marker Filenames").unwrap_or_default()) {
                    let path = game.join(safe_relative_path(&marker).unwrap());
                    fs::create_dir_all(path.parent().unwrap()).unwrap();
                    fs::write(path, b"fixture-loader").unwrap();
                }
            }
            let rules: Vec<ProfileFileTypeRule> = serde_json::from_value(draft["customFileTypes"].clone()).unwrap();
            let context = ProfileInstallContext { profile_id: "test.builtin-route-coverage".to_string(), game_id: profile.to_string(), game_root: game.clone(), executable_dir: game.clone(), draft, rules };
            for rule in &context.rules {
                let sample = root.join(format!("sample-{}", rule.id));
                let sample = if rule.id == "pdth-asset-package" {
                    let path = sample.join("Release/Example/units/characters/example.model");
                    fs::create_dir_all(path.parent().unwrap()).unwrap();
                    fs::write(path, b"fixture-asset").unwrap();
                    sample
                } else if rule.kind == "folder_based" {
                    fs::create_dir_all(&sample).unwrap();
                    fs::write(sample.join(&rule.exact_filenames[0]), b"{}").unwrap();
                    sample
                } else if !rule.folder_markers.is_empty() {
                    let path = sample.join(&rule.folder_markers[0]).join("fixture.lua");
                    fs::create_dir_all(path.parent().unwrap()).unwrap();
                    fs::write(&path, b"fixture-mod").unwrap();
                    sample
                } else {
                    let path = sample.with_extension(rule.extensions[0].trim_start_matches('.'));
                    fs::write(&path, b"fixture-mod").unwrap();
                    path
                };
                let analysis = analyze_custom_profile_path(&context, &sample).unwrap();
                assert!(!analysis.blocked, "{profile}/{}: {:?}", rule.id, analysis.warnings);
                assert!(!analysis.entries.is_empty(), "{profile}/{}", rule.id);
                for entry in analysis.entries {
                    assert!(!entry.blocked, "{profile}/{}: {}", rule.id, entry.reason);
                    assert!(Path::new(&entry.destination).starts_with(&game), "{}", entry.destination);
                }
            }
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reframework_content_requires_the_root_loader_marker() {
        let root = temp_root("reframework-gate");
        let game = root.join("Resident Evil Village BIOHAZARD VILLAGE");
        fs::create_dir_all(&game).unwrap();
        fs::write(game.join("re8.exe"), b"game").unwrap();
        let dropped = root.join("example.lua");
        fs::write(&dropped, b"return true").unwrap();
        let draft = builtin_non_willow_profile_draft("builtin.resident-evil-village").expect("Village draft");
        let rules = serde_json::from_value::<Vec<ProfileFileTypeRule>>(draft.get("customFileTypes").unwrap().clone()).unwrap();
        let context = ProfileInstallContext { profile_id: "test.village".to_string(), game_id: "resident-evil-village".to_string(), game_root: game.clone(), executable_dir: game.clone(), draft, rules };

        assert!(analyze_custom_profile_path(&context, &dropped).unwrap().blocked);
        fs::write(game.join("dinput8.dll"), b"reframework").unwrap();
        let ready = analyze_custom_profile_path(&context, &dropped).unwrap();
        assert!(!ready.blocked);
        assert_eq!(PathBuf::from(&ready.entries[0].destination), game.join("reframework/autorun/example.lua"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn superblt_requires_matching_game_architecture() {
        let root = temp_root("superblt-machine");
        let game = root.join("game");
        fs::create_dir_all(&game).unwrap();
        let pe = |machine: u16| {
            let mut bytes = vec![0u8; 70];
            bytes[..2].copy_from_slice(b"MZ");
            bytes[60..64].copy_from_slice(&64u32.to_le_bytes());
            bytes[64..68].copy_from_slice(b"PE\0\0");
            bytes[68..70].copy_from_slice(&machine.to_le_bytes());
            bytes
        };
        fs::write(game.join("PAYDAY2.exe"), pe(0x8664)).unwrap();
        fs::write(game.join("WSOCK32.dll"), pe(0x014c)).unwrap();
        let draft = builtin_non_willow_profile_draft("builtin.payday2").unwrap();
        let context = ProfileInstallContext { profile_id:"builtin.payday2".into(), game_id:"payday-2".into(), game_root:game.clone(), executable_dir:game.clone(), rules:serde_json::from_value(draft["customFileTypes"].clone()).unwrap(), draft };
        let evaluations = evaluate_profile_dependencies(&context);
        assert!(!evaluations[0].found);
        assert!(evaluations[0].details.contains("architecture"));
        fs::write(game.join("WSOCK32.dll"), pe(0x8664)).unwrap();
        assert!(evaluate_profile_dependencies(&context)[0].found);
        fs::write(game.join("WSOCK32.dll"), b"not a DLL").unwrap();
        assert!(!evaluate_profile_dependencies(&context)[0].found);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reframework_preserves_data_and_rejects_root_proxy_as_plugin() {
        let root = temp_root("reframework-data");
        let game = root.join("game");
        let source = root.join("package");
        fs::create_dir_all(&game).unwrap();
        fs::write(game.join("dinput8.dll"), b"existing-loader").unwrap();
        fs::create_dir_all(source.join("reframework/autorun")).unwrap();
        fs::create_dir_all(source.join("reframework/data")).unwrap();
        fs::write(source.join("reframework/autorun/example.lua"), b"return true").unwrap();
        fs::write(source.join("reframework/data/example.json"), b"{}").unwrap();
        fs::create_dir_all(source.join("reframework/images/example")).unwrap();
        fs::write(source.join("reframework/images/example/card.png"), b"image fixture").unwrap();
        fs::write(source.join("modinfo.ini"), b"name=Example").unwrap();
        let draft = builtin_non_willow_profile_draft("builtin.resident-evil-requiem").unwrap();
        let rules = serde_json::from_value(draft["customFileTypes"].clone()).unwrap();
        let context = ProfileInstallContext { profile_id:"test.reframework-data".into(), game_id:"requiem".into(), game_root:game.clone(), executable_dir:game.clone(), draft, rules };
        let item = analyze_custom_profile_path(&context, &source).unwrap();
        assert!(!item.blocked, "{:?}", item.warnings);
        assert!(item.entries.iter().any(|entry| Path::new(&entry.destination) == game.join("reframework/data/example.json")));
        assert!(item.entries.iter().any(|entry| Path::new(&entry.destination) == game.join("reframework/images/example/card.png")));
        let proxy = root.join("dinput8.dll");
        fs::write(&proxy, b"loader").unwrap();
        let item = analyze_custom_profile_path(&context, &proxy).unwrap();
        assert!(item.blocked);
        assert_eq!(item.entries[0].route_kind, "external-loader");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn spider_man_formats_remain_manager_handoffs() {
        let root = temp_root("spider-manager-only");
        let game = root.join("Marvel's Spider-Man 2");
        fs::create_dir_all(&game).unwrap();
        fs::write(game.join("Spider-Man2.exe"), b"game").unwrap();
        let dropped = root.join("example.suit");
        fs::write(&dropped, b"overstrike package").unwrap();
        let draft = builtin_non_willow_profile_draft("builtin.spider-man-2").expect("Spider-Man 2 draft");
        let rules = serde_json::from_value::<Vec<ProfileFileTypeRule>>(draft.get("customFileTypes").unwrap().clone()).unwrap();
        let context = ProfileInstallContext { profile_id: "test.spider2".to_string(), game_id: "spider-man-2".to_string(), game_root: game, executable_dir: root.clone(), draft, rules };

        let analysis = analyze_custom_profile_path(&context, &dropped).unwrap();
        assert!(analysis.blocked);
        assert!(analysis.warnings.iter().any(|warning| warning.contains("no configured custom Mod Types")));
        let _ = fs::remove_dir_all(root);
    }
}
