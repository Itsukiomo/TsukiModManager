//! Approved dependency recipes, scoped to the exact game variant and receipt-owned files.
use super::*;
use fs2::FileExt;
use std::collections::{BTreeMap, BTreeSet};
use std::io::Cursor;
use std::time::Duration;

const LIMIT: u64 = 256 * 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Definition {
    id: String,
    name: String,
    games: Vec<String>,
    #[serde(default)]
    requires: Vec<String>,
    nexus: Option<NexusSource>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NexusSource {
    game_domain: String,
    mod_id: String,
}
#[derive(Clone)]
enum Source {
    Workshop(&'static str, &'static str),
    Github(&'static str, &'static str),
    Commit(&'static str),
    Nexus(NexusSource),
}
struct Recipe {
    source: Source,
    base: String,
    prefixes: Vec<String>,
    markers: Vec<String>,
    strip: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OwnedFile {
    path: String,
    sha256: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    id: String,
    profile_id: String,
    game_root: String,
    version: String,
    archive_sha256: String,
    checked_at: u128,
    files: Vec<OwnedFile>,
}
#[derive(Serialize, Deserialize)]
struct Mutation {
    path: String,
    before: Option<String>,
    after: Option<String>,
    backup: String,
}
#[derive(Serialize, Deserialize)]
struct Journal {
    game_root: String,
    mutations: Vec<Mutation>,
    previous_receipt: Option<Vec<u8>>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DependencySetupResult {
    pub(crate) messages: Vec<String>,
}

fn catalog() -> Result<Vec<Definition>, String> {
    serde_json::from_str(include_str!("../../src/data/dependencies.json"))
        .map_err(|e| e.to_string())
}
fn identity(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}
fn definition<'a>(all: &'a [Definition], profile: &str, name: &str) -> Option<&'a Definition> {
    let key = identity(name);
    let alias = match key.as_str() {
        "superblt" => "pd2-superblt-x64",
        "beardlib" => "pd2-beardlib",
        "las" | "legendaryarmourskins" | "legendaryarmorskins" => "pd2-legendary-armour-skins",
        "ue4ss" | "allowmods" | "allowmodsmod" if profile == "builtin.payday3" => {
            "pd3-ue5-ue4ss-allow-pak"
        }
        "willow1sdk" | "willow1modmanagerclassic" => "borderlands-willow1-classic",
        "willow1enhancedsdk" | "willow1modmanagerenhanced" => "borderlands-willow1-enhanced",
        "willow2sdk" | "willow2modmanager" => "borderlands2-willow2",
        "oaksdk" => "borderlands3-oak",
        "oak2modmanager" => "borderlands4-oak2",
        "pluginloader" => "borderlands-plugin-loader",
        "openhotfixloader" => "borderlands-open-hotfix-loader",
        "reframework" => "re-reframework",
        "pdthmodoverrides" => "pdth-mod-overrides",
        _ => name,
    };
    all.iter().find(|d| {
        d.games.iter().any(|g| g == profile)
            && (d.id == alias || identity(&d.id) == key || identity(&d.name) == key)
    })
}
fn recipe(dep: &Definition, profile: &str, game: &Path) -> Result<Recipe, String> {
    let mut result = Recipe {
        source: Source::Workshop("", ""),
        base: String::new(),
        prefixes: Vec::new(),
        markers: Vec::new(),
        strip: String::new(),
    };
    let (source, base, prefixes, markers): (Source, &str, Vec<&str>, Vec<&str>) = match dep.id.as_str() {
        "pd2-superblt-x64" | "pd2-beardlib" => {
            if profile_installs::portable_executable_machine(&game.join("PAYDAY2.exe")) != Some(0x8664) {
                return Err("Current SuperBLT and BeardLib require 64-bit PAYDAY 2. Legacy x86 needs a separate compatible release; no files were changed.".into());
            }
            if dep.id == "pd2-beardlib" {
                (Source::Workshop("14924", ""), "mods", vec!["BeardLib/"], vec!["BeardLib/mod.txt", "BeardLib/main.xml"])
            } else {
                (Source::Workshop("58342", ""), "", vec!["WSOCK32.dll"], vec!["WSOCK32.dll"])
            }
        }
        "borderlands-willow1-classic" | "borderlands-willow1-enhanced" => {
            let enhanced = game.join("Binaries/Win64/BorderlandsGOTY.exe").is_file();
            if enhanced {
                (Source::Github("bl-sdk/willow1-mod-manager", "bl1-enhanced-sdk.zip"), "", vec!["Binaries/Win64/Plugins/", "Binaries/Win64/dinput8.dll", "sdk_mods/"], vec!["Binaries/Win64/dinput8.dll", "Binaries/Win64/Plugins/unrealsdk.dll"])
            } else {
                (Source::Github("bl-sdk/willow1-mod-manager", "bl1-sdk.zip"), "", vec!["Binaries/Plugins/", "Binaries/dsound.dll", "sdk_mods/"], vec!["Binaries/dsound.dll", "Binaries/Plugins/unrealsdk.dll"])
            }
        }
        "borderlands2-willow2" => (Source::Github("bl-sdk/willow2-mod-manager", "willow2-sdk.zip"), "", vec!["Binaries/Win32/Plugins/", "Binaries/Win32/ddraw.dll", "sdk_mods/"], vec!["Binaries/Win32/ddraw.dll", "Binaries/Win32/Plugins/unrealsdk.dll"]),
        "pd2-legendary-armour-skins" => (Source::Workshop("24006", ""), "assets/mod_overrides", vec!["Legendary Armour Skins/"], vec!["Legendary Armour Skins/main.xml"]),
        "borderlands3-oak" => (Source::Github("bl-sdk/oak-mod-manager", if profile == "builtin.tiny-tinas-wonderlands" { "wl-sdk.zip" } else { "bl3-sdk.zip" }), "", vec!["OakGame/Binaries/Win64/Plugins/", "OakGame/Binaries/Win64/dsound.dll", "sdk_mods/"], vec!["OakGame/Binaries/Win64/dsound.dll", "OakGame/Binaries/Win64/Plugins/unrealsdk.dll"]),
        "borderlands4-oak2" => (Source::Github("bl-sdk/oak2-mod-manager", "oak2-sdk.zip"), "", vec!["OakGame/Binaries/Win64/Plugins/", "OakGame/Binaries/Win64/dsound.dll", "sdk_mods/"], vec!["OakGame/Binaries/Win64/Plugins/unrealsdk.dll"]),
        "borderlands-plugin-loader" => (Source::Github("FromDarkHell/BL3DX11Injection", "D3D11.zip"), "OakGame/Binaries/Win64", vec!["d3d11.dll", "Plugins/pluginLoader.ini"], vec!["d3d11.dll"]),
        "borderlands-open-hotfix-loader" => (Source::Github("apple1417/OpenHotfixLoader", "OpenHotfixLoader.zip"), "OakGame/Binaries/Win64/Plugins", vec!["OpenHotfixLoader.dll"], vec!["OpenHotfixLoader.dll"]),
        "pdth-mod-overrides" => (Source::Github("HW12Dev/PDTHModOverrides", "PDTHModOverrides.zip"), "", vec!["DINPUT8.dll", "PDTHModOverrides.dll"], vec!["DINPUT8.dll", "PDTHModOverrides.dll"]),
        "re-reframework" | "mhw-reframework-nexus" => {
            match profile {
                "builtin.resident-evil-7" | "builtin.resident-evil-village" | "builtin.resident-evil-requiem" | "builtin.monster-hunter-wilds" => (),
                _ => return Err("This game has no verified stable REFramework release asset. Use the linked game-specific release; Tsuki will not install another game's DLL.".into()),
            }
            (Source::Github("praydog/REFramework-nightly", "REFramework.zip"), "", vec!["dinput8.dll"], vec!["dinput8.dll"])
        }
        id if id.starts_with("cyberpunk-") && dep.nexus.is_some() => (
            Source::Nexus(dep.nexus.clone().unwrap()), "",
            if id == "cyberpunk-redscript" { vec!["engine/tools/scc.exe", "r6/config/", "r6/cache/final.redscripts"] } else { vec!["bin/x64/plugins/", "bin/x64/version.dll", "red4ext/", "r6/scripts/", "r6/tweaks/", "r6/config/", "r6/cache/modded/", "archive/pc/mod/"] }, Vec::new()
        ),
        "mhw-catlib" => {
            result.source = Source::Nexus(dep.nexus.clone().ok_or("CatLib source is missing")?);
            result.strip = "_CatLib/".into();
            result.prefixes = vec!["reframework/".into()];
            result.markers = vec!["reframework/autorun/_CatLib/init.lua".into()];
            return Ok(result);
        }
        "pd3-ue5-ue4ss-allow-pak" => {
            let paths = detect_payday3_paths_internal().ok_or("PAYDAY 3 paths are not configured")?;
            if !payday_uses_ue5_layout(&paths) { return Err("The automatic PAYDAY 3 dependency recipe is UE5-only. Legacy UE4 packages will not be substituted.".into()); }
            result.base = paths.win64.strip_prefix(game).map_err(|_| "PAYDAY 3 binary directory is outside the selected installation")?.to_string_lossy().replace('\\', "/");
            result.strip = "PD3-UE5-UE4SS-exp/".into();
            result.source = Source::Workshop("47771", "PD3-UE5");
            result.prefixes = vec!["dwmapi.dll", "UE4SS/UE4SS.dll", "UE4SS/UE4SS-settings.ini", "UE4SS/MemberVariableLayout.ini", "UE4SS/VTableLayout.ini", "UE4SS/UE4SS_Signatures/", "UE4SS/Mods/mods.txt", "UE4SS/Mods/AllowModsMod/dlls/AllowModsMod.dll", "UE4SS/Mods/BPML_GenericFunctions/", "UE4SS/Mods/Keybinds/", "UE4SS/Mods/shared/"].into_iter().map(str::to_string).collect();
            result.markers = vec!["dwmapi.dll".into(), "UE4SS/UE4SS.dll".into(), "UE4SS/Mods/AllowModsMod/dlls/AllowModsMod.dll".into()];
            return Ok(result);
        }
        _ => return Err(format!("{} requires its documented manual or external-manager setup. No approved automatic recipe exists; use its source link.", dep.name)),
    };
    result.source = source;
    result.base = base.into();
    result.prefixes = prefixes.into_iter().map(str::to_string).collect();
    result.markers = markers.into_iter().map(str::to_string).collect();
    Ok(result)
}
fn trusted(url: &reqwest::Url) -> bool {
    let host = url.host_str().unwrap_or("");
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && (matches!(
            host,
            "api.github.com"
                | "github.com"
                | "codeload.github.com"
                | "release-assets.githubusercontent.com"
                | "objects.githubusercontent.com"
                | "api.modworkshop.net"
                | "storage.modworkshop.net"
        ) || host == "nexusmods.com"
            || host.ends_with(".nexusmods.com")
            || host == "nexus-cdn.com"
            || host.ends_with(".nexus-cdn.com"))
}
fn fetch(url: &str) -> Result<Vec<u8>, String> {
    let url = reqwest::Url::parse(url).map_err(|e| e.to_string())?;
    if !trusted(&url) {
        return Err("Dependency source is outside the approved HTTPS hosts.".into());
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(180))
        .connect_timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::custom(|a| {
            if a.previous().len() >= 5 || !trusted(a.url()) {
                a.error("Untrusted dependency redirect")
            } else {
                a.follow()
            }
        }))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(url)
        .header("User-Agent", "Tsuki-Dependencies/2")
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Dependency download failed: {}", e.without_url()))?;
    if response.content_length().is_some_and(|s| s > LIMIT) {
        return Err("Dependency exceeds the download size limit.".into());
    }
    let mut bytes = Vec::new();
    response
        .take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > LIMIT {
        return Err("Dependency exceeds the download size limit.".into());
    }
    Ok(bytes)
}
fn resolve(source: &Source, profile: &str) -> Result<(String, String, Option<String>), String> {
    match source {
        Source::Workshop(id, filter) => {
            let value: serde_json::Value = serde_json::from_slice(&fetch(&format!(
                "https://api.modworkshop.net/mods/{id}/files"
            ))?)
            .map_err(|e| e.to_string())?;
            let files = value
                .get("data")
                .and_then(|v| v.as_array())
                .ok_or("Invalid dependency file list")?;
            let selected = files
                .iter()
                .filter(|f| {
                    f.get("type").and_then(|v| v.as_str()) == Some("zip")
                        && json_string(f, "name").is_some_and(|n| n.contains(filter))
                        && !json_string(f, "label")
                            .unwrap_or_default()
                            .to_lowercase()
                            .contains("old")
                })
                .max_by_key(|f| json_string(f, "created_at").unwrap_or_default())
                .ok_or("No compatible dependency archive is available")?;
            Ok((
                json_string(selected, "download_url").ok_or("Dependency has no download URL")?,
                json_string(selected, "version")
                    .filter(|s| !s.is_empty())
                    .or_else(|| json_string(selected, "created_at"))
                    .unwrap_or_default(),
                None,
            ))
        }
        Source::Github(repo, asset) => {
            let value: serde_json::Value = serde_json::from_slice(&fetch(&format!(
                "https://api.github.com/repos/{repo}/releases/latest"
            ))?)
            .map_err(|e| e.to_string())?;
            let selected = value.get("assets").and_then(|v| v.as_array()).and_then(|a| a.iter().find(|a| json_string(a, "name").is_some_and(|n| n == *asset))).ok_or_else(|| format!("Latest {repo} release has no compatible {asset}. No substitute game asset will be used."))?;
            Ok((
                json_string(selected, "browser_download_url")
                    .ok_or("Release has no download URL")?,
                json_string(&value, "tag_name").ok_or("Release has no version")?,
                json_string(selected, "digest")
                    .and_then(|s| s.strip_prefix("sha256:").map(str::to_string)),
            ))
        }
        Source::Commit(repo) => {
            let value: serde_json::Value = serde_json::from_slice(&fetch(&format!(
                "https://api.github.com/repos/{repo}/commits/master"
            ))?)
            .map_err(|e| e.to_string())?;
            let sha = json_string(&value, "sha")
                .filter(|s| s.len() == 40 && s.bytes().all(|c| c.is_ascii_hexdigit()))
                .ok_or("Invalid official basemod commit")?;
            Ok((
                format!("https://codeload.github.com/{repo}/zip/{sha}"),
                sha,
                None,
            ))
        }
        Source::Nexus(source) => {
            let detail = fetch_nexus_mod_detail(
                source.mod_id.clone(),
                Some(profile.into()),
                Some(source.game_domain.clone()),
            )?;
            let selected = detail.files.iter().filter(|f| f.file_type.as_deref().is_some_and(|k| k.eq_ignore_ascii_case("main")))
                .max_by_key(|f| f.uploaded_at.clone().unwrap_or_default()).ok_or("Dependency has no unambiguous main file. Choose the compatible file using Browse Files.")?;
            let url = resolve_source_file_download_url(
                "nexus",
                &source.mod_id,
                &selected.id,
                None,
                Some(&source.game_domain),
            )?;
            Ok((
                url,
                selected
                    .version
                    .clone()
                    .or(detail.version)
                    .unwrap_or(selected.id.clone()),
                None,
            ))
        }
    }
}
fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn safe_relative(value: &str) -> Result<(), String> {
    let path = Path::new(value);
    if value.is_empty()
        || value.contains('\\')
        || path.is_absolute()
        || value.split('/').any(|p| {
            let stem = p.split('.').next().unwrap_or("").to_ascii_uppercase();
            p.is_empty()
                || p == "."
                || p == ".."
                || p.ends_with('.')
                || p.ends_with(' ')
                || p.bytes().any(|b| b < 32 || b":<>\"|?*".contains(&b))
                || [
                    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6",
                    "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7",
                    "LPT8", "LPT9",
                ]
                .contains(&stem.as_str())
        })
    {
        return Err("Unsafe dependency archive path.".into());
    }
    for component in path.components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return Err("Unsafe dependency archive path.".into());
        }
    }
    Ok(())
}
fn ordinary(path: &Path) -> Result<(), String> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("Dependency target contains a reparse point.".into());
            }
        }
        if metadata.file_type().is_symlink() {
            return Err("Dependency target contains a symbolic link.".into());
        }
    }
    if let Some(parent) = path.parent() {
        ordinary(parent)?;
    }
    Ok(())
}
fn payload(bytes: &[u8], recipe: &Recipe) -> Result<BTreeMap<String, Vec<u8>>, String> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| "Dependency is not a valid ZIP archive")?;
    if zip.len() > 12000 {
        return Err("Dependency has too many archive entries.".into());
    }
    let mut result = BTreeMap::new();
    let mut total = 0u64;
    let mut names = BTreeSet::new();
    for i in 0..zip.len() {
        let file = zip.by_index(i).map_err(|e| e.to_string())?;
        if file.is_dir() {
            continue;
        }
        let name = file.name().to_string();
        safe_relative(&name)?;
        if file.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000) {
            return Err("Dependency archive contains a link.".into());
        }
        let name = if recipe.strip == "*" {
            name.split_once('/')
                .map(|(_, p)| p)
                .ok_or("Missing dependency wrapper")?
                .to_string()
        } else {
            name.strip_prefix(&recipe.strip)
                .ok_or("Unexpected dependency archive wrapper")?
                .to_string()
        };
        let lower = name.to_ascii_lowercase();
        if !recipe.prefixes.iter().any(|p| {
            if p.is_empty() || p.ends_with('/') {
                lower.starts_with(&p.to_ascii_lowercase())
            } else {
                lower == p.to_ascii_lowercase()
            }
        }) {
            continue;
        }
        if [".exe", ".bat", ".cmd", ".ps1", ".lnk"]
            .iter()
            .any(|e| lower.ends_with(e))
            && !(lower == "engine/tools/scc.exe" && recipe.prefixes.iter().any(|p| p == "engine/tools/scc.exe"))
        {
            return Err("Dependency package contains an unexpected executable installer.".into());
        }
        if lower.ends_with(".pdb") || lower.ends_with(".log") {
            continue;
        }
        total = total
            .checked_add(file.size())
            .ok_or("Expanded dependency size overflow")?;
        if total > LIMIT * 3 || file.size() > LIMIT {
            return Err("Expanded dependency exceeds its size limit.".into());
        }
        if !names.insert(lower) {
            return Err("Dependency contains duplicate destination names.".into());
        }
        let mut content = Vec::new();
        file.take(LIMIT + 1)
            .read_to_end(&mut content)
            .map_err(|e| e.to_string())?;
        if content.len() as u64 > LIMIT {
            return Err("Dependency member exceeds its size limit.".into());
        }
        result.insert(name, content);
    }
    if result.is_empty()
        || recipe
            .markers
            .iter()
            .any(|marker| !result.keys().any(|p| p.eq_ignore_ascii_case(marker)))
    {
        return Err(
            "Dependency archive does not contain the required game-specific payload.".into(),
        );
    }
    Ok(result)
}
fn preserved(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".ini")
        || lower.ends_with(".user.toml")
        || lower.ends_with("/mods/mods.txt")
        || lower.contains("/settings/")
        || lower.contains("/saves/")
}
fn recover(game: &Path, receipt_path: &Path) -> Result<(), String> {
    let parent = receipt_path.parent().ok_or("Invalid dependency storage")?;
    for entry in fs::read_dir(parent).map_err(|e| e.to_string())? {
        let dir = entry.map_err(|e| e.to_string())?.path();
        if !dir.is_dir()
            || !dir
                .file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with("backup-"))
            || dir.join("complete").exists()
        {
            continue;
        }
        ordinary(&dir)?;
        let journal_path = dir.join("transaction.json");
        if !journal_path.exists() {
            continue;
        }
        let journal: Journal =
            serde_json::from_slice(&fs::read(&journal_path).map_err(|e| e.to_string())?)
                .map_err(|_| "Dependency recovery journal is invalid")?;
        if Path::new(&journal.game_root) != game {
            return Err("Dependency recovery belongs to another game folder.".into());
        }
        for mutation in &journal.mutations {
            safe_relative(&mutation.path)?;
            safe_relative(&mutation.backup)?;
            let destination = game.join(&mutation.path);
            ordinary(&destination)?;
            let current = if destination.is_file() {
                Some(sha(&fs::read(&destination).map_err(|e| e.to_string())?))
            } else {
                None
            };
            if current == mutation.before {
                continue;
            }
            if current != mutation.after {
                return Err("An interrupted dependency install has externally changed files. Its backups were preserved for review.".into());
            }
            if let Some(before) = mutation.before.as_ref() {
                let bytes = fs::read(dir.join(&mutation.backup))
                    .map_err(|_| "Interrupted dependency backup is missing")?;
                if sha(&bytes) != *before {
                    return Err("Interrupted dependency backup failed verification.".into());
                }
                fs::write(destination, bytes).map_err(|e| e.to_string())?;
            } else {
                fs::remove_file(destination).map_err(|e| e.to_string())?;
            }
        }
        if let Some(previous) = journal.previous_receipt {
            fs::write(receipt_path, previous).map_err(|e| e.to_string())?;
        } else if receipt_path.exists() {
            fs::remove_file(receipt_path).map_err(|e| e.to_string())?;
        }
        fs::write(dir.join("complete"), b"rolled back").map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub(crate) fn game_closed(profile: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        let mut command = Command::new("tasklist");
        hide_command_window(&mut command);
        let output = command
            .args(["/FO", "CSV", "/NH"])
            .output()
            .map_err(|_| "Cannot verify that the game is closed")?;
        if !output.status.success() {
            return Err("Cannot verify that the game is closed".into());
        }
        let text = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
        if profile_installs::builtin_profile_executable_markers(profile)
            .iter()
            .any(|p| {
                Path::new(p).file_name().is_some_and(|n| {
                    text.contains(&format!("\"{}\"", n.to_string_lossy().to_ascii_lowercase()))
                })
            })
        {
            return Err("Close the game before installing or updating its dependencies.".into());
        }
    }
    Ok(())
}
fn deploy(
    profile: &str,
    game: &Path,
    dep: &Definition,
    recipe: &Recipe,
    version: &str,
    archive: &[u8],
    receipt_path: &Path,
) -> Result<String, String> {
    game_closed(profile)?;
    recover(game, receipt_path)?;
    let files = payload(archive, recipe)?;
    let base = game.join(&recipe.base);
    ordinary(&base)?;
    let old: Option<Receipt> = match fs::read(receipt_path) {
        Ok(bytes) => Some(
            serde_json::from_slice(&bytes)
                .map_err(|_| "Dependency receipt is damaged; preserving existing files")?,
        ),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    if old.as_ref().is_some_and(|r| {
        r.profile_id != profile || Path::new(&r.game_root) != game || r.id != dep.id
    }) {
        return Err("Dependency receipt belongs to another game installation.".into());
    }
    let mut owned = Vec::new();
    let mut writes = Vec::new();
    let other_receipts = if profile.starts_with("builtin.") {
        profile_installs::list_profile_receipts_internal(profile)?
            .into_iter().filter(|r| r.id != format!("dependency-{}", dep.id)).collect::<Vec<_>>()
    } else { Vec::new() };
    for (path, bytes) in files {
        let relative = if recipe.base.is_empty() {
            path
        } else {
            format!("{}/{}", recipe.base, path)
        };
        safe_relative(&relative)?;
        let destination = game.join(&relative);
        ordinary(&destination)?;
        let destination_key = destination.to_string_lossy().replace('\\', "/").to_ascii_lowercase();
        if other_receipts.iter().any(|r| r.files.iter().any(|f| f.original_path.as_deref().unwrap_or(&f.relative_path).replace('\\', "/").to_ascii_lowercase() == destination_key)) {
            return Err(format!("{} is owned by another installed mod or framework; refusing to adopt or overwrite it.", destination.display()));
        }
        if relative.to_ascii_lowercase().ends_with(".dll") || relative.to_ascii_lowercase().ends_with(".exe") {
            let machine = pe_machine(&bytes).ok_or("Dependency contains an invalid PE DLL")?;
            let expected = profile_installs::builtin_profile_executable_markers(profile).iter().find_map(|p| profile_installs::portable_executable_machine(&game.join(p)))
                .ok_or("Cannot verify the game's executable architecture; no native dependencies were installed")?;
            if expected != machine {
                return Err(
                    "Dependency DLL architecture does not match the game executable.".into(),
                );
            }
        }
        let existing = if destination.is_file() {
            Some(fs::read(&destination).map_err(|e| e.to_string())?)
        } else {
            None
        };
        if let Some(existing) = existing.as_ref().filter(|_| preserved(&relative)) {
            // Track the preserved bytes, not the archive defaults, so integrity checks stay truthful.
            owned.push(OwnedFile { path: relative, sha256: sha(existing) });
            continue;
        }
        let digest = sha(&bytes);
        if let Some(existing) = existing.as_ref() {
            let existing_hash = sha(existing);
            if existing_hash != digest
                && !old.as_ref().is_some_and(|r| {
                    r.files.iter().any(|f| {
                        f.path.eq_ignore_ascii_case(&relative) && f.sha256 == existing_hash
                    })
                })
            {
                return Err(format!("{} is not an unchanged Tsuki-owned dependency file. Back up or review the existing installation before replacement.", destination.display()));
            }
            if existing_hash == digest {
                owned.push(OwnedFile {
                    path: relative,
                    sha256: digest,
                });
                continue;
            }
        }
        owned.push(OwnedFile {
            path: relative,
            sha256: digest,
        });
        writes.push((destination, Some(bytes), existing));
    }
    // Remove only unchanged, previously owned files that the new archive no longer supplies.
    if let Some(old) = old.as_ref() {
        for file in &old.files {
            if owned.iter().any(|f| f.path.eq_ignore_ascii_case(&file.path)) { continue; }
            safe_relative(&file.path)?;
            let destination = game.join(&file.path);
            ordinary(&destination)?;
            if preserved(&file.path) { owned.push(file.clone()); continue; }
            if !destination.exists() { continue; }
            let bytes = fs::read(&destination).map_err(|e| e.to_string())?;
            if sha(&bytes) != file.sha256 { return Err(format!("Obsolete dependency file was modified externally: {}. No update was applied.", destination.display())); }
            writes.push((destination, None, Some(bytes)));
        }
    }
    game_closed(profile)?;
    let backup = receipt_path
        .parent()
        .ok_or("Dependency storage has no parent")?
        .join(format!("backup-{}", now_unix_millis()));
    fs::create_dir_all(&backup).map_err(|e| e.to_string())?;
    let journal = backup.join("transaction.json");
    let previous_receipt = fs::read(receipt_path).ok();
    // Save every original before mutating any destination; a failed write restores the whole transaction.
    for (i, (_, _, previous)) in writes.iter().enumerate() {
        if let Some(bytes) = previous {
            fs::write(backup.join(i.to_string()), bytes).map_err(|e| e.to_string())?;
        }
    }
    let record = Journal {
        game_root: game.display().to_string(),
        previous_receipt,
        mutations: writes
            .iter()
            .enumerate()
            .map(|(i, (path, bytes, previous))| Mutation {
                path: path
                    .strip_prefix(game)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/"),
                before: previous.as_ref().map(|b| sha(b)),
                after: bytes.as_ref().map(|b| sha(b)),
                backup: i.to_string(),
            })
            .collect(),
    };
    fs::write(
        &journal,
        serde_json::to_vec(&record).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let result = (|| -> Result<(), String> {
        for (path, bytes, _) in &writes {
            ordinary(path)?;
            if bytes.is_none() {
                fs::remove_file(path).map_err(|e| e.to_string())?;
                continue;
            }
            let bytes = bytes.as_ref().unwrap();
            fs::create_dir_all(path.parent().ok_or("Invalid dependency destination")?)
                .map_err(|e| e.to_string())?;
            fs::write(path, bytes).map_err(|e| e.to_string())?;
            if sha(&fs::read(path).map_err(|e| e.to_string())?) != sha(bytes) {
                return Err("Dependency destination failed hash verification.".into());
            }
        }
        let receipt = Receipt {
            id: dep.id.clone(),
            profile_id: profile.into(),
            game_root: game.display().to_string(),
            version: version.into(),
            archive_sha256: sha(archive),
            checked_at: now_unix_millis(),
            files: owned,
        };
        let pending = receipt_path.with_extension("pending.json");
        ordinary(&pending)?;
        fs::write(
            &pending,
            serde_json::to_vec_pretty(&receipt).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        fs::rename(pending, receipt_path).map_err(|e| e.to_string())?;
        fs::write(backup.join("complete"), b"verified").map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(error) = result {
        let mut failures = Vec::new();
        for (path, _, previous) in writes.iter().rev() {
            let restored = if let Some(bytes) = previous {
                fs::write(path, bytes)
            } else if path.exists() {
                fs::remove_file(path)
            } else {
                Ok(())
            };
            if let Err(e) = restored {
                failures.push(format!("{}: {e}", path.display()));
            }
        }
        if let Some(previous) = record.previous_receipt.as_ref() {
            if let Err(e) = fs::write(receipt_path, previous) {
                failures.push(e.to_string());
            }
        } else if receipt_path.exists() {
            if let Err(e) = fs::remove_file(receipt_path) {
                failures.push(e.to_string());
            }
        }
        if failures.is_empty() {
            let _ = fs::write(backup.join("complete"), b"rolled back");
        }
        return Err(format!(
            "{error}{}",
            if failures.is_empty() {
                String::new()
            } else {
                format!(" Rollback needs attention: {}", failures.join("; "))
            }
        ));
    }
    Ok(format!(
        "{} {} installed and file hashes verified.",
        dep.name, version
    ))
}
fn pe_machine(bytes: &[u8]) -> Option<u16> {
    if bytes.get(..2)? != b"MZ" {
        return None;
    }
    let offset = u32::from_le_bytes(bytes.get(0x3c..0x40)?.try_into().ok()?) as usize;
    if bytes.get(offset..offset + 4)? != b"PE\0\0" {
        return None;
    }
    Some(u16::from_le_bytes(
        bytes.get(offset + 4..offset + 6)?.try_into().ok()?,
    ))
}
fn installed_receipt_path(profile: &str, id: &str) -> Result<PathBuf, String> {
    let folder = profile_installs::profile_receipts_dir(profile)?;
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    Ok(folder.join(format!("dependency-{id}.json")))
}
fn mirror_receipt(
    profile: &str,
    game: &Path,
    dep: &Definition,
    receipt: &Path,
) -> Result<(), String> {
    let managed: Receipt = serde_json::from_slice(&fs::read(receipt).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let files: Vec<InstallReceiptFile> = managed
        .files
        .iter()
        .map(|file| {
            let full = game.join(&file.path).display().to_string();
            InstallReceiptFile {
                relative_path: full.clone(),
                original_path: Some(full),
                backup_path: None,
                size_bytes: fs::metadata(game.join(&file.path)).ok().map(|m| m.len()),
                sha256: Some(file.sha256.clone()),
            }
        })
        .collect();
    let target = installed_receipt_path(profile, &dep.id)?;
    ordinary(&target)?;
    if let Ok(bytes) = fs::read(&target) {
        let current: InstallReceipt = serde_json::from_slice(&bytes)
            .map_err(|_| "Installed dependency receipt is damaged")?;
        if current.version.as_deref() == Some(&managed.version)
            && current.enabled != Some(false)
            && current.files.len() == files.len()
            && current
                .files
                .iter()
                .zip(&files)
                .all(|(a, b)| a.relative_path == b.relative_path && a.sha256 == b.sha256)
        {
            return Ok(());
        }
    }
    let mirrored = InstallReceipt {
        id: format!("dependency-{}", dep.id), display_name: dep.name.clone(), source: "tsuki-managed-dependency".into(),
        mod_type: "dependency".into(), source_mod_id: None, source_file_id: None, source_file_name: None,
        source_file_category: None, source_file_uploaded_at: None, source_file_version: Some(managed.version.clone()),
        version: Some(managed.version), author: None, thumbnail_url: None, banner_url: None, page_url: None,
        installed_at_unix: Some(now_unix_seconds()), enabled: Some(true), profile_id: Some(profile.into()),
        notes: Some("Managed shared dependency. File hashes verified; runtime compatibility is not guaranteed.".into()), files,
    };
    let pending = target.with_extension("pending");
    ordinary(&pending)?;
    fs::write(
        &pending,
        serde_json::to_vec_pretty(&mirrored).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::rename(pending, target).map_err(|e| e.to_string())
}
fn install_one_with_recipe(
    profile: &str,
    game: &Path,
    dep: &Definition,
    force: bool,
    recipe: Recipe,
) -> Result<String, String> {
    let dir = ensure_profile_data_dirs(profile)?
        .join("dependencies")
        .join(&dep.id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    ordinary(&dir)?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join("operation.lock"))
        .map_err(|e| e.to_string())?;
    lock.try_lock_exclusive()
        .map_err(|_| "This dependency is already being updated")?;
    let receipt = dir.join("receipt.json");
    if let Some(existing) = profile_installs::list_profile_receipts_internal(profile)?.into_iter().find(|r| r.id == format!("dependency-{}", dep.id)) {
        if existing.enabled == Some(false) {
            return Err(format!(
                "{} is disabled. Enable it in Installed before installing a mod that requires it.",
                dep.name
            ));
        }
    }
    game_closed(profile)?;
    recover(game, &receipt)?;
    if let Ok(bytes) = fs::read(&receipt) {
        let installed: Receipt =
            serde_json::from_slice(&bytes).map_err(|_| "Dependency receipt is damaged")?;
        if installed.profile_id != profile || Path::new(&installed.game_root) != game {
            return Err("Dependency receipt belongs to another installation.".into());
        }
        let intact = !installed.files.is_empty()
            && installed.files.iter().all(|f| {
                safe_relative(&f.path).is_ok()
                    && ordinary(&game.join(&f.path)).is_ok()
                    && fs::read(game.join(&f.path)).is_ok_and(|b| sha(&b) == f.sha256)
            });
        if intact
            && !force
            && now_unix_millis().saturating_sub(installed.checked_at) < 24 * 60 * 60 * 1000
        {
            mirror_receipt(profile, game, dep, &receipt)?;
            return Ok(format!("{} {} verified.", dep.name, installed.version));
        }
    } else if !force
        && !recipe.markers.is_empty()
        && recipe
            .markers
            .iter()
            .all(|p| game.join(&recipe.base).join(p).is_file())
    {
        return Ok(format!("{} already installed externally; preserving it. Use Install / Update to verify an approved package.", dep.name));
    }
    game_closed(profile)?;
    let (url, version, expected) = resolve(&recipe.source, profile)?;
    let archive = fetch(&url)?;
    if expected.is_some_and(|s| !sha(&archive).eq_ignore_ascii_case(&s)) {
        return Err("Dependency archive failed the upstream SHA-256 verification.".into());
    }
    let message = deploy(profile, game, dep, &recipe, &version, &archive, &receipt)?;
    mirror_receipt(profile, game, dep, &receipt)?;
    Ok(message)
}
fn install_one(
    profile: &str,
    game: &Path,
    dep: &Definition,
    force: bool,
) -> Result<String, String> {
    install_one_with_recipe(profile, game, dep, force, recipe(dep, profile, game)?)
}
pub(crate) fn ensure(
    profile: &str,
    names: &[String],
    force: bool,
) -> Result<DependencySetupResult, String> {
    if names.is_empty() {
        return Ok(DependencySetupResult {
            messages: Vec::new(),
        });
    }
    let game = PathBuf::from(profile_launch_mapping_internal(profile)?.game_root);
    profile_installs::validate_builtin_profile_root(profile, &game)?;
    ordinary(&game)?;
    let state = ensure_profile_data_dirs(profile)?.join("dependencies");
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(state.join("setup.lock"))
        .map_err(|e| e.to_string())?;
    lock.try_lock_exclusive()
        .map_err(|_| "Another dependency setup operation is running for this profile")?;
    let all = catalog()?;
    let mut ordered = Vec::new();
    let mut visited = BTreeSet::new();
    let mut visiting = BTreeSet::new();
    fn visit<'a>(
        dep: &'a Definition,
        all: &'a [Definition],
        profile: &str,
        ordered: &mut Vec<&'a Definition>,
        visited: &mut BTreeSet<String>,
        visiting: &mut BTreeSet<String>,
    ) -> Result<(), String> {
        if visited.contains(&dep.id) {
            return Ok(());
        }
        if !visiting.insert(dep.id.clone()) {
            return Err("Dependency graph contains a cycle.".into());
        }
        for parent in &dep.requires {
            visit(
                definition(all, profile, parent)
                    .ok_or_else(|| format!("Missing or cross-game dependency: {parent}"))?,
                all,
                profile,
                ordered,
                visited,
                visiting,
            )?;
        }
        visiting.remove(&dep.id);
        visited.insert(dep.id.clone());
        ordered.push(dep);
        Ok(())
    }
    for name in names {
        let mut dep = definition(&all, profile, name).ok_or_else(|| format!("No approved dependency identity for '{name}' in this game profile. Use the mod author's dependency link."))?;
        if profile == "builtin.borderlands" && dep.id.starts_with("borderlands-willow1-") {
            dep = definition(
                &all,
                profile,
                if game.join("Binaries/Win64/BorderlandsGOTY.exe").is_file() {
                    "borderlands-willow1-enhanced"
                } else {
                    "borderlands-willow1-classic"
                },
            )
            .ok_or("Borderlands SDK definition is missing")?;
        }
        if dep.id == "mhw-reframework-nexus" {
            dep = definition(&all, profile, "re-reframework")
                .ok_or("REFramework definition is missing")?;
        }
        visit(
            dep,
            &all,
            profile,
            &mut ordered,
            &mut visited,
            &mut visiting,
        )?;
    }
    // Validate the complete graph before downloading or changing any files.
    for dep in &ordered {
        recipe(dep, profile, &game)?;
    }
    let mut messages = Vec::new();
    for dep in ordered {
        if dep.id == "pd2-superblt-x64" {
            let base = Definition {
                id: "pd2-superblt-base".into(),
                name: "SuperBLT basemod".into(),
                games: vec![profile.into()],
                requires: Vec::new(),
                nexus: None,
            };
            let base_recipe = Recipe {
                source: Source::Commit("diesel-modding/PAYDAY2-SuperBLT-Lua"),
                base: "mods/base".into(),
                prefixes: vec![
                    "lua/".into(),
                    "req/".into(),
                    "loc/".into(),
                    "wren/".into(),
                    "base.lua".into(),
                    "mod.txt".into(),
                    "blt.png".into(),
                ],
                markers: vec!["base.lua".into(), "mod.txt".into()],
                strip: "*".into(),
            };
            messages.push(install_one_with_recipe(
                profile,
                &game,
                &base,
                force,
                base_recipe,
            )?);
        }
        messages.push(install_one(profile, &game, dep, force)?);
    }
    Ok(DependencySetupResult { messages })
}
#[tauri::command]
pub(crate) async fn install_profile_dependency(
    profile_id: Option<String>,
    dependency_id: String,
) -> Result<DependencySetupResult, String> {
    let profile = require_game_profile_installation(profile_id.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || ensure(&profile, &[dependency_id], true))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn download_profile_dependency_tool(profile_id: Option<String>, dependency_id: String) -> Result<DependencySetupResult, String> {
    let profile = require_game_profile_installation(profile_id.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let all = catalog()?;
        let dep = definition(&all, &profile, &dependency_id).ok_or("Tool does not belong to this game profile")?;
        let (url, version) = match dep.id.as_str() {
            "outlast-iris" | "outlast-janus" | "outlast-odessa" | "re-fluffy-mod-manager" | "spiderman-overstrike-remastered" => {
                let (url, version, _) = resolve(&Source::Nexus(dep.nexus.clone().ok_or("Tool source is missing")?), &profile)?;
                (url, version)
            }
            "borderlands2-openblcmm" => {
                let release: serde_json::Value = serde_json::from_slice(&fetch("https://api.github.com/repos/BLCM/OpenBLCMM/releases/latest")?).map_err(|e| e.to_string())?;
                let asset = release["assets"].as_array().and_then(|assets| assets.iter().find(|a| a["name"].as_str().is_some_and(|n| n.ends_with("-Windows.zip") && !n.contains("-Java-")))).ok_or("No current portable Windows OpenBLCMM release")?;
                (json_string(asset, "browser_download_url").ok_or("Missing tool URL")?, json_string(&release, "tag_name").ok_or("Missing release version")?)
            }
            _ => return Err("This dependency is not an approved standalone tool download. Use its documented setup.".into()),
        };
        let storage = ensure_profile_data_dirs(&profile)?.join("tool-downloads").join(&dep.id);
        ordinary(&storage)?;
        fs::create_dir_all(&storage).map_err(|e| e.to_string())?;
        let lock_path = storage.join("download.lock");
        ordinary(&lock_path)?;
        let lock = fs::OpenOptions::new().write(true).create(true).truncate(false).open(lock_path).map_err(|e| e.to_string())?;
        lock.try_lock_exclusive().map_err(|_| "This tool download is already running")?;
        let partial = storage.join(format!("download-{}-{}.partial", std::process::id(), now_unix_millis()));
        let digest = match stream_tool_download(&url, &partial) {
            Ok(digest) => digest,
            Err(error) => { let _ = fs::remove_file(&partial); return Err(error); }
        };
        let folder = storage.join(&digest);
        ordinary(&folder)?;
        fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
        let archive = folder.join(format!("{}.zip", dep.id));
        ordinary(&archive)?;
        if archive.exists() {
            if sha256_file(&archive)? != digest { let _ = fs::remove_file(&partial); return Err("Cached tool archive was modified; preserving it for review".into()); }
            fs::remove_file(&partial).map_err(|e| e.to_string())?;
        } else {
            fs::rename(&partial, &archive).map_err(|e| e.to_string())?;
            if sha256_file(&archive)? != digest { return Err("Tool archive failed disk hash verification".into()); }
        }
        let manifest = folder.join("download.json");
        ordinary(&manifest)?;
        fs::write(manifest, serde_json::to_vec_pretty(&serde_json::json!({
            "dependencyId": dep.id, "profileId": profile, "version": version, "sha256": digest,
            "archive": archive, "state": "downloaded-awaiting-external-setup", "installed": false, "checkedAt": now_unix_millis()
        })).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        open_folder_in_explorer(&folder, "downloaded external tool")?;
        Ok(DependencySetupResult { messages: vec![format!("{} {} downloaded and hash-verified in {}. Extract and configure the external tool; it was not executed or installed into the game.", dep.name, version, folder.display())] })
    }).await.map_err(|e| e.to_string())?
}

fn stream_tool_download(url: &str, path: &Path) -> Result<String, String> {
    const TOOL_LIMIT: u64 = 2 * 1024 * 1024 * 1024;
    let url = reqwest::Url::parse(url).map_err(|e| e.to_string())?;
    if !trusted(&url) { return Err("Unapproved tool HTTPS source".into()); }
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(900)).connect_timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::custom(|a| {
            if a.previous().len() >= 5 || !trusted(a.url()) { a.error("Untrusted tool redirect") } else { a.follow() }
        })).build().map_err(|e| e.to_string())?;
    let mut response = client.get(url).header("User-Agent", "Tsuki-Dependencies/2").send()
        .and_then(|r| r.error_for_status()).map_err(|e| e.without_url().to_string())?;
    if response.content_length().is_some_and(|n| n > TOOL_LIMIT) { return Err("Standalone tool exceeds the 2 GiB download limit".into()); }
    ordinary(path)?;
    let mut target = fs::OpenOptions::new().write(true).create_new(true).open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 65536];
    loop {
        let count = response.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 { break; }
        total += count as u64;
        if total > TOOL_LIMIT { return Err("Standalone tool exceeds the 2 GiB download limit".into()); }
        target.write_all(&buffer[..count]).map_err(|e| e.to_string())?;
        hasher.update(&buffer[..count]);
    }
    target.sync_all().map_err(|e| e.to_string())?;
    drop(target);
    validate_tool_archive(fs::File::open(path).map_err(|e| e.to_string())?)?;
    Ok(format!("{:x}", hasher.finalize()))
}

fn validate_tool_archive(reader: impl Read + std::io::Seek) -> Result<(), String> {
    // Tools stay in a separate download cache; no executable is launched or copied into a game.
    let mut zip = zip::ZipArchive::new(reader).map_err(|_| "Tool download is not a portable ZIP; use the author's file selector")?;
    if zip.len() == 0 || zip.len() > 12000 { return Err("Invalid portable tool archive size".into()); }
    let mut expanded = 0u64;
    let mut names = BTreeSet::new();
    for index in 0..zip.len() {
        let file = zip.by_index(index).map_err(|e| e.to_string())?;
        safe_relative(file.name().trim_end_matches('/'))?;
        if file.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000) || !names.insert(file.name().to_ascii_lowercase()) { return Err("Tool ZIP contains links or duplicate paths".into()); }
        expanded = expanded.checked_add(file.size()).ok_or("Tool archive size overflow")?;
        if expanded > 4 * 1024 * 1024 * 1024 || file.size() > 2 * 1024 * 1024 * 1024 { return Err("Tool ZIP exceeds the expanded size limit".into()); }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn archive(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (path, bytes) in files {
            zip.start_file(*path, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }
    fn fixture() -> (PathBuf, Definition, Recipe, PathBuf) {
        let root = env::temp_dir().join(format!(
            "tsuki-dependency-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("state")).unwrap();
        let dep = Definition {
            id: "fixture".into(),
            name: "Fixture".into(),
            games: vec!["test.profile".into()],
            requires: Vec::new(),
            nexus: None,
        };
        let recipe = Recipe {
            source: Source::Workshop("", ""),
            base: "mods/Fixture".into(),
            prefixes: vec!["".into()],
            markers: vec!["Core.lua".into()],
            strip: String::new(),
        };
        let receipt = root.join("state/receipt.json");
        (root, dep, recipe, receipt)
    }
    #[test]
    fn approved_dependencies_are_game_scoped_and_links_match() {
        let all = catalog().unwrap();
        assert_eq!(
            definition(&all, "builtin.payday2", "BeardLib")
                .unwrap()
                .requires,
            ["pd2-superblt-x64"]
        );
        assert!(definition(&all, "builtin.payday3", "BeardLib").is_none());
        assert!(definition(&all, "builtin.borderlands3", "Oak SDK").is_some());
        assert!(definition(&all, "builtin.cyberpunk2077", "BeardLib").is_none());
        assert_eq!(definition(&all, "builtin.monster-hunter-wilds", "CatLib").unwrap().requires, ["re-reframework"]);
    }
    #[test]
    fn tool_downloads_validate_archives_without_executing_them() {
        assert!(validate_tool_archive(Cursor::new(archive(&[("Tool.exe", b"portable tool")]))).is_ok());
        assert!(validate_tool_archive(Cursor::new(archive(&[("../Tool.exe", b"bad")]))).is_err());
        assert!(validate_tool_archive(Cursor::new(archive(&[("Tool.exe", b"a"), ("tool.exe", b"b")]))).is_err());
        assert!(validate_tool_archive(Cursor::new(b"not a zip")).is_err());
    }
    #[test]
    fn dependency_paths_and_config_preservation_are_strict() {
        for value in [
            "../evil.dll",
            "C:/evil.dll",
            "mods/../evil",
            "mods\\evil",
            "mods/foo:bar",
            "mods/foo.",
        ] {
            assert!(safe_relative(value).is_err());
        }
        assert!(safe_relative("mods/BeardLib/Core.lua").is_ok());
        assert!(preserved("UE4SS/UE4SS-settings.ini"));
        assert!(preserved("sdk_mods/settings/sample.json"));
        assert!(!preserved("red4ext/plugins/ArchiveXL.dll"));
        assert!(!trusted(
            &reqwest::Url::parse("https://github.com.evil.example/file").unwrap()
        ));
    }
    #[test]
    fn updates_preserve_settings_and_reject_modified_owned_files() {
        let (game, dep, recipe, receipt) = fixture();
        deploy(
            "test.profile",
            &game,
            &dep,
            &recipe,
            "1",
            &archive(&[("Core.lua", b"v1"), ("settings.ini", b"default")]),
            &receipt,
        )
        .unwrap();
        fs::write(game.join("mods/Fixture/settings.ini"), b"user settings").unwrap();
        deploy(
            "test.profile",
            &game,
            &dep,
            &recipe,
            "2",
            &archive(&[("Core.lua", b"v2"), ("settings.ini", b"new default")]),
            &receipt,
        )
        .unwrap();
        assert_eq!(fs::read(game.join("mods/Fixture/Core.lua")).unwrap(), b"v2");
        assert_eq!(
            fs::read(game.join("mods/Fixture/settings.ini")).unwrap(),
            b"user settings"
        );
        fs::write(game.join("mods/Fixture/Core.lua"), b"external edit").unwrap();
        assert!(deploy(
            "test.profile",
            &game,
            &dep,
            &recipe,
            "3",
            &archive(&[("Core.lua", b"v3")]),
            &receipt
        )
        .unwrap_err()
        .contains("not an unchanged"));
        assert_eq!(
            fs::read(game.join("mods/Fixture/Core.lua")).unwrap(),
            b"external edit"
        );
        fs::remove_dir_all(game).unwrap();
    }
    #[test]
    fn updates_remove_only_unchanged_obsolete_files_with_backups() {
        let (game, dep, recipe, receipt) = fixture();
        deploy("test.profile", &game, &dep, &recipe, "1", &archive(&[("Core.lua", b"v1"), ("Old.lua", b"obsolete")]), &receipt).unwrap();
        deploy("test.profile", &game, &dep, &recipe, "2", &archive(&[("Core.lua", b"v2")]), &receipt).unwrap();
        assert!(!game.join("mods/Fixture/Old.lua").exists());
        let current: Receipt = serde_json::from_slice(&fs::read(&receipt).unwrap()).unwrap();
        assert_eq!(current.files.len(), 1);
        assert!(fs::read_dir(receipt.parent().unwrap()).unwrap().flatten().any(|e| e.path().join("transaction.json").is_file()));
        fs::remove_dir_all(game).unwrap();
    }
    #[test]
    fn unexpected_installers_and_duplicate_destinations_are_rejected() {
        let (root, _, recipe, _) = fixture();
        assert!(payload(
            &archive(&[("Core.lua", b"ok"), ("install.exe", b"no")]),
            &recipe
        )
        .is_err());
        assert!(payload(
            &archive(&[("Core.lua", b"ok"), ("core.lua", b"duplicate")]),
            &recipe
        )
        .is_err());
        assert!(payload(&archive(&[("Other.lua", b"no marker")]), &recipe).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn interrupted_updates_restore_original_files_and_receipt() {
        let (game, dep, recipe, receipt) = fixture();
        deploy(
            "test.profile",
            &game,
            &dep,
            &recipe,
            "1",
            &archive(&[("Core.lua", b"old")]),
            &receipt,
        )
        .unwrap();
        let original_receipt = fs::read(&receipt).unwrap();
        let backup = game.join("state/backup-interrupted");
        fs::create_dir_all(&backup).unwrap();
        fs::write(backup.join("0"), b"old").unwrap();
        let journal = Journal {
            game_root: game.display().to_string(),
            previous_receipt: Some(original_receipt.clone()),
            mutations: vec![Mutation {
                path: "mods/Fixture/Core.lua".into(),
                before: Some(sha(b"old")),
                after: Some(sha(b"new")),
                backup: "0".into(),
            }],
        };
        fs::write(
            backup.join("transaction.json"),
            serde_json::to_vec(&journal).unwrap(),
        )
        .unwrap();
        fs::write(game.join("mods/Fixture/Core.lua"), b"new").unwrap();
        recover(&game, &receipt).unwrap();
        assert_eq!(
            fs::read(game.join("mods/Fixture/Core.lua")).unwrap(),
            b"old"
        );
        assert_eq!(fs::read(&receipt).unwrap(), original_receipt);
        fs::remove_dir_all(game).unwrap();
    }
    #[test]
    fn payday2_recipes_require_real_x64_identity() {
        let all = catalog().unwrap();
        let dep = definition(&all, "builtin.payday2", "BeardLib").unwrap();
        assert!(recipe(dep, "builtin.payday2", Path::new("missing-fixture")).is_err());
    }
}
