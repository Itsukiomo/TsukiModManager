use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::env;
use std::fs;
use std::fs::File;
use std::io::{self, Read, Write};
#[cfg(target_os = "windows")]
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStrExt;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager, WindowEvent};
use zip::write::SimpleFileOptions;
use zip::ZipArchive;
use sha2::{Digest, Sha256};

mod source_models;
mod source_http;
mod nexus;
mod modworkshop;
mod text_encoding;
mod profile_installs;
mod managed_loaders;
mod source_catalog;

const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const APP_DIR_NAME: &str = "Tsuki Mod Manager";
const SETTINGS_FILE_NAME: &str = "settings.json";
const DEFAULT_THEME_ID: &str = "moonveil";
// Fill this with your real public latest.json URL before final release,
// or set it in Settings -> App Update on the user's machine.
// Example: https://raw.githubusercontent.com/<you>/<repo>/main/latest.json
const DEFAULT_APP_UPDATE_MANIFEST_URL: &str = "https://raw.githubusercontent.com/Itsukiomo/TsukiModManager/main/latest.json";
const BUILTIN_PAYDAY3_PROFILE_ID: &str = "builtin.payday3";

static LAUNCH_IN_PROGRESS: AtomicBool = AtomicBool::new(false);
static ACTIVE_STAGED_DOWNLOADS: AtomicUsize = AtomicUsize::new(0);
static PAYDAY_PROCESS_CACHE: Mutex<Option<(u128, bool)>> = Mutex::new(None);

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "windows")]
fn hide_command_window(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn hide_command_window(_command: &mut Command) {}

struct LaunchProgressGuard;

impl Drop for LaunchProgressGuard {
    fn drop(&mut self) {
        LAUNCH_IN_PROGRESS.store(false, Ordering::SeqCst);
    }
}

fn acquire_launch_guard() -> Result<LaunchProgressGuard, String> {
    if LAUNCH_IN_PROGRESS.swap(true, Ordering::SeqCst) {
        return Err("PAYDAY 3 is already launching. Wait a few seconds before trying again.".to_string());
    }

    Ok(LaunchProgressGuard)
}


struct StagedDownloadGuard;

impl Drop for StagedDownloadGuard {
    fn drop(&mut self) {
        ACTIVE_STAGED_DOWNLOADS.fetch_sub(1, Ordering::SeqCst);
    }
}

fn acquire_staged_download_guard(limit: usize) -> Result<StagedDownloadGuard, String> {
    let max_downloads = limit.clamp(1, 8);

    loop {
        let current = ACTIVE_STAGED_DOWNLOADS.load(Ordering::SeqCst);
        if current >= max_downloads {
            return Err(format!(
                "The download queue is full ({} active, limit {}). Wait for an active download to finish or increase the simultaneous download limit in Settings.",
                current, max_downloads
            ));
        }

        if ACTIVE_STAGED_DOWNLOADS
            .compare_exchange(current, current + 1, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            return Ok(StagedDownloadGuard);
        }
    }
}
fn now_unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn is_builtin_payday3_profile(profile_id: Option<&str>) -> bool {
    match profile_id.map(str::trim).filter(|value| !value.is_empty()) {
        None => true,
        Some("payday3") | Some("payday-3") | Some(BUILTIN_PAYDAY3_PROFILE_ID) => true,
        Some(_) => false,
    }
}

fn profile_not_payday3_message(profile_id: Option<&str>) -> String {
    let label = profile_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("current profile");

    format!(
        "This command is PAYDAY 3-specific and is disabled for {}. Configure profile-specific paths/sources before scanning or mutating installed files.",
        label
    )
}

fn empty_profile_pak_scan_result() -> PakScanResult {
    PakScanResult {
        game_root: String::new(),
        pak_mods_path: String::new(),
        pak_mods_path_exists: false,
        pak_file_count: 0,
        pak_mods: Vec::new(),
    }
}

fn safe_nexus_game_domain(value: Option<&str>) -> Option<String> {
    let raw = value?.trim().trim_matches(|ch| ch == '/' || ch == '\\');
    let first = raw
        .split(|ch| ch == '/' || ch == '\\' || ch == '?' || ch == '#')
        .find(|part| !part.trim().is_empty())?
        .trim()
        .to_ascii_lowercase();

    if first
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        Some(first)
    } else {
        None
    }
}


#[derive(Debug, Clone)]
struct PaydayPaths {
    game_root: PathBuf,
    pak_mods: PathBuf,
    win64: PathBuf,
    ue4ss_mods: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PakModFile {
    file_name: String,
    full_path: String,
    extension: String,
    size_bytes: u64,
    enabled: bool,
    priority: Option<u32>,
    modified_unix: Option<u64>,
    sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PakScanResult {
    game_root: String,
    pak_mods_path: String,
    pak_mods_path_exists: bool,
    pak_file_count: usize,
    pak_mods: Vec<PakModFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PakBackupInfo {
    file_name: String,
    display_name: String,
    full_path: String,
    size_bytes: u64,
    created_unix: Option<u64>,
}


#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PakBackupFileEntry {
    file_name: String,
    zip_path: String,
    extension: String,
    size_bytes: u64,
    priority: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PakBackupInspectResult {
    backup: PakBackupInfo,
    files: Vec<PakBackupFileEntry>,
    manifest: Option<String>,
}


#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallReceiptFile {
    relative_path: String,
    size_bytes: Option<u64>,
    sha256: Option<String>,
    #[serde(default)]
    original_path: Option<String>,
    #[serde(default)]
    backup_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallReceipt {
    id: String,
    display_name: String,
    source: String,
    mod_type: String,
    source_mod_id: Option<String>,
    source_file_id: Option<String>,
    source_file_name: Option<String>,
    source_file_category: Option<String>,
    source_file_uploaded_at: Option<String>,
    source_file_version: Option<String>,
    version: Option<String>,
    author: Option<String>,
    thumbnail_url: Option<String>,
    banner_url: Option<String>,
    page_url: Option<String>,
    installed_at_unix: Option<u64>,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    profile_id: Option<String>,
    #[serde(default)]
    notes: Option<String>,
    files: Vec<InstallReceiptFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DisabledInstallFileRecord {
    original_path: String,
    disabled_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DisabledInstallManifest {
    receipt_id: String,
    display_name: String,
    disabled_at_unix: u64,
    files: Vec<DisabledInstallFileRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagedInstallInfo {
    id: String,
    display_name: String,
    source: String,
    source_mod_id: Option<String>,
    source_file_id: Option<String>,
    page_url: Option<String>,
    enabled: bool,
    file_count: usize,
    pak_file_count: usize,
    non_pak_file_count: usize,
    disabled_folder: String,
}


#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct InstalledStateDatabase {
    version: u32,
    records: Vec<InstalledStateRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledStateFile {
    relative_path: String,
    location: String,
    file_name: String,
    file_type: String,
    size_bytes: Option<u64>,
    sha256: Option<String>,
    live: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledStateRecord {
    uid: String,
    id: String,
    name: String,
    source: String,
    version: Option<String>,
    author: Option<String>,
    filename: String,
    file_id: Option<String>,
    file_type: String,
    sha256: Option<String>,
    folder_id: String,
    location: String,
    receipt_id: Option<String>,
    source_mod_id: Option<String>,
    source_file_id: Option<String>,
    source_file_name: Option<String>,
    source_file_category: Option<String>,
    source_file_uploaded_at: Option<String>,
    source_file_version: Option<String>,
    page_url: Option<String>,
    thumbnail_url: Option<String>,
    banner_url: Option<String>,
    enabled: bool,
    installed_at_unix: Option<u64>,
    files: Vec<InstalledStateFile>,
}


#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PersistentPairDatabase {
    version: u32,
    pairs: Vec<PersistentSourcePair>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistentSourcePair {
    uid: String,
    source: String,
    game: String,
    mod_id: String,
    file_id: Option<String>,
    display_name: String,
    file_name: String,
    version: Option<String>,
    install_type: String,
    location: String,
    installed_files: Vec<String>,
    installed_file_hashes: std::collections::BTreeMap<String, String>,
    installed_at: Option<u64>,
    updated_at: Option<String>,
    confidence: u32,
    match_kind: String,
    page_url: Option<String>,
    thumbnail_url: Option<String>,
    banner_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceUpdateStatus {
    uid: String,
    source: String,
    mod_id: String,
    installed_file_id: Option<String>,
    latest_file_id: Option<String>,
    latest_file_name: Option<String>,
    installed_version: Option<String>,
    latest_version: Option<String>,
    update_available: bool,
    can_update: bool,
    reason: String,
    page_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModProfile {
    id: String,
    #[serde(default)]
    game_profile_id: String,
    name: String,
    created_unix: u64,
    enabled_pak_files: Vec<String>,
    enabled_receipt_ids: Vec<String>,
    #[serde(default)]
    migration_state: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DependencyStatusItem {
    id: String,
    label: String,
    status: String,
    found: bool,
    path: Option<String>,
    details: String,
    recommendation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VanillaLaunchSession {
    created_at_unix: u64,
    pak_files: Vec<String>,
    receipt_ids: Vec<String>,
    #[serde(default)]
    temp_files: Vec<DisabledInstallFileRecord>,
}

fn vanilla_launch_session_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("vanilla-launch-session.json"))
}

fn write_vanilla_launch_session(session: &VanillaLaunchSession) -> Result<(), String> {
    let root = ensure_app_data_dirs()?;
    let contents = serde_json::to_string_pretty(session)
        .map_err(|err| format!("Failed to serialize vanilla launch session: {}", err))?;

    fs::write(root.join("vanilla-launch-session.json"), contents)
        .map_err(|err| format!("Failed to write vanilla launch session: {}", err))
}

fn read_vanilla_launch_session() -> Option<VanillaLaunchSession> {
    let path = vanilla_launch_session_path().ok()?;
    let contents = fs::read_to_string(path).ok()?;
    serde_json::from_str(&contents).ok()
}

fn clear_vanilla_launch_session() {
    if let Ok(path) = vanilla_launch_session_path() {
        let _ = fs::remove_file(path);
    }
}

fn disable_mods_for_vanilla_launch() -> Result<String, String> {
    let paths = detect_payday3_paths_internal()
        .ok_or_else(|| "PAYDAY 3 was not detected. Set the game path in Settings first.".to_string())?;

    let mut temp_files = Vec::<DisabledInstallFileRecord>::new();
    let mut hidden_receipt_files = 0usize;
    let mut hidden_loose_paks = 0usize;
    let mut hidden_runtime_files = 0usize;
    let mut skipped = Vec::new();
    let mut move_errors = Vec::new();

    // Restore any previous unfinished temp session before making a new one.
    let _ = restore_mods_after_vanilla_launch();

    for receipt in list_install_receipts_internal().unwrap_or_default() {
        if !receipt_enabled_internal(&paths, &receipt) {
            continue;
        }

        for file in &receipt.files {
            let original = receipt_destination_path(file);

            if receipt_is_movie_file_path(&file.relative_path) {
                skipped.push(format!("Skipped movie/video {}", original.display()));
                continue;
            }

            if receipt_is_shared_loader_path(&original) {
                skipped.push(format!("Skipped shared loader/dependency {}", original.display()));
                continue;
            }

            if !original.exists() || !original.is_file() {
                continue;
            }

            let temp_root = if receipt_is_pak_file_path(&file.relative_path) {
                vanilla_pak_temp_root(&paths)
            } else {
                vanilla_temp_root(&paths)
            };

            let relative = path_relative_for_vanilla_temp(&paths, Some(&receipt), &original);
            let temp_path = temp_root.join(relative);

            match move_file_to_target(&original, &temp_path) {
                Ok(_) => {
                    temp_files.push(DisabledInstallFileRecord {
                        original_path: original.display().to_string(),
                        disabled_path: temp_path.display().to_string(),
                    });
                    hidden_receipt_files += 1;
                }
                Err(error) => move_errors.push(error),
            }
        }
    }

    // Hide loose enabled PAK-family files that are not covered by Tsuki receipts.
    let already_hidden_originals = temp_files
        .iter()
        .map(|record| record.original_path.to_lowercase())
        .collect::<std::collections::BTreeSet<_>>();

    let scan = scan_pak_mods_internal()?;

    for file in scan.pak_mods.into_iter().filter(|file| file.enabled) {
        let original = PathBuf::from(&file.full_path);
        let original_key = original.display().to_string().to_lowercase();

        if already_hidden_originals.contains(&original_key) {
            continue;
        }

        if !original.exists() || !original.is_file() {
            continue;
        }

        let temp_path = vanilla_pak_temp_root(&paths)
            .join("Loose PAK Mods")
            .join(&file.file_name);

        match move_file_to_target(&original, &temp_path) {
            Ok(_) => {
                temp_files.push(DisabledInstallFileRecord {
                    original_path: original.display().to_string(),
                    disabled_path: temp_path.display().to_string(),
                });
                hidden_loose_paks += 1;
            }
            Err(error) => move_errors.push(error),
        }
    }

    hidden_runtime_files += disable_vanilla_runtime_surfaces(&paths, &mut temp_files, &mut move_errors);

    if !temp_files.is_empty() {
        write_vanilla_launch_session(&VanillaLaunchSession {
            created_at_unix: now_unix_seconds(),
            pak_files: Vec::new(),
            receipt_ids: Vec::new(),
            temp_files,
        })?;
    }

    if !move_errors.is_empty() {
        return Err(format!(
            "Vanilla launch blocked because Tsuki could not move every active mod surface away. Nothing will launch until this is fixed. Move errors: {}",
            move_errors.join(" | ")
        ));
    }

    let mut message = format!(
        "Vanilla mode prepared temporarily: hidden {} receipt file(s), {} loose PAK-family file(s), and {} UE4SS/runtime loader item(s). Mods remain logically On and will restore after PAYDAY 3 closes.",
        hidden_receipt_files,
        hidden_loose_paks,
        hidden_runtime_files
    );

    if !skipped.is_empty() {
        message.push_str(&format!(" Skipped: {}", skipped.join(" | ")));
    }

    Ok(message)
}

fn restore_mods_after_vanilla_launch() -> Result<String, String> {
    let Some(session) = read_vanilla_launch_session() else {
        let (restored, skipped) = restore_orphaned_vanilla_temp_files()?;

        if restored == 0 {
            if skipped.is_empty() {
                return Ok("No previous vanilla launch session needed restoring.".to_string());
            }

            return Ok(format!("No previous vanilla launch session needed restoring. {}", skipped.join(" | ")));
        }

        let mut message = format!("Restored orphaned vanilla temp folders on startup/manual repair: {} item(s).", restored);
        if !skipped.is_empty() {
            message.push_str(&format!(" Notes: {}", skipped.join(" | ")));
        }
        return Ok(message);
    };

    let mut restored_temp = 0usize;
    let mut restored_paks = 0usize;
    let mut restored_receipts = 0usize;
    let mut skipped = Vec::new();

    for record in &session.temp_files {
        let source_path = PathBuf::from(&record.disabled_path);
        let destination = PathBuf::from(&record.original_path);

        if !source_path.exists() {
            skipped.push(format!("Missing temporary vanilla file {}", source_path.display()));
            continue;
        }

        match restore_path_merge(&source_path, &destination, &mut skipped) {
            Ok(count) => restored_temp += count,
            Err(error) => skipped.push(error),
        }
    }

    // Legacy restore path from v0.86. Kept so users are not stranded if they used an older build.
    if !session.receipt_ids.is_empty() {
        for receipt_id in &session.receipt_ids {
            match set_receipt_mod_enabled_internal(receipt_id, true) {
                Ok(_) => restored_receipts += 1,
                Err(error) => skipped.push(format!("receipt {}: {}", receipt_id, error)),
            }
        }
    }

    if !session.pak_files.is_empty() {
        let count = session.pak_files.len();
        match set_pak_mod_files_enabled(session.pak_files.clone(), true, None) {
            Ok(_) => restored_paks = count,
            Err(error) => skipped.push(format!("pak restore: {}", error)),
        }
    }

    clear_vanilla_launch_session();

    let mut message = format!(
        "Restored vanilla temporary session: {} temp file(s), {} legacy pak file(s), {} legacy receipt install(s).",
        restored_temp,
        restored_paks,
        restored_receipts
    );

    if !skipped.is_empty() {
        message.push_str(&format!(" Skipped: {}", skipped.join(" | ")));
    }

    Ok(message)
}


fn restore_path_merge(source: &Path, destination: &Path, skipped: &mut Vec<String>) -> Result<usize, String> {
    if !source.exists() {
        return Ok(0);
    }

    if source.is_dir() {
        fs::create_dir_all(destination)
            .map_err(|err| format!("Failed to create restore folder {}: {}", destination.display(), err))?;

        let mut restored = 0usize;
        let entries = fs::read_dir(source)
            .map_err(|err| format!("Failed to read vanilla temp folder {}: {}", source.display(), err))?;

        for entry in entries {
            let entry = entry.map_err(|err| format!("Failed to read vanilla temp entry: {}", err))?;
            let child_source = entry.path();
            let child_destination = destination.join(entry.file_name());
            restored += restore_path_merge(&child_source, &child_destination, skipped)?;
        }

        let _ = fs::remove_dir(source);
        return Ok(restored);
    }

    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create restore parent {}: {}", parent.display(), err))?;
    }

    if destination.exists() {
        if keep_uninstalled_mods_enabled() {
            let holding_root = uninstalled_dir()?.join(format!("vanilla_restore_conflict_{}", current_timestamp()));
            fs::create_dir_all(&holding_root)
                .map_err(|err| format!("Failed to create restore conflict folder {}: {}", holding_root.display(), err))?;

            let fallback_name = destination
                .file_name()
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("unknown_restore_conflict"));
            let conflict_destination = unique_destination_path(&holding_root.join(fallback_name));

            move_path_to_target(destination, &conflict_destination).map_err(|err| {
                format!(
                    "Could not move existing restore conflict {} out of the way before restoring {}: {}",
                    destination.display(),
                    source.display(),
                    err
                )
            })?;

            skipped.push(format!("Moved existing restore conflict to {}", conflict_destination.display()));
        } else {
            delete_file_permanently(destination, "restore conflict")?;
            skipped.push(format!("Deleted existing restore conflict {}", destination.display()));
        }
    }

    move_path_to_target(source, destination)?;
    Ok(1)
}

fn restore_temp_children_to(source_root: &Path, destination_root: &Path, skipped: &mut Vec<String>) -> Result<usize, String> {
    if !source_root.exists() {
        return Ok(0);
    }

    let entries = fs::read_dir(source_root)
        .map_err(|err| format!("Failed to read vanilla temp folder {}: {}", source_root.display(), err))?;
    let mut restored = 0usize;

    for entry in entries {
        let entry = entry.map_err(|err| format!("Failed to read vanilla temp entry: {}", err))?;
        let source = entry.path();
        let destination = destination_root.join(entry.file_name());
        restored += restore_path_merge(&source, &destination, skipped)?;
    }

    let _ = fs::remove_dir(source_root);
    Ok(restored)
}


fn restore_pak_temp_tree(source_root: &Path, pak_mods_root: &Path, skipped: &mut Vec<String>) -> Result<usize, String> {
    if !source_root.exists() {
        return Ok(0);
    }

    let mut restored = 0usize;
    let entries = fs::read_dir(source_root)
        .map_err(|err| format!("Failed to read vanilla PAK temp folder {}: {}", source_root.display(), err))?;

    for entry in entries {
        let entry = entry.map_err(|err| format!("Failed to read vanilla PAK temp entry: {}", err))?;
        let source = entry.path();

        if source.is_dir() {
            restored += restore_pak_temp_tree(&source, pak_mods_root, skipped)?;
            let _ = fs::remove_dir(&source);
            continue;
        }

        let Some(file_name) = source.file_name().map(PathBuf::from) else { continue; };
        let lower = file_name.to_string_lossy().to_lowercase();

        if !(lower.ends_with(".pak") || lower.ends_with(".ucas") || lower.ends_with(".utoc") || lower.ends_with(".sig")) {
            skipped.push(format!("Skipped non-PAK vanilla temp file {}", source.display()));
            continue;
        }

        restored += restore_path_merge(&source, &pak_mods_root.join(file_name), skipped)?;
    }

    let _ = fs::remove_dir(source_root);
    Ok(restored)
}

fn restore_orphaned_vanilla_temp_files() -> Result<(usize, Vec<String>), String> {
    if payday_process_running() {
        return Ok((0, vec!["PAYDAY 3 is still running, so startup restore skipped to avoid changing files while the game is open.".to_string()]));
    }

    let Some(paths) = detect_payday3_paths_internal() else {
        return Ok((0, vec!["PAYDAY 3 path was not detected, so no orphaned vanilla temp folders could be checked.".to_string()]));
    };

    let mut restored = 0usize;
    let mut skipped = Vec::new();

    let pak_temp_roots = [
        vanilla_pak_temp_root(&paths),
        legacy_vanilla_pak_temp_root(&paths),
    ];

    // PAK temp files always belong back in Content/Paks/~mods. Check both the new safe AppData
    // temp root and the legacy ~mods/.tsuki-vanilla-temp root so older test builds never strand PAKs.
    for pak_temp in pak_temp_roots {
        restored += restore_pak_temp_tree(&pak_temp, &paths.pak_mods, &mut skipped)?;
    }

    let win64_temp_roots = [
        vanilla_temp_root(&paths),
        legacy_vanilla_temp_root(&paths),
    ];

    // Win64 temp has named buckets. Merge children back instead of replacing existing folders.
    for win64_temp in win64_temp_roots {
        if win64_temp.exists() {
            let entries = fs::read_dir(&win64_temp)
                .map_err(|err| format!("Failed to read vanilla temp folder {}: {}", win64_temp.display(), err))?;

            for entry in entries {
                let entry = entry.map_err(|err| format!("Failed to read vanilla temp entry: {}", err))?;
                let source = entry.path();
                let name = entry.file_name().to_string_lossy().to_lowercase();

                let destination_root = if name == "runtime loaders" {
                    paths.win64.clone()
                } else if name == "ue4ss mods" {
                    paths.ue4ss_mods.clone()
                } else {
                    // Receipt temp folders store paths relative to Win64, for example Mods/SomeUE4SSMod.
                    paths.win64.clone()
                };

                if source.is_dir() {
                    restored += restore_temp_children_to(&source, &destination_root, &mut skipped)?;
                } else {
                    restored += restore_path_merge(&source, &destination_root.join(entry.file_name()), &mut skipped)?;
                }
            }

            let _ = fs::remove_dir(&win64_temp);
        }
    }

    if restored > 0 {
        let _ = sync_installed_state_database();
    }

    Ok((restored, skipped))
}

#[tauri::command]
fn restore_mods_after_vanilla() -> Result<String, String> {
    restore_mods_after_vanilla_launch()
}


#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DependencyReport {
    game_root: String,
    win64: String,
    mods_folder: String,
    items: Vec<DependencyStatusItem>,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReceiptRepairItem {
    receipt_id: String,
    display_name: String,
    source: String,
    source_mod_id: Option<String>,
    installed_at_unix: Option<u64>,
    live_files: usize,
    missing_files: usize,
    disabled_files: usize,
    stale: bool,
    tracked_files: Vec<String>,
    missing_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MovieValidationItem {
    receipt_id: String,
    display_name: String,
    archive_or_installed_path: String,
    destination: String,
    exact_target_exists: bool,
    same_file_name_matches: Vec<String>,
    verdict: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedWindowState {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct AppSettings {
    game_path: Option<String>,
    current_game_profile_id: Option<String>,
    active_game_profile_id: Option<String>,
    active_mod_profile_by_game_profile_id: std::collections::BTreeMap<String, String>,
    theme_id: String,
    appearance_mode: String,
    accent_color: String,
    interface_density: String,
    animations_enabled: bool,
    transparency_enabled: bool,
    font_scale: u32,
    thumbnail_size: u32,
    sidebar_density: String,
    startup_destination: String,
    notifications_enabled: bool,
    language: String,
    default_launch_action: String,
    confirm_destructive_actions: bool,
    auto_update_checks: bool,
    remember_window_state: bool,
    window_state: Option<SavedWindowState>,
    download_folder: Option<String>,
    simultaneous_downloads: usize,
    download_retry_count: usize,
    download_bandwidth_limit_mb_s: u64,
    verify_hashes: bool,
    keep_downloaded_archives: bool,
    keep_uninstalled_mods: bool,
    browser_mode: String,
    external_link_behavior: String,
    remember_website_logins: bool,
    intercept_supported_downloads: bool,
    keep_embedded_browsing_in_sites: bool,
    protect_wrong_game_downloads: bool,
    remember_last_website_per_profile: bool,
    profile_default_sources: Vec<String>,
    profile_default_dependency_setup: String,
    profile_default_backup_behavior: String,
    profile_default_installation_flow: String,
    profile_default_browser_mode: String,
    profile_default_index_behavior: String,
    app_update_manifest_url: Option<String>,
    update_channel: String,
    profile_update_checks: bool,
    dependency_update_checks: bool,
    index_update_checks: bool,
    ignored_versions: Vec<String>,
    source_index_v2_remote_enabled: Option<bool>,
    source_index_v2_remote_url: Option<String>,
    index_overnight: bool,
    index_pause_while_game_running: bool,
    index_pause_on_battery: bool,
    index_build_mode: String,
    index_bandwidth_limit_mb_s: u64,
    index_temp_storage_limit_gb: u32,
    index_remote_behavior: String,
    modworkshop_api_key: Option<String>,
    nexus_api_key: Option<String>,
    show_age_restricted_nexus: bool,
    developer_mode: Option<bool>,
    verbose_logging: bool,
    experimental_features: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            game_path: None,
            current_game_profile_id: None,
            active_game_profile_id: None,
            active_mod_profile_by_game_profile_id: std::collections::BTreeMap::new(),
            theme_id: DEFAULT_THEME_ID.to_string(),
            appearance_mode: "system".to_string(),
            accent_color: "#9b72ff".to_string(),
            interface_density: "comfortable".to_string(),
            animations_enabled: true,
            transparency_enabled: true,
            font_scale: 100,
            thumbnail_size: 160,
            sidebar_density: "comfortable".to_string(),
            startup_destination: "home".to_string(),
            notifications_enabled: true,
            language: "system".to_string(),
            default_launch_action: "ask".to_string(),
            confirm_destructive_actions: true,
            auto_update_checks: true,
            remember_window_state: true,
            window_state: None,
            download_folder: None,
            simultaneous_downloads: 3,
            download_retry_count: 2,
            download_bandwidth_limit_mb_s: 0,
            verify_hashes: true,
            keep_downloaded_archives: true,
            keep_uninstalled_mods: false,
            browser_mode: "fallback".to_string(),
            external_link_behavior: "ask".to_string(),
            remember_website_logins: true,
            intercept_supported_downloads: true,
            keep_embedded_browsing_in_sites: true,
            protect_wrong_game_downloads: true,
            remember_last_website_per_profile: true,
            profile_default_sources: vec!["modworkshop".to_string(), "nexus".to_string(), "github".to_string()],
            profile_default_dependency_setup: "ask".to_string(),
            profile_default_backup_behavior: "before-replace".to_string(),
            profile_default_installation_flow: "guided".to_string(),
            profile_default_browser_mode: "global".to_string(),
            profile_default_index_behavior: "auto".to_string(),
            app_update_manifest_url: None,
            update_channel: "stable".to_string(),
            profile_update_checks: true,
            dependency_update_checks: true,
            index_update_checks: true,
            ignored_versions: Vec::new(),
            source_index_v2_remote_enabled: Some(true),
            source_index_v2_remote_url: None,
            index_overnight: false,
            index_pause_while_game_running: true,
            index_pause_on_battery: true,
            index_build_mode: "metadata".to_string(),
            index_bandwidth_limit_mb_s: 0,
            index_temp_storage_limit_gb: 8,
            index_remote_behavior: "auto".to_string(),
            modworkshop_api_key: None,
            nexus_api_key: None,
            show_age_restricted_nexus: true,
            developer_mode: Some(false),
            verbose_logging: false,
            experimental_features: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ProfileSettings {
    game_version: Option<String>,
    profile_id: String,
    updated_at_unix: u64,
    game_root_override: Option<String>,
    executable_override: Option<String>,
    working_directory_override: Option<String>,
    launch_arguments: String,
    launch_environment: Vec<String>,
    default_launch_action: String,
    browser_mode_override: String,
    preferred_browser_source: String,
    remember_last_website: bool,
    enabled_sources: Vec<String>,
    index_behavior: String,
    dependency_setup: String,
    dependency_updates: String,
    backup_behavior: String,
    backup_retention_count: u32,
    setup_reminders: bool,
    dismissed_setup_checks: Vec<String>,
    last_settings_category: Option<String>,
}

impl Default for ProfileSettings {
    fn default() -> Self {
        Self {
            profile_id: String::new(),
            game_version: None,
            updated_at_unix: 0,
            game_root_override: None,
            executable_override: None,
            working_directory_override: None,
            launch_arguments: String::new(),
            launch_environment: Vec::new(),
            default_launch_action: "inherit".to_string(),
            browser_mode_override: "inherit".to_string(),
            preferred_browser_source: "auto".to_string(),
            remember_last_website: true,
            enabled_sources: Vec::new(),
            index_behavior: "inherit".to_string(),
            dependency_setup: "inherit".to_string(),
            dependency_updates: "inherit".to_string(),
            backup_behavior: "inherit".to_string(),
            backup_retention_count: 5,
            setup_reminders: true,
            dismissed_setup_checks: Vec::new(),
            last_settings_category: None,
        }
    }
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheStats {
    app_data_path: String,
    cache_path: String,
    download_cache_path: String,
    extraction_cache_path: String,
    uninstalled_path: String,
    receipts_path: String,
    indexes_path: String,
    backups_path: String,
    logs_path: String,
    thumbnails_path: String,
    download_cache_size_bytes: u64,
    extraction_cache_size_bytes: u64,
    total_cache_size_bytes: u64,
    cached_download_count: usize,
    temporary_extraction_folder_count: usize,
    uninstalled_storage_size_bytes: u64,
    uninstalled_entry_count: usize,
    receipts_size_bytes: u64,
    receipt_count: usize,
    indexes_size_bytes: u64,
    index_file_count: usize,
    backups_size_bytes: u64,
    backup_count: usize,
    logs_size_bytes: u64,
    log_count: usize,
    thumbnails_size_bytes: u64,
    thumbnail_count: usize,
}

fn allowed_theme_id(value: &str) -> bool {
    matches!(
        value,
        "moonveil"
            | "true-dark"
            | "polar-day"
            | "neon-rift"
            | "aqua-ghost"
            | "ember-forge"
            | "sakura-night"
            | "emerald-grid"
            | "royal-indigo"
            | "classic-light"
    )
}

fn normalize_theme_id(value: &str) -> String {
    let trimmed = value.trim();
    let canonical = match trimmed {
        "basic-light" => "classic-light",
        "basic-dark" | "midnight" | "mono-eclipse" => "true-dark",
        "crimson-noir" | "solar-dusk" => "ember-forge",
        "solar-byte" => "polar-day",
        "deep-space" => "neon-rift",
        "void-rose" => "sakura-night",
        other => other,
    };

    if allowed_theme_id(canonical) {
        canonical.to_string()
    } else {
        DEFAULT_THEME_ID.to_string()
    }
}

fn clean_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|text| {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn normalize_choice(value: &mut String, allowed: &[&str], fallback: &str) {
    if !allowed.contains(&value.as_str()) {
        *value = fallback.to_string();
    }
}

fn normalize_hex_color(value: &mut String, fallback: &str) {
    let valid = value.len() == 7
        && value.starts_with('#')
        && value.chars().skip(1).all(|ch| ch.is_ascii_hexdigit());
    if !valid {
        *value = fallback.to_string();
    }
}

fn normalize_string_list(values: Vec<String>, allowed: &[&str], fallback: &[&str]) -> Vec<String> {
    let mut normalized = Vec::new();
    for value in values {
        let trimmed = value.trim().to_lowercase();
        if allowed.contains(&trimmed.as_str()) && !normalized.contains(&trimmed) {
            normalized.push(trimmed);
        }
    }

    if normalized.is_empty() {
        fallback.iter().map(|value| value.to_string()).collect()
    } else {
        normalized
    }
}

fn normalize_free_string_list(values: Vec<String>) -> Vec<String> {
    let mut normalized = Vec::new();
    for value in values {
        let trimmed = value.trim();
        if !trimmed.is_empty() && !normalized.iter().any(|existing: &String| existing.eq_ignore_ascii_case(trimmed)) {
            normalized.push(trimmed.to_string());
        }
    }
    normalized
}

fn normalize_app_settings(mut settings: AppSettings) -> AppSettings {
    settings.game_path = clean_optional_string(settings.game_path);
    settings.current_game_profile_id = clean_optional_string(settings.current_game_profile_id);
    settings.active_game_profile_id = clean_optional_string(settings.active_game_profile_id);
    settings.active_mod_profile_by_game_profile_id = settings
        .active_mod_profile_by_game_profile_id
        .into_iter()
        .filter_map(|(game_profile_id, mod_profile_id)| {
            let game_profile_id = clean_profile_id(&game_profile_id).ok()?;
            let mod_profile_id = clean_optional_string(Some(mod_profile_id))?;
            Some((game_profile_id, mod_profile_id))
        })
        .collect();
    settings.theme_id = normalize_theme_id(&settings.theme_id);
    normalize_choice(&mut settings.appearance_mode, &["system", "light", "dark"], "system");
    normalize_hex_color(&mut settings.accent_color, "#9b72ff");
    normalize_choice(&mut settings.interface_density, &["compact", "comfortable", "spacious"], "comfortable");
    settings.font_scale = settings.font_scale.clamp(90, 125);
    settings.thumbnail_size = settings.thumbnail_size.clamp(96, 280);
    normalize_choice(&mut settings.sidebar_density, &["comfortable", "compact", "icons"], "comfortable");
    normalize_choice(&mut settings.startup_destination, &["home", "browse", "installed", "games", "last"], "home");
    normalize_choice(&mut settings.language, &["system", "en"], "system");
    normalize_choice(&mut settings.default_launch_action, &["ask", "vanilla", "modded", "remember"], "ask");
    settings.download_folder = clean_optional_string(settings.download_folder);
    settings.simultaneous_downloads = settings.simultaneous_downloads.clamp(1, 8);
    settings.download_retry_count = settings.download_retry_count.clamp(0, 6);
    settings.download_bandwidth_limit_mb_s = settings.download_bandwidth_limit_mb_s.clamp(0, 250);
    normalize_choice(&mut settings.browser_mode, &["native", "embedded", "fallback", "ask"], "fallback");
    normalize_choice(&mut settings.external_link_behavior, &["ask", "external", "block"], "ask");
    settings.profile_default_sources = normalize_string_list(settings.profile_default_sources, &["modworkshop", "nexus", "github"], &["modworkshop", "nexus", "github"]);
    normalize_choice(&mut settings.profile_default_dependency_setup, &["ask", "auto", "off"], "ask");
    normalize_choice(&mut settings.profile_default_backup_behavior, &["before-replace", "every-install", "needed", "disabled"], "before-replace");
    normalize_choice(&mut settings.profile_default_installation_flow, &["guided", "quick", "ask"], "guided");
    normalize_choice(&mut settings.profile_default_browser_mode, &["global", "native", "embedded", "ask"], "global");
    normalize_choice(&mut settings.profile_default_index_behavior, &["auto", "manual", "disabled"], "auto");
    settings.app_update_manifest_url = clean_optional_string(settings.app_update_manifest_url);
    settings.update_channel = "stable".to_string();
    settings.ignored_versions = normalize_free_string_list(settings.ignored_versions);
    settings.source_index_v2_remote_url = clean_optional_string(settings.source_index_v2_remote_url);
    settings.index_bandwidth_limit_mb_s = settings.index_bandwidth_limit_mb_s.clamp(0, 250);
    settings.index_temp_storage_limit_gb = settings.index_temp_storage_limit_gb.clamp(1, 64);
    normalize_choice(&mut settings.index_build_mode, &["metadata", "manifest", "full"], "metadata");
    normalize_choice(&mut settings.index_remote_behavior, &["auto", "ask", "manual", "disabled"], "auto");
    if settings.index_remote_behavior == "disabled" {
        settings.source_index_v2_remote_enabled = Some(false);
    } else if settings.source_index_v2_remote_enabled.is_none() {
        settings.source_index_v2_remote_enabled = Some(true);
    }
    settings.modworkshop_api_key = clean_optional_string(settings.modworkshop_api_key);
    settings.nexus_api_key = clean_optional_string(settings.nexus_api_key);
    if settings.developer_mode.is_none() {
        settings.developer_mode = Some(false);
    }
    settings
}

fn normalize_profile_settings(mut settings: ProfileSettings, profile_id: &str) -> ProfileSettings {
    settings.profile_id = profile_id.trim().to_string();
    settings.game_version = clean_optional_string(settings.game_version);
    if profile_id == BUILTIN_PAYDAY3_PROFILE_ID && settings.game_version.as_deref() != Some("UE4.27") {
        settings.game_version = Some("UE5.5".to_string());
    }
    settings.game_root_override = clean_optional_string(settings.game_root_override);
    settings.executable_override = clean_optional_string(settings.executable_override);
    settings.working_directory_override = clean_optional_string(settings.working_directory_override);
    settings.launch_arguments = settings.launch_arguments.trim().to_string();
    settings.launch_environment = normalize_free_string_list(settings.launch_environment);
    normalize_choice(
        &mut settings.default_launch_action,
        &["inherit", "ask", "vanilla", "modded", "remember"],
        "inherit",
    );
    normalize_choice(
        &mut settings.browser_mode_override,
        &["inherit", "native", "embedded", "fallback", "ask"],
        "inherit",
    );
    normalize_choice(
        &mut settings.preferred_browser_source,
        &["auto", "modworkshop", "nexus", "github", "custom"],
        "auto",
    );
    settings.enabled_sources = normalize_string_list(
        settings.enabled_sources,
        &["modworkshop", "nexus", "github", "custom"],
        &[],
    );
    normalize_choice(&mut settings.index_behavior, &["inherit", "auto", "manual", "disabled"], "inherit");
    normalize_choice(&mut settings.dependency_setup, &["inherit", "ask", "auto", "off"], "inherit");
    normalize_choice(&mut settings.dependency_updates, &["inherit", "auto", "ask", "off"], "inherit");
    normalize_choice(
        &mut settings.backup_behavior,
        &["inherit", "before-replace", "every-install", "needed", "disabled"],
        "inherit",
    );
    settings.backup_retention_count = settings.backup_retention_count.clamp(0, 50);
    settings.dismissed_setup_checks = normalize_free_string_list(settings.dismissed_setup_checks);
    settings.last_settings_category = clean_optional_string(settings.last_settings_category);
    settings
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupProgress {
    is_running: bool,
    message: String,
    current: usize,
    total: usize,
}

impl Default for BackupProgress {
    fn default() -> Self {
        Self {
            is_running: false,
            message: "Ready.".to_string(),
            current: 0,
            total: 0,
        }
    }
}

struct BackupState {
    progress: Mutex<BackupProgress>,
}

fn set_backup_progress(app: &tauri::AppHandle, progress: BackupProgress) {
    if let Some(state) = app.try_state::<BackupState>() {
        if let Ok(mut current) = state.progress.lock() {
            *current = progress.clone();
        }
    }

    let _ = app.emit("backup-progress", progress);
}

fn app_data_dir() -> Result<PathBuf, String> {
    let appdata = env::var("APPDATA").map_err(|_| "APPDATA environment variable not found".to_string())?;
    Ok(PathBuf::from(appdata).join(APP_DIR_NAME))
}

fn legacy_backups_dir() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("backups"))
}

fn backups_dir() -> Result<PathBuf, String> {
    if let Some(paths) = detect_payday3_paths_internal() {
        return Ok(paths.pak_mods.join("Tsuki_Backups"));
    }

    legacy_backups_dir()
}

fn downloads_cache_dir() -> Result<PathBuf, String> {
    if let Some(folder) = load_settings_internal().download_folder {
        return Ok(PathBuf::from(folder));
    }

    Ok(app_data_dir()?.join("cache").join("downloads"))
}

fn cache_dir() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("cache"))
}

fn extraction_cache_dir() -> Result<PathBuf, String> {
    Ok(downloads_cache_dir()?.join("external_extract"))
}

fn source_download_cache_dirs() -> Result<Vec<PathBuf>, String> {
    let downloads = downloads_cache_dir()?;
    Ok(vec![downloads.join("nexus"), downloads.join("modworkshop")])
}

fn uninstalled_dir() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("uninstalled"))
}

fn keep_uninstalled_mods_enabled() -> bool {
    load_settings_internal().keep_uninstalled_mods
}

fn delete_file_permanently(path: &Path, context: &str) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    if path.is_dir() {
        fs::remove_dir_all(path)
            .map_err(|err| format!("Failed to delete {} folder {}: {}", context, path.display(), err))
    } else {
        fs::remove_file(path)
            .map_err(|err| format!("Failed to delete {} file {}: {}", context, path.display(), err))
    }
}

fn settings_file_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join(SETTINGS_FILE_NAME))
}

fn profile_settings_dir() -> Result<PathBuf, String> {
    let dir = app_data_dir()?.join("profile-settings");
    fs::create_dir_all(&dir)
        .map_err(|err| format!("Failed to create profile settings folder {}: {}", dir.display(), err))?;
    Ok(dir)
}

fn profile_settings_file_path(profile_id: &str) -> Result<PathBuf, String> {
    let trimmed = profile_id.trim();
    if trimmed.is_empty() {
        return Err("Profile id is required.".to_string());
    }

    Ok(profile_settings_dir()?.join(format!("{}.json", sanitize_file_component(trimmed))))
}

fn ensure_app_data_dirs() -> Result<PathBuf, String> {
    let root = app_data_dir()?;

    for folder in ["logs", "backups", "cache", "receipts", "profiles", "profile-settings", "profile-data", "game-profile-drafts", "uninstalled", "diagnostics"] {
        fs::create_dir_all(root.join(folder))
            .map_err(|err| format!("Failed to create {}: {}", folder, err))?;
    }

    Ok(root)
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RuntimeProcessDiagnostic {
    time_unix: u64,
    label: String,
    status: String,
    reason: String,
    details: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeLockStatus {
    payday3_running: bool,
    vanilla_session_active: bool,
    toggle_locked: bool,
    message: String,
}

#[tauri::command]
fn migrate_text_encoding_stores() -> Result<text_encoding::TextEncodingMigrationReport, String> {
    let root = ensure_app_data_dirs()?;
    text_encoding::run_persisted_text_encoding_migration(&root)
}

#[tauri::command]
fn payday3_runtime_lock_status() -> Result<RuntimeLockStatus, String> {
    let payday3_running = payday_process_running();
    let vanilla_session_active = read_vanilla_launch_session().is_some();
    let toggle_locked = payday3_running || vanilla_session_active;
    let message = if payday3_running {
        "PAYDAY 3 is running. Tsuki cannot enable, disable, uninstall, or replace mod files until the game closes.".to_string()
    } else if vanilla_session_active {
        "Vanilla launch session is active. Mods are temporarily shown Off and will restore after PAYDAY 3 closes.".to_string()
    } else {
        "No PAYDAY 3 runtime lock.".to_string()
    };

    Ok(RuntimeLockStatus { payday3_running, vanilla_session_active, toggle_locked, message })
}

fn runtime_mutation_locked_message() -> Option<String> {
    if payday_process_running() {
        return Some("PAYDAY 3 is running. Close the game before enabling, disabling, uninstalling, or replacing mod files.".to_string());
    }

    None
}

fn runtime_diagnostic_file_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("diagnostics").join("runtime-process.json"))
}

fn write_runtime_process_diagnostic(diagnostic: &RuntimeProcessDiagnostic) -> Result<(), String> {
    let _ = ensure_app_data_dirs()?;
    let path = runtime_diagnostic_file_path()?;
    let contents = serde_json::to_string_pretty(diagnostic)
        .map_err(|err| format!("Failed to serialize runtime process diagnostic: {}", err))?;

    fs::write(&path, contents)
        .map_err(|err| format!("Failed to write runtime process diagnostic {}: {}", path.display(), err))
}

fn read_runtime_process_diagnostic() -> Option<RuntimeProcessDiagnostic> {
    let path = runtime_diagnostic_file_path().ok()?;
    let contents = fs::read_to_string(path).ok()?;
    serde_json::from_str(&contents).ok()
}

fn format_runtime_process_diagnostic_for_report() -> String {
    let Some(diagnostic) = read_runtime_process_diagnostic() else {
        return "Last Runtime Process: none\n".to_string();
    };

    let mut lines = Vec::new();
    lines.push("Last Runtime Process:".to_string());
    lines.push(format!("  Time Unix: {}", diagnostic.time_unix));
    lines.push(format!("  Label: {}", diagnostic.label));
    lines.push(format!("  Status: {}", diagnostic.status));
    lines.push(format!("  Reason: {}", diagnostic.reason));

    if !diagnostic.details.is_empty() {
        lines.push("  Details:".to_string());
        for detail in diagnostic.details.iter().take(30) {
            lines.push(format!("    - {}", detail));
        }

        if diagnostic.details.len() > 30 {
            lines.push(format!("    ... {} more detail line(s)", diagnostic.details.len() - 30));
        }
    }

    lines.push(String::new());
    lines.join("\n")
}

#[tauri::command]
fn record_runtime_process_diagnostic(
    label: String,
    status: String,
    reason: String,
    details: Option<Vec<String>>,
) -> Result<String, String> {
    let diagnostic = RuntimeProcessDiagnostic {
        time_unix: now_unix_seconds(),
        label,
        status,
        reason,
        details: details.unwrap_or_default(),
    };

    write_runtime_process_diagnostic(&diagnostic)?;
    Ok("Runtime process diagnostic recorded.".to_string())
}


fn hash_cache_file_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("cache").join("hash-cache.json"))
}

fn source_index_file_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("cache").join("source-index.json"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileHashCacheRecord {
    path: String,
    size_bytes: u64,
    modified_unix: Option<u64>,
    sha256: String,
}

fn read_hash_cache() -> std::collections::BTreeMap<String, FileHashCacheRecord> {
    let Some(path) = hash_cache_file_path().ok() else {
        return std::collections::BTreeMap::new();
    };

    let Ok(contents) = fs::read_to_string(path) else {
        return std::collections::BTreeMap::new();
    };

    serde_json::from_str(&contents).unwrap_or_default()
}

fn write_hash_cache(cache: &std::collections::BTreeMap<String, FileHashCacheRecord>) {
    let Ok(path) = hash_cache_file_path() else {
        return;
    };

    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    if let Ok(contents) = serde_json::to_string(cache) {
        let _ = fs::write(path, contents);
    }
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path)
        .map_err(|err| format!("Failed to open {} for hashing: {}", path.display(), err))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 1024 * 128];

    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|err| format!("Failed to read {} for hashing: {}", path.display(), err))?;

        if read == 0 {
            break;
        }

        hasher.update(&buffer[..read]);
    }

    let digest = hasher.finalize();
    Ok(digest.iter().map(|byte| format!("{:02x}", byte)).collect::<String>())
}

fn cached_sha256_for_file(
    path: &Path,
    size_bytes: u64,
    modified_unix: Option<u64>,
    cache: &mut std::collections::BTreeMap<String, FileHashCacheRecord>,
) -> Option<String> {
    const MAX_SYNC_HASH_BYTES: u64 = 64 * 1024 * 1024;

    let key = path.display().to_string();

    if let Some(record) = cache.get(&key) {
        if record.size_bytes == size_bytes && record.modified_unix == modified_unix {
            return Some(record.sha256.clone());
        }
    }

    // Do not freeze startup by hashing huge PAKs synchronously.
    // Large files can be hashed later by a dedicated repair/index action.
    if size_bytes > MAX_SYNC_HASH_BYTES {
        return None;
    }

    let Ok(sha256) = sha256_file(path) else {
        return None;
    };

    cache.insert(
        key.clone(),
        FileHashCacheRecord {
            path: key,
            size_bytes,
            modified_unix,
            sha256: sha256.clone(),
        },
    );

    Some(sha256)
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SourceIndexDatabase {
    version: u32,
    records: std::collections::BTreeMap<String, SourceIndexRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceIndexRecord {
    source: String,
    source_id: String,
    indexed_at_unix: u64,
    summary: SourceModSummary,
    file_names: Vec<String>,
    file_ids: Vec<String>,
    archive_fingerprint: Option<String>,
}

fn source_index_key(source: &str, source_id: &str) -> String {
    format!("{}-{}", source.to_lowercase(), source_id)
}

fn read_source_index_database() -> SourceIndexDatabase {
    let Some(path) = source_index_file_path().ok() else {
        return SourceIndexDatabase { version: 1, records: std::collections::BTreeMap::new() };
    };

    let Ok(contents) = fs::read_to_string(path) else {
        return SourceIndexDatabase { version: 1, records: std::collections::BTreeMap::new() };
    };

    serde_json::from_str(&contents).unwrap_or_else(|_| SourceIndexDatabase {
        version: 1,
        records: std::collections::BTreeMap::new(),
    })
}

fn write_source_index_database(database: &SourceIndexDatabase) {
    let Ok(path) = source_index_file_path() else {
        return;
    };

    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let mut records = database.records.values().cloned().collect::<Vec<_>>();
    records.sort_by(|a, b| b.indexed_at_unix.cmp(&a.indexed_at_unix));

    let pruned = SourceIndexDatabase {
        version: database.version,
        records: records
            .into_iter()
            .map(|record| (source_index_key(&record.source, &record.source_id), record))
            .collect(),
    };

    if let Ok(contents) = serde_json::to_string(&pruned) {
        let _ = fs::write(path, contents);
    }
}

fn upsert_source_index_summaries(source_mods: &[SourceModSummary]) {
    if source_mods.is_empty() {
        return;
    }

    let mut database = read_source_index_database();
    database.version = 1;
    let now = now_unix_seconds();

    for summary in source_mods {
        let key = source_index_key(&summary.source, &summary.source_id);
        let mut file_names = Vec::new();

        for tag in &summary.tags {
            if tag.contains('.') && tag.len() < 140 {
                file_names.push(tag.clone());
            }
        }

        database.records
            .entry(key)
            .and_modify(|record| {
                record.indexed_at_unix = now;
                record.summary = summary.clone();

                for file_name in &file_names {
                    if !record.file_names.iter().any(|existing| existing.eq_ignore_ascii_case(file_name)) {
                        record.file_names.push(file_name.clone());
                    }
                }
            })
            .or_insert(SourceIndexRecord {
                source: summary.source.clone(),
                source_id: summary.source_id.clone(),
                indexed_at_unix: now,
                summary: summary.clone(),
                file_names,
                file_ids: Vec::new(),
                archive_fingerprint: None,
            });
    }

    write_source_index_database(&database);
}

fn upsert_source_index_detail(detail: &SourceModDetail) {
    let mut database = read_source_index_database();
    database.version = 1;
    let key = source_index_key(&detail.source, &detail.source_id);

    let file_names = detail
        .files
        .iter()
        .map(|file| file.name.clone())
        .filter(|name| !name.trim().is_empty())
        .take(24)
        .collect::<Vec<_>>();

    let file_ids = detail
        .files
        .iter()
        .map(|file| file.id.clone())
        .filter(|id| !id.trim().is_empty())
        .take(24)
        .collect::<Vec<_>>();

    let summary = SourceModSummary {
        source: detail.source.clone(),
        source_id: detail.source_id.clone(),
        uid: None,
        game_id: None,
        name: detail.name.clone(),
        author: detail.author.clone(),
        author_username: detail.author_username.clone(),
        author_user_id: detail.author_user_id.clone(),
        author_profile_url: detail.author_profile_url.clone(),
        author_avatar_url: detail.author_avatar_url.clone(),
        version: detail.version.clone(),
        thumbnail_url: detail.thumbnail_url.clone(),
        banner_url: detail.banner_url.clone(),
        page_url: detail.page_url.clone(),
        updated_at: detail.updated_at.clone(),
        downloads: detail.downloads,
        likes: detail.likes,
        short_description: detail.short_description.clone(),
        tags: detail.tags.clone(),
    };

    database.records.insert(
        key,
        SourceIndexRecord {
            source: detail.source.clone(),
            source_id: detail.source_id.clone(),
            indexed_at_unix: now_unix_seconds(),
            summary,
            file_names,
            file_ids,
            archive_fingerprint: None,
        },
    );

    write_source_index_database(&database);
}

#[tauri::command]
fn list_source_index(source: Option<String>, limit: Option<usize>, profile_id: Option<String>) -> Result<Vec<SourceModSummary>, String> {
    let database = source_catalog::read_catalog(profile_id.as_deref())?;
    let source_filter = source.map(|value| value.to_lowercase());
    let max_items = limit.unwrap_or(1200).clamp(1, 100_000);

    let mut records = database.records.into_values().collect::<Vec<_>>();
    records.sort_by(|a, b| b.indexed_at_unix.cmp(&a.indexed_at_unix));

    Ok(records
        .into_iter()
        .filter(|record| {
            source_filter
                .as_ref()
                .map(|source| record.source.to_lowercase() == *source)
                .unwrap_or(true)
        })
        .take(max_items)
        .map(|record| record.summary)
        .collect())
}

#[tauri::command]
fn get_source_index_status() -> Result<String, String> {
    let database = read_source_index_database();
    let nexus = database.records.values().filter(|record| record.source == "nexus").count();
    let modworkshop = database.records.values().filter(|record| record.source == "modworkshop").count();

    Ok(format!(
        "Source index database: {} total records ({} Nexus, {} ModWorkshop). Stored at {}",
        database.records.len(),
        nexus,
        modworkshop,
        source_index_file_path()?.display()
    ))
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceIndexDiagnostics {
    remote_enabled: bool,
    last_refresh_at: Option<u64>,
    index_version: Option<String>,
    record_count: usize,
    file_entry_count: usize,
    hash_cache_entries: usize,
    refresh_error: Option<String>,
    total_records: usize,
    hash_entries: usize,
    archive_manifests: usize,
    unknown_mods: usize,
    duplicate_hashes: usize,
    broken_entries: usize,
    matching_success_rate: u32,
}

#[tauri::command]
fn get_source_index_diagnostics(profile_id: Option<String>) -> Result<SourceIndexDiagnostics, String> {
    let settings = load_settings_internal();
    let database = source_catalog::read_catalog(profile_id.as_deref())?;
    let record_count = database.records.len();
    let file_entry_count = database
        .records
        .values()
        .map(|record| record.file_names.len().max(record.file_ids.len()))
        .sum::<usize>();
    let archive_manifests = database
        .records
        .values()
        .filter(|record| record.archive_fingerprint.as_ref().map(|value| !value.trim().is_empty()).unwrap_or(false))
        .count();
    let last_refresh_at = database.records.values().map(|record| record.indexed_at_unix).max();
    let hash_cache_entries = read_hash_cache().len();
    let receipts = if is_builtin_payday3_profile(profile_id.as_deref()) { list_install_receipts_internal().unwrap_or_default() }
        else { profile_installs::list_profile_receipts_internal(profile_id.as_deref().unwrap_or(BUILTIN_PAYDAY3_PROFILE_ID)).unwrap_or_default() };
    let unknown_mods = receipts
        .iter()
        .filter(|receipt| receipt.source_mod_id.as_ref().map(|value| value.trim().is_empty()).unwrap_or(true))
        .count();
    let matched_receipts = receipts.len().saturating_sub(unknown_mods);
    let matching_success_rate = if receipts.is_empty() {
        0
    } else {
        ((matched_receipts as f64 / receipts.len() as f64) * 100.0).round() as u32
    };

    let mut fingerprints = std::collections::BTreeMap::<String, usize>::new();
    for record in database.records.values() {
        if let Some(fingerprint) = record.archive_fingerprint.as_ref().map(|value| value.trim()).filter(|value| !value.is_empty()) {
            *fingerprints.entry(fingerprint.to_string()).or_insert(0) += 1;
        }
    }
    let duplicate_hashes = fingerprints.values().filter(|count| **count > 1).count();
    let (indexed_archives, indexed_files, indexed_duplicates) = source_catalog::index_file_statistics(profile_id.as_deref().unwrap_or(BUILTIN_PAYDAY3_PROFILE_ID));

    Ok(SourceIndexDiagnostics {
        remote_enabled: settings.source_index_v2_remote_enabled.unwrap_or(true) && settings.index_remote_behavior != "disabled",
        last_refresh_at,
        index_version: Some(database.version.to_string()),
        record_count,
        file_entry_count: file_entry_count.max(indexed_files),
        hash_cache_entries,
        refresh_error: None,
        total_records: record_count,
        hash_entries: indexed_files,
        archive_manifests: archive_manifests.max(indexed_archives),
        unknown_mods,
        duplicate_hashes: duplicate_hashes.max(indexed_duplicates),
        broken_entries: 0,
        matching_success_rate,
    })
}

fn source_index_recently_refreshed(max_age: Duration) -> bool {
    let Ok(path) = source_index_file_path() else {
        return false;
    };
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    let Ok(modified) = metadata.modified() else {
        return false;
    };
    modified.elapsed().map(|elapsed| elapsed < max_age).unwrap_or(false)
}

fn refresh_source_index_v2_remote_internal() -> Result<String, String> {
    let settings = load_settings_internal();
    if !settings.source_index_v2_remote_enabled.unwrap_or(true) || settings.index_remote_behavior == "disabled" {
        return Ok("Remote source index refresh is disabled in Settings.".to_string());
    }

    let mut notes = Vec::new();
    for source in ["modworkshop", "nexus"] {
        match fetch_source_mods_page_sync(source.to_string(), 1, Some("recent".to_string()), serde_json::Value::Null) {
            Ok(mods) => notes.push(format!("{}: {} record(s)", source, mods.len())),
            Err(error) => notes.push(format!("{}: {}", source, error)),
        }
    }

    Ok(format!("Remote source index refresh finished. {}", notes.join(" | ")))
}

#[tauri::command]
async fn refresh_source_index_v2_remote() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(refresh_source_index_v2_remote_internal)
        .await
        .map_err(|err| format!("Remote source index refresh task failed: {:?}", err))?
}

#[tauri::command]
async fn refresh_source_index_v2_remote_if_stale() -> Result<String, String> {
    if source_index_recently_refreshed(Duration::from_secs(6 * 60 * 60)) {
        return Ok("Remote source index is fresh.".to_string());
    }

    refresh_source_index_v2_remote().await
}

#[tauri::command]
async fn diagnose_modworkshop_categories() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mods = fetch_modworkshop_mods_page(1, "recent")?;
        Ok(format!("ModWorkshop public browsing returned {} PAYDAY 3 mod(s).", mods.len()))
    })
    .await
    .map_err(|err| format!("ModWorkshop diagnostic task failed: {:?}", err))?
}

fn load_settings_internal() -> AppSettings {
    let Ok(settings_path) = settings_file_path() else {
        return AppSettings::default();
    };

    let Ok(contents) = fs::read_to_string(settings_path) else {
        return AppSettings::default();
    };

    serde_json::from_str::<AppSettings>(&contents)
        .map(normalize_app_settings)
        .unwrap_or_default()
}

fn save_settings_internal(settings: &AppSettings) -> Result<(), String> {
    let root = ensure_app_data_dirs()?;
    let settings_path = root.join(SETTINGS_FILE_NAME);
    let normalized = normalize_app_settings(settings.clone());
    let contents = serde_json::to_string_pretty(&normalized)
        .map_err(|err| format!("Failed to serialize settings: {}", err))?;

    fs::write(settings_path, contents).map_err(|err| format!("Failed to save settings: {}", err))
}

fn load_profile_settings_internal(profile_id: &str) -> ProfileSettings {
    let Ok(path) = profile_settings_file_path(profile_id) else {
        return normalize_profile_settings(ProfileSettings::default(), profile_id);
    };

    let Ok(contents) = fs::read_to_string(path) else {
        return normalize_profile_settings(ProfileSettings::default(), profile_id);
    };

    serde_json::from_str::<ProfileSettings>(&contents)
        .map(|settings| normalize_profile_settings(settings, profile_id))
        .unwrap_or_else(|_| normalize_profile_settings(ProfileSettings::default(), profile_id))
}

fn save_profile_settings_internal(profile_id: &str, settings: &ProfileSettings) -> Result<ProfileSettings, String> {
    let mut normalized = normalize_profile_settings(settings.clone(), profile_id);
    normalized.updated_at_unix = now_unix_seconds();
    let path = profile_settings_file_path(profile_id)?;
    let value = serde_json::to_value(&normalized)
        .map_err(|err| format!("Failed to serialize profile settings: {}", err))?;
    write_json_file(&path, &value, "profile settings")?;
    Ok(normalized)
}

fn reset_profile_settings_scope(settings: &mut ProfileSettings, defaults: &ProfileSettings, scope: &str) -> Result<(), String> {
    match scope.trim() {
        "overview" | "identity" => {
            settings.last_settings_category = None;
        }
        "gameLaunch" | "game-launch" | "game" | "launch" => {
            settings.game_root_override = defaults.game_root_override.clone();
            settings.executable_override = defaults.executable_override.clone();
            settings.working_directory_override = defaults.working_directory_override.clone();
            settings.launch_arguments = defaults.launch_arguments.clone();
            settings.launch_environment = defaults.launch_environment.clone();
            settings.default_launch_action = defaults.default_launch_action.clone();
        }
        "browsing" | "browser" => {
            settings.browser_mode_override = defaults.browser_mode_override.clone();
            settings.preferred_browser_source = defaults.preferred_browser_source.clone();
            settings.remember_last_website = defaults.remember_last_website;
        }
        "sources" => {
            settings.enabled_sources = defaults.enabled_sources.clone();
        }
        "modIndex" | "mod-index" => {
            settings.index_behavior = defaults.index_behavior.clone();
        }
        "dependencies" => {
            settings.dependency_setup = defaults.dependency_setup.clone();
            settings.dependency_updates = defaults.dependency_updates.clone();
        }
        "backups" => {
            settings.backup_behavior = defaults.backup_behavior.clone();
            settings.backup_retention_count = defaults.backup_retention_count;
        }
        "setup" => {
            settings.setup_reminders = defaults.setup_reminders;
            settings.dismissed_setup_checks = defaults.dismissed_setup_checks.clone();
        }
        "all" => {
            *settings = defaults.clone();
        }
        other => return Err(format!("Unknown profile settings reset scope: {}", other)),
    }

    Ok(())
}

fn current_timestamp() -> String {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => format!("{}", duration.as_secs()),
        Err(_) => "unknown".to_string(),
    }
}

fn system_time_unix(time: SystemTime) -> Option<u64> {
    time.duration_since(UNIX_EPOCH).ok().map(|duration| duration.as_secs())
}

fn payday_paths_from_root(game_root: &Path) -> PaydayPaths {
    let version = load_profile_settings_internal(BUILTIN_PAYDAY3_PROFILE_ID).game_version;
    payday_paths_for_version(game_root, version.as_deref().unwrap_or("UE5.5"))
}

fn payday_paths_for_version(game_root: &Path, version: &str) -> PaydayPaths {
    let game_dir = if game_root.join("Content/PAYDAY3/Binaries/WinGDK").is_dir() {
        game_root.join("Content/PAYDAY3")
    } else { game_root.join("PAYDAY3") };
    let win64 = game_dir.join("Binaries").join(if game_dir.join("Binaries/WinGDK").is_dir() { "WinGDK" } else { "Win64" });
    PaydayPaths {
        game_root: game_root.to_path_buf(),
        pak_mods: game_dir.join("Content/Paks/~mods"),
        ue4ss_mods: if version == "UE4.27" { win64.join("Mods") } else { win64.join("UE4SS/Mods") },
        win64,
    }
}

fn payday_uses_ue5_layout(paths: &PaydayPaths) -> bool {
    paths.ue4ss_mods == paths.win64.join("UE4SS/Mods")
}

fn payday_ue5_loader_ready(paths: &PaydayPaths, require_pak: bool) -> bool {
    let loader_present = paths.win64.join("dwmapi.dll").is_file()
        && paths.win64.join("UE4SS/UE4SS.dll").is_file();
    if !require_pak { return loader_present; }
    let allow_mods = paths.ue4ss_mods.join("AllowModsMod");
    let enabled = fs::read_to_string(paths.ue4ss_mods.join("mods.txt")).ok().map(|text| text.lines().any(|line| {
        let clean = line.split(';').next().unwrap_or("").trim();
        clean.split_once(':').map(|(name, value)| name.trim().eq_ignore_ascii_case("AllowModsMod") && value.trim() == "1").unwrap_or(false)
    })).unwrap_or(false) || allow_mods.join("enabled.txt").is_file();
    loader_present && allow_mods.join("dlls/AllowModsMod.dll").is_file() && enabled
}

fn allowmods_patch_failed(log: &str) -> bool {
    let session = log.rsplit("Starting C++ mod 'AllowModsMod'").next().unwrap_or(log);
    session.lines().any(|line| line.contains("[AllowModsMod]") && line.contains("Unable to patch"))
}

fn payday_ue5_runtime_warning(paths: &PaydayPaths) -> Option<String> {
    let log_path = paths.win64.join("UE4SS/UE4SS.log");
    let metadata = fs::metadata(&log_path).ok()?;
    let modified = metadata.modified().ok()?;
    let mut markers = vec![paths.win64.join("UE4SS/Mods/AllowModsMod/dlls/AllowModsMod.dll")];
    markers.extend(payday_exe_candidates(paths).into_iter().filter(|path| path.is_file()));
    if markers.iter().any(|path| fs::metadata(path).and_then(|m| m.modified()).map(|time| time > modified).unwrap_or(true)) { return None; }
    let mut file = File::open(&log_path).ok()?;
    use std::io::{Seek, SeekFrom};
    file.seek(SeekFrom::Start(metadata.len().saturating_sub(4 * 1024 * 1024))).ok()?;
    let mut contents = Vec::new();
    file.take(4 * 1024 * 1024).read_to_end(&mut contents).ok()?;
    allowmods_patch_failed(&String::from_utf8_lossy(&contents)).then(|| "The latest recorded AllowModsMod session could not patch this game build. Dependency files are present, but PAK activation is not verified. Check the official UE5 loader updates; reinstalling the same package is not a confirmed fix.".to_string())
}

fn validate_payday_ue5_dependencies(paths: &PaydayPaths, entries: &[ArchiveInspectEntry]) -> Result<(), String> {
    if !payday_uses_ue5_layout(paths) { return Ok(()); }
    let has_destination = |relative: &str| entries.iter().any(|entry| !entry.blocked && Path::new(&entry.destination) == paths.win64.join(relative));
    let bundled_loader = has_destination("dwmapi.dll") && has_destination("UE4SS/UE4SS.dll")
        && entries.iter().any(|entry| entry.archive_path.to_lowercase().ends_with("ue4ss/ue4ss.dll"));
    if has_destination("UE4SS/UE4SS.dll") && !bundled_loader {
        return Err("This archive does not have the current PAYDAY 3 UE5 loader layout. Choose the UE5 package with dwmapi.dll and UE4SS/UE4SS.dll; legacy loader files must not overwrite it.".to_string());
    }
    let needs_pak = entries.iter().any(|entry| !entry.blocked && entry.route_kind == "pak-mods");
    let needs_script = entries.iter().any(|entry| !entry.blocked && Path::new(&entry.destination).starts_with(&paths.ue4ss_mods));
    if needs_pak && !payday_ue5_loader_ready(paths, true) {
        return Err("PAYDAY 3 UE5 PAK mods require PD3 UE4SS V3.01 + Allow Pak Mods (ModWorkshop 47771), including enabled AllowModsMod. Install the UE5 package first; -fileopenlog and the UE4 Logic Mod Loader are not compatible.".to_string());
    }
    if needs_script && !bundled_loader && !payday_ue5_loader_ready(paths, false) {
        return Err("PAYDAY 3 UE5 script mods require the PAYDAY-specific UE5 UE4SS package (ModWorkshop 47771). Generic or legacy UE4SS in Win64 does not satisfy this dependency.".to_string());
    }
    Ok(())
}

fn is_payday3_root(path: &Path) -> bool {
    [path.join("PAYDAY3"), path.join("Content/PAYDAY3")].iter().any(|game_dir|
        game_dir.join("Content/Paks").is_dir()
            && (game_dir.join("Binaries/Win64").is_dir() || game_dir.join("Binaries/WinGDK").is_dir()))
}

fn common_steam_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();

    roots.push(PathBuf::from(r"C:\Program Files (x86)\Steam"));
    roots.push(PathBuf::from(r"C:\Program Files\Steam"));

    if let Ok(program_files_x86) = env::var("ProgramFiles(x86)") {
        roots.push(PathBuf::from(program_files_x86).join("Steam"));
    }

    if let Ok(program_files) = env::var("ProgramFiles") {
        roots.push(PathBuf::from(program_files).join("Steam"));
    }

    roots
}

fn parse_steam_libraries(steam_root: &Path) -> Vec<PathBuf> {
    let mut libraries = vec![steam_root.to_path_buf()];
    let library_file = steam_root.join("steamapps").join("libraryfolders.vdf");

    let Ok(contents) = fs::read_to_string(library_file) else {
        return libraries;
    };

    for line in contents.lines() {
        let trimmed = line.trim();

        if !trimmed.contains("\"path\"") {
            continue;
        }

        let parts: Vec<&str> = trimmed.split('"').collect();
        if parts.len() >= 4 {
            let path = parts[3].replace("\\\\", "\\");
            libraries.push(PathBuf::from(path));
        }
    }

    libraries
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GameProfileInstallationProbe {
    profile_id: String,
    steam_app_ids: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GameProfileInstallationResult {
    profile_id: String,
    installed: bool,
    storefront: Option<String>,
    game_root: Option<String>,
    matched_app_id: Option<String>,
}

fn steam_manifest_value(contents: &str, key: &str) -> Option<String> {
    contents.lines().find_map(|line| {
        let quoted = line.split('"').collect::<Vec<_>>();
        if quoted.len() >= 4 && quoted[1].eq_ignore_ascii_case(key) {
            Some(quoted[3].replace("\\\\", "\\"))
        } else {
            None
        }
    })
}

fn discovered_steam_libraries() -> Vec<PathBuf> {
    let mut libraries = Vec::new();
    for steam_root in common_steam_roots().into_iter().filter(|root| root.exists()) {
        for library in parse_steam_libraries(&steam_root) {
            if library.exists() && !libraries.iter().any(|known: &PathBuf| known == &library) {
                libraries.push(library);
            }
        }
    }
    libraries
}

fn detect_profile_installation(
    probe: GameProfileInstallationProbe,
    steam_libraries: &[PathBuf],
) -> GameProfileInstallationResult {
    if let Some(manual_root) = load_profile_settings_internal(&probe.profile_id)
        .game_root_override
        .map(PathBuf::from)
        .filter(|path| path.is_dir() && profile_installs::validate_builtin_profile_root(&probe.profile_id, path).is_ok())
    {
        return GameProfileInstallationResult {
            profile_id: probe.profile_id,
            installed: true,
            storefront: Some("manual".to_string()),
            game_root: Some(manual_root.display().to_string()),
            matched_app_id: None,
        };
    }

    for app_id in probe
        .steam_app_ids
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty() && value.chars().all(|character| character.is_ascii_digit()))
    {
        for library in steam_libraries {
            let manifest_path = library
                .join("steamapps")
                .join(format!("appmanifest_{}.acf", app_id));
            let Ok(contents) = fs::read_to_string(&manifest_path) else {
                continue;
            };
            let Some(install_dir) = steam_manifest_value(&contents, "installdir") else {
                continue;
            };
            let game_root = library.join("steamapps").join("common").join(install_dir);
            if game_root.is_dir() && profile_installs::validate_builtin_profile_root(&probe.profile_id, &game_root).is_ok() {
                return GameProfileInstallationResult {
                    profile_id: probe.profile_id,
                    installed: true,
                    storefront: Some("steam".to_string()),
                    game_root: Some(game_root.display().to_string()),
                    matched_app_id: Some(app_id.to_string()),
                };
            }
        }
    }

    GameProfileInstallationResult {
        profile_id: probe.profile_id,
        installed: false,
        storefront: None,
        game_root: None,
        matched_app_id: None,
    }
}

#[tauri::command]
fn detect_game_profile_installations(
    profiles: Vec<GameProfileInstallationProbe>,
) -> Result<Vec<GameProfileInstallationResult>, String> {
    let steam_libraries = discovered_steam_libraries();
    Ok(profiles
        .into_iter()
        .map(|probe| detect_profile_installation(probe, &steam_libraries))
        .collect())
}

fn builtin_profile_steam_app_ids(profile_id: &str) -> &'static [&'static str] {
    match profile_id {
        "builtin.cyberpunk2077" => &["1091500"],
        "builtin.outlast-trials" => &["1304930"],
        "builtin.payday-the-heist" => &["24240"],
        "builtin.payday2" => &["218620"],
        BUILTIN_PAYDAY3_PROFILE_ID => &["1272080"],
        "builtin.resident-evil-7" => &["418370"],
        "builtin.resident-evil-village" => &["1196590"],
        "builtin.resident-evil-requiem" => &["3764200"],
        "builtin.borderlands" => &["8980", "729040"],
        "builtin.borderlands2" => &["49520"],
        "builtin.borderlands3" => &["397540"],
        "builtin.borderlands4" => &["1285190"],
        "builtin.tiny-tinas-wonderlands" => &["1286680"],
        "builtin.spider-man-remastered" => &["1817070"],
        "builtin.spider-man-2" => &["2651280"],
        "builtin.monster-hunter-wilds" => &["2246340"],
        _ => &[],
    }
}

fn require_game_profile_installation(profile_id: Option<&str>) -> Result<String, String> {
    let profile_id = profile_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "A game profile is required before downloading or installing files.".to_string())?;
    let clean = clean_profile_id(profile_id)?;
    let probe = GameProfileInstallationProbe {
        profile_id: clean.clone(),
        steam_app_ids: builtin_profile_steam_app_ids(&clean)
            .iter()
            .map(|value| (*value).to_string())
            .collect(),
    };
    let result = detect_profile_installation(probe, &discovered_steam_libraries());
    if !result.installed {
        return Err(format!(
            "Downloads are disabled because the selected game profile is not installed: {}.",
            clean
        ));
    }
    Ok(clean)
}

fn detect_payday3_paths_internal() -> Option<PaydayPaths> {
    if let Some(root) = load_profile_settings_internal(BUILTIN_PAYDAY3_PROFILE_ID).game_root_override {
        let root = PathBuf::from(root.trim());
        if is_payday3_root(&root) { return Some(payday_paths_from_root(&root)); }
    }
    let settings = load_settings_internal();

    if let Some(game_path) = settings.game_path {
        let manual_path = PathBuf::from(game_path.trim());

        if is_payday3_root(&manual_path) {
            return Some(payday_paths_from_root(&manual_path));
        }
    }

    let mut candidates = Vec::new();

    for steam_root in common_steam_roots() {
        if !steam_root.exists() {
            continue;
        }

        for library in parse_steam_libraries(&steam_root) {
            candidates.push(
                library
                    .join("steamapps")
                    .join("common")
                    .join("PAYDAY3"),
            );
        }
    }

    for drive in ["C", "D", "E", "F", "G"] {
        candidates.push(PathBuf::from(format!(
            r"{}:\SteamLibrary\steamapps\common\PAYDAY3",
            drive
        )));
        candidates.push(PathBuf::from(format!(
            r"{}:\Steam\steamapps\common\PAYDAY3",
            drive
        )));
    }

    candidates
        .into_iter()
        .find(|candidate| is_payday3_root(candidate))
        .map(|root| payday_paths_from_root(&root))
}

fn format_path_status(paths: Option<&PaydayPaths>) -> String {
    match paths {
        Some(paths) => format!(
            "Payday 3 Path: {game_root}\n\
Pak Mods Path: {pak_mods}\n\
Pak Mods Path Exists: {pak_exists}\n\
Win64 Path: {win64}\n\
Win64 Path Exists: {win64_exists}\n\
UE4SS Mods Path: {ue4ss_mods}\n\
UE4SS Path Exists: {ue4ss_exists}",
            game_root = paths.game_root.display(),
            pak_mods = paths.pak_mods.display(),
            pak_exists = paths.pak_mods.exists(),
            win64 = paths.win64.display(),
            win64_exists = paths.win64.exists(),
            ue4ss_mods = paths.ue4ss_mods.display(),
            ue4ss_exists = paths.ue4ss_mods.exists(),
        ),
        None => [
            "Payday 3 Path: not detected",
            "Pak Mods Path Exists: unknown",
            "Win64 Path Exists: unknown",
            "UE4SS Path Exists: unknown",
        ]
        .join("\n"),
    }
}


fn pak_file_kind_from_name(file_name: &str) -> Option<String> {
    let lower = file_name.to_ascii_lowercase();

    for extension in ["pak", "ucas", "utoc"] {
        if lower.ends_with(&format!(".{}", extension))
            || lower.ends_with(&format!(".{}.disabled", extension))
        {
            return Some(extension.to_string());
        }
    }

    None
}

fn is_disabled_pak_name(file_name: &str) -> bool {
    let lower = file_name.to_ascii_lowercase();
    lower.ends_with(".pak.disabled")
        || lower.ends_with(".ucas.disabled")
        || lower.ends_with(".utoc.disabled")
}

fn enabled_name_from_disabled(file_name: &str) -> String {
    file_name
        .strip_suffix(".disabled")
        .or_else(|| file_name.strip_suffix(".DISABLED"))
        .unwrap_or(file_name)
        .to_string()
}

fn disabled_name_from_enabled(file_name: &str) -> String {
    if is_disabled_pak_name(file_name) {
        file_name.to_string()
    } else {
        format!("{}.disabled", file_name)
    }
}

fn is_pak_related_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .and_then(pak_file_kind_from_name)
        .is_some()
}

fn is_pak_file(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|extension| extension.eq_ignore_ascii_case("pak"))
        .unwrap_or(false)
}

fn extract_priority(file_name: &str) -> Option<u32> {
    let prefix: String = file_name.chars().take_while(|ch| ch.is_ascii_digit()).collect();

    if prefix.is_empty() {
        return None;
    }

    file_name
        .chars()
        .nth(prefix.len())
        .filter(|separator| *separator == '_' || *separator == '-')
        .and_then(|_| prefix.parse::<u32>().ok())
}

fn modified_unix(metadata: &fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
}

fn scan_pak_file_into_scan(path: &Path, pak_mods: &mut Vec<PakModFile>, hash_cache: &mut std::collections::BTreeMap<String, FileHashCacheRecord>) -> Result<(), String> {
    if !path.is_file() || !is_pak_related_file(path) {
        return Ok(());
    }

    let metadata = fs::metadata(path)
        .map_err(|err| format!("Failed to read metadata for {}: {}", path.display(), err))?;

    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("unknown")
        .to_string();

    let extension = pak_file_kind_from_name(&file_name).unwrap_or_else(|| {
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
    });

    let size_bytes = metadata.len();
    let modified = modified_unix(&metadata);
    let sha256 = cached_sha256_for_file(path, size_bytes, modified, hash_cache);

    pak_mods.push(PakModFile {
        priority: extract_priority(&enabled_name_from_disabled(&file_name)),
        enabled: !is_disabled_pak_name(&file_name),
        extension,
        size_bytes,
        modified_unix: modified,
        full_path: path.display().to_string(),
        file_name,
        sha256,
    });

    Ok(())
}

fn scan_disabled_pak_tree_into_scan(current: &Path, pak_mods: &mut Vec<PakModFile>, hash_cache: &mut std::collections::BTreeMap<String, FileHashCacheRecord>) -> Result<(), String> {
    if !current.exists() {
        return Ok(());
    }

    let entries = fs::read_dir(current)
        .map_err(|err| format!("Failed to read disabled pak folder {}: {}", current.display(), err))?;

    for entry in entries {
        let entry = entry.map_err(|err| format!("Failed to read disabled pak folder entry: {}", err))?;
        let path = entry.path();

        if path.is_dir() {
            // Never scan inside zip backups or unrelated helper folders. The disabled_pak_mods
            // root should only contain Tsuki-created ModName folders, but this keeps it safe.
            scan_disabled_pak_tree_into_scan(&path, pak_mods, hash_cache)?;
        } else {
            scan_pak_file_into_scan(&path, pak_mods, hash_cache)?;
        }
    }

    Ok(())
}

fn scan_pak_mods_internal() -> Result<PakScanResult, String> {
    let paths = detect_payday3_paths_internal()
        .ok_or_else(|| "Payday 3 not detected. Set a manual path in Settings.".to_string())?;

    let mut pak_mods = Vec::new();
    let mut hash_cache = read_hash_cache();

    // Enabled loose PAK-family files live directly in ~mods. The game scans this level.
    if paths.pak_mods.exists() {
        let entries = fs::read_dir(&paths.pak_mods)
            .map_err(|err| format!("Failed to read pak mods folder: {}", err))?;

        for entry in entries {
            let entry = entry.map_err(|err| format!("Failed to read folder entry: {}", err))?;
            let path = entry.path();
            scan_pak_file_into_scan(&path, &mut pak_mods, &mut hash_cache)?;
        }
    }

    // Disabled PAK-family files are intentionally moved under:
    // ~mods/Tsuki_Disabled_Mods/disabled_pak_mods/<ModName>/*.disabled
    // They still need to show in Installed so the user can re-enable them.
    for disabled_root in disabled_pak_mods_root_candidates(&paths) {
        let _ = scan_disabled_pak_tree_into_scan(&disabled_root, &mut pak_mods, &mut hash_cache);
    }

    // Vanilla launch temporarily moves enabled PAK-family files outside ~mods.
    // Show them as Off in Installed while PAYDAY 3 is running, instead of making them vanish.
    if let Some(session) = read_vanilla_launch_session() {
        for record in session.temp_files {
            let hidden = PathBuf::from(&record.disabled_path);
            let original = PathBuf::from(&record.original_path);
            if !hidden.exists() || !is_pak_related_file(&hidden) && !is_pak_related_file(&original) {
                continue;
            }

            if let Ok(metadata) = fs::metadata(&hidden) {
                let file_name = original
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or_else(|| hidden.file_name().and_then(|value| value.to_str()).unwrap_or("unknown.pak"))
                    .to_string();
                let extension = pak_file_kind_from_name(&file_name).unwrap_or_else(|| "pak".to_string());
                let size_bytes = metadata.len();
                let modified = modified_unix(&metadata);
                let sha256 = cached_sha256_for_file(&hidden, size_bytes, modified, &mut hash_cache);

                pak_mods.push(PakModFile {
                    priority: extract_priority(&file_name),
                    enabled: false,
                    extension,
                    size_bytes,
                    modified_unix: modified,
                    full_path: hidden.display().to_string(),
                    file_name,
                    sha256,
                });
            }
        }
    }

    write_hash_cache(&hash_cache);

    pak_mods.sort_by(|a, b| {
        enabled_name_from_disabled(&a.file_name).to_lowercase()
            .cmp(&enabled_name_from_disabled(&b.file_name).to_lowercase())
    });

    Ok(PakScanResult {
        game_root: paths.game_root.display().to_string(),
        pak_mods_path: paths.pak_mods.display().to_string(),
        pak_mods_path_exists: paths.pak_mods.exists(),
        pak_file_count: pak_mods.len(),
        pak_mods,
    })
}

fn find_disabled_pak_file(paths: &PaydayPaths, clean_name: &str) -> Option<PathBuf> {
    let wanted_disabled = disabled_name_from_enabled(clean_name).to_lowercase();
    let wanted_enabled = enabled_name_from_disabled(clean_name).to_lowercase();

    fn visit(current: &Path, wanted_disabled: &str, wanted_enabled: &str) -> Option<PathBuf> {
        let entries = fs::read_dir(current).ok()?;

        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Some(found) = visit(&path, wanted_disabled, wanted_enabled) {
                    return Some(found);
                }
                continue;
            }

            let Some(name) = path.file_name().and_then(|value| value.to_str()).map(|value| value.to_lowercase()) else {
                continue;
            };

            if name == wanted_disabled || enabled_name_from_disabled(&name) == wanted_enabled {
                return Some(path);
            }
        }

        None
    }

    for disabled_root in disabled_pak_mods_root_candidates(paths) {
        if let Some(found) = visit(&disabled_root, &wanted_disabled, &wanted_enabled) {
            return Some(found);
        }
    }

    None
}

fn raw_disabled_pak_destination(paths: &PaydayPaths, file_name: &str) -> PathBuf {
    let enabled_name = enabled_name_from_disabled(file_name);
    let folder_name = sanitize_file_component(
        Path::new(&enabled_name)
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or(enabled_name.as_str()),
    );

    disabled_pak_mods_root(paths)
        .join(if folder_name.is_empty() { "Loose_PAK_Mod".to_string() } else { folder_name })
        .join(disabled_name_from_enabled(&enabled_name))
}

#[tauri::command]
fn set_pak_mod_files_enabled(file_names: Vec<String>, enabled: bool, profile_id: Option<String>) -> Result<String, String> {
    if !is_builtin_payday3_profile(profile_id.as_deref()) {
        return Err(profile_not_payday3_message(profile_id.as_deref()));
    }

    if let Some(message) = runtime_mutation_locked_message() {
        return Err(message);
    }

    let paths = detect_payday3_paths_internal()
        .ok_or_else(|| "Payday 3 not detected. Set a manual path in Settings.".to_string())?;

    if file_names.is_empty() {
        return Err("No files were selected for toggling.".to_string());
    }

    let mut changed = 0usize;
    let mut skipped = Vec::new();

    for file_name in file_names {
        let clean_name = file_name.trim();

        if clean_name.is_empty()
            || clean_name.contains("..")
            || clean_name.contains('/')
            || clean_name.contains('\\')
        {
            skipped.push(format!("Skipped unsafe file name '{}'", clean_name));
            continue;
        }

        if enabled {
            let enabled_name = enabled_name_from_disabled(clean_name);
            let destination = paths.pak_mods.join(&enabled_name);
            let source_path = find_disabled_pak_file(&paths, clean_name)
                .or_else(|| {
                    let local_disabled = paths.pak_mods.join(disabled_name_from_enabled(clean_name));
                    if local_disabled.exists() { Some(local_disabled) } else { None }
                });

            let Some(source_path) = source_path else {
                skipped.push(format!("Missing disabled PAK-family file {}", clean_name));
                continue;
            };

            if destination.exists() {
                skipped.push(format!("Target already exists: {}", destination.display()));
                continue;
            }

            let source_parent = source_path.parent().map(PathBuf::from);
            move_file_to_target(&source_path, &destination)?;
            if let Some(parent) = source_parent {
                for root in disabled_pak_mods_root_candidates(&paths) {
                    if parent.starts_with(&root) {
                        remove_empty_dirs_up_to(&parent, &root);
                    }
                }
            }
            changed += 1;
        } else {
            let enabled_name = enabled_name_from_disabled(clean_name);
            let source_path = paths.pak_mods.join(&enabled_name);

            if !source_path.exists() {
                skipped.push(format!("Missing enabled PAK-family file {}", enabled_name));
                continue;
            }

            let destination = raw_disabled_pak_destination(&paths, &enabled_name);
            if destination.exists() {
                skipped.push(format!("Disabled target already exists: {}", destination.display()));
                continue;
            }

            move_file_to_target(&source_path, &destination)?;
            changed += 1;
        }
    }

    let _ = sync_installed_state_database();

    if skipped.is_empty() {
        Ok(format!(
            "{} {} PAK-family file{} using Tsuki_Disabled_Mods storage.",
            if enabled { "Enabled" } else { "Disabled" },
            changed,
            if changed == 1 { "" } else { "s" }
        ))
    } else {
        Ok(format!(
            "{} {} PAK-family file{} using Tsuki_Disabled_Mods storage. {}",
            if enabled { "Enabled" } else { "Disabled" },
            changed,
            if changed == 1 { "" } else { "s" },
            skipped.join(" | ")
        ))
    }
}


fn sanitize_backup_name(name: &str) -> String {
    let mut output = String::new();

    for ch in name.trim().chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == ' ' {
            output.push(ch);
        }
    }

    output
        .split_whitespace()
        .collect::<Vec<&str>>()
        .join("_")
        .trim_matches('_')
        .to_string()
}

fn backup_display_name_from_file(file_name: &str) -> String {
    let stem = file_name.strip_suffix(".zip").unwrap_or(file_name);
    let parts: Vec<&str> = stem.split("__").collect();

    if parts.len() >= 2 {
        parts[0].replace('_', " ")
    } else {
        stem.replace('_', " ")
    }
}

fn list_pak_backups_internal() -> Result<Vec<PakBackupInfo>, String> {
    let backup_root = backups_dir()?;
    fs::create_dir_all(&backup_root)
        .map_err(|err| format!("Failed to create backups folder: {}", err))?;

    let mut backups = Vec::new();

    let entries = fs::read_dir(&backup_root)
        .map_err(|err| format!("Failed to read backups folder: {}", err))?;

    for entry in entries {
        let entry = entry.map_err(|err| format!("Failed to read backup entry: {}", err))?;
        let path = entry.path();

        if !path.is_file() {
            continue;
        }

        if path.extension().and_then(|value| value.to_str()).map(|ext| ext.to_ascii_lowercase()) != Some("zip".to_string()) {
            continue;
        }

        let metadata = fs::metadata(&path)
            .map_err(|err| format!("Failed to read backup metadata: {}", err))?;

        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("unknown.zip")
            .to_string();

        backups.push(PakBackupInfo {
            display_name: backup_display_name_from_file(&file_name),
            file_name,
            full_path: path.display().to_string(),
            size_bytes: metadata.len(),
            created_unix: metadata.created().ok().and_then(system_time_unix),
        });
    }

    backups.sort_by(|a, b| b.created_unix.unwrap_or(0).cmp(&a.created_unix.unwrap_or(0)));

    Ok(backups)
}

fn create_pak_backup_internal(app: tauri::AppHandle, backup_name: String) -> Result<String, String> {
    let clean_name = sanitize_backup_name(&backup_name);

    if clean_name.is_empty() {
        return Err("Backup name must contain letters or numbers.".to_string());
    }

    let scan = scan_pak_mods_internal()?;
    let pak_files: Vec<PakModFile> = scan
        .pak_mods
        .into_iter()
        .filter(|file| is_pak_file(Path::new(&file.full_path)))
        .collect();

    if pak_files.is_empty() {
        return Err("No .pak files found to back up.".to_string());
    }

    set_backup_progress(
        &app,
        BackupProgress {
            is_running: true,
            message: format!("Preparing {} .pak files...", pak_files.len()),
            current: 0,
            total: pak_files.len(),
        },
    );

    let backup_root = backups_dir()?;
    fs::create_dir_all(&backup_root)
        .map_err(|err| format!("Failed to create backups folder: {}", err))?;

    let file_name = format!("{}__{}.zip", clean_name, current_timestamp());
    let zip_path = backup_root.join(&file_name);
    let temp_zip_path = backup_root.join(format!("{}.tmp", file_name));

    if temp_zip_path.exists() {
        fs::remove_file(&temp_zip_path)
            .map_err(|err| format!("Failed to remove old temp backup: {}", err))?;
    }

    let zip_file = File::create(&temp_zip_path)
        .map_err(|err| format!("Failed to create temporary backup zip: {}", err))?;

    let mut zip = zip::ZipWriter::new(zip_file);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .unix_permissions(0o644);

    let manifest = format!(
        "Tsuki Mod Manager Pak Backup\n\
Name: {name}\n\
Created Unix: {timestamp}\n\
Game Root: {game_root}\n\
Pak Mods Path: {pak_path}\n\
File Count: {file_count}\n\
Backup Rule: .pak files only\n\
UE4SS Rule: UE4SS/Win64 backups require install receipts and are not guessed\n",
        name = backup_name.trim(),
        timestamp = current_timestamp(),
        game_root = scan.game_root,
        pak_path = scan.pak_mods_path,
        file_count = pak_files.len(),
    );

    zip.start_file("tsuki-backup-manifest.txt", options)
        .map_err(|err| format!("Failed to write manifest: {}", err))?;
    zip.write_all(manifest.as_bytes())
        .map_err(|err| format!("Failed to write manifest: {}", err))?;

    let total_files = pak_files.len();

    for (index, pak_file) in pak_files.iter().enumerate() {
        let source_path = PathBuf::from(&pak_file.full_path);
        let file_name = source_path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "Invalid pak file name".to_string())?
            .to_string();

        set_backup_progress(
            &app,
            BackupProgress {
                is_running: true,
                message: format!("Backing up {}", file_name),
                current: index,
                total: total_files,
            },
        );

        let mut source = File::open(&source_path)
            .map_err(|err| format!("Failed to open {}: {}", source_path.display(), err))?;

        zip.start_file(format!("~mods/{}", file_name), options)
            .map_err(|err| format!("Failed to add {} to backup: {}", file_name, err))?;

        io::copy(&mut source, &mut zip)
            .map_err(|err| format!("Failed to stream {} into backup: {}", file_name, err))?;

        set_backup_progress(
            &app,
            BackupProgress {
                is_running: true,
                message: format!("Finished {}", file_name),
                current: index + 1,
                total: total_files,
            },
        );
    }

    let mut finished_file = zip
        .finish()
        .map_err(|err| format!("Failed to finish backup zip: {}", err))?;

    finished_file
        .flush()
        .map_err(|err| format!("Failed to flush backup zip: {}", err))?;

    finished_file
        .sync_all()
        .map_err(|err| format!("Failed to sync backup zip to disk: {}", err))?;

    drop(finished_file);

    if zip_path.exists() {
        fs::remove_file(&zip_path)
            .map_err(|err| format!("Failed to replace existing backup zip: {}", err))?;
    }

    set_backup_progress(
        &app,
        BackupProgress {
            is_running: true,
            message: "Finalizing backup zip...".to_string(),
            current: pak_files.len(),
            total: pak_files.len(),
        },
    );

    fs::rename(&temp_zip_path, &zip_path)
        .map_err(|err| format!("Failed to finalize backup zip: {}", err))?;

    let size = fs::metadata(&zip_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);

    let complete_message = format!(
        "Created backup '{}' with {} .pak files ({:.2} MB).",
        backup_name.trim(),
        pak_files.len(),
        size as f64 / 1024.0 / 1024.0
    );

    set_backup_progress(
        &app,
        BackupProgress {
            is_running: false,
            message: complete_message.clone(),
            current: pak_files.len(),
            total: pak_files.len(),
        },
    );

    Ok(complete_message)
}



fn backup_info_for_file(file_name: &str) -> Result<PakBackupInfo, String> {
    let backup_root = backups_dir()?;
    let path = backup_root.join(file_name);

    let canonical_root = backup_root
        .canonicalize()
        .map_err(|err| format!("Failed to read backups folder: {}", err))?;

    let canonical_path = path
        .canonicalize()
        .map_err(|_| "Backup file was not found.".to_string())?;

    if !canonical_path.starts_with(&canonical_root) {
        return Err("Refusing to open a file outside the backups folder.".to_string());
    }

    if canonical_path.extension().and_then(|value| value.to_str()) != Some("zip") {
        return Err("Backup file must be a .zip file.".to_string());
    }

    let metadata = fs::metadata(&canonical_path)
        .map_err(|err| format!("Failed to read backup metadata: {}", err))?;

    let backup_file_name = canonical_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("unknown.zip")
        .to_string();

    Ok(PakBackupInfo {
        display_name: backup_display_name_from_file(&backup_file_name),
        file_name: backup_file_name,
        full_path: canonical_path.display().to_string(),
        size_bytes: metadata.len(),
        created_unix: metadata.created().ok().and_then(system_time_unix),
    })
}

fn inspect_pak_backup_internal(file_name: String) -> Result<PakBackupInspectResult, String> {
    let backup = backup_info_for_file(&file_name)?;
    let backup_file = File::open(&backup.full_path)
        .map_err(|err| format!("Failed to open backup zip: {}", err))?;

    let mut archive = ZipArchive::new(backup_file)
        .map_err(|err| format!("Failed to read backup zip: {}", err))?;

    let mut files = Vec::new();
    let mut manifest = None;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|err| format!("Failed to read zip entry: {}", err))?;

        if entry.is_dir() {
            continue;
        }

        let zip_path = entry.name().replace('\\', "/");
        let file_name = Path::new(&zip_path)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("unknown")
            .to_string();

        if file_name == "tsuki-backup-manifest.txt" {
            let mut contents = String::new();
            let _ = entry.read_to_string(&mut contents);
            manifest = Some(contents);
            continue;
        }

        let extension = Path::new(&file_name)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();

        if extension != "pak" {
            continue;
        }

        files.push(PakBackupFileEntry {
            priority: extract_priority(&file_name),
            size_bytes: entry.size(),
            extension,
            zip_path,
            file_name,
        });
    }

    files.sort_by(|a, b| a.file_name.to_lowercase().cmp(&b.file_name.to_lowercase()));

    Ok(PakBackupInspectResult {
        backup,
        files,
        manifest,
    })
}



fn receipts_dir() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("receipts"))
}


fn receipt_file_path(receipt_id: &str) -> Result<PathBuf, String> {
    Ok(receipts_dir()?.join(format!("{}.json", sanitize_file_component(receipt_id))))
}

fn find_receipt_by_source(source: &str, source_id: &str) -> Result<InstallReceipt, String> {
    list_install_receipts_internal()?
        .into_iter()
        .find(|receipt| {
            receipt.source.eq_ignore_ascii_case(source)
                && receipt
                    .source_mod_id
                    .as_ref()
                    .map(|id| id == source_id)
                    .unwrap_or(false)
        })
        .ok_or_else(|| format!("Install receipt was not found for {} {}", source, source_id))
}

fn move_path_to_uninstalled(path: &Path, holding_root: &Path) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }

    if !path.is_file() {
        return Ok(None);
    }

    if !keep_uninstalled_mods_enabled() {
        delete_file_permanently(path, "uninstalled mod")?;
        return Ok(Some(format!("Deleted {}", path.display())));
    }

    let paths = detect_payday3_paths_internal()
        .ok_or_else(|| "PAYDAY 3 was not detected. Set the game path in Settings first.".to_string())?;

    let relative = if let Ok(relative) = path.strip_prefix(&paths.game_root) {
        relative.to_path_buf()
    } else if let Ok(relative) = path.strip_prefix(&paths.win64) {
        PathBuf::from("PAYDAY3").join("Binaries").join("Win64").join(relative)
    } else if let Ok(relative) = path.strip_prefix(&paths.pak_mods) {
        PathBuf::from("PAYDAY3").join("Content").join("Paks").join("~mods").join(relative)
    } else {
        path.file_name()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("unknown_file"))
    };

    let destination = unique_destination_path(&holding_root.join(relative));

    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create uninstall holding folder {}: {}", parent.display(), err))?;
    }

    if let Err(rename_err) = fs::rename(path, &destination) {
        fs::copy(path, &destination)
            .map_err(|copy_err| {
                format!(
                    "Failed to move {} to uninstall holding folder: rename failed ({}) and copy failed ({})",
                    path.display(),
                    rename_err,
                    copy_err
                )
            })?;

        fs::remove_file(path)
            .map_err(|remove_err| format!("Copied {} but failed to remove original: {}", path.display(), remove_err))?;
    }

    Ok(Some(destination.display().to_string()))
}


fn receipt_is_pak_file_path(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".pak") || lower.ends_with(".ucas") || lower.ends_with(".utoc")
}

fn receipt_destination_path(file: &InstallReceiptFile) -> PathBuf {
    PathBuf::from(file.relative_path.trim())
}

fn receipt_safe_folder_name(receipt: &InstallReceipt) -> String {
    let base = sanitize_file_component(&receipt.display_name);
    if base.trim().is_empty() {
        sanitize_file_component(&receipt.id)
    } else {
        base
    }
}

fn tsuki_disabled_root(paths: &PaydayPaths) -> PathBuf {
    paths.pak_mods.join("Tsuki_Disabled_Mods")
}

fn legacy_typo_tsuki_disabled_root(paths: &PaydayPaths) -> PathBuf {
    // Older prompt/prototype text had a space before _mods. Never create it,
    // but scan it so a user's existing disabled files are not orphaned.
    paths.pak_mods.join("Tsuki_Disabled _mods")
}

fn disabled_pak_mods_root(paths: &PaydayPaths) -> PathBuf {
    tsuki_disabled_root(paths).join("disabled_pak_mods")
}

fn disabled_ue4ss_mods_root(paths: &PaydayPaths) -> PathBuf {
    tsuki_disabled_root(paths).join("disabled_UE4SS_Mods")
}

fn disabled_pak_mods_root_candidates(paths: &PaydayPaths) -> Vec<PathBuf> {
    vec![
        disabled_pak_mods_root(paths),
        legacy_typo_tsuki_disabled_root(paths).join("disabled_pak_mods"),
    ]
}

fn disabled_ue4ss_mods_root_candidates(paths: &PaydayPaths) -> Vec<PathBuf> {
    vec![
        disabled_ue4ss_mods_root(paths),
        legacy_typo_tsuki_disabled_root(paths).join("disabled_UE4SS_Mods"),
        legacy_typo_tsuki_disabled_root(paths).join("disabled_UES4_Mods"),
    ]
}

fn disabled_receipt_root(paths: &PaydayPaths, receipt: &InstallReceipt) -> PathBuf {
    // Default display/root path for UI. Individual files may be split into PAK vs UE4SS disabled roots.
    if receipt.files.iter().any(|file| receipt_is_pak_file_path(&file.relative_path)) {
        disabled_pak_mods_root(paths).join(receipt_safe_folder_name(receipt))
    } else {
        disabled_ue4ss_mods_root(paths).join(receipt_safe_folder_name(receipt))
    }
}

fn legacy_disabled_receipt_root(paths: &PaydayPaths, receipt: &InstallReceipt) -> PathBuf {
    paths.win64
        .join("disabled")
        .join(format!(
            "{}_{}",
            sanitize_file_component(&receipt.display_name),
            sanitize_file_component(&receipt.id)
        ))
}

fn legacy_disabled_receipt_root_plain(paths: &PaydayPaths, receipt: &InstallReceipt) -> PathBuf {
    paths.win64.join("disabled").join(receipt_safe_folder_name(receipt))
}

fn disabled_receipt_root_candidates(paths: &PaydayPaths, receipt: &InstallReceipt) -> Vec<PathBuf> {
    let receipt_folder = receipt_safe_folder_name(receipt);
    let mut roots = vec![
        disabled_receipt_root(paths, receipt),
        legacy_disabled_receipt_root(paths, receipt),
        legacy_disabled_receipt_root_plain(paths, receipt),
    ];

    for root in disabled_pak_mods_root_candidates(paths) {
        roots.push(root.join(&receipt_folder));
    }

    for root in disabled_ue4ss_mods_root_candidates(paths) {
        roots.push(root.join(&receipt_folder));
    }

    roots.sort();
    roots.dedup();
    roots
}

fn disabled_manifest_candidates(paths: &PaydayPaths, receipt: &InstallReceipt) -> Vec<PathBuf> {
    disabled_receipt_root_candidates(paths, receipt)
        .into_iter()
        .map(|root| root.join("tsuki-disabled.json"))
        .collect()
}

fn folder_has_non_manifest_files_recursive(path: &Path) -> bool {
    if !path.exists() {
        return false;
    }

    if path.is_file() {
        return path
            .file_name()
            .and_then(|value| value.to_str())
            .map(|name| !name.eq_ignore_ascii_case("tsuki-disabled.json"))
            .unwrap_or(true);
    }

    let Ok(entries) = fs::read_dir(path) else {
        return false;
    };

    for entry in entries.flatten() {
        if folder_has_non_manifest_files_recursive(&entry.path()) {
            return true;
        }
    }

    false
}

fn receipt_disabled_storage_has_files(paths: &PaydayPaths, receipt: &InstallReceipt) -> bool {
    disabled_receipt_root_candidates(paths, receipt)
        .into_iter()
        .any(|root| folder_has_non_manifest_files_recursive(&root))
}

fn disabled_manifest_path(paths: &PaydayPaths, receipt: &InstallReceipt) -> PathBuf {
    for candidate in disabled_manifest_candidates(paths, receipt) {
        if candidate.exists() {
            return candidate;
        }
    }

    disabled_receipt_root(paths, receipt).join("tsuki-disabled.json")
}

fn risky_disabled_file_name(file_name: &str) -> String {
    let lower = file_name.to_lowercase();
    let risky = lower.ends_with(".pak")
        || lower.ends_with(".ucas")
        || lower.ends_with(".utoc")
        || lower.ends_with(".dll")
        || lower.ends_with(".asi")
        || lower.ends_with(".ini")
        || lower.ends_with(".toml")
        || lower.ends_with(".lua")
        || lower.ends_with(".json");

    if risky && !lower.ends_with(".disabled") {
        format!("{}.disabled", file_name)
    } else {
        file_name.to_string()
    }
}

fn disabled_destination_for_receipt_file(paths: &PaydayPaths, receipt: &InstallReceipt, original: &Path, file: &InstallReceiptFile) -> PathBuf {
    let receipt_folder = receipt_safe_folder_name(receipt);
    let is_pak = receipt_is_pak_file_path(&file.relative_path) || original.starts_with(&paths.pak_mods);
    let root = if is_pak {
        disabled_pak_mods_root(paths).join(receipt_folder)
    } else {
        disabled_ue4ss_mods_root(paths).join(receipt_folder)
    };

    let relative = if is_pak {
        original
            .strip_prefix(&paths.pak_mods)
            .map(|value| value.to_path_buf())
            .unwrap_or_else(|_| original.file_name().map(PathBuf::from).unwrap_or_else(|| PathBuf::from("unknown_file")))
    } else if let Ok(relative) = original.strip_prefix(&paths.win64) {
        relative.to_path_buf()
    } else if let Ok(relative) = original.strip_prefix(&paths.game_root) {
        relative.to_path_buf()
    } else {
        original.file_name().map(PathBuf::from).unwrap_or_else(|| PathBuf::from("unknown_file"))
    };

    let mut destination = root.join(relative);
    if let Some(file_name) = destination.file_name().and_then(|value| value.to_str()).map(|value| value.to_string()) {
        destination.set_file_name(risky_disabled_file_name(&file_name));
    }

    destination
}

fn remove_empty_dirs_up_to(path: &Path, stop_at: &Path) {
    let mut current = if path.is_file() {
        path.parent().map(PathBuf::from)
    } else {
        Some(path.to_path_buf())
    };

    while let Some(dir) = current {
        if dir == stop_at || !dir.starts_with(stop_at) {
            break;
        }

        let is_empty = fs::read_dir(&dir)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false);

        if !is_empty {
            break;
        }

        if fs::remove_dir(&dir).is_err() {
            break;
        }

        current = dir.parent().map(PathBuf::from);
    }
}

fn cleanup_disabled_receipt_folders(paths: &PaydayPaths, receipt: &InstallReceipt) {
    let stop_roots = vec![
        disabled_pak_mods_root(paths),
        disabled_ue4ss_mods_root(paths),
        legacy_typo_tsuki_disabled_root(paths).join("disabled_pak_mods"),
        legacy_typo_tsuki_disabled_root(paths).join("disabled_UE4SS_Mods"),
        legacy_typo_tsuki_disabled_root(paths).join("disabled_UES4_Mods"),
    ];

    for candidate in disabled_receipt_root_candidates(paths, receipt) {
        let stop = stop_roots
            .iter()
            .find(|root| candidate.starts_with(root))
            .cloned()
            .or_else(|| candidate.parent().map(PathBuf::from));

        if let Some(stop) = stop {
            remove_empty_dirs_up_to(&candidate, &stop);
        }
    }
}

fn allowed_win64_receipt_companion_extension(path: &Path) -> bool {
    let lower = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();

    lower.ends_with(".dll")
        || lower.ends_with(".ini")
        || lower.ends_with(".toml")
        || lower.ends_with(".lua")
        || lower.eq_ignore_ascii_case("mods.txt")
        || lower.eq_ignore_ascii_case("enabled.txt")
}

fn compact_receipt_key(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(|ch| ch.to_lowercase())
        .collect()
}

fn collect_allowed_files_recursive(root: &Path, out: &mut Vec<PathBuf>, limit: usize) {
    if out.len() >= limit || !root.exists() {
        return;
    }

    if root.is_file() {
        if allowed_win64_receipt_companion_extension(root) {
            out.push(root.to_path_buf());
        }
        return;
    }

    let Ok(entries) = fs::read_dir(root) else {
        return;
    };

    for entry in entries.flatten() {
        collect_allowed_files_recursive(&entry.path(), out, limit);
        if out.len() >= limit {
            break;
        }
    }
}

fn extra_win64_companion_files_for_receipt(paths: &PaydayPaths, receipt: &InstallReceipt) -> Vec<PathBuf> {
    let mut already = receipt
        .files
        .iter()
        .map(|file| receipt_destination_path(file).display().to_string().to_lowercase())
        .collect::<std::collections::BTreeSet<_>>();

    let mut roots = Vec::<PathBuf>::new();
    let mut keys = vec![compact_receipt_key(&receipt.display_name)];

    for file in &receipt.files {
        let path = receipt_destination_path(file);
        if !path.starts_with(&paths.win64) {
            continue;
        }

        if let Ok(relative) = path.strip_prefix(&paths.ue4ss_mods) {
            if let Some(mod_name) = relative.components().next() {
                let mod_name = mod_name.as_os_str().to_string_lossy().to_string();
                let mod_root = paths.ue4ss_mods.join(&mod_name);
                if mod_root.is_dir() && !roots.iter().any(|root| root == &mod_root) { roots.push(mod_root); }
                keys.push(compact_receipt_key(&mod_name));
            }
        } else if let Ok(relative) = path.strip_prefix(&paths.win64) {
            let parts = relative.components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect::<Vec<_>>();
            if parts.len() >= 2 && parts[0].eq_ignore_ascii_case("Mods") {
                let mod_root = paths.win64.join("Mods").join(&parts[1]);
                if !roots.iter().any(|root| root == &mod_root) {
                    roots.push(mod_root);
                }
                keys.push(compact_receipt_key(&parts[1]));
            } else if let Some(parent) = path.parent() {
                if parent != paths.win64 && !roots.iter().any(|root| root == parent) {
                    roots.push(parent.to_path_buf());
                }
            }
        }

        if let Some(stem) = path.file_stem().and_then(|value| value.to_str()) {
            keys.push(compact_receipt_key(stem));
        }
    }

    keys.retain(|key| key.len() >= 4);
    keys.sort();
    keys.dedup();

    let mut found = Vec::<PathBuf>::new();
    for root in roots {
        collect_allowed_files_recursive(&root, &mut found, 256);
    }

    if let Ok(entries) = fs::read_dir(&paths.win64) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() || !allowed_win64_receipt_companion_extension(&path) {
                continue;
            }

            let stem_key = path
                .file_stem()
                .and_then(|value| value.to_str())
                .map(compact_receipt_key)
                .unwrap_or_default();

            if stem_key.len() >= 4 && keys.iter().any(|key| key.contains(&stem_key) || stem_key.contains(key)) {
                found.push(path);
            }
        }
    }

    found.sort();
    found.dedup();
    found
        .into_iter()
        .filter(|path| {
            let key = path.display().to_string().to_lowercase();
            if already.contains(&key) {
                return false;
            }
            already.insert(key);
            true
        })
        .collect()
}

fn install_receipt_file_for_existing_path(path: &Path) -> InstallReceiptFile {
    let size_bytes = fs::metadata(path).ok().map(|metadata| metadata.len());
    InstallReceiptFile {
        relative_path: path.display().to_string(),
        size_bytes,
        sha256: sha256_file(path).ok(),
        original_path: None,
        backup_path: None,
    }
}


fn vanilla_temp_base_root(paths: &PaydayPaths) -> PathBuf {
    // Never store hidden vanilla files inside PAYDAY3/Content/Paks or ~mods.
    // Unreal still discovers PAK files inside nested folders like ~mods/.tsuki-vanilla-temp,
    // which causes "Pak master signature table check failed" crashes on vanilla launch.
    match ensure_app_data_dirs() {
        Ok(root) => root.join("vanilla-temp"),
        Err(_) => paths.game_root.join(".tsuki-vanilla-temp-outside-paks"),
    }
}

fn vanilla_temp_root(paths: &PaydayPaths) -> PathBuf {
    vanilla_temp_base_root(paths).join("win64")
}

fn vanilla_pak_temp_root(paths: &PaydayPaths) -> PathBuf {
    vanilla_temp_base_root(paths).join("paks")
}

fn legacy_vanilla_temp_root(paths: &PaydayPaths) -> PathBuf {
    paths.win64.join(".tsuki-vanilla-temp")
}

fn legacy_vanilla_pak_temp_root(paths: &PaydayPaths) -> PathBuf {
    paths.pak_mods.join(".tsuki-vanilla-temp")
}

fn receipt_is_movie_file_path(path: &str) -> bool {
    let lower = path.replace('\\', "/").to_lowercase();
    lower.contains("/content/movies/")
        || lower.ends_with(".bk2")
        || lower.ends_with(".bik")
        || lower.ends_with(".mp4")
        || lower.ends_with(".webm")
        || lower.ends_with(".usm")
        || lower.ends_with(".wmv")
        || lower.ends_with(".m4v")
        || lower.ends_with(".mov")
}

fn receipt_is_shared_loader_path(path: &Path) -> bool {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();

    matches!(
        file_name.as_str(),
        "xinput1_3.dll"
            | "ue4ss.dll"
            | "ue4ss-settings.ini"
            | "mods.txt"
            | "winmm.dll"
            | "dinput8.dll"
            | "dsound.dll"
            | "d3d11.dll"
            | "dxgi.dll"
    )
}

fn path_relative_for_vanilla_temp(paths: &PaydayPaths, receipt: Option<&InstallReceipt>, path: &Path) -> PathBuf {
    let mod_folder = receipt
        .map(receipt_safe_folder_name)
        .unwrap_or_else(|| "Loose PAK Mods".to_string());

    if let Ok(relative) = path.strip_prefix(&paths.win64) {
        return PathBuf::from(mod_folder).join(relative);
    }

    if let Ok(relative) = path.strip_prefix(&paths.pak_mods) {
        return PathBuf::from(mod_folder).join(relative);
    }

    PathBuf::from(mod_folder).join(
        path.file_name()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("unknown_file")),
    )
}

fn move_file_to_target(source: &Path, destination: &Path) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create folder {}: {}", parent.display(), err))?;
    }

    if destination.exists() && destination.is_file() {
        let _ = fs::remove_file(destination);
    }

    if let Err(rename_err) = fs::rename(source, destination) {
        fs::copy(source, destination)
            .map_err(|copy_err| {
                format!(
                    "Failed to move {} to {}: rename failed ({}) and copy failed ({})",
                    source.display(),
                    destination.display(),
                    rename_err,
                    copy_err
                )
            })?;

        fs::remove_file(source)
            .map_err(|remove_err| format!("Copied {} but failed to remove original: {}", source.display(), remove_err))?;
    }

    Ok(())
}


fn move_path_to_target(source: &Path, destination: &Path) -> Result<(), String> {
    if source.is_file() {
        return move_file_to_target(source, destination);
    }

    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create folder {}: {}", parent.display(), err))?;
    }

    if destination.exists() {
        if destination.is_dir() {
            fs::remove_dir_all(destination)
                .map_err(|err| format!("Failed to clear existing folder {}: {}", destination.display(), err))?;
        } else {
            fs::remove_file(destination)
                .map_err(|err| format!("Failed to clear existing file {}: {}", destination.display(), err))?;
        }
    }

    fs::rename(source, destination)
        .map_err(|err| format!("Failed to move {} to {}: {}", source.display(), destination.display(), err))
}

fn vanilla_runtime_loader_names() -> &'static [&'static str] {
    &[
        "xinput1_3.dll",
        "UE4SS.dll",
        "ue4ss.dll",
        "UE4SS-settings.ini",
        "ue4ss-settings.ini",
        "mods.txt",
        "winmm.dll",
        "dinput8.dll",
        "dsound.dll",
        "d3d11.dll",
        "dxgi.dll",
    ]
}

fn track_vanilla_temp_move(
    source: &Path,
    destination: &Path,
    temp_files: &mut Vec<DisabledInstallFileRecord>,
    move_errors: &mut Vec<String>,
) -> bool {
    if !source.exists() {
        return false;
    }

    match move_path_to_target(source, destination) {
        Ok(_) => {
            temp_files.push(DisabledInstallFileRecord {
                original_path: source.display().to_string(),
                disabled_path: destination.display().to_string(),
            });
            true
        }
        Err(error) => {
            move_errors.push(error);
            false
        }
    }
}

fn disable_vanilla_runtime_surfaces(
    paths: &PaydayPaths,
    temp_files: &mut Vec<DisabledInstallFileRecord>,
    move_errors: &mut Vec<String>,
) -> usize {
    let mut moved = 0usize;

    // True vanilla means UE4SS/ReShade/proxy loader files in Win64 must be gone too.
    for name in vanilla_runtime_loader_names() {
        let original = paths.win64.join(name);
        if !original.exists() || !original.is_file() {
            continue;
        }

        let temp_path = vanilla_temp_root(paths)
            .join("Runtime Loaders")
            .join(name);

        if track_vanilla_temp_move(&original, &temp_path, temp_files, move_errors) {
            moved += 1;
        }
    }

    // UE4SS loads everything under Binaries/Win64/Mods. Move the children, not the Mods folder itself.
    if paths.ue4ss_mods.exists() && paths.ue4ss_mods.is_dir() {
        match fs::read_dir(&paths.ue4ss_mods) {
            Ok(entries) => {
                for entry in entries.flatten() {
                    let original = entry.path();
                    let Some(name) = original.file_name().map(PathBuf::from) else { continue; };
                    let temp_path = vanilla_temp_root(paths)
                        .join("UE4SS Mods")
                        .join(name);

                    if track_vanilla_temp_move(&original, &temp_path, temp_files, move_errors) {
                        moved += 1;
                    }
                }
            }
            Err(error) => move_errors.push(format!(
                "Failed to inspect UE4SS Mods folder {}: {}",
                paths.ue4ss_mods.display(),
                error
            )),
        }
    }

    moved
}

fn active_ue4ss_mod_surface_count(paths: &PaydayPaths) -> usize {
    if !paths.ue4ss_mods.exists() || !paths.ue4ss_mods.is_dir() {
        return 0;
    }

    fs::read_dir(&paths.ue4ss_mods)
        .map(|entries| entries.filter_map(Result::ok).count())
        .unwrap_or(0)
}

fn active_runtime_loader_files(paths: &PaydayPaths) -> Vec<String> {
    vanilla_runtime_loader_names()
        .iter()
        .filter_map(|name| {
            let path = paths.win64.join(name);
            if path.exists() && path.is_file() {
                Some((*name).to_string())
            } else {
                None
            }
        })
        .collect()
}

fn collect_pak_family_files_under(root: &Path, limit: usize) -> Vec<String> {
    let mut found = Vec::new();

    fn visit(path: &Path, found: &mut Vec<String>, limit: usize) {
        if found.len() >= limit || !path.exists() {
            return;
        }

        if path.is_file() {
            let lower = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_lowercase();

            if lower.ends_with(".pak") || lower.ends_with(".ucas") || lower.ends_with(".utoc") || lower.ends_with(".sig") {
                found.push(path.display().to_string());
            }
            return;
        }

        if let Ok(entries) = fs::read_dir(path) {
            for entry in entries.flatten() {
                visit(&entry.path(), found, limit);
                if found.len() >= limit {
                    break;
                }
            }
        }
    }

    visit(root, &mut found, limit);
    found
}

fn verify_vanilla_mod_surfaces_clean(paths: &PaydayPaths) -> Result<String, String> {
    let scan = scan_pak_mods_internal()?;
    let enabled_paks = scan
        .pak_mods
        .iter()
        .filter(|file| file.enabled)
        .map(|file| file.file_name.clone())
        .collect::<Vec<_>>();

    let runtime_loaders = active_runtime_loader_files(paths);
    let ue4ss_items = active_ue4ss_mod_surface_count(paths);
    let legacy_temp_paks = collect_pak_family_files_under(&legacy_vanilla_pak_temp_root(paths), 12);
    let legacy_temp_win64_paks = collect_pak_family_files_under(&legacy_vanilla_temp_root(paths), 12);

    if !enabled_paks.is_empty() || !runtime_loaders.is_empty() || ue4ss_items > 0 || !legacy_temp_paks.is_empty() || !legacy_temp_win64_paks.is_empty() {
        return Err(format!(
            "Vanilla launch blocked because mod surfaces are still active or still inside a game-scanned temp folder. Enabled PAK files: {}. Runtime loaders: {}. UE4SS Mods folder items: {}. Old ~mods temp PAKs: {}. Old Win64 temp PAKs: {}. Press Restore Mods, close anything locking the files, then try again.",
            if enabled_paks.is_empty() { "none".to_string() } else { enabled_paks.into_iter().take(12).collect::<Vec<_>>().join(", ") },
            if runtime_loaders.is_empty() { "none".to_string() } else { runtime_loaders.join(", ") },
            ue4ss_items,
            if legacy_temp_paks.is_empty() { "none".to_string() } else { legacy_temp_paks.join(", ") },
            if legacy_temp_win64_paks.is_empty() { "none".to_string() } else { legacy_temp_win64_paks.join(", ") }
        ));
    }

    Ok("Vanilla clean check passed: no enabled ~mods files, no UE4SS Mods children, no known Win64 loader files, and no old PAK files inside game-scanned temp folders remained active.".to_string())
}

fn vanilla_session_contains_original(original_path: &Path) -> bool {
    let original = original_path.display().to_string();

    read_vanilla_launch_session()
        .map(|session| session.temp_files.iter().any(|record| record.original_path == original))
        .unwrap_or(false)
}

fn receipt_enabled_internal(paths: &PaydayPaths, receipt: &InstallReceipt) -> bool {
    if disabled_manifest_path(paths, receipt).exists() || receipt_disabled_storage_has_files(paths, receipt) {
        return false;
    }

    // During a vanilla launch session, Tsuki moved the files away on purpose.
    // Show those mods as Off while keeping the receipt/state visible.
    if read_vanilla_launch_session()
        .map(|session| {
            receipt.files.iter().any(|file| {
                let original = receipt_destination_path(file);
                session.temp_files.iter().any(|record| record.original_path.eq_ignore_ascii_case(&original.display().to_string()))
            })
        })
        .unwrap_or(false)
    {
        return false;
    }

    receipt
        .files
        .iter()
        .any(|file| {
            let original = receipt_destination_path(file);
            original.exists()
        })
}

fn receipt_has_live_files_internal(paths: &PaydayPaths, receipt: &InstallReceipt) -> bool {
    if receipt
        .files
        .iter()
        .any(|file| {
            let original = receipt_destination_path(file);
            original.exists() || vanilla_session_contains_original(&original)
        })
    {
        return true;
    }

    let manifest_path = disabled_manifest_path(paths, receipt);

    if let Some(manifest) = read_disabled_manifest(&manifest_path) {
        return manifest
            .files
            .iter()
            .any(|record| PathBuf::from(&record.disabled_path).exists());
    }

    receipt_disabled_storage_has_files(paths, receipt)
}


fn installed_state_file_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("installed-state.json"))
}

fn installed_state_file_type(path: &str) -> String {
    let lower = path.to_lowercase();

    if lower.ends_with(".pak") || lower.ends_with(".ucas") || lower.ends_with(".utoc") {
        "pak".to_string()
    } else if receipt_is_movie_file_path(path) {
        "movie".to_string()
    } else if lower.contains("\\mods\\") || lower.contains("/mods/") {
        "ue4ss-mods".to_string()
    } else {
        Path::new(path)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("file")
            .to_lowercase()
    }
}

fn installed_state_location_for_path(paths: &PaydayPaths, path: &Path) -> String {
    if path.starts_with(&paths.pak_mods) {
        "~mods".to_string()
    } else if path.starts_with(&paths.win64) {
        "Win64".to_string()
    } else {
        path.parent()
            .map(|parent| parent.display().to_string())
            .unwrap_or_else(|| "unknown".to_string())
    }
}


fn receipt_file_disabled_path_exists(paths: &PaydayPaths, receipt: &InstallReceipt, original: &Path, file: &InstallReceiptFile) -> bool {
    let original_display = original.display().to_string();

    for manifest_path in disabled_manifest_candidates(paths, receipt) {
        if let Some(manifest) = read_disabled_manifest(&manifest_path) {
            for record in manifest.files {
                if record.original_path.eq_ignore_ascii_case(&original_display)
                    && PathBuf::from(&record.disabled_path).exists()
                {
                    return true;
                }
            }
        }
    }

    disabled_destination_for_receipt_file(paths, receipt, original, file).exists()
        || receipt_disabled_storage_has_files(paths, receipt)
}

fn installed_state_record_from_receipt(paths: &PaydayPaths, receipt: &InstallReceipt) -> InstalledStateRecord {
    let enabled = receipt_enabled_internal(paths, receipt);
    let files = receipt
        .files
        .iter()
        .map(|file| {
            let path = receipt_destination_path(file);
            let file_name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("unknown")
                .to_string();

            InstalledStateFile {
                relative_path: file.relative_path.clone(),
                location: installed_state_location_for_path(paths, &path),
                file_name,
                file_type: installed_state_file_type(&file.relative_path),
                size_bytes: file.size_bytes,
                sha256: file.sha256.clone(),
                live: path.exists() || vanilla_session_contains_original(&path) || receipt_file_disabled_path_exists(paths, receipt, &path, file),
            }
        })
        .collect::<Vec<_>>();

    let filename = files
        .iter()
        .find(|file| file.file_type == "pak")
        .or_else(|| files.first())
        .map(|file| file.file_name.clone())
        .unwrap_or_else(|| receipt.display_name.clone());

    let sha256 = files.iter().find_map(|file| file.sha256.clone());
    let file_type = files
        .iter()
        .find(|file| file.file_type == "pak")
        .or_else(|| files.first())
        .map(|file| file.file_type.clone())
        .unwrap_or_else(|| "unknown".to_string());

    let location = files
        .iter()
        .find(|file| file.location == "~mods")
        .or_else(|| files.first())
        .map(|file| file.location.clone())
        .unwrap_or_else(|| "unknown".to_string());

    InstalledStateRecord {
        uid: receipt.id.clone(),
        id: receipt
            .source_mod_id
            .clone()
            .unwrap_or_else(|| receipt.id.clone()),
        name: receipt.display_name.clone(),
        source: receipt.source.clone(),
        version: receipt.version.clone(),
        author: receipt.author.clone(),
        filename,
        file_id: receipt.source_file_id.clone(),
        file_type,
        sha256,
        folder_id: receipt_safe_folder_name(receipt),
        location,
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
        enabled,
        installed_at_unix: receipt.installed_at_unix,
        files,
    }
}

fn rebuild_installed_state_database_internal() -> Result<InstalledStateDatabase, String> {
    let Some(paths) = detect_payday3_paths_internal() else {
        return Ok(InstalledStateDatabase {
            version: 1,
            records: Vec::new(),
        });
    };

    let mut records = list_install_receipts_internal()
        .unwrap_or_default()
        .iter()
        .map(|receipt| installed_state_record_from_receipt(&paths, receipt))
        .filter(|record| record.files.iter().any(|file| file.live))
        .collect::<Vec<_>>();

    records.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    Ok(InstalledStateDatabase { version: 1, records })
}

fn write_installed_state_database(database: &InstalledStateDatabase) -> Result<(), String> {
    let path = installed_state_file_path()?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create installed state folder: {}", err))?;
    }

    let contents = serde_json::to_string_pretty(database)
        .map_err(|err| format!("Failed to serialize installed state: {}", err))?;

    fs::write(&path, contents)
        .map_err(|err| format!("Failed to write installed state {}: {}", path.display(), err))
}

fn sync_installed_state_database() -> Result<Vec<InstalledStateRecord>, String> {
    let database = rebuild_installed_state_database_internal()?;
    write_installed_state_database(&database)?;
    let _ = sync_persistent_pairs_from_state_records(&database.records);
    Ok(database.records)
}


fn persistent_pairs_file_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("persistent-pairs.json"))
}

fn read_persistent_pair_database() -> PersistentPairDatabase {
    let Some(path) = persistent_pairs_file_path().ok() else {
        return PersistentPairDatabase { version: 1, pairs: Vec::new() };
    };

    let Ok(contents) = fs::read_to_string(path) else {
        return PersistentPairDatabase { version: 1, pairs: Vec::new() };
    };

    serde_json::from_str(&contents).unwrap_or_else(|_| PersistentPairDatabase {
        version: 1,
        pairs: Vec::new(),
    })
}

fn write_persistent_pair_database(database: &PersistentPairDatabase) -> Result<(), String> {
    let path = persistent_pairs_file_path()?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create persistent pair folder: {}", err))?;
    }

    let contents = serde_json::to_string_pretty(database)
        .map_err(|err| format!("Failed to serialize persistent pairs: {}", err))?;

    fs::write(&path, contents)
        .map_err(|err| format!("Failed to write persistent pairs {}: {}", path.display(), err))
}

fn persistent_uid_for_state(record: &InstalledStateRecord) -> String {
    format!(
        "{}:payday3:{}:{}:{}",
        record.source.to_lowercase(),
        sanitize_file_component(&record.id),
        sanitize_file_component(record.file_id.as_deref().unwrap_or("unknown")),
        sanitize_file_component(&record.filename)
    )
}

fn persistent_pair_from_state(record: &InstalledStateRecord) -> PersistentSourcePair {
    let mut hashes = std::collections::BTreeMap::new();

    for file in &record.files {
        if let Some(hash) = file.sha256.as_ref() {
            hashes.insert(file.file_name.clone(), hash.clone());
        }
    }

    PersistentSourcePair {
        uid: persistent_uid_for_state(record),
        source: record.source.clone(),
        game: "payday3".to_string(),
        mod_id: record.id.clone(),
        file_id: record.file_id.clone(),
        display_name: record.name.clone(),
        file_name: record.filename.clone(),
        version: record.version.clone(),
        install_type: record.file_type.clone(),
        location: record.location.clone(),
        installed_files: record.files.iter().map(|file| file.relative_path.clone()).collect(),
        installed_file_hashes: hashes,
        installed_at: record.installed_at_unix,
        updated_at: None,
        confidence: 100,
        match_kind: "installed-state".to_string(),
        page_url: record.page_url.clone(),
        thumbnail_url: record.thumbnail_url.clone(),
        banner_url: record.banner_url.clone(),
    }
}

fn sync_persistent_pairs_from_state_records(records: &[InstalledStateRecord]) -> Result<(), String> {
    let mut database = read_persistent_pair_database();
    database.version = 1;

    let mut map = database
        .pairs
        .into_iter()
        .map(|pair| (pair.uid.clone(), pair))
        .collect::<std::collections::BTreeMap<_, _>>();

    for record in records {
        if record.source.trim().is_empty() || record.id.trim().is_empty() {
            continue;
        }

        let pair = persistent_pair_from_state(record);
        map.insert(pair.uid.clone(), pair);
    }

    database.pairs = map.into_values().collect();
    write_persistent_pair_database(&database)
}

#[tauri::command]
fn list_persistent_source_pairs() -> Result<Vec<PersistentSourcePair>, String> {
    let _ = sync_installed_state_database();
    Ok(read_persistent_pair_database().pairs)
}

#[tauri::command]
fn persist_confirmed_source_pair(source_mod: SourceModSummary, match_result: InstalledSourceMatch) -> Result<String, String> {
    if !match_result.installed {
        return Err("Refusing to persist a source pair that is not installed.".to_string());
    }

    if match_result.confidence < 86 {
        return Err("Refusing to persist a low-confidence source pair.".to_string());
    }

    let file_name = match_result
        .matched_files
        .first()
        .cloned()
        .unwrap_or_else(|| source_mod.name.clone());

    let uid = format!(
        "{}:payday3:{}:{}:{}",
        source_mod.source.to_lowercase(),
        sanitize_file_component(&source_mod.source_id),
        "unknown",
        sanitize_file_component(&file_name)
    );

    let pair = PersistentSourcePair {
        uid: uid.clone(),
        source: source_mod.source.clone(),
        game: "payday3".to_string(),
        mod_id: source_mod.source_id.clone(),
        file_id: None,
        display_name: source_mod.name.clone(),
        file_name,
        version: source_mod.version.clone(),
        install_type: "source-match".to_string(),
        location: "unknown".to_string(),
        installed_files: match_result.matched_files.clone(),
        installed_file_hashes: std::collections::BTreeMap::new(),
        installed_at: match_result.installed_modified_unix,
        updated_at: source_mod.updated_at.clone(),
        confidence: match_result.confidence,
        match_kind: match_result.match_kind.clone(),
        page_url: source_mod.page_url.clone(),
        thumbnail_url: source_mod.thumbnail_url.clone(),
        banner_url: source_mod.banner_url.clone(),
    };

    let mut database = read_persistent_pair_database();
    database.version = 1;
    database.pairs.retain(|existing| existing.uid != uid);
    database.pairs.push(pair);
    write_persistent_pair_database(&database)?;

    Ok("Persistent source pair saved.".to_string())
}

fn source_file_update_sort_key(file: &SourceFileItem) -> u64 {
    if let Some(uploaded) = file.uploaded_at.as_ref() {
        if let Ok(value) = uploaded.parse::<u64>() {
            return value.saturating_add(1_000_000_000_000);
        }
    }

    file.id.parse::<u64>().unwrap_or(0)
}

fn latest_source_file(files: &[SourceFileItem]) -> Option<SourceFileItem> {
    files
        .iter()
        .filter(|file| !file.id.trim().is_empty() && file.id != "unknown")
        .max_by_key(|file| source_file_update_sort_key(file))
        .cloned()
}

fn source_file_text_is_explicit_old(text: &str) -> bool {
    let lower = text.to_lowercase();
    ["old", "legacy", "previous", "archive", "archived", "deprecated", "outdated", "unsupported"]
        .iter()
        .any(|needle| lower.split(|ch: char| !ch.is_ascii_alphanumeric()).any(|token| token == *needle))
}

fn source_file_text_is_optional(text: &str) -> bool {
    let lower = text.to_lowercase();
    ["optional", "addon", "add", "patch", "compat", "plugin", "extra", "lite", "translation", "variant", "bonus", "separate", "requirement", "required"]
        .iter()
        .any(|needle| lower.split(|ch: char| !ch.is_ascii_alphanumeric()).any(|token| token == *needle))
}

fn source_file_category_for_update(file: &SourceFileItem, main_id: Option<&str>, source: &str) -> &'static str {
    let text = format!("{} {} {}", file.name, file.version.clone().unwrap_or_default(), file.download_url.clone().unwrap_or_default());

    if source_file_text_is_explicit_old(&text) {
        return "old";
    }

    if main_id.map(|id| id == file.id).unwrap_or(false) {
        return "main";
    }

    if source.eq_ignore_ascii_case("modworkshop") {
        return "optional";
    }

    if source_file_text_is_optional(&text) {
        return "optional";
    }

    "optional"
}

fn main_source_file_for_update(files: &[SourceFileItem], source: &str) -> Option<SourceFileItem> {
    let installable = files
        .iter()
        .filter(|file| !file.id.trim().is_empty() && file.id != "unknown")
        .cloned()
        .collect::<Vec<_>>();

    if source.eq_ignore_ascii_case("modworkshop") {
        return installable
            .iter()
            .find(|file| !source_file_text_is_explicit_old(&format!("{} {}", file.name, file.version.clone().unwrap_or_default())))
            .cloned()
            .or_else(|| installable.first().cloned());
    }

    installable
        .iter()
        .filter(|file| {
            let text = format!("{} {}", file.name, file.version.clone().unwrap_or_default());
            !source_file_text_is_explicit_old(&text) && !source_file_text_is_optional(&text)
        })
        .max_by_key(|file| source_file_update_sort_key(file))
        .cloned()
        .or_else(|| latest_source_file(&installable))
}

fn normalized_source_file_family_name(value: &str) -> String {
    let mut text = value
        .to_lowercase()
        .replace(".zip", " ")
        .replace(".rar", " ")
        .replace(".7z", " ")
        .replace(".pak", " ")
        .replace(".ucas", " ")
        .replace(".utoc", " ")
        .replace(".dll", " ")
        .replace(".lua", " ")
        .replace(".ini", " ");

    for marker in ["version", "ver"] {
        text = text.replace(marker, " v ");
    }

    text.split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|token| {
            let token = token.trim();
            if token.len() <= 1 && token != "fov" {
                return false;
            }
            if token == "v" || token == "ver" || token == "version" {
                return false;
            }
            !token.chars().all(|ch| ch.is_ascii_digit())
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn source_file_family_similarity_name(left: &str, right: &str) -> u32 {
    let left = normalized_source_file_family_name(left);
    let right = normalized_source_file_family_name(right);

    if left.is_empty() || right.is_empty() {
        return 0;
    }

    if left == right {
        return 100;
    }

    if left.contains(&right) || right.contains(&left) {
        return 88;
    }

    let left_tokens = left.split_whitespace().collect::<std::collections::BTreeSet<_>>();
    let right_tokens = right.split_whitespace().collect::<std::collections::BTreeSet<_>>();

    if left_tokens.is_empty() || right_tokens.is_empty() {
        return 0;
    }

    let overlap = left_tokens.iter().filter(|token| right_tokens.contains(**token)).count();
    ((overlap as f32 / left_tokens.len().max(right_tokens.len()) as f32) * 78.0).round() as u32
}

fn source_file_version_score_from_text(value: &str) -> f64 {
    let mut score = 0.0_f64;
    let mut index = 0_i32;

    for token in value.split(|ch: char| !(ch.is_ascii_digit() || ch == '.')) {
        if token.trim().is_empty() {
            continue;
        }

        let parsed = token
            .split('.')
            .filter_map(|part| part.parse::<f64>().ok())
            .collect::<Vec<_>>();

        if parsed.is_empty() {
            continue;
        }

        for part in parsed.into_iter().take(4) {
            score += part / 1000_f64.powi(index);
            index += 1;
        }

        if index >= 4 {
            break;
        }
    }

    score
}

fn source_file_version_score_for_update(file: &SourceFileItem) -> f64 {
    source_file_version_score_from_text(&format!("{} {}", file.version.clone().unwrap_or_default(), file.name))
}

fn source_file_uploaded_unix(file: &SourceFileItem) -> Option<u64> {
    file.uploaded_at
        .as_deref()
        .and_then(|value| parse_source_timestamp_to_unix(Some(value)))
}

fn source_file_is_newer_than_record(file: &SourceFileItem, record: &InstalledStateRecord) -> bool {
    let candidate_version = source_file_version_score_for_update(file);
    let installed_version = source_file_version_score_from_text(&format!(
        "{} {} {}",
        record.source_file_version.clone().or(record.version.clone()).unwrap_or_default(),
        record.source_file_name.clone().unwrap_or_default(),
        record.filename
    ));

    if candidate_version > 0.0 && installed_version > 0.0 && candidate_version > installed_version {
        return true;
    }

    let candidate_upload = source_file_uploaded_unix(file);
    let installed_upload = record
        .source_file_uploaded_at
        .as_deref()
        .and_then(|value| parse_source_timestamp_to_unix(Some(value)));

    matches!((candidate_upload, installed_upload), (Some(candidate), Some(installed)) if candidate > installed)
}

fn same_update_category(record_category: &str, candidate_category: &str) -> bool {
    let normalized = |value: &str| {
        let lower = value.to_lowercase();
        if source_file_text_is_explicit_old(&lower) {
            "old"
        } else if source_file_text_is_optional(&lower) {
            "optional"
        } else {
            "main"
        }
    };

    normalized(record_category) == candidate_category
}

fn check_update_for_record(record: InstalledStateRecord) -> SourceUpdateStatus {
    let mut status = SourceUpdateStatus {
        uid: persistent_uid_for_state(&record),
        source: record.source.clone(),
        mod_id: record.id.clone(),
        installed_file_id: record.file_id.clone(),
        latest_file_id: None,
        latest_file_name: None,
        installed_version: record.version.clone(),
        latest_version: None,
        update_available: false,
        can_update: false,
        reason: "No update check performed.".to_string(),
        page_url: record.page_url.clone(),
    };

    let detail = match record.source.as_str() {
        "modworkshop" => fetch_modworkshop_mod_detail(record.id.clone(), None),
        "nexus" => fetch_nexus_mod_detail(record.id.clone(), None, None),
        other => Err(format!("Unsupported source for update checks: {}", other)),
    };

    let Ok(detail) = detail else {
        status.reason = "Could not load source detail/files for update check.".to_string();
        return status;
    };

    status.page_url = detail.page_url.clone().or(status.page_url);

    let main_file = main_source_file_for_update(&detail.files, &record.source);
    let main_id = main_file.as_ref().map(|file| file.id.as_str());
    let installed_category = record
        .source_file_category
        .clone()
        .unwrap_or_else(|| "main".to_string());
    let installed_family_name = record
        .source_file_name
        .clone()
        .unwrap_or_else(|| record.filename.clone());
    let installed_file_id = record
        .source_file_id
        .clone()
        .or(record.file_id.clone())
        .unwrap_or_default();

    if installed_file_id.trim().is_empty() {
        status.reason = "No saved source file ID; update cannot be trusted without manual confirmation.".to_string();
        return status;
    }

    let mut candidates = detail
        .files
        .iter()
        .filter(|file| !file.id.trim().is_empty() && file.id != "unknown")
        .filter(|file| file.id != installed_file_id)
        .filter(|file| {
            let category = source_file_category_for_update(file, main_id, &record.source);
            same_update_category(&installed_category, category)
        })
        .filter(|file| source_file_family_similarity_name(&installed_family_name, &file.name) >= 70)
        .filter(|file| source_file_is_newer_than_record(file, &record))
        .cloned()
        .collect::<Vec<_>>();

    if candidates.is_empty() {
        status.reason = "No newer same-family file in the same category was proven.".to_string();
        return status;
    }

    candidates.sort_by_key(|file| source_file_update_sort_key(file));
    let latest = candidates.last().cloned().expect("candidates checked non-empty");

    status.latest_file_id = Some(latest.id.clone());
    status.latest_file_name = Some(latest.name.clone());
    status.latest_version = latest.version.clone().or(detail.version.clone());
    status.update_available = true;
    status.can_update = true;
    status.reason = format!(
        "Newer same-family {} file proven: installed {} ({}) -> latest {} ({}).",
        source_file_category_for_update(&latest, main_id, &record.source),
        installed_file_id,
        installed_family_name,
        latest.id,
        latest.name
    );

    status
}

fn check_installed_source_updates_internal() -> Result<Vec<SourceUpdateStatus>, String> {
    // Receipt-only by design:
    // this checks mods installed/downloaded through Tsuki where source file IDs
    // were saved in receipts/installed-state. Filename-only/manual pairs are
    // deliberately skipped so update badges do not lie.
    let records = sync_installed_state_database()?;
    let mut results = Vec::new();

    for record in records {
        if record.source != "modworkshop" && record.source != "nexus" {
            continue;
        }

        if record.receipt_id.is_none() {
            continue;
        }

        results.push(check_update_for_record(record));
    }

    Ok(results)
}

#[tauri::command]
async fn check_installed_source_updates(profile_id: Option<String>) -> Result<Vec<SourceUpdateStatus>, String> {
    if !is_builtin_payday3_profile(profile_id.as_deref()) {
        return Ok(Vec::new());
    }

    tauri::async_runtime::spawn_blocking(check_installed_source_updates_internal)
        .await
        .map_err(|err| format!("Update check task failed: {}", err))?
}


fn list_installed_state_records_internal() -> Result<Vec<InstalledStateRecord>, String> {
    sync_installed_state_database()
}

#[tauri::command]
async fn list_installed_state_records(profile_id: Option<String>) -> Result<Vec<InstalledStateRecord>, String> {
    if !is_builtin_payday3_profile(profile_id.as_deref()) {
        let profile_id = profile_id.ok_or_else(|| "A game profile is required.".to_string())?;
        return tauri::async_runtime::spawn_blocking(move || profile_installs::sync_profile_installed_state(&profile_id))
            .await
            .map_err(|err| format!("Profile installed-state task failed: {}", err))?;
    }

    tauri::async_runtime::spawn_blocking(list_installed_state_records_internal)
        .await
        .map_err(|err| format!("Installed-state task failed: {}", err))?
}


fn prune_stale_receipts_internal() -> Result<usize, String> {
    // v1.8.31: Conservative by design. Installed receipts are Tsuki's ownership ledger.
    // Auto-pruning before the UI has finished discovering disabled PAK/UE4SS storage
    // can orphan mods and make disabled Win64/UE4SS installs disappear. Explicit
    // uninstall commands remove receipts directly, so background refresh should not.
    Ok(0)
}

#[tauri::command]
fn prune_stale_install_receipts(profile_id: Option<String>) -> Result<String, String> {
    if !is_builtin_payday3_profile(profile_id.as_deref()) {
        return Ok("No stale receipts for this profile.".to_string());
    }

    let removed = prune_stale_receipts_internal()?;

    Ok(format!(
        "Removed {} stale receipt{}.",
        removed,
        if removed == 1 { "" } else { "s" }
    ))
}

fn find_receipt_by_id(receipt_id: &str) -> Result<InstallReceipt, String> {
    list_install_receipts_internal()?
        .into_iter()
        .find(|receipt| receipt.id == receipt_id)
        .ok_or_else(|| format!("Install receipt was not found: {}", receipt_id))
}

fn read_disabled_manifest(path: &Path) -> Option<DisabledInstallManifest> {
    let contents = fs::read_to_string(path).ok()?;
    serde_json::from_str(&contents).ok()
}

fn write_disabled_manifest(path: &Path, manifest: &DisabledInstallManifest) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create disabled manifest folder: {}", err))?;
    }

    let contents = serde_json::to_string_pretty(manifest)
        .map_err(|err| format!("Failed to serialize disabled manifest: {}", err))?;

    fs::write(path, contents)
        .map_err(|err| format!("Failed to write disabled manifest: {}", err))
}

fn set_receipt_mod_enabled_internal(receipt_id: &str, enabled: bool) -> Result<String, String> {
    if let Some(message) = runtime_mutation_locked_message() {
        return Err(message);
    }

    let paths = detect_payday3_paths_internal()
        .ok_or_else(|| "Payday 3 not detected. Set a manual path in Settings.".to_string())?;
    let receipt = find_receipt_by_id(receipt_id)?;
    let disabled_root = disabled_receipt_root(&paths, &receipt);
    let manifest_path = disabled_manifest_path(&paths, &receipt);

    if enabled {
        let manifest = read_disabled_manifest(&manifest_path).unwrap_or_else(|| DisabledInstallManifest {
            receipt_id: receipt.id.clone(),
            display_name: receipt.display_name.clone(),
            disabled_at_unix: now_unix_seconds(),
            files: receipt.files.iter().map(|file| {
                let original = receipt_destination_path(file);
                DisabledInstallFileRecord {
                    original_path: original.display().to_string(),
                    disabled_path: disabled_destination_for_receipt_file(&paths, &receipt, &original, file).display().to_string(),
                }
            }).collect(),
        });

        let mut moved = 0usize;
        let mut skipped = Vec::new();

        for record in manifest.files {
            let source_path = PathBuf::from(&record.disabled_path);
            let destination = PathBuf::from(&record.original_path);

            if !source_path.exists() {
                skipped.push(format!("Missing disabled file {}", source_path.display()));
                continue;
            }

            if destination.exists() && destination.is_file() {
                if let Some(replaced) = move_existing_destination_file_for_install(&destination, &receipt.display_name)? {
                    skipped.push(format!("Moved existing enabled file to {}", replaced));
                }
            }

            let source_parent = source_path.parent().map(PathBuf::from);
            move_file_to_target(&source_path, &destination)?;
            if let Some(parent) = source_parent {
                for root in disabled_receipt_root_candidates(&paths, &receipt) {
                    if parent.starts_with(&root) {
                        remove_empty_dirs_up_to(&parent, &root);
                    }
                }
                for root in disabled_ue4ss_mods_root_candidates(&paths) {
                    if parent.starts_with(&root) {
                        remove_empty_dirs_up_to(&parent, &root);
                    }
                }
                for root in disabled_pak_mods_root_candidates(&paths) {
                    if parent.starts_with(&root) {
                        remove_empty_dirs_up_to(&parent, &root);
                    }
                }
            }
            moved += 1;
        }

        let _ = fs::remove_file(&manifest_path);
        cleanup_disabled_receipt_folders(&paths, &receipt);

        let _ = sync_installed_state_database();

        return Ok(format!(
            "Enabled {} by moving {} file(s) from Tsuki disabled storage back to their original paths and cleaned empty disabled folders. {}",
            receipt.display_name,
            moved,
            skipped.join(" | ")
        ));
    }

    let mut records = Vec::new();
    let mut moved = 0usize;
    let mut skipped = Vec::new();

    let mut files_to_disable = receipt.files.clone();
    for extra in extra_win64_companion_files_for_receipt(&paths, &receipt) {
        let extra_display = extra.display().to_string();
        if files_to_disable.iter().any(|file| file.relative_path.eq_ignore_ascii_case(&extra_display)) {
            continue;
        }
        skipped.push(format!("Rescued untracked Win64 companion file into disabled manifest: {}", extra.display()));
        files_to_disable.push(install_receipt_file_for_existing_path(&extra));
    }

    for file in &files_to_disable {
        let original = receipt_destination_path(file);

        if receipt_is_movie_file_path(&file.relative_path) {
            skipped.push(format!("Skipped movie/video file {}. Movies are not toggled by Tsuki because movie replacers overwrite real game movie files.", original.display()));
            continue;
        }

        if !original.exists() {
            skipped.push(format!("Missing {}", original.display()));
            continue;
        }

        if !original.is_file() {
            skipped.push(format!("Skipped non-file {}", original.display()));
            continue;
        }

        let disabled_path = disabled_destination_for_receipt_file(&paths, &receipt, &original, file);

        let original_parent = original.parent().map(PathBuf::from);
        move_file_to_target(&original, &disabled_path)?;
        if let Some(parent) = original_parent {
            remove_empty_dirs_up_to(&parent, &paths.win64);
        }

        records.push(DisabledInstallFileRecord {
            original_path: original.display().to_string(),
            disabled_path: disabled_path.display().to_string(),
        });

        moved += 1;
    }

    if !records.is_empty() {
        let manifest = DisabledInstallManifest {
            receipt_id: receipt.id.clone(),
            display_name: receipt.display_name.clone(),
            disabled_at_unix: now_unix_seconds(),
            files: records,
        };

        write_disabled_manifest(&disabled_root.join("tsuki-disabled.json"), &manifest)?;
    }

    let _ = sync_installed_state_database();

    Ok(format!(
        "Disabled {} by moving {} file(s) into Tsuki disabled storage at {}. {}",
        receipt.display_name,
        moved,
        disabled_root.display(),
        skipped.join(" | ")
    ))
}


fn uninstall_receipt_internal(receipt: &InstallReceipt) -> Result<String, String> {
    if let Some(message) = runtime_mutation_locked_message() {
        return Err(message);
    }

    let paths = detect_payday3_paths_internal()
        .ok_or_else(|| "Payday 3 not detected. Set a manual path in Settings.".to_string())?;

    let keep_uninstalled = keep_uninstalled_mods_enabled();
    let holding_root = uninstalled_dir()?.join(format!(
        "uninstall_{}_{}",
        sanitize_file_component(&receipt.display_name),
        current_timestamp()
    ));
    if keep_uninstalled {
        fs::create_dir_all(&holding_root)
            .map_err(|err| format!("Failed to create uninstall holding folder: {}", err))?;
    }

    let mut moved = Vec::new();
    let mut skipped = Vec::new();
    let receipt_originals = receipt
        .files
        .iter()
        .map(|file| receipt_destination_path(file).display().to_string())
        .collect::<std::collections::BTreeSet<_>>();

    let mut files_to_uninstall = receipt.files.clone();
    for extra in extra_win64_companion_files_for_receipt(&paths, receipt) {
        let extra_display = extra.display().to_string();
        if files_to_uninstall.iter().any(|file| file.relative_path.eq_ignore_ascii_case(&extra_display)) {
            continue;
        }
        files_to_uninstall.push(install_receipt_file_for_existing_path(&extra));
    }

    for file in &files_to_uninstall {
        let original = receipt_destination_path(file);

        match move_path_to_uninstalled(&original, &holding_root)? {
            Some(path) => moved.push(path),
            None => skipped.push(format!("Missing or not file: {}", original.display())),
        }
    }

    for manifest_path in disabled_manifest_candidates(&paths, receipt) {
        if let Some(manifest) = read_disabled_manifest(&manifest_path) {
            for record in manifest.files {
                let disabled_path = PathBuf::from(record.disabled_path);

                if let Some(path) = move_path_to_uninstalled(&disabled_path, &holding_root)? {
                    moved.push(path);
                }
            }

            let _ = fs::remove_file(&manifest_path);
        }
    }

    cleanup_disabled_receipt_folders(&paths, receipt);

    if let Some(mut session) = read_vanilla_launch_session() {
        let mut kept = Vec::new();

        for record in session.temp_files {
            if receipt_originals.contains(&record.original_path) {
                let temp_path = PathBuf::from(&record.disabled_path);

                if let Some(path) = move_path_to_uninstalled(&temp_path, &holding_root)? {
                    moved.push(path);
                }
            } else {
                kept.push(record);
            }
        }

        session.temp_files = kept;

        if session.temp_files.is_empty() && session.pak_files.is_empty() && session.receipt_ids.is_empty() {
            clear_vanilla_launch_session();
        } else {
            let _ = write_vanilla_launch_session(&session);
        }
    }

    let receipt_path = receipt_file_path(&receipt.id)?;
    let _ = fs::remove_file(&receipt_path);
    let _ = sync_installed_state_database();

    Ok(format!(
        "Uninstalled {}. {} {} file(s){}. {}",
        receipt.display_name,
        if keep_uninstalled { "Moved" } else { "Deleted" },
        moved.len(),
        if keep_uninstalled { format!(" to {}", holding_root.display()) } else { String::new() },
        if skipped.is_empty() { String::new() } else { skipped.join(" | ") }
    ))
}

#[tauri::command]
fn uninstall_managed_install(receipt_id: String, profile_id: Option<String>) -> Result<String, String> {
    if !is_builtin_payday3_profile(profile_id.as_deref()) {
        let profile_id = profile_id.ok_or_else(|| "A game profile is required.".to_string())?;
        return profile_installs::uninstall_profile_receipt_internal(&profile_id, &receipt_id);
    }

    let receipt = find_receipt_by_id(&receipt_id)?;
    uninstall_receipt_internal(&receipt)
}

#[tauri::command]
fn uninstall_source_install(source: String, source_id: String, profile_id: Option<String>) -> Result<String, String> {
    if !is_builtin_payday3_profile(profile_id.as_deref()) {
        let profile_id = profile_id.ok_or_else(|| "A game profile is required.".to_string())?;
        let receipt = profile_installs::find_profile_receipt_by_source(&profile_id, &source, &source_id)?;
        return profile_installs::uninstall_profile_receipt_internal(&profile_id, &receipt.id);
    }

    let receipt = find_receipt_by_source(&source, &source_id)?;
    uninstall_receipt_internal(&receipt)
}

#[tauri::command]
fn set_source_install_enabled(source: String, source_id: String, enabled: bool, profile_id: Option<String>) -> Result<String, String> {
    if !is_builtin_payday3_profile(profile_id.as_deref()) {
        let profile_id = profile_id.ok_or_else(|| "A game profile is required.".to_string())?;
        let receipt = profile_installs::find_profile_receipt_by_source(&profile_id, &source, &source_id)?;
        return profile_installs::set_profile_receipt_enabled_internal(&profile_id, &receipt.id, enabled);
    }

    let receipt = find_receipt_by_source(&source, &source_id)?;
    set_receipt_mod_enabled_internal(&receipt.id, enabled)
}

fn list_managed_installs_internal() -> Result<Vec<ManagedInstallInfo>, String> {
    let paths = detect_payday3_paths_internal()
        .ok_or_else(|| "Payday 3 not detected. Set a manual path in Settings.".to_string())?;

    let mut installs = list_install_receipts_internal()?
        .into_iter()
        .map(|receipt| {
            let pak_file_count = receipt.files.iter().filter(|file| receipt_is_pak_file_path(&file.relative_path)).count();
            let movie_file_count = receipt.files.iter().filter(|file| receipt_is_movie_file_path(&file.relative_path)).count();
            let file_count = receipt.files.len();
            let non_pak_file_count = file_count.saturating_sub(pak_file_count).saturating_sub(movie_file_count);

            ManagedInstallInfo {
                id: receipt.id.clone(),
                display_name: receipt.display_name.clone(),
                source: receipt.source.clone(),
                source_mod_id: receipt.source_mod_id.clone(),
                source_file_id: receipt.source_file_id.clone(),
                page_url: receipt.page_url.clone(),
                enabled: receipt_enabled_internal(&paths, &receipt),
                file_count,
                pak_file_count,
                non_pak_file_count,
                disabled_folder: disabled_receipt_root(&paths, &receipt).display().to_string(),
            }
        })
        .collect::<Vec<_>>();

    installs.sort_by(|a, b| a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase()));
    Ok(installs)
}

#[tauri::command]
async fn list_managed_installs(profile_id: Option<String>) -> Result<Vec<ManagedInstallInfo>, String> {
    if !is_builtin_payday3_profile(profile_id.as_deref()) {
        let profile_id = profile_id.ok_or_else(|| "A game profile is required.".to_string())?;
        return tauri::async_runtime::spawn_blocking(move || profile_installs::list_profile_managed_installs_internal(&profile_id))
            .await
            .map_err(|err| format!("Profile managed-install task failed: {}", err))?;
    }

    tauri::async_runtime::spawn_blocking(list_managed_installs_internal)
        .await
        .map_err(|err| format!("Managed install task failed: {}", err))?
}

#[tauri::command]
fn set_managed_install_enabled(receipt_id: String, enabled: bool, profile_id: Option<String>) -> Result<String, String> {
    if !is_builtin_payday3_profile(profile_id.as_deref()) {
        let profile_id = profile_id.ok_or_else(|| "A game profile is required.".to_string())?;
        return profile_installs::set_profile_receipt_enabled_internal(&profile_id, &receipt_id, enabled);
    }

    set_receipt_mod_enabled_internal(&receipt_id, enabled)
}


fn folder_has_any_files(path: &Path) -> bool {
    if !path.exists() || !path.is_dir() {
        return false;
    }

    let Ok(entries) = fs::read_dir(path) else {
        return false;
    };

    for entry in entries.flatten() {
        let child = entry.path();

        if child.is_file() {
            return true;
        }

        if child.is_dir() && folder_has_any_files(&child) {
            return true;
        }
    }

    false
}

fn dependency_item(id: &str, label: &str, path: PathBuf, details: &str, recommendation: &str) -> DependencyStatusItem {
    let found = path.exists();

    DependencyStatusItem {
        id: id.to_string(),
        label: label.to_string(),
        status: if found { "found".to_string() } else { "missing".to_string() },
        found,
        path: Some(path.display().to_string()),
        details: details.to_string(),
        recommendation: recommendation.to_string(),
    }
}

#[tauri::command]
fn get_dependency_report(profile_id: Option<String>) -> Result<DependencyReport, String> {
    if !is_builtin_payday3_profile(profile_id.as_deref()) {
        let profile_id = profile_id.as_deref().ok_or_else(|| "Choose a profile before checking dependencies.".to_string())?;
        return profile_installs::get_profile_dependency_report(profile_id);
    }

    let paths = detect_payday3_paths_internal()
        .ok_or_else(|| "Payday 3 not detected. Set a manual path in Settings.".to_string())?;

    let mut items = Vec::new();
    let mut warnings = Vec::new();

    if payday_uses_ue5_layout(&paths) {
        let ready = payday_ue5_loader_ready(&paths, true);
        for (id, label, relative) in [
            ("pd3-ue5-proxy", "UE5 dwmapi proxy", "dwmapi.dll"),
            ("pd3-ue5-ue4ss", "PAYDAY 3 UE5 UE4SS", "UE4SS/UE4SS.dll"),
            ("pd3-ue5-allowmods", "UE5 AllowModsMod", "UE4SS/Mods/AllowModsMod/dlls/AllowModsMod.dll"),
        ] {
            items.push(dependency_item(id, label, paths.win64.join(relative),
                "UE5-specific package layout; file detection does not verify binary compatibility.",
                "Use PD3 UE4SS V3.01 + Allow Pak Mods: https://modworkshop.net/mod/47771 (UE5 file, not older files)."));
        }
        items.push(DependencyStatusItem {
            id: "pd3-ue5-pak-ready".to_string(), label: "UE5 PAK dependency files".to_string(),
            status: if ready { "found" } else { "missing/disabled" }.to_string(), found: ready,
            path: Some(paths.ue4ss_mods.join("mods.txt").display().to_string()),
            details: "Requires dwmapi.dll, UE4SS/UE4SS.dll, AllowModsMod DLL and an enabled AllowModsMod entry.".to_string(),
            recommendation: "UE5 does not support -fileopenlog or the UE4 Logic Mod Loader.".to_string(),
        });
        if !ready { warnings.push("UE5 PAK mods are blocked until the PAYDAY-specific loader and enabled AllowModsMod are detected.".to_string()); }
        if let Some(warning) = payday_ue5_runtime_warning(&paths) { warnings.push(warning); }
        return Ok(DependencyReport { game_root: paths.game_root.display().to_string(), win64: paths.win64.display().to_string(), mods_folder: paths.ue4ss_mods.display().to_string(), items, warnings });
    }
    let ue4ss_dll = paths.win64.join("UE4SS.dll");
    let xinput = paths.win64.join("xinput1_3.dll");
    let ue4ss_settings = paths.win64.join("UE4SS-settings.ini");
    let mods_txt = paths.ue4ss_mods.join("mods.txt");

    items.push(dependency_item(
        "ue4ss-dll",
        "UE4SS.dll",
        ue4ss_dll.clone(),
        "Main UE4SS loader DLL in Win64.",
        "Needed by Lua/UE4SS mods and many script mods.",
    ));
    items.push(dependency_item(
        "xinput-proxy",
        "xinput1_3.dll",
        xinput.clone(),
        "Proxy DLL used by common UE4SS installs.",
        "If missing, some UE4SS installs will never load.",
    ));
    items.push(dependency_item(
        "ue4ss-settings",
        "UE4SS-settings.ini",
        ue4ss_settings.clone(),
        "UE4SS settings file.",
        "Usually installed next to UE4SS.dll in Win64.",
    ));
    items.push(DependencyStatusItem {
        id: "ue4ss-mods-folder".to_string(),
        label: "Win64/Mods folder".to_string(),
        status: if paths.ue4ss_mods.exists() { "found".to_string() } else { "missing".to_string() },
        found: paths.ue4ss_mods.exists(),
        path: Some(paths.ue4ss_mods.display().to_string()),
        details: "Folder where UE4SS mods live.".to_string(),
        recommendation: "Tsuki creates this when installing UE4SS-style mods.".to_string(),
    });

    let logic_candidates = vec![
        paths.ue4ss_mods.join("LogicMods"),
        paths.ue4ss_mods.join("LogicModLoader"),
        paths.ue4ss_mods.join("PD3LogicModLoader"),
        paths.win64.join("LogicMods"),
    ];
    let logic_found = logic_candidates.iter().find(|path| path.exists()).cloned();
    items.push(DependencyStatusItem {
        id: "logic-mod-loader".to_string(),
        label: "Logic Mod Loader".to_string(),
        status: if logic_found.is_some() { "found".to_string() } else { "missing/unknown".to_string() },
        found: logic_found.is_some(),
        path: logic_found.map(|path| path.display().to_string()),
        details: "Detected by common Logic Mod Loader folder names.".to_string(),
        recommendation: "Needed only for mods that explicitly require Logic Mod Loader or LogicMods.".to_string(),
    });

    let moolah_candidates = vec![
        paths.ue4ss_mods.join("MoolahNet"),
        paths.ue4ss_mods.join("Moolah"),
        paths.ue4ss_mods.join("AllowModsMod"),
        paths.win64.join("MoolahNet"),
    ];
    let moolah_found = moolah_candidates.iter().find(|path| path.exists()).cloned();
    items.push(DependencyStatusItem {
        id: "moolahnet".to_string(),
        label: "MoolahNet / AllowModsMod".to_string(),
        status: if moolah_found.is_some() { "found".to_string() } else { "missing/unknown".to_string() },
        found: moolah_found.is_some(),
        path: moolah_found.map(|path| path.display().to_string()),
        details: "Detected by common MoolahNet and AllowModsMod folder names.".to_string(),
        recommendation: "Needed for mods that require MoolahNet/AllowModsMod compatibility plumbing.".to_string(),
    });

    if !ue4ss_dll.exists() && folder_has_any_files(&paths.ue4ss_mods) {
        warnings.push("Win64/Mods has files, but UE4SS.dll is missing. UE4SS-style mods probably will not load.".to_string());
    }

    if ue4ss_dll.exists() && !xinput.exists() {
        warnings.push("UE4SS.dll exists but xinput1_3.dll is missing. Check whether this UE4SS install uses a different loader/proxy.".to_string());
    }

    if mods_txt.exists() {
        warnings.push(format!("mods.txt found at {}. Some frameworks need entries in this file.", mods_txt.display()));
    }

    Ok(DependencyReport {
        game_root: paths.game_root.display().to_string(),
        win64: paths.win64.display().to_string(),
        mods_folder: paths.ue4ss_mods.display().to_string(),
        items,
        warnings,
    })
}

fn receipt_repair_item(paths: &PaydayPaths, receipt: &InstallReceipt) -> ReceiptRepairItem {
    let manifest_path = disabled_receipt_root(paths, receipt).join("tsuki-disabled.json");
    let disabled_manifest = read_disabled_manifest(&manifest_path);

    let mut live_files = 0usize;
    let mut missing_files = 0usize;
    let mut disabled_files = 0usize;
    let mut tracked_files = Vec::new();
    let mut missing_paths = Vec::new();

    for file in &receipt.files {
        let path = receipt_destination_path(file);
        let display = path.display().to_string();
        tracked_files.push(display.clone());

        if path.exists() {
            live_files += 1;
        } else {
            missing_files += 1;
            missing_paths.push(display);
        }
    }

    if let Some(manifest) = disabled_manifest {
        for record in manifest.files {
            let path = PathBuf::from(&record.disabled_path);

            if path.exists() {
                disabled_files += 1;
            }
        }
    }

    ReceiptRepairItem {
        receipt_id: receipt.id.clone(),
        display_name: receipt.display_name.clone(),
        source: receipt.source.clone(),
        source_mod_id: receipt.source_mod_id.clone(),
        installed_at_unix: receipt.installed_at_unix,
        live_files,
        missing_files,
        disabled_files,
        stale: live_files == 0 && disabled_files == 0,
        tracked_files,
        missing_paths,
    }
}

#[tauri::command]
fn list_receipt_repair_items(profile_id: Option<String>) -> Result<Vec<ReceiptRepairItem>, String> {
    if !is_builtin_payday3_profile(profile_id.as_deref()) {
        return Ok(Vec::new());
    }

    let paths = detect_payday3_paths_internal()
        .ok_or_else(|| "Payday 3 not detected. Set a manual path in Settings.".to_string())?;

    let mut items = list_install_receipts_internal()?
        .iter()
        .map(|receipt| receipt_repair_item(&paths, receipt))
        .collect::<Vec<_>>();

    items.sort_by(|a, b| {
        b.stale
            .cmp(&a.stale)
            .then_with(|| a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase()))
    });

    Ok(items)
}

#[tauri::command]
fn remove_receipt_by_id(receipt_id: String, profile_id: Option<String>) -> Result<String, String> {
    if !is_builtin_payday3_profile(profile_id.as_deref()) {
        let profile_id = profile_id.ok_or_else(|| "A game profile is required.".to_string())?;
        return profile_installs::remove_profile_receipt_internal(&profile_id, &receipt_id);
    }

    let receipt = find_receipt_by_id(&receipt_id)?;
    let path = receipt_file_path(&receipt.id)?;

    if path.exists() {
        fs::remove_file(&path)
            .map_err(|err| format!("Failed to remove receipt {}: {}", path.display(), err))?;
    }

    Ok(format!("Removed receipt for {}.", receipt.display_name))
}

fn collect_movie_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();

    fn visit(current: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = fs::read_dir(current) else {
            return;
        };

        for entry in entries.flatten() {
            let path = entry.path();

            if path.is_dir() {
                visit(&path, out);
            } else if path.is_file() {
                let ext = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_lowercase();
                if matches!(ext.as_str(), "bk2" | "bik" | "mp4" | "webm" | "usm" | "wmv" | "m4v" | "mov") {
                    out.push(path);
                }
            }
        }
    }

    visit(root, &mut out);
    out
}

#[tauri::command]
fn validate_movie_replacer_receipts(profile_id: Option<String>) -> Result<Vec<MovieValidationItem>, String> {
    if !is_builtin_payday3_profile(profile_id.as_deref()) {
        return Ok(Vec::new());
    }

    let paths = detect_payday3_paths_internal()
        .ok_or_else(|| "Payday 3 not detected. Set a manual path in Settings.".to_string())?;
    let movie_root = payday_movies_path(&paths);
    let movie_files = collect_movie_files(&movie_root);
    let mut items = Vec::new();

    for receipt in list_install_receipts_internal()? {
        for file in &receipt.files {
            let destination = receipt_destination_path(file);
            let ext = destination.extension().and_then(|value| value.to_str()).unwrap_or("").to_lowercase();

            if !matches!(ext.as_str(), "bk2" | "bik" | "mp4" | "webm" | "usm" | "wmv" | "m4v" | "mov") {
                continue;
            }

            let exact_target_exists = destination.exists();
            let file_name = destination.file_name().and_then(|value| value.to_str()).unwrap_or("").to_lowercase();

            let same_file_name_matches = movie_files
                .iter()
                .filter(|path| path.file_name().and_then(|value| value.to_str()).unwrap_or("").eq_ignore_ascii_case(&file_name))
                .map(|path| path.display().to_string())
                .take(12)
                .collect::<Vec<_>>();

            let is_known_movie_target = known_payday_movie_file_name(&file_name);

            let verdict = if exact_target_exists {
                if is_known_movie_target {
                    "Exact PAYDAY 3 movie target exists. This should replace a known startup/loading movie file.".to_string()
                } else {
                    "Exact destination exists. Movie replacer is in a live game movie path.".to_string()
                }
            } else if !same_file_name_matches.is_empty() {
                "Exact destination is missing, but same filename exists elsewhere in Content/Movies. Archive path may be wrong.".to_string()
            } else {
                "No exact target or same filename found under Content/Movies. This movie replacer likely needs manual path review.".to_string()
            };

            items.push(MovieValidationItem {
                receipt_id: receipt.id.clone(),
                display_name: receipt.display_name.clone(),
                archive_or_installed_path: file.relative_path.clone(),
                destination: destination.display().to_string(),
                exact_target_exists,
                same_file_name_matches,
                verdict,
            });
        }
    }

    Ok(items)
}


const UNASSIGNED_GAME_PROFILE_ID: &str = "migration.unassigned";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileImageReferenceWire { kind: String, value: String, updated_at: String }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileArtworkImportResult { image_reference: ProfileImageReferenceWire, source_path: String, source_exists: bool, managed_path: String, managed_exists: bool }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileArtworkResolveResult { final_src: String, source_path: String, source_exists: bool, managed_root: String, resolver: String, byte_length: usize }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GameFolderScanExecutable { file_name: String, path: String, relative_path: String, size_bytes: Option<u64>, score: Option<u32> }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GameFolderScanFolder { name: String, path: String, relative_path: String }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GameFolderScanResult { game_folder: String, suggested_game_name: String, executables: Vec<GameFolderScanExecutable>, suggested_executable: Option<GameFolderScanExecutable>, folders: Vec<GameFolderScanFolder>, frameworks: Vec<String>, steam_app_ids: Vec<String>, architecture_hints: Vec<String>, visited_entries: Option<usize> }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileRuntimeIssue { level: String, code: String, message: String, section: Option<String> }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveProfileRuntimeWire { profile_id: String, definition_revision: u64, game_id: String, game_name: String, game_root: Option<String>, executable: Option<String>, named_paths: Vec<String>, sources: Vec<String>, source_config: serde_json::Value, mod_types: Vec<String>, install_rules: Vec<String>, toggle_rules: Vec<String>, dependencies: Vec<String>, conflict_rules: Vec<String>, storage_path: String, installed_state_path: String, receipts_path: String, backups_path: String, disabled_state_path: String, browse_cache_path: String, thumbnail_cache_path: String, source_index_path: String, dependency_state_path: String, setup_state_path: String, launch_configuration: serde_json::Value, loaded_receipt_count: usize, loaded_installed_mod_count: usize, ready: bool, error: Option<String> }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileRuntimeOpenResult { profile_id: String, storage_path: String, profile_path: String, draft_path: String, setup_state_path: String, index_path: String, test_workspace_path: String, blocking: Vec<ProfileRuntimeIssue>, warnings: Vec<ProfileRuntimeIssue>, revision: u64, opened_at_unix: u64, preview_setup: bool }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileCreatorRuntimeTestResult { status: String, what_was_tested: String, input_used: Vec<String>, resolved_paths: Vec<String>, actions: Vec<String>, warnings: Vec<String>, errors: Vec<String>, technical_details: Vec<String>, profile_revision: u64, outdated: bool }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceTestConfigResult { status: String, message: String, user_message: Option<String>, technical_details: Option<String>, source_type: Option<String>, reachable: bool, authenticated: bool, mapping_valid: bool, final_url: Option<String>, http_status: Option<u16> }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EmbeddedBrowserStatus { open: bool, url: Option<String> }

fn clean_profile_id(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() { return Err("Game profile id is required.".to_string()); }
    let mut out = String::new();
    for ch in trimmed.chars() { if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') { out.push(ch); } else { out.push('_'); } }
    let clean = out.trim_matches('.').to_string();
    if clean.is_empty() { Err("Game profile id is invalid.".to_string()) } else { Ok(clean.chars().take(140).collect()) }
}

fn profile_data_root_dir() -> Result<PathBuf, String> { Ok(app_data_dir()?.join("profile-data")) }
fn profile_data_dir_for(profile_id: &str) -> Result<PathBuf, String> { Ok(profile_data_root_dir()?.join(clean_profile_id(profile_id)?)) }

fn ensure_profile_data_dirs(profile_id: &str) -> Result<PathBuf, String> {
    let root = profile_data_dir_for(profile_id)?;
    for folder in ["installed-state", "receipts", "backups", "cache", "cache\\browse", "cache\\thumbnails", "source-index", "dependencies", "setup", "disabled-state", "mod-profiles", "browser", "test-workspace"] {
        fs::create_dir_all(root.join(folder)).map_err(|err| format!("Failed to create profile data folder {}: {}", folder, err))?;
    }
    Ok(root)
}

fn game_profile_drafts_dir() -> Result<PathBuf, String> { let dir = app_data_dir()?.join("game-profile-drafts"); fs::create_dir_all(&dir).map_err(|err| format!("Failed to create game profile drafts folder {}: {}", dir.display(), err))?; Ok(dir) }
fn game_profile_draft_path(profile_id: &str) -> Result<PathBuf, String> { Ok(game_profile_drafts_dir()?.join(format!("{}.json", clean_profile_id(profile_id)?))) }
fn json_bool(value: &serde_json::Value, key: &str) -> Option<bool> { value.get(key).and_then(|entry| entry.as_bool()) }
fn draft_profile_id(draft: &serde_json::Value) -> Option<String> { json_string(draft, "profileId") }
fn draft_overview_string(draft: &serde_json::Value, key: &str) -> Option<String> { draft.get("overview").and_then(|overview| json_string(overview, key)) }
fn draft_section_items<'a>(draft: &'a serde_json::Value, section: &str) -> Vec<&'a serde_json::Value> { draft.get("sections").and_then(|sections| sections.get(section)).and_then(|items| items.as_array()).map(|items| items.iter().collect()).unwrap_or_default() }
fn item_title(item: &serde_json::Value) -> Option<String> { json_string(item, "title") }
fn item_field_value(item: &serde_json::Value, label: &str) -> Option<String> {
    item.get("fields").and_then(|fields| fields.as_array()).and_then(|fields| {
        fields.iter().find_map(|field| { let field_label = json_string(field, "label")?; if field_label.eq_ignore_ascii_case(label) { json_string(field, "value") } else { None } })
    })
}
fn item_any_field_value(item: &serde_json::Value, labels: &[&str]) -> Option<String> {
    labels
        .iter()
        .find_map(|label| item_field_value(item, label))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}
fn split_source_list_value(value: Option<String>) -> Vec<String> {
    value
        .unwrap_or_default()
        .split(|ch| matches!(ch, ',' | '\n' | '\r' | ';' | '|'))
        .map(|part| part.trim().to_string())
        .filter(|part| !part.is_empty())
        .collect()
}

fn source_url_with_protocol(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{}", trimmed)
    }
}

fn parse_http_source_url(value: &str) -> Option<reqwest::Url> {
    let url = reqwest::Url::parse(&source_url_with_protocol(value)).ok()?;
    if matches!(url.scheme(), "http" | "https") && url.host_str().is_some() {
        Some(url)
    } else {
        None
    }
}

fn source_host_matches(url: &reqwest::Url, suffix: &str) -> bool {
    let Some(host) = url.host_str().map(|value| value.to_ascii_lowercase()) else {
        return false;
    };
    let clean = suffix.to_ascii_lowercase();
    host == clean || host.ends_with(&format!(".{}", clean))
}

fn source_url_path_parts(url: &reqwest::Url) -> Vec<String> {
    url.path_segments()
        .map(|segments| segments.map(|part| part.trim().to_string()).filter(|part| !part.is_empty()).collect())
        .unwrap_or_default()
}

fn clean_source_slug(value: &str) -> Option<String> {
    let trimmed = value
        .trim()
        .trim_matches(|ch| ch == '/' || ch == '\\')
        .split(|ch| matches!(ch, '/' | '\\' | '?' | '#'))
        .find(|part| !part.trim().is_empty())?
        .trim()
        .to_ascii_lowercase();

    if trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
        && !trimmed.contains(' ')
    {
        Some(trimmed)
    } else {
        None
    }
}

fn source_id_is_numeric(value: &str) -> bool {
    !value.trim().is_empty() && value.trim().chars().all(|ch| ch.is_ascii_digit())
}

fn parse_nexus_game_url_fields(value: &str) -> Option<(String, String, bool)> {
    let url = parse_http_source_url(value)?;
    if !source_host_matches(&url, "nexusmods.com") {
        return None;
    }
    let parts = source_url_path_parts(&url);
    let domain_index = if parts.first().map(|part| part.eq_ignore_ascii_case("games")).unwrap_or(false) {
        1
    } else {
        0
    };
    let domain = clean_source_slug(parts.get(domain_index)?)?;
    let is_category_url = parts.len() > domain_index + 1 || url.query().is_some();
    Some((domain, url.to_string(), is_category_url))
}

fn parse_modworkshop_game_url_fields(value: &str) -> Option<(Option<String>, Option<String>, String, bool)> {
    let mut url = parse_http_source_url(value)?;
    if !source_host_matches(&url, "modworkshop.net") {
        return None;
    }

    let mut parts = source_url_path_parts(&url);
    let mut slug = None::<String>;
    let mut numeric_id = None::<String>;

    if let Some(index) = parts
        .iter()
        .position(|part| matches!(part.to_ascii_lowercase().as_str(), "g" | "game" | "games"))
    {
        if let Some(candidate) = parts.get(index + 1) {
            if source_id_is_numeric(candidate) {
                numeric_id = Some(candidate.to_string());
            } else {
                slug = clean_source_slug(candidate);
            }
        }
    }

    for (key, value) in url.query_pairs() {
        if !matches!(key.as_ref(), "game" | "game_id" | "gameId") {
            continue;
        }
        if source_id_is_numeric(&value) {
            numeric_id.get_or_insert_with(|| value.to_string());
        } else if slug.is_none() {
            slug = clean_source_slug(&value);
        }
    }

    if let Some(value) = slug.as_deref() {
        let canonical = normalize_modworkshop_game_route(value).ok()?;
        if let Some(index) = parts
            .iter()
            .position(|part| matches!(part.to_ascii_lowercase().as_str(), "g" | "game" | "games"))
        {
            if let Some(route) = parts.get_mut(index + 1) {
                *route = canonical.clone();
                url.set_path(&format!("/{}", parts.join("/")));
            }
        }
        slug = Some(canonical);
    }

    if slug.is_none() && numeric_id.is_none() {
        return None;
    }

    let is_category_url = parts.iter().any(|part| part.to_ascii_lowercase().starts_with("categor"))
        || url.query_pairs().any(|(key, _)| matches!(key.as_ref(), "category" | "category_id" | "tags" | "tag"));

    Some((slug, numeric_id, url.to_string(), is_category_url))
}

fn github_repository_component(value: &str) -> Option<String> {
    let clean = value.trim().trim_end_matches(".git");
    if !clean.is_empty()
        && clean.len() <= 100
        && clean.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        Some(clean.to_string())
    } else {
        None
    }
}

fn parse_github_repository_url(value: &str) -> Option<(String, String)> {
    let url = parse_http_source_url(value)?;
    if !source_host_matches(&url, "github.com") {
        return None;
    }
    let parts = source_url_path_parts(&url);
    Some((
        github_repository_component(parts.first()?)?,
        github_repository_component(parts.get(1)?)?,
    ))
}

fn source_type_from_item(item: &serde_json::Value) -> String { item_field_value(item, "Source Type").or_else(|| item_title(item)).unwrap_or_else(|| "custom_browser".to_string()).trim().to_ascii_lowercase().replace(' ', "_") }

fn is_game_profile_draft_value(value: &serde_json::Value) -> bool { value.get("overview").map(|entry| entry.is_object()).unwrap_or(false) && value.get("sections").map(|entry| entry.is_object()).unwrap_or(false) }
fn stamp_game_profile_draft(mut draft: serde_json::Value, profile_id: &str, path: &Path) -> serde_json::Value {
    if !draft.is_object() { draft = serde_json::json!({}); }
    let now = current_timestamp();
    let object = draft.as_object_mut().expect("draft object");
    object.insert("schemaVersion".to_string(), object.get("schemaVersion").cloned().unwrap_or_else(|| serde_json::Value::from(3)));
    object.insert("profileId".to_string(), serde_json::Value::String(profile_id.to_string()));
    object.entry("profileType".to_string()).or_insert_with(|| serde_json::Value::String("user_created".to_string()));
    object.entry("status".to_string()).or_insert_with(|| serde_json::Value::String("draft".to_string()));
    object.entry("lifecycleState".to_string()).or_insert_with(|| serde_json::Value::String("draft".to_string()));
    object.entry("setupStatus".to_string()).or_insert_with(|| serde_json::Value::String("incomplete".to_string()));
    object.entry("createdAt".to_string()).or_insert_with(|| serde_json::Value::String(now.clone()));
    object.entry("updatedAt".to_string()).or_insert_with(|| serde_json::Value::String(now));
    object.entry("sourceConfigMigrationVersion".to_string()).or_insert_with(|| serde_json::Value::from(2));
    object.entry("sourceConfigMigrationState".to_string()).or_insert_with(|| serde_json::Value::String("identity-fields-split".to_string()));
    object.insert("draftStoragePath".to_string(), serde_json::Value::String(path.display().to_string()));
    draft
}
fn read_json_file(path: &Path) -> Option<serde_json::Value> { serde_json::from_str(&fs::read_to_string(path).ok()?).ok() }
fn write_json_file(path: &Path, value: &serde_json::Value, label: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create {} folder {}: {}", label, parent.display(), err))?;
    }

    let contents = serde_json::to_string_pretty(value)
        .map_err(|err| format!("Failed to serialize {}: {}", label, err))?;
    let tmp_path = path.with_extension(format!(
        "{}.tmp",
        path.extension().and_then(|value| value.to_str()).unwrap_or("json")
    ));
    let backup_path = path.with_extension(format!(
        "{}.bak",
        path.extension().and_then(|value| value.to_str()).unwrap_or("json")
    ));

    fs::write(&tmp_path, contents)
        .map_err(|err| format!("Failed to write temporary {} {}: {}", label, tmp_path.display(), err))?;

    if path.exists() {
        fs::copy(path, &backup_path)
            .map_err(|err| format!("Failed to back up existing {} {}: {}", label, path.display(), err))?;
        eprintln!("Replacing {} {} after backup {}", label, path.display(), backup_path.display());
    } else {
        eprintln!("Writing new {} {}", label, path.display());
    }

    match fs::rename(&tmp_path, path) {
        Ok(_) => Ok(()),
        Err(rename_error) => {
            fs::copy(&tmp_path, path)
                .map_err(|copy_error| format!(
                    "Failed to replace {} {}: rename failed: {}; copy failed: {}",
                    label,
                    path.display(),
                    rename_error,
                    copy_error,
                ))?;
            let _ = fs::remove_file(&tmp_path);
            Ok(())
        }
    }
}
fn read_game_profile_draft(profile_id: &str) -> Result<serde_json::Value, String> { let clean = clean_profile_id(profile_id)?; let path = game_profile_draft_path(&clean)?; let value = read_json_file(&path).ok_or_else(|| format!("Game profile draft was not found: {}", profile_id))?; Ok(stamp_game_profile_draft(value, &clean, &path)) }
fn save_game_profile_draft_value(profile_id: &str, draft: serde_json::Value) -> Result<serde_json::Value, String> { let clean = clean_profile_id(profile_id)?; let path = game_profile_draft_path(&clean)?; let stamped = stamp_game_profile_draft(draft, &clean, &path); write_json_file(&path, &stamped, "game profile draft")?; Ok(stamped) }
fn legacy_game_profile_draft_dirs() -> Result<Vec<PathBuf>, String> { let root = app_data_dir()?; Ok(vec![root.join("profile-drafts"), root.join("game-profiles").join("drafts"), root.join("profiles")]) }
fn migrate_game_profile_drafts() -> Result<(usize, usize), String> {
    let target_dir = game_profile_drafts_dir()?;
    let mut migrated = 0usize;
    let mut malformed = 0usize;
    for folder in legacy_game_profile_draft_dirs()? {
        if !folder.exists() || folder == target_dir { continue; }
        let Ok(entries) = fs::read_dir(&folder) else { continue; };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") { continue; }
            let Some(value) = read_json_file(&path) else {
                malformed += 1;
                eprintln!("Malformed legacy game profile draft was left in place: {}", path.display());
                continue;
            };
            if !is_game_profile_draft_value(&value) {
                malformed += 1;
                eprintln!("Legacy game profile draft missing overview/sections was left in place: {}", path.display());
                continue;
            }
            let Some(profile_id) = draft_profile_id(&value) else {
                malformed += 1;
                eprintln!("Legacy game profile draft missing profileId was left in place: {}", path.display());
                continue;
            };
            let Ok(target_path) = game_profile_draft_path(&profile_id) else {
                malformed += 1;
                eprintln!("Legacy game profile draft had an invalid profileId and was left in place: {}", path.display());
                continue;
            };
            if target_path.exists() { continue; }
            let stamped = stamp_game_profile_draft(value, &profile_id, &target_path);
            match write_json_file(&target_path, &stamped, "migrated game profile draft") {
                Ok(_) => migrated += 1,
                Err(error) => eprintln!("Failed to migrate game profile draft {}: {}", path.display(), error),
            }
        }
    }
    Ok((migrated, malformed))
}

#[tauri::command]
fn list_game_profile_drafts() -> Result<Vec<serde_json::Value>, String> {
    let (migrated, mut malformed) = migrate_game_profile_drafts()?;
    let folder = game_profile_drafts_dir()?;
    let mut drafts = Vec::new();
    let mut found = 0usize;
    for entry in fs::read_dir(&folder).map_err(|err| format!("Failed to read game profile drafts folder: {}", err))? {
        let entry = entry.map_err(|err| format!("Failed to read game profile draft entry: {}", err))?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") { continue; }
        found += 1;
        let Some(value) = read_json_file(&path) else {
            malformed += 1;
            eprintln!("Malformed game profile draft was left in place: {}", path.display());
            continue;
        };
        if !is_game_profile_draft_value(&value) {
            malformed += 1;
            eprintln!("Game profile draft missing overview/sections was left in place: {}", path.display());
            continue;
        }
        let Some(profile_id) = draft_profile_id(&value) else {
            malformed += 1;
            eprintln!("Game profile draft missing profileId was left in place: {}", path.display());
            continue;
        };
        if profile_id == BUILTIN_PAYDAY3_PROFILE_ID { continue; }
        drafts.push(stamp_game_profile_draft(value, &profile_id, &path));
    }
    drafts.sort_by(|a, b| json_string(b, "updatedAt").cmp(&json_string(a, "updatedAt")));
    let _ = write_runtime_process_diagnostic(&RuntimeProcessDiagnostic {
        time_unix: now_unix_seconds(),
        label: "Game Profile Drafts".to_string(),
        status: if malformed == 0 { "success".to_string() } else { "warning".to_string() },
        reason: format!("Loaded {} displayed game profile draft(s) from AppData.", drafts.len()),
        details: vec![
            format!("Drafts found: {}", found),
            "Storage source: AppData/game-profile-drafts plus migrated legacy draft folders".to_string(),
            format!("Drafts migrated: {}", migrated),
            format!("Drafts malformed: {}", malformed),
            format!("Drafts displayed: {}", drafts.len()),
        ],
    });
    Ok(drafts)
}
#[tauri::command]
fn create_game_profile_draft(draft: serde_json::Value) -> Result<serde_json::Value, String> { let profile_id = draft_profile_id(&draft).unwrap_or_else(|| format!("user.{}", current_timestamp())); let clean = clean_profile_id(&profile_id)?; let path = game_profile_draft_path(&clean)?; if let Some(existing) = read_json_file(&path) { return Ok(stamp_game_profile_draft(existing, &clean, &path)); } save_game_profile_draft_value(&clean, draft) }

#[tauri::command]
fn save_game_profile_draft(profile_id: String, draft: serde_json::Value) -> Result<serde_json::Value, String> { save_game_profile_draft_value(&profile_id, draft) }

#[tauri::command]
fn delete_game_profile_draft(profile_id: String) -> Result<String, String> {
    let clean = clean_profile_id(&profile_id)?;
    if clean == BUILTIN_PAYDAY3_PROFILE_ID {
        return Err("The built-in PAYDAY 3 profile cannot be deleted.".to_string());
    }
    let path = game_profile_draft_path(&clean)?;
    if !path.exists() {
        eprintln!("Game profile draft delete skipped; no draft existed for {} at {}", clean, path.display());
        return Ok(format!("No draft existed for {}.", clean));
    }
    fs::remove_file(&path)
        .map_err(|err| format!("Failed to delete game profile draft {}: {}", path.display(), err))?;
    eprintln!("Deleted game profile draft {} at {}", clean, path.display());
    Ok(format!("Deleted draft {}.", clean))
}

#[tauri::command]
fn duplicate_game_profile_draft(profile_id: String) -> Result<serde_json::Value, String> { let source = read_game_profile_draft(&profile_id)?; let duplicate_id = format!("user.{}", current_timestamp()); let mut duplicate = source.clone(); if !duplicate.is_object() { duplicate = serde_json::json!({}); } if let Some(object) = duplicate.as_object_mut() { object.insert("profileId".to_string(), serde_json::Value::String(duplicate_id.clone())); object.insert("status".to_string(), serde_json::Value::String("draft".to_string())); object.insert("lifecycleState".to_string(), serde_json::Value::String("draft".to_string())); if let Some(overview) = object.get_mut("overview").and_then(|value| value.as_object_mut()) { if let Some(title) = overview.get("profileTitle").and_then(|value| value.as_str()).map(|value| value.to_string()) { overview.insert("profileTitle".to_string(), serde_json::Value::String(format!("{} Copy", title))); } } } save_game_profile_draft_value(&duplicate_id, duplicate) }

#[tauri::command]
fn export_game_profile_draft_to_path(profile_id: String, export_path: String) -> Result<String, String> { let draft = read_game_profile_draft(&profile_id)?; let path = PathBuf::from(export_path.trim()); if path.as_os_str().is_empty() { return Err("Export path is required.".to_string()); } write_json_file(&path, &draft, "exported game profile")?; Ok(format!("Exported game profile draft to {}", path.display())) }

fn insert_config_string(config: &mut serde_json::Map<String, serde_json::Value>, key: &str, value: Option<String>) {
    if let Some(clean) = clean_optional_string(value) {
        config.entry(key.to_string()).or_insert(serde_json::Value::String(clean));
    }
}

fn insert_config_array(config: &mut serde_json::Map<String, serde_json::Value>, key: &str, values: Vec<String>) {
    if !values.is_empty() {
        config.entry(key.to_string()).or_insert(serde_json::json!(values));
    }
}

fn builtin_payday3_source_config() -> serde_json::Value {
    serde_json::json!({
        "modworkshopDisplayName": "ModWorkshop",
        "modworkshopGameName": "PAYDAY 3",
        "modworkshopGameId": "853",
        "modworkshopSlug": "payday-3",
        "modworkshopGamePageUrl": "https://modworkshop.net/g/payday-3/mods",
        "modworkshopEmbeddedStartUrl": "https://modworkshop.net/g/payday-3/mods",
        "modworkshopAllowedDomains": ["modworkshop.net", "www.modworkshop.net", "storage.modworkshop.net", "api.modworkshop.net"],
        "modworkshopBrowseMode": "Built-in/API",
        "nexusDisplayName": "Nexus Mods",
        "nexusGameName": "PAYDAY 3",
        "nexusDomain": "payday3",
        "nexusGameId": "5717",
        "nexusGamePageUrl": "https://www.nexusmods.com/payday3",
        "nexusEmbeddedStartUrl": "https://www.nexusmods.com/payday3/mods",
        "nexusAllowedDomains": ["nexusmods.com", "www.nexusmods.com", "staticdelivery.nexusmods.com", "users.nexusmods.com"],
        "nexusBrowseMode": "Built-in/API",
    })
}

fn builtin_nexus_source_pair(
    id_prefix: &str,
    game_name: &str,
    domain: &str,
    numeric_game_id: &str,
    label_suffix: Option<&str>,
) -> Vec<serde_json::Value> {
    let suffix = label_suffix.map(|value| format!(" - {}", value)).unwrap_or_default();
    let game_page_url = format!("https://www.nexusmods.com/{}", domain);
    let start_url = format!("{}/mods", game_page_url);
    let allowed_domains = serde_json::json!([
        "nexusmods.com",
        "www.nexusmods.com",
        "staticdelivery.nexusmods.com",
        "users.nexusmods.com"
    ]);
    vec![
        serde_json::json!({
            "id": format!("{}-nexus-api", id_prefix),
            "displayName": format!("Nexus Mods{}", suffix),
            "provider": "nexus",
            "enabled": true,
            "browseMode": "api",
            "apiEnabled": true,
            "apiKeySource": "Global Settings",
            "gameName": game_name,
            "providerSlug": domain,
            "providerGameId": numeric_game_id,
            "gamePageUrl": game_page_url,
            "listingUrl": start_url,
            "startUrl": start_url,
            "allowedDomains": allowed_domains,
            "captureDownloads": true,
        }),
        serde_json::json!({
            "id": format!("{}-nexus-browser", id_prefix),
            "displayName": format!("Nexus Browser{}", suffix),
            "provider": "nexus",
            "enabled": true,
            "browseMode": "webview_window",
            "apiEnabled": false,
            "apiKeySource": serde_json::Value::Null,
            "gameName": game_name,
            "providerSlug": domain,
            "providerGameId": numeric_game_id,
            "gamePageUrl": game_page_url,
            "listingUrl": start_url,
            "startUrl": start_url,
            "allowedDomains": allowed_domains,
            "captureDownloads": true,
        }),
    ]
}

fn builtin_modworkshop_source_pair(
    id_prefix: &str,
    game_name: &str,
    slug: &str,
    numeric_game_id: &str,
) -> Vec<serde_json::Value> {
    let game_page_url = format!("https://modworkshop.net/g/{}/mods", slug);
    let allowed_domains = serde_json::json!([
        "modworkshop.net",
        "www.modworkshop.net",
        "storage.modworkshop.net",
        "api.modworkshop.net"
    ]);
    vec![
        serde_json::json!({
            "id": format!("{}-modworkshop-api", id_prefix),
            "displayName": "ModWorkshop",
            "provider": "modworkshop",
            "enabled": true,
            "browseMode": "api",
            "apiEnabled": true,
            "apiKeySource": serde_json::Value::Null,
            "gameName": game_name,
            "providerSlug": slug,
            "providerGameId": numeric_game_id,
            "gamePageUrl": game_page_url,
            "listingUrl": game_page_url,
            "startUrl": game_page_url,
            "allowedDomains": allowed_domains,
            "captureDownloads": true,
        }),
        serde_json::json!({
            "id": format!("{}-modworkshop-browser", id_prefix),
            "displayName": "ModWorkshop Browser",
            "provider": "modworkshop",
            "enabled": true,
            "browseMode": "webview_window",
            "apiEnabled": false,
            "apiKeySource": serde_json::Value::Null,
            "gameName": game_name,
            "providerSlug": slug,
            "providerGameId": numeric_game_id,
            "gamePageUrl": game_page_url,
            "listingUrl": game_page_url,
            "startUrl": game_page_url,
            "allowedDomains": allowed_domains,
            "captureDownloads": true,
        }),
    ]
}

fn builtin_nexus_profile_source_config(
    id_prefix: &str,
    game_name: &str,
    domain: &str,
    numeric_game_id: &str,
) -> serde_json::Value {
    serde_json::json!({
        "sources": builtin_nexus_source_pair(id_prefix, game_name, domain, numeric_game_id, None)
    })
}

fn builtin_payday_profile_source_config(
    id_prefix: &str,
    game_name: &str,
    modworkshop_slug: &str,
    modworkshop_game_id: &str,
    nexus_domain: &str,
    nexus_game_id: &str,
) -> serde_json::Value {
    let mut sources = builtin_modworkshop_source_pair(id_prefix, game_name, modworkshop_slug, modworkshop_game_id);
    sources.extend(builtin_nexus_source_pair(id_prefix, game_name, nexus_domain, nexus_game_id, None));
    serde_json::json!({ "sources": sources })
}

fn builtin_profile_source_config(profile_id: &str) -> Option<serde_json::Value> {
    match profile_id {
        "builtin.cyberpunk2077" => Some(builtin_nexus_profile_source_config("cyberpunk2077", "Cyberpunk 2077", "cyberpunk2077", "3333")),
        "builtin.outlast-trials" => Some(builtin_nexus_profile_source_config("outlast-trials", "The Outlast Trials", "theoutlasttrials", "5376")),
        "builtin.payday-the-heist" => Some(builtin_payday_profile_source_config("payday-the-heist", "PAYDAY: The Heist", "pdth", "2", "paydaytheheist", "4339")),
        "builtin.payday2" => Some(builtin_payday_profile_source_config("payday2", "PAYDAY 2", "payday-2", "1", "payday2", "648")),
        BUILTIN_PAYDAY3_PROFILE_ID => {
            let mut config = builtin_payday3_source_config();
            let sources = builtin_payday_profile_source_config("payday3", "PAYDAY 3", "payday-3", "853", "payday3", "5717")
                .get("sources")
                .cloned()
                .unwrap_or_else(|| serde_json::json!([]));
            config.as_object_mut().expect("PAYDAY 3 source config").insert("sources".to_string(), sources);
            Some(config)
        }
        "builtin.resident-evil-7" => Some(builtin_nexus_profile_source_config("resident-evil-7", "Resident Evil 7 biohazard", "residentevil7", "3111")),
        "builtin.resident-evil-village" => Some(builtin_nexus_profile_source_config("resident-evil-village", "Resident Evil Village", "residentevilvillage", "3669")),
        "builtin.resident-evil-requiem" => Some(builtin_nexus_profile_source_config("resident-evil-requiem", "Resident Evil Requiem", "residentevilrequiem", "8863")),
        "builtin.borderlands" => {
            let mut sources = builtin_nexus_source_pair(
                "borderlands",
                "Borderlands Game of the Year",
                "borderlands",
                "360",
                Some("Classic"),
            );
            sources.extend(builtin_nexus_source_pair(
                "borderlands-enhanced",
                "Borderlands Game of the Year Enhanced",
                "borderlandsgotyenhanced",
                "2776",
                Some("Enhanced"),
            ));
            Some(serde_json::json!({ "sources": sources }))
        }
        "builtin.borderlands2" => Some(serde_json::json!({
            "sources": builtin_nexus_source_pair(
                "borderlands2",
                "Borderlands 2",
                "borderlands2",
                "428",
                None,
            )
        })),
        "builtin.borderlands3" => Some(builtin_nexus_profile_source_config("borderlands3", "Borderlands 3", "borderlands3", "2953")),
        "builtin.borderlands4" => Some(builtin_nexus_profile_source_config("borderlands4", "Borderlands 4", "borderlands4", "8148")),
        "builtin.tiny-tinas-wonderlands" => Some(builtin_nexus_profile_source_config("tiny-tinas-wonderlands", "Tiny Tina's Wonderlands", "tinytinaswonderlands", "4394")),
        "builtin.spider-man-remastered" => Some(builtin_nexus_profile_source_config("spider-man-remastered", "Marvel's Spider-Man Remastered", "marvelsspidermanremastered", "4536")),
        "builtin.spider-man-2" => Some(builtin_nexus_profile_source_config("spider-man-2", "Marvel's Spider-Man 2", "marvelsspiderman2", "6082")),
        "builtin.monster-hunter-wilds" => Some(builtin_nexus_profile_source_config("monster-hunter-wilds", "Monster Hunter Wilds", "monsterhunterwilds", "6993")),
        _ => None,
    }
}

fn source_config_from_draft(draft: &serde_json::Value) -> serde_json::Value {
    let mut config = serde_json::Map::new();
    let mut custom_sources = Vec::new();
    let mut configured_sources = Vec::new();
    let mut recovered_nexus_browser = None;
    let draft_sources = draft_section_items(draft, "sources");
    let has_dedicated_nexus_browser = draft_sources.iter().any(|item| {
        let source_type = source_type_from_item(item);
        let mode = item_any_field_value(item, &["Browse Mode"]).unwrap_or_default().to_ascii_lowercase();
        let start_url = item_any_field_value(item, &["Embedded Start URL", "Starting Page URL", "Start URL", "Base URL"]);
        (matches!(source_type.as_str(), "nexus" | "nexus_mods")
            && (mode.contains("embedded") || mode.contains("browser") || mode.contains("webview") || mode.contains("external")))
            || (matches!(source_type.as_str(), "embedded" | "custom_browser")
                && start_url.as_deref().and_then(parse_http_source_url).map(|url| source_host_matches(&url, "nexusmods.com")).unwrap_or(false))
    });

    for item in draft_sources {
        if json_bool(item, "enabled") == Some(false) {
            continue;
        }

        match source_type_from_item(item).as_str() {
            "nexus" | "nexus_mods" => {
                let source_id = item_any_field_value(item, &["Source Instance ID"])
                    .or_else(|| json_string(item, "id"))
                    .unwrap_or_else(|| format!("source-nexus-{}", configured_sources.len() + 1));
                let display_name = item_any_field_value(item, &["Display Name"]).or_else(|| item_title(item));
                let game_name = item_any_field_value(item, &["Human Game Name", "Selected Nexus Game", "Selected Game", "Game Name", "Search Nexus Games"]);
                let browse_mode = item_any_field_value(item, &["Browse Mode"]);
                let allowed_domains = split_source_list_value(item_any_field_value(item, &["Allowed Domains", "Allowed Domain"]));

                insert_config_string(&mut config, "nexusDisplayName", display_name.clone());
                insert_config_string(&mut config, "nexusGameName", game_name.clone());
                insert_config_string(&mut config, "nexusBrowseMode", browse_mode.clone());
                insert_config_string(&mut config, "nexusApiBaseUrl", item_any_field_value(item, &["Nexus API Base URL", "API Base URL"]));
                insert_config_array(&mut config, "nexusAllowedDomains", allowed_domains.clone());

                let mut domain = item_any_field_value(item, &["Nexus Domain", "Domain"])
                    .and_then(|value| clean_source_slug(&value))
                    .filter(|value| value != "games");
                let game_id = item_any_field_value(item, &["Nexus Game ID", "Numeric Nexus Game ID", "Game ID"])
                    .filter(|value| source_id_is_numeric(value));
                let mut game_page_url = item_any_field_value(item, &["Nexus Game Page URL", "Game Page URL", "Page URL"]);
                let mut category_url = item_any_field_value(item, &["Nexus Category URL", "Category URL", "Mods URL"]);
                let mut start_url = item_any_field_value(item, &["Embedded Start URL", "Start URL", "Starting Page URL"]);

                for candidate in [
                    item_any_field_value(item, &["Nexus Domain", "Domain"]),
                    item_any_field_value(item, &["Nexus Game ID", "Game ID"]),
                    game_page_url.clone(),
                    category_url.clone(),
                    start_url.clone(),
                ]
                .into_iter()
                .flatten()
                {
                    if let Some((parsed_domain, parsed_url, is_category_url)) = parse_nexus_game_url_fields(&candidate) {
                        domain.get_or_insert(parsed_domain);
                        if is_category_url {
                            category_url.get_or_insert(parsed_url.clone());
                        } else {
                            game_page_url.get_or_insert(parsed_url.clone());
                        }
                        start_url.get_or_insert(parsed_url);
                    } else if domain.is_none() && !source_id_is_numeric(&candidate) {
                        domain = clean_source_slug(&candidate).filter(|value| value != "games");
                    }
                }

                if let Some(domain_value) = domain.clone() {
                    game_page_url.get_or_insert_with(|| format!("https://www.nexusmods.com/{}", domain_value));
                    start_url.get_or_insert_with(|| category_url.clone().unwrap_or_else(|| format!("https://www.nexusmods.com/{}/mods", domain_value)));
                }
                configured_sources.push(serde_json::json!({
                    "id": source_id.clone(),
                    "displayName": display_name.unwrap_or_else(|| "Nexus Mods".to_string()),
                    "provider": "nexus",
                    "enabled": true,
                    "browseMode": browse_mode.clone().unwrap_or_else(|| "Built-in/API".to_string()),
                    "apiEnabled": item_any_field_value(item, &["API Enabled State"]).map(|value| !matches!(value.to_ascii_lowercase().as_str(), "disabled" | "no" | "off")).unwrap_or(true),
                    "apiKeySource": item_any_field_value(item, &["API Key Source"]).unwrap_or_else(|| "Global Settings".to_string()),
                    "gameName": game_name,
                    "providerSlug": domain,
                    "providerGameId": game_id,
                    "gamePageUrl": game_page_url,
                    "listingUrl": category_url,
                    "startUrl": start_url,
                    "allowedDomains": allowed_domains,
                    "captureDownloads": item_any_field_value(item, &["Capture Downloads"]).map(|value| !matches!(value.to_ascii_lowercase().as_str(), "disabled" | "no" | "off")).unwrap_or(true),
                }));
                let saved = configured_sources.last().expect("configured Nexus source");
                insert_config_string(&mut config, "nexusDomain", json_string(saved, "providerSlug"));
                insert_config_string(&mut config, "nexusGameId", json_string(saved, "providerGameId"));
                insert_config_string(&mut config, "nexusGamePageUrl", json_string(saved, "gamePageUrl"));
                insert_config_string(&mut config, "nexusCategoryUrl", json_string(saved, "listingUrl"));
                insert_config_string(&mut config, "nexusEmbeddedStartUrl", json_string(saved, "startUrl"));
                if !has_dedicated_nexus_browser
                    && browse_mode.as_deref().map(|mode| mode.to_ascii_lowercase()).map(|mode| !mode.contains("embedded") && !mode.contains("browser") && !mode.contains("webview") && !mode.contains("external")).unwrap_or(true)
                {
                    if let Some(browser_url) = item_any_field_value(item, &["Embedded Start URL"]).filter(|value| parse_nexus_game_url_fields(value).is_some()) {
                        recovered_nexus_browser = Some(serde_json::json!({
                            "id": format!("{}.browser", source_id),
                            "displayName": "Nexus Browser",
                            "provider": "nexus",
                            "enabled": true,
                            "browseMode": "webview_window",
                            "apiEnabled": false,
                            "apiKeySource": serde_json::Value::Null,
                            "gameName": game_name,
                            "providerSlug": domain,
                            "providerGameId": game_id,
                            "gamePageUrl": game_page_url,
                            "listingUrl": category_url,
                            "startUrl": browser_url,
                            "allowedDomains": allowed_domains,
                            "captureDownloads": item_any_field_value(item, &["Capture Downloads"]).map(|value| !matches!(value.to_ascii_lowercase().as_str(), "disabled" | "no" | "off")).unwrap_or(true),
                        }));
                    }
                }
            }
            "modworkshop" => {
                let source_id = item_any_field_value(item, &["Source Instance ID"])
                    .or_else(|| json_string(item, "id"))
                    .unwrap_or_else(|| format!("source-modworkshop-{}", configured_sources.len() + 1));
                let display_name = item_any_field_value(item, &["Display Name"]).or_else(|| item_title(item));
                let game_name = item_any_field_value(item, &["Human Game Name", "Selected ModWorkshop Game", "Selected Game", "Game Name", "Search ModWorkshop Games"]);
                let browse_mode = item_any_field_value(item, &["Browse Mode"]);
                let allowed_domains = split_source_list_value(item_any_field_value(item, &["Allowed Domains", "Allowed Domain"]));

                insert_config_string(&mut config, "modworkshopDisplayName", display_name.clone());
                insert_config_string(&mut config, "modworkshopGameName", game_name.clone());
                insert_config_string(&mut config, "modworkshopBrowseMode", browse_mode.clone());
                insert_config_array(&mut config, "modworkshopAllowedDomains", allowed_domains.clone());

                let mut slug = item_any_field_value(item, &["ModWorkshop Slug", "Slug", "Game Slug"])
                    .and_then(|value| clean_source_slug(&value))
                    .and_then(|value| normalize_modworkshop_game_route(&value).ok());
                let mut game_id = item_any_field_value(item, &["ModWorkshop Game ID", "Numeric ModWorkshop Game ID", "Game ID"]);
                if let Some(raw_id) = game_id.clone() {
                    if source_id_is_numeric(&raw_id) {
                        game_id = Some(raw_id.trim().to_string());
                    } else {
                        if slug.is_none() {
                            slug = clean_source_slug(&raw_id).and_then(|value| normalize_modworkshop_game_route(&value).ok());
                        }
                        game_id = None;
                    }
                }

                let mut game_page_url = item_any_field_value(item, &["ModWorkshop Game Page URL", "Game Page URL", "Page URL"]);
                let mut category_url = item_any_field_value(item, &["ModWorkshop Category URL", "Category URL", "Mods URL"]);
                let mut start_url = item_any_field_value(item, &["Embedded Start URL", "Start URL", "Starting Page URL"]);

                for candidate in [
                    game_page_url.clone(),
                    category_url.clone(),
                    start_url.clone(),
                    item_any_field_value(item, &["ModWorkshop Slug", "Slug", "Game Slug"]),
                    item_any_field_value(item, &["ModWorkshop Game ID", "Game ID"]),
                ]
                .into_iter()
                .flatten()
                {
                    if let Some((parsed_slug, parsed_game_id, parsed_url, is_category_url)) = parse_modworkshop_game_url_fields(&candidate) {
                        if let Some(value) = parsed_slug {
                            slug.get_or_insert(normalize_modworkshop_game_route(&value).unwrap_or(value));
                        }
                        if let Some(value) = parsed_game_id {
                            game_id.get_or_insert(value);
                        }
                        if is_category_url {
                            category_url.get_or_insert(parsed_url.clone());
                        } else {
                            game_page_url.get_or_insert(parsed_url.clone());
                        }
                        start_url.get_or_insert(parsed_url);
                    }
                }

                game_page_url = game_page_url.and_then(|value| parse_modworkshop_game_url_fields(&value).map(|parsed| parsed.2));
                category_url = category_url.and_then(|value| parse_modworkshop_game_url_fields(&value).map(|parsed| parsed.2));
                start_url = start_url.and_then(|value| parse_modworkshop_game_url_fields(&value).map(|parsed| parsed.2));

                if let Some(slug_value) = slug.clone() {
                    game_page_url.get_or_insert_with(|| format!("https://modworkshop.net/g/{}/mods", slug_value));
                    start_url.get_or_insert_with(|| category_url.clone().unwrap_or_else(|| format!("https://modworkshop.net/g/{}/mods", slug_value)));
                }
                configured_sources.push(serde_json::json!({
                    "id": source_id,
                    "displayName": display_name.unwrap_or_else(|| "ModWorkshop".to_string()),
                    "provider": "modworkshop",
                    "enabled": true,
                    "browseMode": browse_mode.unwrap_or_else(|| "Built-in/API".to_string()),
                    "apiEnabled": item_any_field_value(item, &["API Enabled State"]).map(|value| !matches!(value.to_ascii_lowercase().as_str(), "disabled" | "no" | "off")).unwrap_or(true),
                    "apiKeySource": item_any_field_value(item, &["API Key Source"]).unwrap_or_else(|| "Global Settings".to_string()),
                    "gameName": game_name,
                    "providerSlug": slug,
                    "providerGameId": game_id,
                    "gamePageUrl": game_page_url,
                    "listingUrl": category_url,
                    "startUrl": start_url,
                    "allowedDomains": allowed_domains,
                    "captureDownloads": item_any_field_value(item, &["Capture Downloads"]).map(|value| !matches!(value.to_ascii_lowercase().as_str(), "disabled" | "no" | "off")).unwrap_or(true),
                }));
                let saved = configured_sources.last().expect("configured ModWorkshop source");
                insert_config_string(&mut config, "modworkshopSlug", json_string(saved, "providerSlug"));
                insert_config_string(&mut config, "modworkshopGameId", json_string(saved, "providerGameId"));
                insert_config_string(&mut config, "modworkshopGamePageUrl", json_string(saved, "gamePageUrl"));
                insert_config_string(&mut config, "modworkshopCategoryUrl", json_string(saved, "listingUrl"));
                insert_config_string(&mut config, "modworkshopEmbeddedStartUrl", json_string(saved, "startUrl"));
            }
            "github" => {
                let source_id = item_any_field_value(item, &["Source Instance ID"])
                    .or_else(|| json_string(item, "id"))
                    .unwrap_or_else(|| format!("source-github-{}", configured_sources.len() + 1));
                let display_name = item_any_field_value(item, &["Display Name"])
                    .or_else(|| item_title(item))
                    .unwrap_or_else(|| "GitHub Releases".to_string());
                let repository_url = item_any_field_value(item, &["Repository URL", "GitHub URL", "Page URL"]);
                let parsed = repository_url.as_deref().and_then(parse_github_repository_url);
                let owner = item_any_field_value(item, &["Repository Owner", "GitHub Owner"])
                    .and_then(|value| github_repository_component(&value))
                    .or_else(|| parsed.as_ref().map(|value| value.0.clone()));
                let repository = item_any_field_value(item, &["Repository Name", "GitHub Repository"])
                    .and_then(|value| github_repository_component(&value))
                    .or_else(|| parsed.as_ref().map(|value| value.1.clone()));
                let browse_mode = item_any_field_value(item, &["Browse Mode"]).unwrap_or_else(|| "Built-in/API".to_string());
                let allowed_domains = split_source_list_value(item_any_field_value(item, &["Allowed Domains", "Allowed Domain"]));
                let canonical_url = owner.as_ref().zip(repository.as_ref()).map(|(owner, repository)| format!("https://github.com/{}/{}", owner, repository));
                let start_url = item_any_field_value(item, &["Embedded Start URL", "Start URL", "Starting Page URL"])
                    .or_else(|| canonical_url.clone());

                configured_sources.push(serde_json::json!({
                    "id": source_id,
                    "displayName": display_name,
                    "provider": "github",
                    "enabled": true,
                    "browseMode": browse_mode,
                    "apiEnabled": true,
                    "apiKeySource": serde_json::Value::Null,
                    "gameName": item_any_field_value(item, &["Human Game Name", "Game Name"]),
                    "providerSlug": owner,
                    "providerGameId": repository,
                    "gamePageUrl": canonical_url,
                    "listingUrl": serde_json::Value::Null,
                    "startUrl": start_url,
                    "allowedDomains": if allowed_domains.is_empty() { vec!["github.com".to_string(), "api.github.com".to_string(), "objects.githubusercontent.com".to_string()] } else { allowed_domains },
                    "captureDownloads": item_any_field_value(item, &["Capture Downloads"]).map(|value| !matches!(value.to_ascii_lowercase().as_str(), "disabled" | "no" | "off")).unwrap_or(true),
                }));
            }
            "embedded" | "custom_browser" => {
                config.insert("customBrowser".to_string(), serde_json::Value::Bool(true));
                let display_name = item_any_field_value(item, &["Display Name"])
                    .or_else(|| item_title(item))
                    .unwrap_or_else(|| "Custom Browser".to_string());
                let mut start_url = item_any_field_value(item, &["Starting Page URL", "Start URL", "Base URL"]);
                let allowed_domains = split_source_list_value(item_any_field_value(item, &["Allowed Domains", "Allowed Domain"]));
                let current_game_patterns = split_source_list_value(item_any_field_value(item, &["Current-Game URL Patterns", "Game-Page Validation", "Game Page Validation"]));
                let download_capture_rules = split_source_list_value(item_any_field_value(item, &["Download Capture", "Download Capture Rules"]));
                let auth_requirement = item_any_field_value(item, &["Login Required", "Authentication Requirement"]);
                let cross_game_protection = item_any_field_value(item, &["Cross-Game Protection"]);

                let provider = start_url.as_deref().and_then(parse_http_source_url).and_then(|url| {
                    if source_host_matches(&url, "nexusmods.com") { Some("nexus") }
                    else if source_host_matches(&url, "modworkshop.net") { Some("modworkshop") }
                    else if source_host_matches(&url, "github.com") { Some("github") }
                    else { None }
                }).unwrap_or("custom");
                if provider == "modworkshop" {
                    start_url = start_url.and_then(|value| parse_modworkshop_game_url_fields(&value).map(|parsed| parsed.2));
                }

                if config.get("customBrowserStartUrl").is_none() {
                    if let Some(value) = start_url.clone() {
                        config.insert("customBrowserStartUrl".to_string(), serde_json::Value::String(value));
                    }
                }
                if config.get("customBrowserAllowedDomains").is_none() && !allowed_domains.is_empty() {
                    config.insert("customBrowserAllowedDomains".to_string(), serde_json::json!(allowed_domains.clone()));
                }

                custom_sources.push(serde_json::json!({
                    "id": item_any_field_value(item, &["Source Instance ID"]).unwrap_or_else(|| display_name.to_ascii_lowercase().replace(' ', "_")),
                    "sourceType": source_type_from_item(item),
                    "displayName": display_name.clone(),
                    "startUrl": start_url.clone(),
                    "allowedDomains": allowed_domains.clone(),
                    "currentGameUrlPatterns": current_game_patterns,
                    "downloadCaptureRules": download_capture_rules.clone(),
                    "authenticationRequirement": auth_requirement,
                    "crossGameProtection": cross_game_protection,
                }));
                configured_sources.push(serde_json::json!({
                    "id": item_any_field_value(item, &["Source Instance ID"]).or_else(|| json_string(item, "id")).unwrap_or_else(|| format!("source-browser-{}", configured_sources.len() + 1)),
                    "displayName": display_name,
                    "provider": provider,
                    "enabled": true,
                    "browseMode": "webview_window",
                    "gameName": item_any_field_value(item, &["Human Game Name", "Game Name"]),
                    "providerSlug": serde_json::Value::Null,
                    "providerGameId": serde_json::Value::Null,
                    "gamePageUrl": start_url.clone(),
                    "listingUrl": serde_json::Value::Null,
                    "startUrl": start_url,
                    "allowedDomains": allowed_domains,
                    "captureDownloads": !download_capture_rules.is_empty(),
                }));
            }
            _ => {}
        }
    }

    if let Some(source) = recovered_nexus_browser {
        configured_sources.push(source);
    }

    if !custom_sources.is_empty() {
        config.insert("customBrowserSources".to_string(), serde_json::Value::Array(custom_sources));
    }
    if !configured_sources.is_empty() {
        config.insert("sources".to_string(), serde_json::Value::Array(configured_sources));
    }

    serde_json::Value::Object(config)
}
fn merge_source_config(profile: &serde_json::Value, draft: Option<&serde_json::Value>) -> serde_json::Value {
    let mut config = profile
        .get("sourceConfig")
        .cloned()
        .filter(|value| value.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    if let Some(defaults) = json_string(profile, "profileId")
        .as_deref()
        .and_then(builtin_profile_source_config)
        .and_then(|value| value.as_object().cloned())
    {
            let target = config.as_object_mut().expect("source config object");
            for (key, value) in defaults {
                if key == "sources" {
                    target.insert(key, value);
                } else {
                    target.entry(key).or_insert(value);
                }
            }
    }
    if let Some(draft_config) = draft.map(source_config_from_draft).and_then(|value| value.as_object().cloned()) {
        let target = config.as_object_mut().expect("source config object");
        for (key, value) in draft_config {
            target.entry(key).or_insert(value);
        }
    }
    config
}
fn source_names_from_config(config: &serde_json::Value, draft: Option<&serde_json::Value>) -> Vec<String> {
    if let Some(configured) = config.get("sources").and_then(|value| value.as_array()) {
        let exact = configured
            .iter()
            .filter(|source| source.get("enabled").and_then(|value| value.as_bool()).unwrap_or(true))
            .filter_map(|source| json_string(source, "id"))
            .collect::<Vec<_>>();
        if !exact.is_empty() {
            return exact;
        }
    }
    let mut sources = Vec::new();
    if config.get("modworkshopGameId").is_some()
        || config.get("modworkshopSlug").is_some()
        || config.get("modworkshopGamePageUrl").is_some()
        || config.get("modworkshopEmbeddedStartUrl").is_some()
    {
        sources.push("modworkshop".to_string());
    }
    if config.get("nexusDomain").is_some()
        || config.get("nexusGameId").is_some()
        || config.get("nexusGamePageUrl").is_some()
        || config.get("nexusEmbeddedStartUrl").is_some()
    {
        sources.push("nexus".to_string());
    }
    if config.get("customBrowser").and_then(|value| value.as_bool()).unwrap_or(false) || config.get("customBrowserStartUrl").is_some() || config.get("customBrowserSources").and_then(|value| value.as_array()).map(|items| !items.is_empty()).unwrap_or(false) { sources.push("custom_browser".to_string()); }
    if let Some(draft) = draft { for item in draft_section_items(draft, "sources") { if json_bool(item, "enabled") == Some(false) { continue; } let source_type = source_type_from_item(item); if !sources.iter().any(|source| source == &source_type) { sources.push(source_type); } } }
    sources
}
fn source_config_for_profile_id(profile_id: Option<&str>) -> serde_json::Value {
    let mut config = source_config_for_profile_id_unversioned(profile_id);
    apply_profile_game_version(&mut config, profile_id.unwrap_or(BUILTIN_PAYDAY3_PROFILE_ID));
    config
}

fn apply_profile_game_version(config: &mut serde_json::Value, profile_id: &str) {
    let payday3_source = modworkshop_game_route_from_source_config(config)
        .and_then(|route| normalize_modworkshop_game_route(&route).ok())
        .map(|route| route == MODWORKSHOP_PAYDAY3_GAME_ID)
        .unwrap_or(false);
    if profile_id != BUILTIN_PAYDAY3_PROFILE_ID && !payday3_source { return; }
    let version = modworkshop_profile_game_version(Some(profile_id), MODWORKSHOP_PAYDAY3_GAME_ID).unwrap_or_else(|| "UE5.5".to_string());
    config["gameVersion"] = serde_json::json!(version);
    if let Some(sources) = config.get_mut("sources").and_then(|value| value.as_array_mut()) {
        for source in sources { source["gameVersion"] = serde_json::json!(version); }
    }
}

fn source_config_for_profile_id_unversioned(profile_id: Option<&str>) -> serde_json::Value {
    let Some(profile_id) = profile_id else {
        return builtin_payday3_source_config();
    };
    let Ok(clean) = clean_profile_id(profile_id) else {
        return serde_json::json!({});
    };
    if let Ok(draft) = read_game_profile_draft(&clean) {
        let mut config = source_config_from_draft(&draft);
        if let Some(defaults) = builtin_profile_source_config(&clean).and_then(|value| value.as_object().cloned()) {
                let target = config.as_object_mut().expect("source config object");
                for (key, value) in defaults {
                    if key == "sources" {
                        target.insert(key, value);
                    } else {
                        target.entry(key).or_insert(value);
                    }
                }
        }
        return config;
    }
    builtin_profile_source_config(&clean).unwrap_or_else(|| serde_json::json!({}))
}

fn source_config_for_profile_source(profile_id: Option<&str>, source_id: Option<&str>) -> serde_json::Value {
    let mut config = source_config_for_profile_id(profile_id);
    let Some(source_id) = source_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return config;
    };
    let selected = config
        .get("sources")
        .and_then(|value| value.as_array())
        .and_then(|sources| sources.iter().find(|source| json_string(source, "id").as_deref() == Some(source_id)))
        .cloned();
    let Some(selected) = selected else {
        return config;
    };
    let provider = json_string(&selected, "provider").unwrap_or_default();
    let target = config.as_object_mut().expect("source config object");
    target.insert("selectedSourceId".to_string(), serde_json::Value::String(source_id.to_string()));
    match provider.as_str() {
        "nexus" => {
            for (from, to) in [
                ("displayName", "nexusDisplayName"),
                ("gameName", "nexusGameName"),
                ("providerSlug", "nexusDomain"),
                ("providerGameId", "nexusGameId"),
                ("gamePageUrl", "nexusGamePageUrl"),
                ("listingUrl", "nexusCategoryUrl"),
                ("startUrl", "nexusEmbeddedStartUrl"),
                ("browseMode", "nexusBrowseMode"),
            ] {
                if let Some(value) = selected.get(from).cloned().filter(|value| !value.is_null()) {
                    target.insert(to.to_string(), value);
                }
            }
        }
        "modworkshop" => {
            for (from, to) in [
                ("displayName", "modworkshopDisplayName"),
                ("gameName", "modworkshopGameName"),
                ("providerSlug", "modworkshopSlug"),
                ("providerGameId", "modworkshopGameId"),
                ("gamePageUrl", "modworkshopGamePageUrl"),
                ("listingUrl", "modworkshopCategoryUrl"),
                ("startUrl", "modworkshopEmbeddedStartUrl"),
                ("browseMode", "modworkshopBrowseMode"),
            ] {
                if let Some(value) = selected.get(from).cloned().filter(|value| !value.is_null()) {
                    target.insert(to.to_string(), value);
                }
            }
        }
        _ => {}
    }
    config
}

fn config_string(config: &serde_json::Value, key: &str) -> Option<String> {
    json_string(config, key)
}

fn configured_provider_source<'a>(config: &'a serde_json::Value, provider: &str) -> Option<&'a serde_json::Value> {
    if let Some(selected_id) = config.get("selectedSourceId").and_then(|value| value.as_str()) {
        if let Some(selected) = config.get("sources")?.as_array()?.iter().find(|source| {
            json_string(source, "id").as_deref() == Some(selected_id)
                && json_string(source, "provider").as_deref() == Some(provider)
                && source.get("enabled").and_then(|value| value.as_bool()) != Some(false)
        }) {
            return Some(selected);
        }
    }
    config.get("sources")?.as_array()?.iter().find(|source| {
        json_string(source, "provider").as_deref() == Some(provider)
            && source.get("enabled").and_then(|value| value.as_bool()) != Some(false)
    })
}

fn nexus_domain_from_source_config(config: &serde_json::Value) -> Option<String> {
    configured_provider_source(config, "nexus")
        .and_then(|source| json_string(source, "providerSlug"))
        .and_then(|value| clean_source_slug(&value))
        .or_else(|| config_string(config, "nexusDomain").and_then(|value| clean_source_slug(&value)))
        .or_else(|| config_string(config, "nexusGamePageUrl").and_then(|value| parse_nexus_game_url_fields(&value).map(|parsed| parsed.0)))
        .or_else(|| config_string(config, "nexusCategoryUrl").and_then(|value| parse_nexus_game_url_fields(&value).map(|parsed| parsed.0)))
        .or_else(|| config_string(config, "nexusEmbeddedStartUrl").and_then(|value| parse_nexus_game_url_fields(&value).map(|parsed| parsed.0)))
        .or_else(|| {
            config_string(config, "nexusGameId")
                .filter(|value| !source_id_is_numeric(value))
                .and_then(|value| clean_source_slug(&value))
        })
}

fn modworkshop_game_route_from_source_config(config: &serde_json::Value) -> Option<String> {
    configured_provider_source(config, "modworkshop")
        .and_then(|source| json_string(source, "providerSlug").or_else(|| json_string(source, "providerGameId")))
        .or_else(|| config_string(config, "modworkshopSlug").and_then(|value| clean_source_slug(&value)))
        .or_else(|| config_string(config, "modworkshopGamePageUrl").and_then(|value| parse_modworkshop_game_url_fields(&value).and_then(|parsed| parsed.0.or(parsed.1))))
        .or_else(|| config_string(config, "modworkshopCategoryUrl").and_then(|value| parse_modworkshop_game_url_fields(&value).and_then(|parsed| parsed.0.or(parsed.1))))
        .or_else(|| config_string(config, "modworkshopEmbeddedStartUrl").and_then(|value| parse_modworkshop_game_url_fields(&value).and_then(|parsed| parsed.0.or(parsed.1))))
        .or_else(|| config_string(config, "modworkshopGameId").and_then(|value| {
            if source_id_is_numeric(&value) {
                Some(value.trim().to_string())
            } else {
                clean_source_slug(&value)
            }
        }))
        .and_then(|value| normalize_modworkshop_game_route(&value).ok())
}
fn collect_section_titles(draft: Option<&serde_json::Value>, section: &str) -> Vec<String> { draft.map(|draft| draft_section_items(draft, section).into_iter().filter_map(item_title).collect()).unwrap_or_default() }
fn draft_named_path_values(draft: Option<&serde_json::Value>) -> Vec<String> { let Some(draft) = draft else { return Vec::new(); }; let mut values = Vec::new(); for item in draft_section_items(draft, "pathsLaunch") { for label in ["Path", "Destination", "Root", "Game Root", "Working Directory", "Executable"] { if let Some(value) = item_field_value(item, label) { if !values.iter().any(|existing: &String| existing == &value) { values.push(value); } } } } values }
fn draft_executable(draft: Option<&serde_json::Value>) -> Option<String> { let draft = draft?; draft_section_items(draft, "pathsLaunch").into_iter().find_map(|item| item_field_value(item, "Executable")).or_else(|| draft_section_items(draft, "detectionStores").into_iter().find_map(|item| item_field_value(item, "Expected executable"))) }
fn draft_game_root(draft: Option<&serde_json::Value>) -> Option<String> { let draft = draft?; draft.get("customTest").and_then(|custom| json_string(custom, "sampleGameRoot")).or_else(|| draft_section_items(draft, "pathsLaunch").into_iter().find_map(|item| item_field_value(item, "Game Root").or_else(|| item_field_value(item, "Root Folder")))) }
fn profile_executable_from_root(profile_id: &str, game_root: &Path) -> Option<PathBuf> {
    profile_installs::builtin_profile_executable_markers(profile_id)
        .iter()
        .map(|marker| game_root.join(marker))
        .find(|path| path.is_file())
}

fn resolve_profile_executable(profile_id: &str, game_root: Option<&str>, draft: Option<&serde_json::Value>, override_path: Option<String>) -> Option<String> {
    if let Some(path) = override_path.map(PathBuf::from).filter(|path| path.is_file()) {
        return Some(path.display().to_string());
    }
    if let Some(raw) = draft_executable(draft) {
        let path = PathBuf::from(&raw);
        let resolved = if path.is_absolute() { path } else if let Some(root) = game_root { PathBuf::from(root).join(path) } else { path };
        if resolved.is_file() { return Some(resolved.display().to_string()); }
    }
    game_root
        .map(PathBuf::from)
        .and_then(|root| profile_executable_from_root(profile_id, &root))
        .or_else(|| profile_installs::detected_builtin_launch_executable(profile_id))
        .map(|path| path.display().to_string())
}
fn runtime_revision_for_profile(profile_id: &str) -> u64 { game_profile_draft_path(profile_id).ok().and_then(|path| fs::metadata(path).ok()).and_then(|metadata| metadata.modified().ok()).and_then(system_time_unix).unwrap_or_else(now_unix_seconds) }
fn runtime_for_game_profile(profile_id: &str, profile: &serde_json::Value) -> Result<ActiveProfileRuntimeWire, String> {
    let clean = clean_profile_id(profile_id)?;
    let storage = ensure_profile_data_dirs(&clean)?;
    let builtin_draft = profile_installs::builtin_install_definition(&clean, profile_installs::detected_builtin_game_root(&clean).as_deref());
    let loaded_draft = read_game_profile_draft(&clean).ok();
    let draft = builtin_draft.as_ref().or_else(|| profile.get("draft").filter(|value| value.is_object())).or(loaded_draft.as_ref());
    let profile_settings = load_profile_settings_internal(&clean);
    let display_name = json_string(profile, "displayName").or_else(|| draft.and_then(|draft| draft_overview_string(draft, "gameName"))).unwrap_or_else(|| if is_builtin_payday3_profile(Some(&clean)) { "PAYDAY 3".to_string() } else { clean.clone() });
    let game_id = json_string(profile, "gameKey").or_else(|| draft.and_then(|draft| draft_overview_string(draft, "gameKey"))).unwrap_or_else(|| clean.clone());
    let mut source_config = merge_source_config(profile, draft);
    apply_profile_game_version(&mut source_config, &clean);
    let payday_paths = if is_builtin_payday3_profile(Some(&clean)) { detect_payday3_paths_internal() } else { None };
    let detected_root = profile_installs::detected_builtin_game_root(&clean);
    let game_root = profile_settings.game_root_override.clone()
        .or_else(|| payday_paths.as_ref().map(|paths| paths.game_root.display().to_string()))
        .or_else(|| profile.get("installation").and_then(|value| json_string(value, "gameRoot")))
        .or_else(|| detected_root.as_ref().map(|path| path.display().to_string()))
        .or_else(|| draft_game_root(draft));
    let executable = profile_settings.executable_override.clone()
        .or_else(|| payday_paths.as_ref().and_then(|paths| payday_exe_candidates(paths).into_iter().find(|exe| exe.is_file())).map(|exe| exe.display().to_string()))
        .or_else(|| resolve_profile_executable(&clean, game_root.as_deref(), draft, None));
    let loaded_receipt_count = profile_installs::list_profile_receipts_internal(&clean).map(|receipts| receipts.len()).unwrap_or(0);
    let loaded_installed_mod_count = if is_builtin_payday3_profile(Some(&clean)) {
        list_installed_state_records_internal().map(|records| records.len()).unwrap_or(0)
    } else {
        profile_installs::sync_profile_installed_state(&clean).map(|records| records.len()).unwrap_or(0)
    };
    Ok(ActiveProfileRuntimeWire { profile_id: clean, definition_revision: runtime_revision_for_profile(profile_id), game_id, game_name: display_name, game_root, executable, named_paths: draft_named_path_values(draft), sources: source_names_from_config(&source_config, draft), source_config, mod_types: collect_section_titles(draft, "modTypes"), install_rules: collect_section_titles(draft, "installBehavior"), toggle_rules: collect_section_titles(draft, "enableDisable"), dependencies: collect_section_titles(draft, "dependencies"), conflict_rules: collect_section_titles(draft, "conflicts"), storage_path: storage.display().to_string(), installed_state_path: storage.join("installed-state").join("installed-state.json").display().to_string(), receipts_path: storage.join("receipts").display().to_string(), backups_path: storage.join("backups").display().to_string(), disabled_state_path: storage.join("disabled-state").join("disabled-state.json").display().to_string(), browse_cache_path: storage.join("cache").join("browse").display().to_string(), thumbnail_cache_path: storage.join("cache").join("thumbnails").display().to_string(), source_index_path: storage.join("source-index").join("source-index.json").display().to_string(), dependency_state_path: storage.join("dependencies").join("dependency-state.json").display().to_string(), setup_state_path: storage.join("setup").join("setup-state.json").display().to_string(), launch_configuration: serde_json::json!({ "arguments": profile_settings.launch_arguments, "workingDirectory": profile_settings.working_directory_override, "environment": profile_settings.launch_environment }), loaded_receipt_count, loaded_installed_mod_count, ready: true, error: None })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileLaunchMapping {
    profile_id: String,
    game_root: String,
    executable: String,
    working_directory: String,
    arguments: Vec<String>,
    vanilla_supported: bool,
    vanilla_scope: String,
}

fn split_launch_arguments(value: &str) -> Vec<String> {
    let mut arguments = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for character in value.chars() {
        match character {
            '"' => quoted = !quoted,
            value if value.is_whitespace() && !quoted => {
                if !current.is_empty() { arguments.push(std::mem::take(&mut current)); }
            }
            value => current.push(value),
        }
    }
    if !current.is_empty() { arguments.push(current); }
    arguments
}

fn profile_launch_mapping_internal(profile_id: &str) -> Result<ProfileLaunchMapping, String> {
    let profile_id = clean_profile_id(profile_id)?;
    if is_builtin_payday3_profile(Some(&profile_id)) {
        let paths = detect_payday3_paths_internal().ok_or_else(|| "PAYDAY 3 is not installed in a detected library.".to_string())?;
        let executable = payday_exe_candidates(&paths).into_iter().find(|exe| exe.is_file())
            .ok_or_else(|| "No PAYDAY 3 shipping executable was found in the selected game folder.".to_string())?;
        return Ok(ProfileLaunchMapping { profile_id, game_root: paths.game_root.display().to_string(), working_directory: paths.win64.display().to_string(), executable: executable.display().to_string(), arguments: Vec::new(), vanilla_supported: true, vanilla_scope: "Temporarily disables PAYDAY 3 mod folders and restores them after exit.".to_string() });
    }

    let settings = load_profile_settings_internal(&profile_id);
    let draft = read_game_profile_draft(&profile_id).ok();
    let game_root = settings.game_root_override.clone().map(PathBuf::from).filter(|path| path.is_dir())
        .or_else(|| profile_installs::detected_builtin_game_root(&profile_id))
        .or_else(|| draft_game_root(draft.as_ref()).map(PathBuf::from).filter(|path| path.is_dir()))
        .ok_or_else(|| format!("{} is not installed in a detected Steam library. Choose its game folder in Profile Settings.", profile_id))?;
    let executable = resolve_profile_executable(&profile_id, game_root.to_str(), draft.as_ref(), settings.executable_override.clone())
        .map(PathBuf::from).filter(|path| path.is_file())
        .ok_or_else(|| format!("No mapped launch executable was found for {} in {}.", profile_id, game_root.display()))?;
    let working_directory = settings.working_directory_override.clone().map(PathBuf::from).filter(|path| path.is_dir())
        .or_else(|| executable.parent().map(PathBuf::from)).unwrap_or_else(|| game_root.clone());
    Ok(ProfileLaunchMapping { profile_id, game_root: game_root.display().to_string(), executable: executable.display().to_string(), working_directory: working_directory.display().to_string(), arguments: split_launch_arguments(&settings.launch_arguments), vanilla_supported: true, vanilla_scope: "Temporarily disables Tsuki receipt-owned files only and restores their prior state after exit.".to_string() })
}

#[tauri::command]
fn get_profile_launch_mapping(profile_id: String) -> Result<ProfileLaunchMapping, String> { profile_launch_mapping_internal(&profile_id) }

fn launch_mapped_profile(profile_id: String, vanilla: bool) -> Result<String, String> {
    if is_builtin_payday3_profile(Some(&profile_id)) { return launch_payday3_with_mode(!vanilla); }
    let mapping = profile_launch_mapping_internal(&profile_id)?;
    if profile_id == managed_loaders::PROFILE {
        managed_loaders::prepare_launch(Path::new(&mapping.game_root), vanilla)?;
    }
    let previously_enabled = if vanilla {
        let enabled = profile_installs::enabled_profile_receipt_ids(&mapping.profile_id)?;
        profile_installs::apply_profile_receipt_selection(&mapping.profile_id, &[])?;
        enabled
    } else { Vec::new() };
    let settings = load_profile_settings_internal(&mapping.profile_id);
    let mut command = Command::new(&mapping.executable);
    command.current_dir(&mapping.working_directory).args(&mapping.arguments);
    for entry in settings.launch_environment {
        if let Some((key, value)) = entry.split_once('=') {
            let key = key.trim();
            if !key.is_empty() { command.env(key, value.trim()); }
        }
    }
    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            if vanilla { let _ = profile_installs::apply_profile_receipt_selection(&mapping.profile_id, &previously_enabled); }
            return Err(format!("Failed to launch {}: {}", mapping.executable, error));
        }
    };
    if vanilla {
        let restore_profile_id = mapping.profile_id.clone();
        std::thread::spawn(move || {
            let mut child = child;
            let _ = child.wait();
            let _ = profile_installs::apply_profile_receipt_selection(&restore_profile_id, &previously_enabled);
        });
    }
    Ok(if vanilla { format!("Launched {} in vanilla mode. Tsuki-owned mod files will be restored after the game exits.", mapping.executable) } else { format!("Launched {} with the profile's current mod state.", mapping.executable) })
}

#[tauri::command]
async fn launch_active_profile_vanilla(profile_id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || launch_mapped_profile(profile_id, true)).await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn launch_active_profile_modded(profile_id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || launch_mapped_profile(profile_id, false)).await.map_err(|error| error.to_string())?
}

#[tauri::command]
fn activate_game_profile_runtime(profile_id: String, profile: serde_json::Value) -> Result<ActiveProfileRuntimeWire, String> { let clean = clean_profile_id(&profile_id)?; let runtime = runtime_for_game_profile(&clean, &profile)?; let mut settings = load_settings_internal(); settings.current_game_profile_id = Some(clean.clone()); settings.active_game_profile_id = Some(clean); save_settings_internal(&settings)?; Ok(runtime) }

fn open_game_profile_draft_runtime_internal(profile_id: String, draft: serde_json::Value, preview_setup: bool) -> Result<ProfileRuntimeOpenResult, String> {
    let clean = clean_profile_id(&profile_id)?;
    let saved = save_game_profile_draft_value(&clean, draft)?;
    let runtime = runtime_for_game_profile(&clean, &serde_json::json!({ "profileId": clean, "draft": saved }))?;
    let storage = PathBuf::from(&runtime.storage_path);
    let draft_path = game_profile_draft_path(&runtime.profile_id)?;
    Ok(ProfileRuntimeOpenResult { profile_id: runtime.profile_id.clone(), storage_path: runtime.storage_path, profile_path: storage.join("profile.json").display().to_string(), draft_path: draft_path.display().to_string(), setup_state_path: runtime.setup_state_path, index_path: runtime.source_index_path, test_workspace_path: storage.join("test-workspace").display().to_string(), blocking: Vec::new(), warnings: Vec::new(), revision: runtime.definition_revision, opened_at_unix: now_unix_seconds(), preview_setup })
}

#[tauri::command]
fn open_game_profile_draft_runtime(profile_id: String, draft: serde_json::Value) -> Result<ProfileRuntimeOpenResult, String> { open_game_profile_draft_runtime_internal(profile_id, draft, false) }
#[tauri::command]
fn preview_game_profile_setup(profile_id: String, draft: serde_json::Value) -> Result<ProfileRuntimeOpenResult, String> { open_game_profile_draft_runtime_internal(profile_id, draft, true) }

#[tauri::command]
fn run_profile_creator_test_action(profile_id: String, draft: serde_json::Value, section: Option<String>, label: String) -> Result<ProfileCreatorRuntimeTestResult, String> {
    let sample = draft.get("customTest").and_then(|value| json_string(value, "sampleArchive"));
    let saved = save_game_profile_draft_value(&profile_id, draft)?;
    let runtime = runtime_for_game_profile(&profile_id, &serde_json::json!({ "profileId": profile_id, "draft": saved }))?;
    let mut warnings = Vec::new();

    let mut errors = Vec::new();
    let mut actions = vec!["Saved draft snapshot".to_string(), "Built isolated profile runtime".to_string()];
    let mut technical_details = vec![format!("Profile runtime revision {}", runtime.definition_revision)];
    let lower_label = label.to_ascii_lowercase();
    let analysis_supported = (lower_label.contains("install") || lower_label.contains("archive") || lower_label.contains("file") || lower_label.contains("folder") || lower_label.contains("recognition"))
        && !["enable", "disable", "rollback", "uninstall", "update"].iter().any(|action| lower_label.contains(action));
    if analysis_supported {
        if let Some(sample) = sample.filter(|value| !value.trim().is_empty()) {
            match profile_installs::analyze_drag_drop_install(vec![sample], profile_id.clone()) {
                Ok(analysis) => {
                    let value = serde_json::to_value(analysis).map_err(|error| error.to_string())?;
                    technical_details.push(serde_json::to_string_pretty(&value).map_err(|error| error.to_string())?);
                    if let Some(items) = value.get("items").and_then(|value| value.as_array()) {
                        for item in items {
                            if item.get("blocked").and_then(|value| value.as_bool()).unwrap_or(true) {
                                errors.push("Sample install analysis is blocked. Review the destination and dependency diagnostics.".to_string());
                            }
                            if let Some(items) = item.get("warnings").and_then(|value| value.as_array()) {
                                warnings.extend(items.iter().filter_map(|value| value.as_str().map(str::to_string)));
                            }
                        }
                    }
                    actions.push("Analyzed sample files, destination safety, dependencies, and conflicts without installing".to_string());
                }
                Err(error) => errors.push(error),
            }
        } else {
            warnings.push("Select a sample file or archive before running this check.".to_string());
        }
    } else {
        warnings.push(format!("{} was not executed. Runtime validation alone does not verify this behavior.", label));
    }
    if runtime.game_root.is_none() { errors.push("No game root is configured yet.".to_string()); }
    Ok(ProfileCreatorRuntimeTestResult {
        status: if !errors.is_empty() { "Failed" } else if !warnings.is_empty() { "Warning" } else { "Passed" }.to_string(),
        what_was_tested: label.clone(),
        input_used: vec![section.unwrap_or_else(|| "profile".to_string()), label],
        resolved_paths: vec![runtime.storage_path, runtime.setup_state_path, runtime.source_index_path],
        actions, warnings, errors, technical_details,
        profile_revision: runtime.definition_revision, outdated: false,
    })
}
fn managed_artwork_dir(profile_id: &str) -> Result<PathBuf, String> { let dir = profile_data_dir_for(profile_id)?.join("artwork"); fs::create_dir_all(&dir).map_err(|err| format!("Failed to create profile artwork folder {}: {}", dir.display(), err))?; Ok(dir) }
fn profile_image_reference(kind: &str, value: String) -> ProfileImageReferenceWire { ProfileImageReferenceWire { kind: kind.to_string(), value, updated_at: current_timestamp() } }
fn artwork_extension_from_mime(mime: &str) -> Option<&'static str> {
    let lower = mime.to_ascii_lowercase();
    if lower.contains("png") {
        Some("png")
    } else if lower.contains("webp") {
        Some("webp")
    } else if lower.contains("jpeg") || lower.contains("jpg") {
        Some("jpg")
    } else {
        None
    }
}

fn validate_profile_artwork_path(path: &Path) -> Result<&'static str, String> {
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => Ok("png"),
        "jpg" | "jpeg" => Ok("jpg"),
        "webp" => Ok("webp"),
        _ => Err("Profile artwork must be a PNG, JPG, JPEG, or WEBP image.".to_string()),
    }
}

#[tauri::command]
fn save_profile_artwork_data_url(profile_id: String, data_url: String) -> Result<ProfileArtworkImportResult, String> {
    let clean = clean_profile_id(&profile_id)?;
    let Some((header, payload)) = data_url.split_once(',') else {
        return Err("Image data URL is invalid.".to_string());
    };
    if !header.starts_with("data:image/") {
        return Err("Only image data URLs can be saved as profile artwork.".to_string());
    }
    let ext = artwork_extension_from_mime(header)
        .ok_or_else(|| "Profile artwork must be a PNG, JPG, JPEG, or WEBP image.".to_string())?;
    let bytes = general_purpose::STANDARD
        .decode(payload.as_bytes())
        .map_err(|err| format!("Failed to decode image data URL: {}", err))?;
    let managed = managed_artwork_dir(&clean)?.join(format!("artwork-{}.{}", current_timestamp(), ext));
    fs::write(&managed, bytes)
        .map_err(|err| format!("Failed to save profile artwork {}: {}", managed.display(), err))?;
    let managed_path = managed.display().to_string();
    Ok(ProfileArtworkImportResult { image_reference: profile_image_reference("managed_local", managed_path.clone()), source_path: "clipboard/data-url".to_string(), source_exists: true, managed_path: managed_path.clone(), managed_exists: managed.exists() })
}

#[tauri::command]
fn import_profile_artwork_image(profile_id: String, source_path: String) -> Result<ProfileArtworkImportResult, String> {
    let clean = clean_profile_id(&profile_id)?;
    let source = PathBuf::from(source_path.trim());
    let source_exists = source.exists();
    if !source_exists || !source.is_file() {
        return Err(format!("Profile artwork file was not found: {}", source.display()));
    }
    validate_profile_artwork_path(&source)?;
    File::open(&source)
        .map_err(|err| format!("Profile artwork file could not be read {}: {}", source.display(), err))?;
    let file_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("artwork.png");
    let managed = managed_artwork_dir(&clean)?.join(format!("{}-{}", current_timestamp(), sanitize_file_component(file_name)));
    fs::copy(&source, &managed)
        .map_err(|err| format!("Failed to import profile artwork {}: {}", source.display(), err))?;
    let managed_path = managed.display().to_string();
    Ok(ProfileArtworkImportResult { image_reference: profile_image_reference("managed_local", managed_path.clone()), source_path: source.display().to_string(), source_exists, managed_path: managed_path.clone(), managed_exists: managed.exists() })
}

#[tauri::command]
fn resolve_profile_artwork_image_src(profile_id: String, path: String) -> Result<ProfileArtworkResolveResult, String> {
    let clean = clean_profile_id(&profile_id)?;
    let managed_root = managed_artwork_dir(&clean)?;
    let managed_root = fs::canonicalize(&managed_root)
        .map_err(|err| format!("Failed to resolve managed artwork folder {}: {}", managed_root.display(), err))?;
    let source = PathBuf::from(path.trim());
    let source_exists = source.is_file();
    if !source_exists {
        return Err(format!("Managed profile artwork was not found: {}", source.display()));
    }
    let source = fs::canonicalize(&source)
        .map_err(|err| format!("Failed to resolve managed profile artwork {}: {}", source.display(), err))?;
    if !source.starts_with(&managed_root) {
        return Err(format!("Profile artwork is outside the managed profile directory: {}", source.display()));
    }
    let bytes = fs::read(&source)
        .map_err(|err| format!("Failed to read managed profile artwork {}: {}", source.display(), err))?;
    if bytes.len() > 12 * 1024 * 1024 {
        return Err("Profile artwork must be 12 MB or smaller.".to_string());
    }
    let mime = match source.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ if bytes.starts_with(&[0x89, b'P', b'N', b'G']) => "image/png",
        _ if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) => "image/jpeg",
        _ if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") => "image/webp",
        _ => return Err("Managed profile artwork is not a supported PNG, JPG, JPEG, or WEBP image.".to_string()),
    };
    let byte_length = bytes.len();
    Ok(ProfileArtworkResolveResult {
        final_src: format!("data:{};base64,{}", mime, general_purpose::STANDARD.encode(bytes)),
        source_path: source.display().to_string(),
        source_exists,
        managed_root: managed_root.display().to_string(),
        resolver: "managed_data_url".to_string(),
        byte_length,
    })
}

#[tauri::command]
fn cache_profile_artwork_remote_url(profile_id: String, url: String) -> Result<ProfileArtworkImportResult, String> { let clean = clean_profile_id(&profile_id)?; let trimmed = url.trim(); if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) { return Err("Artwork URL must start with http:// or https://.".to_string()); } let managed = managed_artwork_dir(&clean)?.join(format!("remote-artwork-{}.img", current_timestamp())); match download_url_to_file_with_diagnostic(trimmed, &managed) { Ok(_) => { let managed_path = managed.display().to_string(); Ok(ProfileArtworkImportResult { image_reference: profile_image_reference("cached_remote", managed_path.clone()), source_path: trimmed.to_string(), source_exists: true, managed_path: managed_path.clone(), managed_exists: managed.exists() }) }, Err(_) => Ok(ProfileArtworkImportResult { image_reference: profile_image_reference("remote_url", trimmed.to_string()), source_path: trimmed.to_string(), source_exists: false, managed_path: String::new(), managed_exists: false }) } }

fn relative_path_for(root: &Path, path: &Path) -> String { path.strip_prefix(root).unwrap_or(path).display().to_string() }
fn scan_game_folder_walk(root: &Path, current: &Path, depth: usize, visited: &mut usize, executables: &mut Vec<GameFolderScanExecutable>, folders: &mut Vec<GameFolderScanFolder>, frameworks: &mut Vec<String>, steam_app_ids: &mut Vec<String>) { if depth > 4 || *visited > 3500 { return; } let Ok(entries) = fs::read_dir(current) else { return; }; for entry in entries.flatten() { if *visited > 3500 { break; } *visited += 1; let path = entry.path(); let name = entry.file_name().to_string_lossy().to_string(); let lower = name.to_ascii_lowercase(); if path.is_dir() { if folders.len() < 180 { folders.push(GameFolderScanFolder { name: name.clone(), path: path.display().to_string(), relative_path: relative_path_for(root, &path) }); } if matches!(lower.as_str(), "bepinex" | "mods" | "plugins" | "red4ext" | "reframework" | "ue4ss") && !frameworks.iter().any(|item| item.eq_ignore_ascii_case(&name)) { frameworks.push(name.clone()); } scan_game_folder_walk(root, &path, depth + 1, visited, executables, folders, frameworks, steam_app_ids); } else { if lower.ends_with(".exe") && executables.len() < 80 { let metadata = fs::metadata(&path).ok(); let score = if lower.contains("shipping") || lower.contains("client") { 90 } else if depth <= 1 { 75 } else { 45 }; executables.push(GameFolderScanExecutable { file_name: name.clone(), path: path.display().to_string(), relative_path: relative_path_for(root, &path), size_bytes: metadata.map(|meta| meta.len()), score: Some(score) }); } if lower == "steam_appid.txt" { if let Ok(contents) = fs::read_to_string(&path) { for id in contents.split_whitespace().filter(|part| part.chars().all(|ch| ch.is_ascii_digit())) { if !steam_app_ids.iter().any(|existing| existing == id) { steam_app_ids.push(id.to_string()); } } } } } } }

#[tauri::command]
fn scan_game_folder_basic(game_folder: String) -> Result<GameFolderScanResult, String> { let root = PathBuf::from(game_folder.trim()); if !root.exists() || !root.is_dir() { return Err(format!("Game folder was not found: {}", root.display())); } let mut visited = 0usize; let mut executables = Vec::new(); let mut folders = Vec::new(); let mut frameworks = Vec::new(); let mut steam_app_ids = Vec::new(); scan_game_folder_walk(&root, &root, 0, &mut visited, &mut executables, &mut folders, &mut frameworks, &mut steam_app_ids); executables.sort_by(|a, b| b.score.unwrap_or(0).cmp(&a.score.unwrap_or(0)).then_with(|| a.file_name.cmp(&b.file_name))); let suggested_executable = executables.first().cloned(); let architecture_hints = executables.iter().filter_map(|exe| { let lower = exe.relative_path.to_ascii_lowercase(); if lower.contains("win64") || lower.contains("x64") { Some("64-bit Windows".to_string()) } else if lower.contains("win32") || lower.contains("x86") { Some("32-bit Windows".to_string()) } else { None } }).collect::<std::collections::BTreeSet<_>>().into_iter().collect(); Ok(GameFolderScanResult { suggested_game_name: root.file_name().and_then(|value| value.to_str()).unwrap_or("Selected Game").replace('_', " "), game_folder: root.display().to_string(), executables, suggested_executable, folders, frameworks, steam_app_ids, architecture_hints, visited_entries: Some(visited) }) }
#[tauri::command]
fn read_profile_creator_import_file(path: String) -> Result<String, String> { fs::read_to_string(path.trim()).map_err(|err| format!("Failed to read profile creator import file: {}", err)) }

#[tauri::command]
fn write_profile_creator_text_file(path: String, contents: String, extension: String) -> Result<String, String> { let mut target = PathBuf::from(path.trim()); if target.as_os_str().is_empty() { return Err("Output path is required.".to_string()); } if target.extension().is_none() && !extension.trim().is_empty() { target.set_extension(extension.trim().trim_start_matches('.')); } if let Some(parent) = target.parent() { fs::create_dir_all(parent).map_err(|err| format!("Failed to create output folder {}: {}", parent.display(), err))?; } fs::write(&target, contents).map_err(|err| format!("Failed to write {}: {}", target.display(), err))?; Ok(format!("Wrote {}", target.display())) }

#[tauri::command]
fn test_profile_source_config(source: serde_json::Value) -> Result<SourceTestConfigResult, String> {
    let source_type = source_type_from_item(&source);
    let mut mapping_valid = true;
    let mut messages = Vec::new();
    let mut details = Vec::new();
    let mut final_url = None;

    match source_type.as_str() {
        "nexus" | "nexus_mods" => {
            let domain = item_any_field_value(&source, &["Nexus Domain", "Domain"])
                .and_then(|value| clean_source_slug(&value))
                .or_else(|| item_any_field_value(&source, &["Nexus Game Page URL", "Nexus Category URL", "Embedded Start URL", "Game Page URL", "Page URL"])
                    .and_then(|value| parse_nexus_game_url_fields(&value).map(|parsed| parsed.0)));
            let numeric_id = item_any_field_value(&source, &["Nexus Game ID", "Numeric Nexus Game ID", "Game ID"]);
            if numeric_id.as_deref().map(|value| !source_id_is_numeric(value)).unwrap_or(false) {
                mapping_valid = false;
                messages.push("Nexus game ID must be numeric. Put game titles in Human Game Name and slugs in Nexus Domain.".to_string());
            }
            for label in ["Nexus Game Page URL", "Nexus Category URL", "Embedded Start URL"] {
                if let Some(value) = item_field_value(&source, label) {
                    if parse_nexus_game_url_fields(&value).is_none() {
                        mapping_valid = false;
                        messages.push(format!("{} must be a nexusmods.com URL.", label));
                    }
                }
            }
            if domain.is_none() && numeric_id.as_deref().filter(|value| source_id_is_numeric(value)).is_none() {
                mapping_valid = false;
                messages.push("Nexus needs a domain, a full game page URL, or a numeric game ID.".to_string());
            }
            final_url = item_any_field_value(&source, &["Embedded Start URL", "Nexus Category URL", "Nexus Game Page URL"])
                .or_else(|| domain.clone().map(|domain| format!("https://www.nexusmods.com/{}/mods", domain)));
            details.push(format!("Nexus domain: {}", domain.unwrap_or_else(|| "not set".to_string())));
            details.push(format!("Nexus numeric game ID: {}", numeric_id.unwrap_or_else(|| "not set".to_string())));
        }
        "modworkshop" => {
            let slug = item_any_field_value(&source, &["ModWorkshop Slug", "Slug", "Game Slug"])
                .and_then(|value| clean_source_slug(&value))
                .or_else(|| item_any_field_value(&source, &["ModWorkshop Game Page URL", "ModWorkshop Category URL", "Embedded Start URL", "Game Page URL", "Page URL"])
                    .and_then(|value| parse_modworkshop_game_url_fields(&value).and_then(|parsed| parsed.0)))
                .and_then(|value| normalize_modworkshop_game_route(&value).ok());
            let numeric_id = item_any_field_value(&source, &["ModWorkshop Game ID", "Numeric ModWorkshop Game ID", "Game ID"]);
            if numeric_id.as_deref().map(|value| !source_id_is_numeric(value)).unwrap_or(false) {
                mapping_valid = false;
                messages.push("ModWorkshop game ID must be numeric. Put game titles in Human Game Name and slugs in ModWorkshop Slug.".to_string());
            }
            for label in ["ModWorkshop Game Page URL", "ModWorkshop Category URL", "Embedded Start URL"] {
                if let Some(value) = item_field_value(&source, label) {
                    if parse_modworkshop_game_url_fields(&value).is_none() {
                        mapping_valid = false;
                        messages.push(format!("{} must be a modworkshop.net game URL.", label));
                    }
                }
            }
            if slug.is_none() && numeric_id.as_deref().filter(|value| source_id_is_numeric(value)).is_none() {
                mapping_valid = false;
                messages.push("ModWorkshop needs a slug, full game page URL, or numeric game ID.".to_string());
            }
            final_url = item_any_field_value(&source, &["Embedded Start URL", "ModWorkshop Category URL", "ModWorkshop Game Page URL"])
                .and_then(|value| parse_modworkshop_game_url_fields(&value).map(|parsed| parsed.2))
                .or_else(|| slug.clone().map(|slug| format!("https://modworkshop.net/g/{}/mods", slug)));
            details.push(format!("ModWorkshop slug: {}", slug.unwrap_or_else(|| "not set".to_string())));
            details.push(format!("ModWorkshop numeric game ID: {}", numeric_id.unwrap_or_else(|| "not set".to_string())));
        }
        "embedded" | "custom_browser" => {
            final_url = item_field_value(&source, "Starting Page URL").or_else(|| item_field_value(&source, "Start URL"));
            if final_url.is_none() {
                mapping_valid = false;
                messages.push("Starting page URL is required.".to_string());
            }
        }
        "github" => {
            let repository_url = item_any_field_value(&source, &["Repository URL", "GitHub URL", "Page URL"]);
            let parsed = repository_url.as_deref().and_then(parse_github_repository_url);
            let owner = item_field_value(&source, "Repository Owner").or_else(|| parsed.as_ref().map(|value| value.0.clone()));
            let repo = item_field_value(&source, "Repository Name").or_else(|| parsed.as_ref().map(|value| value.1.clone()));
            if owner.is_none() || repo.is_none() {
                mapping_valid = false;
                messages.push("GitHub owner and repository are required.".to_string());
            }
            if let (Some(owner), Some(repo)) = (owner, repo) {
                final_url = Some(format!("https://github.com/{}/{}", owner, repo));
            }
        }
        "local" => final_url = Some("local-files".to_string()),
        "direct_catalog" => {
            final_url = item_field_value(&source, "Catalog URL");
            if final_url.is_none() {
                mapping_valid = false;
                messages.push("Catalog URL is required.".to_string());
            }
        }
        _ => {}
    }

    Ok(SourceTestConfigResult {
        status: if mapping_valid { "Valid".to_string() } else { "Failed".to_string() },
        message: if mapping_valid { "Source mapping is valid locally. Provider reachability is tested separately.".to_string() } else { messages.join(" ") },
        user_message: None,
        technical_details: Some(if details.is_empty() { "Local validation only; no network probe was required.".to_string() } else { details.join("\n") }),
        source_type: Some(source_type),
        reachable: mapping_valid,
        authenticated: true,
        mapping_valid,
        final_url,
        http_status: None,
    })
}
fn mod_profiles_dir_for_game_profile(game_profile_id: &str) -> Result<PathBuf, String> { Ok(ensure_profile_data_dirs(game_profile_id)?.join("mod-profiles")) }
fn legacy_mod_profile_sources() -> Vec<(PathBuf, Option<String>)> { let mut sources = Vec::new(); if let Ok(path) = legacy_mod_profiles_dir() { sources.push((path, None)); } if let Some(paths) = detect_payday3_paths_internal() { sources.push((paths.pak_mods.join("Tsuki_Profiles"), Some(BUILTIN_PAYDAY3_PROFILE_ID.to_string()))); } sources }
fn normalize_mod_profile(mut profile: ModProfile, fallback_game_profile_id: Option<&str>) -> ModProfile { if profile.id.trim().is_empty() { profile.id = format!("profile-{}", current_timestamp()); } profile.id = sanitize_file_component(&profile.id); if profile.name.trim().is_empty() { profile.name = profile.id.clone(); } let missing_owner = profile.game_profile_id.trim().is_empty(); let owner = if missing_owner { fallback_game_profile_id.unwrap_or(UNASSIGNED_GAME_PROFILE_ID).to_string() } else { profile.game_profile_id.clone() }; profile.game_profile_id = clean_profile_id(&owner).unwrap_or_else(|_| UNASSIGNED_GAME_PROFILE_ID.to_string()); if missing_owner && fallback_game_profile_id.is_none() { profile.migration_state = Some("unassignedOwnership".to_string()); } profile }
fn mod_profile_file_path(folder: &Path, profile: &ModProfile) -> PathBuf { let base = sanitize_file_component(if profile.id.trim().is_empty() { &profile.name } else { &profile.id }); folder.join(format!("{}.json", base)) }
fn write_mod_profile_file(folder: &Path, profile: &ModProfile, allow_overwrite: bool) -> Result<PathBuf, String> { fs::create_dir_all(folder).map_err(|err| format!("Failed to create mod profiles folder {}: {}", folder.display(), err))?; let mut path = mod_profile_file_path(folder, profile); if !allow_overwrite && path.exists() { let stem = path.file_stem().and_then(|value| value.to_str()).unwrap_or("profile").to_string(); path = folder.join(format!("{}-{}.json", stem, current_timestamp())); } let contents = serde_json::to_string_pretty(profile).map_err(|err| format!("Failed to serialize mod profile: {}", err))?; fs::write(&path, contents).map_err(|err| format!("Failed to write mod profile {}: {}", path.display(), err))?; Ok(path) }
fn migrate_legacy_mod_profiles_for_game_profile(game_profile_id: &str) -> Result<(), String> { let current_game_profile_id = clean_profile_id(game_profile_id)?; for (folder, inferred_owner) in legacy_mod_profile_sources() { if !folder.exists() { continue; } let Ok(entries) = fs::read_dir(&folder) else { continue; }; for entry in entries.flatten() { let path = entry.path(); if path.extension().and_then(|value| value.to_str()) != Some("json") { continue; } let Ok(contents) = fs::read_to_string(&path) else { continue; }; let Ok(profile) = serde_json::from_str::<ModProfile>(&contents) else { continue; }; let profile = normalize_mod_profile(profile, inferred_owner.as_deref()); let owner_folder = mod_profiles_dir_for_game_profile(&profile.game_profile_id)?; let target = mod_profile_file_path(&owner_folder, &profile); if !target.exists() { let _ = write_mod_profile_file(&owner_folder, &profile, false); } } } let _ = mod_profiles_dir_for_game_profile(UNASSIGNED_GAME_PROFILE_ID)?; let _ = mod_profiles_dir_for_game_profile(&current_game_profile_id)?; Ok(()) }
fn set_active_mod_profile_for_game(game_profile_id: &str, mod_profile_id: Option<String>) -> Result<(), String> { let game_profile_id = clean_profile_id(game_profile_id)?; let mut settings = load_settings_internal(); if let Some(mod_profile_id) = mod_profile_id.and_then(|value| clean_optional_string(Some(value))) { settings.active_mod_profile_by_game_profile_id.insert(game_profile_id, mod_profile_id); } else { settings.active_mod_profile_by_game_profile_id.remove(&game_profile_id); } save_settings_internal(&settings) }
fn legacy_mod_profiles_dir() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("profiles"))
}

#[tauri::command]
fn list_mod_profiles(game_profile_id: String) -> Result<Vec<ModProfile>, String> {
    let game_profile_id = clean_profile_id(&game_profile_id)?;
    migrate_legacy_mod_profiles_for_game_profile(&game_profile_id)?;
    let folder = mod_profiles_dir_for_game_profile(&game_profile_id)?;
    fs::create_dir_all(&folder).map_err(|err| format!("Failed to create profiles folder: {}", err))?;
    let mut profiles = Vec::new();
    for entry in fs::read_dir(&folder).map_err(|err| format!("Failed to read profiles folder: {}", err))? {
        let entry = entry.map_err(|err| format!("Failed to read profile entry: {}", err))?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") { continue; }
        let Ok(contents) = fs::read_to_string(&path) else { continue; };
        if let Ok(profile) = serde_json::from_str::<ModProfile>(&contents) {
            let profile = normalize_mod_profile(profile, Some(&game_profile_id));
            if profile.game_profile_id == game_profile_id { profiles.push(profile); }
        }
    }
    profiles.sort_by(|a, b| b.created_unix.cmp(&a.created_unix));
    Ok(profiles)
}

#[tauri::command]
fn save_current_mod_profile(name: String, game_profile_id: String) -> Result<ModProfile, String> {
    let game_profile_id = clean_profile_id(&game_profile_id)?;
    let profile_name = if name.trim().is_empty() { format!("Profile {}", current_timestamp()) } else { name.trim().to_string() };
    let enabled_pak_files = if is_builtin_payday3_profile(Some(&game_profile_id)) {
        let scan = scan_pak_mods_internal()?;
        scan.pak_mods.into_iter().filter(|file| file.enabled).map(|file| enabled_name_from_disabled(&file.file_name)).collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let enabled_receipt_ids = profile_installs::list_profile_receipts_internal(&game_profile_id)?
        .into_iter()
        .filter(|receipt| receipt.enabled.unwrap_or(false))
        .map(|receipt| receipt.id)
        .collect::<Vec<_>>();
    let profile = ModProfile { id: sanitize_file_component(&format!("{}-{}", profile_name, current_timestamp())), game_profile_id: game_profile_id.clone(), name: profile_name.clone(), created_unix: now_unix_seconds(), enabled_pak_files, enabled_receipt_ids, migration_state: None };
    let folder = mod_profiles_dir_for_game_profile(&game_profile_id)?;
    write_mod_profile_file(&folder, &profile, false)?;
    set_active_mod_profile_for_game(&game_profile_id, Some(profile.id.clone()))?;
    Ok(profile)
}

#[tauri::command]
fn apply_mod_profile(profile_id: String, game_profile_id: String) -> Result<String, String> {
    let game_profile_id = clean_profile_id(&game_profile_id)?;
    let profile = list_mod_profiles(game_profile_id.clone())?.into_iter().find(|profile| profile.id == profile_id || profile.name == profile_id).ok_or_else(|| format!("Profile not found for {}: {}", game_profile_id, profile_id))?;
    if !is_builtin_payday3_profile(Some(&game_profile_id)) {
        let receipt_changes = profile_installs::apply_profile_receipt_selection(&game_profile_id, &profile.enabled_receipt_ids)?;
        set_active_mod_profile_for_game(&game_profile_id, Some(profile.id.clone()))?;
        return Ok(format!("Applied profile '{}' for {}. Managed installs changed: {}.", profile.name, game_profile_id, receipt_changes));
    }
    let scan = scan_pak_mods_internal()?;
    let mut enabled_paks = Vec::new();
    let mut disabled_paks = Vec::new();
    for file in scan.pak_mods {
        let enabled_name = enabled_name_from_disabled(&file.file_name);
        if profile.enabled_pak_files.iter().any(|wanted| wanted.eq_ignore_ascii_case(&enabled_name)) { enabled_paks.push(file.file_name); } else { disabled_paks.push(file.file_name); }
    }
    if !enabled_paks.is_empty() { let _ = set_pak_mod_files_enabled(enabled_paks, true, Some(game_profile_id.clone()))?; }
    if !disabled_paks.is_empty() { let _ = set_pak_mod_files_enabled(disabled_paks, false, Some(game_profile_id.clone()))?; }
    let mut receipt_changes = 0usize;
    for receipt in list_install_receipts_internal()? {
        if receipt.files.iter().all(|file| receipt_is_pak_file_path(&file.relative_path)) { continue; }
        let should_enable = profile.enabled_receipt_ids.iter().any(|id| id == &receipt.id);
        set_receipt_mod_enabled_internal(&receipt.id, should_enable)?;
        receipt_changes += 1;
    }
    set_active_mod_profile_for_game(&game_profile_id, Some(profile.id.clone()))?;
    Ok(format!("Applied profile '{}'. PAK enabled targets: {}. Managed installs touched: {}.", profile.name, profile.enabled_pak_files.len(), receipt_changes))
}

#[tauri::command]
fn delete_mod_profile(profile_id: String, game_profile_id: String) -> Result<String, String> {
    let game_profile_id = clean_profile_id(&game_profile_id)?;
    let target = profile_id.trim();
    if target.is_empty() { return Err("Profile id is required.".to_string()); }
    let folder = mod_profiles_dir_for_game_profile(&game_profile_id)?;
    fs::create_dir_all(&folder).map_err(|err| format!("Failed to create profiles folder: {}", err))?;
    let mut removed = 0usize;
    let mut matched_name = None::<String>;
    let mut removed_active = false;
    for entry in fs::read_dir(&folder).map_err(|err| format!("Failed to read profiles folder: {}", err))? {
        let entry = entry.map_err(|err| format!("Failed to read profile entry: {}", err))?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") { continue; }
        let profile_matches = fs::read_to_string(&path).ok().and_then(|contents| serde_json::from_str::<ModProfile>(&contents).ok()).map(|profile| {
            let profile = normalize_mod_profile(profile, Some(&game_profile_id));
            let matches = profile.game_profile_id == game_profile_id && (profile.id.eq_ignore_ascii_case(target) || profile.name.eq_ignore_ascii_case(target) || sanitize_file_component(&profile.name).eq_ignore_ascii_case(target));
            if matches { matched_name = Some(profile.name); removed_active = load_settings_internal().active_mod_profile_by_game_profile_id.get(&game_profile_id).map(|id| id.eq_ignore_ascii_case(&profile.id)).unwrap_or(false); }
            matches
        }).unwrap_or(false);
        if profile_matches { fs::remove_file(&path).map_err(|err| format!("Failed to delete profile {}: {}", path.display(), err))?; removed += 1; }
    }
    if removed == 0 { return Err(format!("Profile not found for {}: {}", game_profile_id, target)); }
    if removed_active { set_active_mod_profile_for_game(&game_profile_id, None)?; }
    Ok(format!("Deleted profile '{}' ({} file{} removed).", matched_name.unwrap_or_else(|| target.to_string()), removed, if removed == 1 { "" } else { "s" }))
}
fn list_install_receipts_internal() -> Result<Vec<InstallReceipt>, String> {
    let receipt_root = receipts_dir()?;
    fs::create_dir_all(&receipt_root)
        .map_err(|err| format!("Failed to create receipts folder: {}", err))?;

    let mut receipts = Vec::new();

    for entry in fs::read_dir(&receipt_root)
        .map_err(|err| format!("Failed to read receipts folder: {}", err))?
    {
        let entry = entry.map_err(|err| format!("Failed to read receipt entry: {}", err))?;
        let path = entry.path();

        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }

        let contents = fs::read_to_string(&path)
            .map_err(|err| format!("Failed to read receipt {}: {}", path.display(), err))?;

        match serde_json::from_str::<InstallReceipt>(&contents) {
            Ok(receipt) => receipts.push(receipt),
            Err(_) => continue,
        }
    }

    receipts.sort_by(|a, b| a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase()));
    Ok(receipts)
}

#[tauri::command]
fn list_install_receipts(profile_id: Option<String>) -> Result<Vec<InstallReceipt>, String> {
    let profile_id = profile_id.unwrap_or_else(|| BUILTIN_PAYDAY3_PROFILE_ID.to_string());
    profile_installs::list_profile_receipts_internal(&profile_id)
}


#[tauri::command]
fn is_running_as_admin() -> Result<bool, String> {
    Ok(is_running_as_admin_internal())
}

#[tauri::command]
fn relaunch_tsuki_as_admin() -> Result<String, String> {
    Ok("Admin relaunch is disabled. Tsuki now launches normally.".to_string())
}


fn launch_steam_payday3() -> Result<String, String> {
    shell_execute_open_target("steam://rungameid/1272080")?;
    Ok("Asked Steam to launch PAYDAY 3 without one-time custom arguments.".to_string())
}

fn launch_steam_payday3_modded() -> Result<String, String> {
    shell_execute_open_target("steam://rungameid/1272080")?;
    Ok("Asked Steam to launch PAYDAY 3. Modded launch uses the saved Steam Launch Options instead of a one-time custom argument prompt.".to_string())
}

fn launch_payday3_vanilla_direct(paths: &PaydayPaths) -> Result<String, String> {
    launch_payday3_direct(paths, "vanilla")
}

fn launch_payday3_direct(paths: &PaydayPaths, mode: &str) -> Result<String, String> {
    let candidates = payday_exe_candidates(paths);
    let mut checked = Vec::new();

    for exe in candidates {
        checked.push(exe.display().to_string());

        if !exe.exists() || !exe.is_file() {
            continue;
        }

        let working_dir = exe
            .parent()
            .map(PathBuf::from)
            .unwrap_or_else(|| paths.win64.clone());

        Command::new(&exe)
            .current_dir(&working_dir)
            .spawn()
            .map_err(|err| format!("Failed to launch PAYDAY 3 vanilla executable {}: {}", exe.display(), err))?;

        return Ok(format!(
            "Launched PAYDAY 3 directly from {} for {} mode without -fileopenlog.",
            exe.display(), mode
        ));
    }

    Err(format!(
        "Could not find a PAYDAY 3 executable for direct vanilla launch. Checked: {}",
        checked.join(" | ")
    ))
}

#[cfg(target_os = "windows")]
fn payday_process_running() -> bool {
    let now = now_unix_millis();
    if let Ok(cache) = PAYDAY_PROCESS_CACHE.lock() {
        if let Some((checked_at, running)) = *cache {
            if now.saturating_sub(checked_at) < 1_500 {
                return running;
            }
        }
    }

    let mut command = Command::new("tasklist");
    hide_command_window(&mut command);

    let output = match command.output() {
        Ok(output) => output,
        Err(_) => return false,
    };

    let text = String::from_utf8_lossy(&output.stdout).to_lowercase();
    let running = [
        "payday3client-win64-shipping.exe",
        "payday3-wingdk-shipping.exe",
        "payday3-win64-shipping.exe",
        "payday3_win64_shipping.exe",
        "payday3client.exe",
        "payday3.exe",
    ]
    .iter()
    .any(|name| text.contains(name));

    if let Ok(mut cache) = PAYDAY_PROCESS_CACHE.lock() {
        *cache = Some((now, running));
    }

    running
}

#[cfg(not(target_os = "windows"))]
fn payday_process_running() -> bool {
    false
}

fn start_vanilla_restore_watcher() {
    std::thread::spawn(|| {
        // Release v1.8.1: faster restore watcher with a shorter no-process fallback window.
        // If PAYDAY 3 closes/crashes, restore shortly after the process disappears.
        // If the process never appears, give it a short launch window and then restore.
        let mut saw_game = false;

        for _ in 0..24 {
            if payday_process_running() {
                saw_game = true;
                break;
            }

            std::thread::sleep(std::time::Duration::from_millis(250));
        }

        if saw_game {
            let mut not_running_ticks = 0u8;

            loop {
                if payday_process_running() {
                    not_running_ticks = 0;
                } else {
                    not_running_ticks = not_running_ticks.saturating_add(1);
                }

                // Crash/close recovery: about 1 second closed, then restore.
                if not_running_ticks >= 2 {
                    break;
                }

                std::thread::sleep(std::time::Duration::from_millis(500));
            }
        }

        let _ = restore_mods_after_vanilla_launch();
    });
}


fn payday_exe_candidates(paths: &PaydayPaths) -> Vec<PathBuf> {
    vec![
        paths.win64.join("PAYDAY3-WinGDK-Shipping.exe"),
        paths.win64.join("PAYDAY3Client-Win64-Shipping.exe"),
        paths.win64.join("PAYDAY3-Win64-Shipping.exe"),
        paths.win64.join("PAYDAY3Client.exe"),
        paths.game_root.join("PAYDAY3.exe"),
    ]
}

fn launch_payday3_with_mode(modded: bool) -> Result<String, String> {
    let _launch_guard = acquire_launch_guard()?;

    let paths = detect_payday3_paths_internal()
        .ok_or_else(|| "PAYDAY 3 was not detected. Set the game path in Settings first.".to_string())?;

    if modded {
        let restore_message = if read_vanilla_launch_session().is_some() {
            restore_mods_after_vanilla_launch()?
        } else {
            "No pending vanilla temp session needed restoring.".to_string()
        };
        if payday_uses_ue5_layout(&paths) {
            return Ok(format!("{} {}", restore_message, launch_payday3_direct(&paths, "UE5 modded")?));
        }
        let options_message = ensure_steam_payday3_fileopenlog_launch_option(&paths)?;
        let launch_message = launch_steam_payday3_modded()?;

        return Ok(format!(
            "{} {} {} This avoids Steam's one-time 'custom arguments' confirmation dialog.",
            restore_message,
            options_message,
            launch_message
        ));
    }

    // Always restore any old crashed vanilla session before preparing a fresh one.
    let pre_restore_message = if read_vanilla_launch_session().is_some() {
        restore_mods_after_vanilla_launch()?
    } else {
        "No stale vanilla temp session found.".to_string()
    };

    let disable_message = disable_mods_for_vanilla_launch()?;
    let clean_check_message = verify_vanilla_mod_surfaces_clean(&paths)?;

    // Try to clear Steam's saved -fileopenlog, but do not strand the user if Steam keeps stale
    // launch options in memory. Vanilla launches the game executable directly so no custom
    // Steam arguments are injected into this run.
    let options_message = match ensure_steam_payday3_vanilla_launch_option(&paths) {
        Ok(message) => message,
        Err(error) => format!("Warning: could not fully clear/verify Steam Launch Options before direct vanilla launch: {}", error),
    };

    let launch_message = match launch_payday3_vanilla_direct(&paths) {
        Ok(message) => message,
        Err(direct_error) => {
            let steam_message = launch_steam_payday3()?;
            format!(
                "Direct vanilla executable launch failed: {}. Fell back to Steam launch: {}",
                direct_error,
                steam_message
            )
        }
    };

    start_vanilla_restore_watcher();

    Ok(format!(
        "{} {} {} {} {} Vanilla launch temporarily moves active Tsuki mods fully outside the game-scanned Paks/Win64 folders first, launches without one-time -fileopenlog arguments when direct launch is available, then restores those mods after PAYDAY 3 closes/crashes.",
        pre_restore_message,
        disable_message,
        clean_check_message,
        options_message,
        launch_message
    ))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateManifest {
    version: String,
    notes: Option<String>,
    pub_date: Option<String>,
    download_url: Option<String>,
    release_url: Option<String>,
    sha256: Option<String>,
    mandatory: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateStatus {
    current_version: String,
    current_semver: String,
    latest_version: Option<String>,
    update_available: bool,
    notes: Option<String>,
    pub_date: Option<String>,
    download_url: Option<String>,
    release_url: Option<String>,
    sha256: Option<String>,
    manifest_url: Option<String>,
    checked_at_unix: u64,
    error: Option<String>,
}

fn app_update_manifest_url_from_settings() -> Option<String> {
    let value = DEFAULT_APP_UPDATE_MANIFEST_URL.trim();
    if value.is_empty() { None } else { Some(value.to_string()) }
}

fn extract_version_numbers(value: &str) -> Vec<u64> {
    let text = value.trim().trim_start_matches('v');
    let mut number = String::new();
    let mut parts = Vec::<u64>::new();

    for ch in text.chars() {
        if ch.is_ascii_digit() {
            number.push(ch);
            continue;
        }

        if ch == '.' {
            if number.is_empty() {
                break;
            }

            if let Ok(value) = number.parse::<u64>() {
                parts.push(value);
            }

            number.clear();
            continue;
        }

        break;
    }

    if !number.is_empty() {
        if let Ok(value) = number.parse::<u64>() {
            parts.push(value);
        }
    }

    parts
}

fn semver_string(value: &str) -> String {
    let mut parts = extract_version_numbers(value);

    if parts.is_empty() {
        return value.to_string();
    }

    // Tsuki release numbers currently use 4 parts, for example 1.0.7.27.
    // Keep all numeric parts so 1.0.7.28 correctly compares newer than 1.0.7.27.
    while parts.len() < 4 {
        parts.push(0);
    }

    parts
        .into_iter()
        .map(|part| part.to_string())
        .collect::<Vec<_>>()
        .join(".")
}

fn version_is_newer(latest: &str, current: &str) -> bool {
    let mut latest_parts = extract_version_numbers(latest);
    let mut current_parts = extract_version_numbers(current);

    if latest_parts.is_empty() || current_parts.is_empty() {
        return false;
    }

    let length = latest_parts.len().max(current_parts.len()).max(4);
    latest_parts.resize(length, 0);
    current_parts.resize(length, 0);

    latest_parts > current_parts
}

fn parse_app_update_manifest(text: &str) -> Result<AppUpdateManifest, String> {
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|err| format!("Update manifest is not valid JSON: {}", err))?;

    let version = json_string(&value, &["version"])
        .ok_or_else(|| "Update manifest is missing 'version'.".to_string())?;

    let download_url = json_string(&value, &["downloadUrl", "download_url", "url"])
        .or_else(|| {
            value
                .get("platforms")
                .and_then(|platforms| platforms.get("windows-x86_64"))
                .and_then(|platform| json_string(platform, &["url"]))
        });

    Ok(AppUpdateManifest {
        version,
        notes: json_string(&value, &["notes", "body", "changelog"]),
        pub_date: json_string(&value, &["pubDate", "pub_date", "publishedAt", "published_at"]),
        download_url,
        release_url: json_string(&value, &["releaseUrl", "release_url", "htmlUrl", "html_url"]),
        sha256: json_string(&value, &["sha256", "hash"]),
        mandatory: value.get("mandatory").and_then(|v| v.as_bool()),
    })
}

fn check_app_update_internal(manifest_url_override: Option<String>) -> Result<AppUpdateStatus, String> {
    let manifest_url = manifest_url_override
        .filter(|value| !value.trim().is_empty())
        .or_else(app_update_manifest_url_from_settings)
        .ok_or_else(|| "No built-in app update manifest URL is configured.".to_string())?;

    if !manifest_url.starts_with("https://") && !manifest_url.starts_with("http://") {
        return Err("Update manifest URL must be http(s). HTTPS is recommended.".to_string());
    }

    let text = http_get_text_fast(&manifest_url, 12)
        .or_else(|_| http_get_text(&manifest_url))?;
    let manifest = parse_app_update_manifest(&text)?;
    let current_semver = semver_string(APP_VERSION);
    let update_available = version_is_newer(&manifest.version, APP_VERSION);

    Ok(AppUpdateStatus {
        current_version: APP_VERSION.to_string(),
        current_semver,
        latest_version: Some(manifest.version),
        update_available,
        notes: manifest.notes,
        pub_date: manifest.pub_date,
        download_url: manifest.download_url,
        release_url: manifest.release_url,
        sha256: manifest.sha256,
        manifest_url: Some(manifest_url),
        checked_at_unix: now_unix_seconds(),
        error: None,
    })
}

#[tauri::command]
fn check_app_update(manifest_url: Option<String>) -> Result<AppUpdateStatus, String> {
    match check_app_update_internal(manifest_url) {
        Ok(status) => Ok(status),
        Err(error) => Ok(AppUpdateStatus {
            current_version: APP_VERSION.to_string(),
            current_semver: semver_string(APP_VERSION),
            latest_version: None,
            update_available: false,
            notes: None,
            pub_date: None,
            download_url: None,
            release_url: None,
            sha256: None,
            manifest_url: app_update_manifest_url_from_settings(),
            checked_at_unix: now_unix_seconds(),
            error: Some(error),
        }),
    }
}

fn app_update_download_dir() -> Result<PathBuf, String> {
    let dir = app_data_dir()?.join("cache").join("app-updates");
    fs::create_dir_all(&dir)
        .map_err(|err| format!("Failed to create update cache folder {}: {}", dir.display(), err))?;
    Ok(dir)
}

fn safe_update_file_name(version: &str, download_url: &str) -> String {
    let ext = download_url
        .split('?')
        .next()
        .unwrap_or(download_url)
        .rsplit('.')
        .next()
        .filter(|ext| ext.len() <= 8 && ext.chars().all(|ch| ch.is_ascii_alphanumeric()))
        .unwrap_or("exe");

    let version = semver_string(version).replace('.', "_");
    format!("Tsuki_Mod_Manager_Update_{}.{}", version, ext)
}

fn download_update_file(url: &str, destination: &Path) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("TsukiModManager/1.0")
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|err| format!("Failed to create HTTP client: {}", err))?;

    let mut response = client
        .get(url)
        .header("Accept", "application/octet-stream,*/*")
        .send()
        .map_err(|err| format!("Update download failed: {}", err))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("Update download returned HTTP {}", status));
    }

    let mut file = File::create(destination)
        .map_err(|err| format!("Failed to create update file {}: {}", destination.display(), err))?;

    io::copy(&mut response, &mut file)
        .map_err(|err| format!("Failed to write update file {}: {}", destination.display(), err))?;

    Ok(())
}

fn verify_update_sha256(path: &Path, expected: &str) -> Result<(), String> {
    let expected = expected.trim().to_lowercase();
    if expected.is_empty() {
        return Ok(());
    }

    let actual = sha256_file(path)?.to_lowercase();
    if actual != expected {
        return Err(format!(
            "Downloaded update hash did not match manifest. Expected {}, got {}.",
            expected, actual
        ));
    }

    Ok(())
}

fn app_update_extract_dir(version: &str) -> Result<PathBuf, String> {
    let version = semver_string(version).replace('.', "_");
    let dir = app_update_download_dir()?.join(format!("extracted_{}", version));

    if dir.exists() {
        fs::remove_dir_all(&dir)
            .map_err(|err| format!("Failed to clear old extracted update folder {}: {}", dir.display(), err))?;
    }

    fs::create_dir_all(&dir)
        .map_err(|err| format!("Failed to create extracted update folder {}: {}", dir.display(), err))?;
    Ok(dir)
}

fn extract_update_zip(zip_path: &Path, version: &str) -> Result<PathBuf, String> {
    let file = File::open(zip_path)
        .map_err(|err| format!("Failed to open downloaded update ZIP {}: {}", zip_path.display(), err))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|err| format!("Downloaded update is not a readable ZIP: {}", err))?;
    let extract_dir = app_update_extract_dir(version)?;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|err| format!("Failed to read update ZIP entry {}: {}", index, err))?;

        let Some(enclosed) = entry.enclosed_name().map(|path| path.to_owned()) else {
            continue;
        };

        let destination = extract_dir.join(enclosed);

        if entry.is_dir() {
            fs::create_dir_all(&destination)
                .map_err(|err| format!("Failed to create update folder {}: {}", destination.display(), err))?;
            continue;
        }

        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|err| format!("Failed to create update folder {}: {}", parent.display(), err))?;
        }

        let mut output = File::create(&destination)
            .map_err(|err| format!("Failed to extract update file {}: {}", destination.display(), err))?;
        io::copy(&mut entry, &mut output)
            .map_err(|err| format!("Failed to write update file {}: {}", destination.display(), err))?;
    }

    Ok(extract_dir)
}

fn collect_update_installer_candidates(root: &Path, candidates: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(root)
        .map_err(|err| format!("Failed to read update folder {}: {}", root.display(), err))?
    {
        let entry = entry.map_err(|err| format!("Failed to read update folder entry: {}", err))?;
        let path = entry.path();

        if path.is_dir() {
            collect_update_installer_candidates(&path, candidates)?;
            continue;
        }

        let lower = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_lowercase();

        if lower.ends_with(".exe") || lower.ends_with(".msi") {
            candidates.push(path);
        }
    }

    Ok(())
}

fn update_installer_score(path: &Path) -> i32 {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase();
    let full = path.display().to_string().to_lowercase();
    let mut score = 0;

    if name.ends_with(".exe") {
        score += 100;
    } else if name.ends_with(".msi") {
        score += 60;
    }

    if name.contains("setup") || name.contains("installer") || name.contains("install") {
        score += 40;
    }

    if full.contains("\\nsis\\") || full.contains("/nsis/") {
        score += 25;
    }

    if full.contains("\\msi\\") || full.contains("/msi/") {
        score += 10;
    }

    if name.contains("uninstall") {
        score -= 200;
    }

    score
}

fn find_update_installer(root: &Path) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    collect_update_installer_candidates(root, &mut candidates)?;

    candidates
        .into_iter()
        .max_by_key(|path| update_installer_score(path))
        .ok_or_else(|| format!("Downloaded update package did not contain an EXE or MSI installer in {}.", root.display()))
}

fn prepare_update_installer(downloaded: &Path, version: &str) -> Result<PathBuf, String> {
    let lower = downloaded
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase();

    if lower.ends_with(".zip") {
        let extract_dir = extract_update_zip(downloaded, version)?;
        return find_update_installer(&extract_dir);
    }

    if lower.ends_with(".exe") || lower.ends_with(".msi") || lower.ends_with(".appinstaller") || lower.ends_with(".msix") {
        return Ok(downloaded.to_path_buf());
    }

    Err(format!(
        "Downloaded update file {} is not a supported installer or ZIP package.",
        downloaded.display()
    ))
}

fn launch_update_installer(installer: &Path) -> Result<(), String> {
    let installer_string = installer.display().to_string();
    let mut command = Command::new("cmd");
    hide_command_window(&mut command);
    command
        .args(["/C", "start", ""])
        .arg(&installer_string)
        .spawn()
        .map_err(|err| format!("Downloaded update but failed to launch installer {}: {}", installer.display(), err))?;
    Ok(())
}

#[tauri::command]
fn download_and_launch_app_update(manifest_url: Option<String>) -> Result<String, String> {
    let status = check_app_update_internal(manifest_url)?;

    if !status.update_available {
        return Ok(format!(
            "Tsuki is already up to date. Current: {} Latest: {}.",
            status.current_semver,
            status.latest_version.unwrap_or_else(|| "unknown".to_string())
        ));
    }

    let download_url = status
        .download_url
        .clone()
        .ok_or_else(|| "Update is available, but the manifest has no downloadUrl.".to_string())?;
    let latest = status
        .latest_version
        .clone()
        .unwrap_or_else(|| "update".to_string());

    let destination = app_update_download_dir()?.join(safe_update_file_name(&latest, &download_url));
    download_update_file(&download_url, &destination)?;

    if let Some(hash) = status.sha256.as_deref() {
        verify_update_sha256(&destination, hash)?;
    }

    let installer = prepare_update_installer(&destination, &latest)?;
    launch_update_installer(&installer)?;

    Ok(format!(
        "Downloaded Tsuki {} to {} and launched installer {}. Close Tsuki when the installer asks.",
        latest,
        destination.display(),
        installer.display()
    ))
}

#[tauri::command]
fn save_app_update_settings(manifest_url: String) -> Result<String, String> {
    let mut settings = load_settings_internal();
    let trimmed = manifest_url.trim();

    settings.app_update_manifest_url = if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    };

    save_settings_internal(&settings)?;
    Ok(if trimmed.is_empty() {
        "Cleared app update manifest URL. Auto app update checks are disabled until a URL is set.".to_string()
    } else {
        "Saved app update manifest URL. Tsuki will check it on launch and from Settings.".to_string()
    })
}

#[tauri::command]
fn launch_payday3_vanilla() -> Result<String, String> {
    launch_payday3_with_mode(false)
}

#[tauri::command]
fn launch_payday3_modded() -> Result<String, String> {
    launch_payday3_with_mode(true)
}

#[tauri::command]
fn open_external_url(url: String) -> Result<String, String> {
    if load_settings_internal().external_link_behavior == "block" {
        return Err("External links are blocked by Settings.".to_string());
    }

    open_http_url(&url)
}

fn browser_window_label(value: &str) -> String {
    let mut label = String::from("tsuki-browser");
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
            label.push(ch);
        } else if ch == '.' || ch.is_whitespace() {
            label.push('_');
        }
        if label.len() >= 96 {
            break;
        }
    }
    label
}

#[tauri::command]
async fn open_embedded_browser_window(
    app: tauri::AppHandle,
    label: String,
    url: String,
    title: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<String, String> {
    let parsed = reqwest::Url::parse(url.trim())
        .map_err(|err| format!("Embedded browser URL is invalid: {}", err))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Embedded browser only supports http:// and https:// URLs.".to_string());
    }

    let clean_label = browser_window_label(&label);
    let display_url = parsed.to_string();
    let requested_width = width.unwrap_or(960.0);
    let requested_height = height.unwrap_or(620.0);
    if requested_width < 320.0 || requested_height < 240.0 {
        return Err("Restore or enlarge the Tsuki window before opening the embedded browser.".to_string());
    }
    let position = tauri::LogicalPosition::new(x.unwrap_or(0.0), y.unwrap_or(0.0));
    let size = tauri::LogicalSize::new(requested_width, requested_height);

    if let Some(webview) = app.get_webview(&clean_label) {
        webview
            .navigate(parsed)
            .map_err(|err| format!("Failed to navigate embedded browser: {}", err))?;
        webview
            .set_position(position)
            .map_err(|err| format!("Failed to position embedded browser: {}", err))?;
        webview
            .set_size(size)
            .map_err(|err| format!("Failed to resize embedded browser: {}", err))?;
        webview
            .show()
            .map_err(|err| format!("Failed to show embedded browser: {}", err))?;
        webview
            .set_focus()
            .map_err(|err| format!("Failed to focus embedded browser: {}", err))?;
        return Ok(format!("Embedded browser focused; navigation started for {}.", display_url));
    }

    let main_window = app
        .get_window("main")
        .ok_or_else(|| "The main Tsuki window is unavailable.".to_string())?;
    let _ = title;
    let webview = main_window
        .add_child(
            tauri::webview::WebviewBuilder::new(clean_label, tauri::WebviewUrl::External(parsed)),
            position,
            size,
        )
        .map_err(|err| format!("Failed to create embedded browser: {}", err))?;
    webview
        .set_focus()
        .map_err(|err| format!("Failed to focus embedded browser: {}", err))?;

    Ok(format!("Embedded browser opened; navigation started for {}.", display_url))
}

#[tauri::command]
fn is_embedded_browser_window_open(app: tauri::AppHandle, label: String) -> bool {
    app.get_webview(&browser_window_label(&label)).is_some()
}

#[tauri::command]
fn get_embedded_browser_status(app: tauri::AppHandle, label: String) -> EmbeddedBrowserStatus {
    let Some(webview) = app.get_webview(&browser_window_label(&label)) else {
        return EmbeddedBrowserStatus { open: false, url: None };
    };
    EmbeddedBrowserStatus {
        open: true,
        url: webview.url().ok().map(|url| url.to_string()),
    }
}

#[tauri::command]
fn set_embedded_browser_bounds(
    app: tauri::AppHandle,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible: bool,
) -> Result<(), String> {
    let webview = app
        .get_webview(&browser_window_label(&label))
        .ok_or_else(|| "This source's embedded browser is not open.".to_string())?;
    webview
        .set_position(tauri::LogicalPosition::new(x, y))
        .map_err(|err| format!("Failed to position embedded browser: {}", err))?;
    webview
        .set_size(tauri::LogicalSize::new(width.max(320.0), height.max(240.0)))
        .map_err(|err| format!("Failed to resize embedded browser: {}", err))?;
    if visible {
        webview.show().map_err(|err| format!("Failed to show embedded browser: {}", err))?;
    } else {
        webview.hide().map_err(|err| format!("Failed to hide embedded browser: {}", err))?;
    }
    Ok(())
}

#[tauri::command]
fn control_embedded_browser_window(app: tauri::AppHandle, label: String, action: String) -> Result<String, String> {
    let clean_label = browser_window_label(&label);
    let webview = app
        .get_webview(&clean_label)
        .ok_or_else(|| "This source's embedded browser is not open.".to_string())?;
    match action.trim().to_ascii_lowercase().as_str() {
        "back" => webview.eval("history.back()").map_err(|err| format!("Browser Back failed: {}", err))?,
        "forward" => webview.eval("history.forward()").map_err(|err| format!("Browser Forward failed: {}", err))?,
        "refresh" => webview.eval("location.reload()").map_err(|err| format!("Browser Refresh failed: {}", err))?,
        "close" => webview.close().map_err(|err| format!("Browser Close failed: {}", err))?,
        _ => return Err(format!("Unknown browser action: {}", action)),
    }
    Ok(format!("Browser {} completed.", action.trim().to_ascii_lowercase()))
}

fn push_unique_path(paths: &mut Vec<PathBuf>, candidate: PathBuf) {
    let candidate_key = candidate.display().to_string().to_lowercase();

    if !paths.iter().any(|path| path.display().to_string().to_lowercase() == candidate_key) {
        paths.push(candidate);
    }
}

fn receipt_existing_file_locations(paths: &PaydayPaths, receipt: &InstallReceipt) -> Vec<PathBuf> {
    let mut locations = Vec::new();

    for file in &receipt.files {
        let original = receipt_destination_path(file);

        if original.exists() {
            push_unique_path(&mut locations, original.clone());
            continue;
        }

        let original_display = original.display().to_string();
        for manifest_path in disabled_manifest_candidates(paths, receipt) {
            if let Some(manifest) = read_disabled_manifest(&manifest_path) {
                for record in manifest.files {
                    let disabled = PathBuf::from(&record.disabled_path);

                    if record.original_path.eq_ignore_ascii_case(&original_display) && disabled.exists() {
                        push_unique_path(&mut locations, disabled);
                    }
                }
            }
        }

        let disabled_guess = disabled_destination_for_receipt_file(paths, receipt, &original, file);
        if disabled_guess.exists() {
            push_unique_path(&mut locations, disabled_guess);
        }
    }

    locations
}

fn common_existing_parent(paths: &[PathBuf]) -> Option<PathBuf> {
    let mut current = paths
        .first()
        .and_then(|path| if path.is_dir() { Some(path.as_path()) } else { path.parent() })
        .map(PathBuf::from)?;

    loop {
        if paths.iter().all(|path| path.starts_with(&current)) {
            return Some(current);
        }

        if !current.pop() {
            return None;
        }
    }
}

fn best_installed_location_target(paths: &PaydayPaths, candidates: &[PathBuf]) -> Option<PathBuf> {
    if candidates.is_empty() {
        return None;
    }

    if candidates.len() == 1 {
        return candidates.first().cloned();
    }

    if candidates.iter().all(|path| path.starts_with(&paths.pak_mods)) {
        return Some(paths.pak_mods.clone());
    }

    if candidates.iter().all(|path| path.starts_with(&paths.ue4ss_mods)) {
        return Some(paths.ue4ss_mods.clone());
    }

    if candidates.iter().all(|path| path.starts_with(&paths.win64)) {
        return common_existing_parent(candidates).or_else(|| Some(paths.win64.clone()));
    }

    common_existing_parent(candidates)
}

fn open_path_in_explorer(path: &Path) -> Result<String, String> {
    if !path.exists() {
        return Err("File location not found. The file may have been moved or deleted.".to_string());
    }

    if path.is_file() {
        Command::new("explorer")
            .arg("/select,")
            .arg(path)
            .spawn()
            .map_err(|err| format!("Failed to open file location in Explorer: {}", err))?;

        return Ok(format!("Opened file location: {}", path.display()));
    }

    if path.is_dir() {
        Command::new("explorer")
            .arg(path)
            .spawn()
            .map_err(|err| format!("Failed to open folder in Explorer: {}", err))?;

        return Ok(format!("Opened folder: {}", path.display()));
    }

    Err("File location not found. The file may have been moved or deleted.".to_string())
}

fn staged_download_location_for_source(source: &str, source_id: &str) -> Option<PathBuf> {
    let diagnostic = read_last_install_diagnostic()?;

    if !diagnostic.source.eq_ignore_ascii_case(source) || diagnostic.mod_id != source_id {
        return None;
    }

    if let Some(staged_file) = diagnostic.staged_file_path {
        let path = PathBuf::from(staged_file);
        if path.exists() {
            return Some(path);
        }
    }

    if let Some(staged_folder) = diagnostic.staged_folder_path {
        let path = PathBuf::from(staged_folder);
        if path.exists() {
            return Some(path);
        }
    }

    None
}

#[tauri::command]
fn open_installed_mod_file_location(
    source: String,
    source_id: String,
    matched_files: Vec<String>,
    match_kind: Option<String>,
) -> Result<String, String> {
    let paths = detect_payday3_paths_internal()
        .ok_or_else(|| "PAYDAY 3 was not detected. Set the game path in Settings first.".to_string())?;

    let source = source.trim().to_string();
    let source_id = source_id.trim().to_string();
    let match_kind = match_kind.unwrap_or_default();

    match find_receipt_by_source(&source, &source_id) {
        Ok(receipt) => {
            let locations = receipt_existing_file_locations(&paths, &receipt);

            if let Some(target) = best_installed_location_target(&paths, &locations) {
                return open_path_in_explorer(&target);
            }

            return Err("File location not found. The file may have been moved or deleted.".to_string());
        }
        Err(error) => {
            if match_kind.eq_ignore_ascii_case("receipt") && matched_files.is_empty() {
                return Err(error);
            }
        }
    }

    let mut locations = Vec::new();
    for file_name in matched_files {
        if let Some(path) = resolve_installed_file_path(&paths, &file_name) {
            push_unique_path(&mut locations, path);
        }
    }

    if let Some(target) = best_installed_location_target(&paths, &locations) {
        return open_path_in_explorer(&target);
    }

    if let Some(staged) = staged_download_location_for_source(&source, &source_id) {
        return open_path_in_explorer(&staged);
    }

    Err("File location not found. The file may have been moved or deleted.".to_string())
}

#[tauri::command]
fn open_nexus_login_page() -> Result<String, String> {
    let mut command = Command::new("cmd");
    hide_command_window(&mut command);
    command
        .args(["/C", "start", "", "https://www.nexusmods.com/users/myaccount?tab=api"])
        .spawn()
        .map_err(|err| format!("Failed to open Nexus account page: {}", err))?;

    Ok("Opened Nexus API/account page. Paste the key here after you copy it.".to_string())
}

#[tauri::command]
fn verify_source_settings() -> Result<String, String> {
    let settings = load_settings_internal();
    let modworkshop_ready = true;
    let nexus_ready = settings
        .nexus_api_key
        .as_ref()
        .map(|key| !key.trim().is_empty())
        .unwrap_or(false);

    Ok(format!(
        "ModWorkshop public API ready: {}. Nexus API key saved: {}. Nexus age-restricted setting: {}.",
        modworkshop_ready, nexus_ready, settings.show_age_restricted_nexus
    ))
}

#[tauri::command]
fn get_app_settings() -> Result<AppSettings, String> {
    ensure_app_data_dirs()?;
    Ok(load_settings_internal())
}
#[tauri::command]
fn save_app_settings(settings: AppSettings) -> Result<AppSettings, String> {
    let normalized = normalize_app_settings(settings);
    save_settings_internal(&normalized)?;
    Ok(load_settings_internal())
}

#[tauri::command]
fn get_profile_settings(profile_id: String) -> Result<ProfileSettings, String> {
    profile_settings_file_path(&profile_id)?;
    Ok(load_profile_settings_internal(&profile_id))
}

#[tauri::command]
fn save_profile_settings(profile_id: String, settings: ProfileSettings) -> Result<ProfileSettings, String> {
    save_profile_settings_internal(&profile_id, &settings)
}

#[tauri::command]
fn reset_profile_settings(profile_id: String, scope: String) -> Result<ProfileSettings, String> {
    profile_settings_file_path(&profile_id)?;
    let mut settings = load_profile_settings_internal(&profile_id);
    let defaults = normalize_profile_settings(ProfileSettings::default(), &profile_id);
    reset_profile_settings_scope(&mut settings, &defaults, &scope)?;
    save_profile_settings_internal(&profile_id, &settings)
}

#[tauri::command]
fn open_profile_settings_folder() -> Result<String, String> {
    open_folder_in_explorer(&profile_settings_dir()?, "profile settings")
}

#[tauri::command]
fn open_game_profile_data_folder(profile_id: String) -> Result<String, String> {
    open_folder_in_explorer(&ensure_profile_data_dirs(&clean_profile_id(&profile_id)?)?, "game profile")
}

#[tauri::command]
fn export_app_settings_to_path(path: String) -> Result<String, String> {
    let target = PathBuf::from(path.trim());
    if target.as_os_str().is_empty() {
        return Err("Choose a settings export path first.".to_string());
    }

    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|err| format!("Failed to create settings export folder: {}", err))?;
        }
    }

    let settings = load_settings_internal();
    let contents = serde_json::to_string_pretty(&settings)
        .map_err(|err| format!("Failed to serialize settings export: {}", err))?;
    fs::write(&target, contents).map_err(|err| format!("Failed to export settings: {}", err))?;
    Ok(format!("Exported settings to {}", target.display()))
}

#[tauri::command]
fn import_app_settings_from_path(path: String) -> Result<AppSettings, String> {
    let source = PathBuf::from(path.trim());
    let contents = fs::read_to_string(&source)
        .map_err(|err| format!("Failed to read settings import {}: {}", source.display(), err))?;
    let settings = serde_json::from_str::<AppSettings>(&contents)
        .map(normalize_app_settings)
        .map_err(|err| format!("Failed to parse settings import: {}", err))?;
    save_settings_internal(&settings)?;
    Ok(load_settings_internal())
}

fn reset_general_settings(settings: &mut AppSettings, defaults: &AppSettings) {
    settings.startup_destination = defaults.startup_destination.clone();
    settings.notifications_enabled = defaults.notifications_enabled;
    settings.language = defaults.language.clone();
    settings.default_launch_action = defaults.default_launch_action.clone();
    settings.confirm_destructive_actions = defaults.confirm_destructive_actions;
    settings.auto_update_checks = defaults.auto_update_checks;
    settings.remember_window_state = defaults.remember_window_state;
    settings.window_state = defaults.window_state.clone();
}

fn reset_appearance_settings(settings: &mut AppSettings, defaults: &AppSettings) {
    settings.theme_id = defaults.theme_id.clone();
    settings.appearance_mode = defaults.appearance_mode.clone();
    settings.accent_color = defaults.accent_color.clone();
    settings.interface_density = defaults.interface_density.clone();
    settings.animations_enabled = defaults.animations_enabled;
    settings.transparency_enabled = defaults.transparency_enabled;
    settings.font_scale = defaults.font_scale;
    settings.thumbnail_size = defaults.thumbnail_size;
    settings.sidebar_density = defaults.sidebar_density.clone();
}

fn reset_download_settings(settings: &mut AppSettings, defaults: &AppSettings) {
    settings.download_folder = defaults.download_folder.clone();
    settings.simultaneous_downloads = defaults.simultaneous_downloads;
    settings.download_retry_count = defaults.download_retry_count;
    settings.download_bandwidth_limit_mb_s = defaults.download_bandwidth_limit_mb_s;
    settings.verify_hashes = defaults.verify_hashes;
    settings.keep_downloaded_archives = defaults.keep_downloaded_archives;
}

fn reset_browser_settings(settings: &mut AppSettings, defaults: &AppSettings) {
    settings.browser_mode = defaults.browser_mode.clone();
    settings.external_link_behavior = defaults.external_link_behavior.clone();
    settings.remember_website_logins = defaults.remember_website_logins;
    settings.intercept_supported_downloads = defaults.intercept_supported_downloads;
    settings.keep_embedded_browsing_in_sites = defaults.keep_embedded_browsing_in_sites;
    settings.protect_wrong_game_downloads = defaults.protect_wrong_game_downloads;
    settings.remember_last_website_per_profile = defaults.remember_last_website_per_profile;
}

fn reset_profile_default_settings(settings: &mut AppSettings, defaults: &AppSettings) {
    settings.profile_default_sources = defaults.profile_default_sources.clone();
    settings.profile_default_dependency_setup = defaults.profile_default_dependency_setup.clone();
    settings.profile_default_backup_behavior = defaults.profile_default_backup_behavior.clone();
    settings.profile_default_installation_flow = defaults.profile_default_installation_flow.clone();
    settings.profile_default_browser_mode = defaults.profile_default_browser_mode.clone();
    settings.profile_default_index_behavior = defaults.profile_default_index_behavior.clone();
}

fn reset_update_settings(settings: &mut AppSettings, defaults: &AppSettings) {
    settings.app_update_manifest_url = defaults.app_update_manifest_url.clone();
    settings.update_channel = defaults.update_channel.clone();
    settings.profile_update_checks = defaults.profile_update_checks;
    settings.dependency_update_checks = defaults.dependency_update_checks;
    settings.index_update_checks = defaults.index_update_checks;
    settings.ignored_versions = defaults.ignored_versions.clone();
}

fn reset_mod_index_settings(settings: &mut AppSettings, defaults: &AppSettings) {
    settings.source_index_v2_remote_enabled = defaults.source_index_v2_remote_enabled;
    settings.source_index_v2_remote_url = defaults.source_index_v2_remote_url.clone();
    settings.index_overnight = defaults.index_overnight;
    settings.index_pause_while_game_running = defaults.index_pause_while_game_running;
    settings.index_pause_on_battery = defaults.index_pause_on_battery;
    settings.index_build_mode = defaults.index_build_mode.clone();
    settings.index_bandwidth_limit_mb_s = defaults.index_bandwidth_limit_mb_s;
    settings.index_temp_storage_limit_gb = defaults.index_temp_storage_limit_gb;
    settings.index_remote_behavior = defaults.index_remote_behavior.clone();
}

fn reset_advanced_settings(settings: &mut AppSettings, defaults: &AppSettings) {
    settings.developer_mode = defaults.developer_mode;
    settings.verbose_logging = defaults.verbose_logging;
    settings.experimental_features = defaults.experimental_features;
}

#[tauri::command]
fn reset_app_settings(scope: String) -> Result<AppSettings, String> {
    let mut settings = load_settings_internal();
    let defaults = AppSettings::default();

    match scope.trim() {
        "general" => reset_general_settings(&mut settings, &defaults),
        "appearance" => reset_appearance_settings(&mut settings, &defaults),
        "accounts" => {
            settings.modworkshop_api_key = defaults.modworkshop_api_key.clone();
            settings.nexus_api_key = defaults.nexus_api_key.clone();
            settings.show_age_restricted_nexus = defaults.show_age_restricted_nexus;
        }
        "downloads" => reset_download_settings(&mut settings, &defaults),
        "browser" => reset_browser_settings(&mut settings, &defaults),
        "profiles" => reset_profile_default_settings(&mut settings, &defaults),
        "storage" => settings.keep_uninstalled_mods = defaults.keep_uninstalled_mods,
        "updates" => reset_update_settings(&mut settings, &defaults),
        "modIndex" | "mod-index" => reset_mod_index_settings(&mut settings, &defaults),
        "advanced" => reset_advanced_settings(&mut settings, &defaults),
        "all" => {
            let game_path = settings.game_path.clone();
            let current_game_profile_id = settings.current_game_profile_id.clone();
            let active_game_profile_id = settings.active_game_profile_id.clone();
            let active_mod_profile_by_game_profile_id = settings.active_mod_profile_by_game_profile_id.clone();
            settings = defaults;
            settings.game_path = game_path;
            settings.current_game_profile_id = current_game_profile_id;
            settings.active_game_profile_id = active_game_profile_id;
            settings.active_mod_profile_by_game_profile_id = active_mod_profile_by_game_profile_id;
        }
        other => return Err(format!("Unknown settings reset scope: {}", other)),
    }

    let normalized = normalize_app_settings(settings);
    save_settings_internal(&normalized)?;
    Ok(load_settings_internal())
}

#[tauri::command]
fn save_game_path(game_path: String) -> Result<String, String> {
    let trimmed = game_path.trim();

    if trimmed.is_empty() {
        return Err("Game path cannot be empty. Use Clear Manual Path instead.".to_string());
    }

    let path = PathBuf::from(trimmed);

    if !is_payday3_root(&path) {
        return Err("That folder does not look like the Payday 3 root folder.".to_string());
    }

    let mut settings = load_settings_internal();
    settings.game_path = Some(trimmed.to_string());
    save_settings_internal(&settings)?;

    Ok(format!("Saved manual Payday 3 path: {}", trimmed))
}

#[tauri::command]
fn clear_game_path() -> Result<String, String> {
    let mut settings = load_settings_internal();
    settings.game_path = None;
    save_settings_internal(&settings)?;

    Ok("Manual Payday 3 path cleared. Auto-detection will be used.".to_string())
}

#[tauri::command]
fn save_theme(theme_id: String) -> Result<String, String> {
    let trimmed = theme_id.trim();
    let normalized = normalize_theme_id(trimmed);
    if normalized == DEFAULT_THEME_ID && trimmed != DEFAULT_THEME_ID && trimmed != "basic-light" {
        return Err(format!("Unknown theme: {}", theme_id));
    }

    let mut settings = load_settings_internal();
    settings.theme_id = normalized.clone();
    save_settings_internal(&settings)?;

    Ok(format!("Saved theme: {}", normalized))
}

#[tauri::command]
fn save_source_api_keys(
    modworkshop_api_key: String,
    nexus_api_key: String,
    show_age_restricted_nexus: Option<bool>,
) -> Result<String, String> {
    let mut settings = load_settings_internal();

    let modworkshop_trimmed = modworkshop_api_key.trim();
    let nexus_trimmed = nexus_api_key.trim();

    settings.modworkshop_api_key = if modworkshop_trimmed.is_empty() {
        None
    } else {
        Some(modworkshop_trimmed.to_string())
    };

    settings.nexus_api_key = if nexus_trimmed.is_empty() {
        None
    } else {
        Some(nexus_trimmed.to_string())
    };

    settings.show_age_restricted_nexus = show_age_restricted_nexus.unwrap_or(settings.show_age_restricted_nexus);

    save_settings_internal(&settings)?;

    Ok("Saved source API keys.".to_string())
}

#[tauri::command]
fn clear_source_api_keys() -> Result<String, String> {
    let mut settings = load_settings_internal();
    settings.modworkshop_api_key = None;
    settings.nexus_api_key = None;
    save_settings_internal(&settings)?;

    Ok("Cleared source API keys.".to_string())
}

#[tauri::command]
fn detect_payday3_path() -> Result<String, String> {
    match detect_payday3_paths_internal() {
        Some(paths) => Ok(paths.game_root.display().to_string()),
        None => Ok("Payday 3 not detected. Set a manual path in Settings.".to_string()),
    }
}

#[tauri::command]
fn detect_active_profile_path(profile_id: Option<String>) -> Result<String, String> {
    if is_builtin_payday3_profile(profile_id.as_deref()) { return detect_payday3_path(); }
    let profile_id = clean_profile_id(profile_id.as_deref().unwrap_or_default())?;
    let settings = load_profile_settings_internal(&profile_id);
    let root = settings.game_root_override.as_deref().map(PathBuf::from).filter(|path| path.is_dir())
        .or_else(|| profile_installs::detected_builtin_game_root(&profile_id));
    let Some(root) = root else {
        return Ok(format!("{} is not installed in a detected Steam library. Choose its game folder in Profile Settings if it is installed elsewhere.", profile_id));
    };
    let executable = resolve_profile_executable(&profile_id, root.to_str(), None, settings.executable_override);
    match executable {
        Some(executable) => Ok(format!("Detected {} with launch executable {}.", root.display(), executable)),
        None => Ok(format!("Detected {}, but none of this profile's mapped launch executables exist there.", root.display())),
    }
}

#[tauri::command]
async fn scan_pak_mods(profile_id: Option<String>) -> Result<PakScanResult, String> {
    if !is_builtin_payday3_profile(profile_id.as_deref()) {
        return Ok(empty_profile_pak_scan_result());
    }

    tauri::async_runtime::spawn_blocking(scan_pak_mods_internal)
        .await
        .map_err(|err| format!("PAK scan task failed: {}", err))?
}

fn resolve_installed_file_path(paths: &PaydayPaths, file_name: &str) -> Option<PathBuf> {
    let clean = file_name.trim();

    if clean.is_empty() || clean.contains("..") || clean.contains('/') || clean.contains('\\') {
        return None;
    }

    let direct = paths.pak_mods.join(clean);

    if direct.exists() {
        return Some(direct);
    }

    let enabled = enabled_name_from_disabled(clean);
    let enabled_path = paths.pak_mods.join(&enabled);

    if enabled_path.exists() {
        return Some(enabled_path);
    }

    let disabled = disabled_name_from_enabled(clean);
    let disabled_path = paths.pak_mods.join(&disabled);

    if disabled_path.exists() {
        return Some(disabled_path);
    }

    let requested_stem = Path::new(&enabled)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();

    if requested_stem.is_empty() {
        return None;
    }

    if let Ok(entries) = fs::read_dir(&paths.pak_mods) {
        for entry in entries.flatten() {
            let path = entry.path();

            if !path.is_file() || !is_pak_related_file(&path) {
                continue;
            }

            let candidate_name = path.file_name().and_then(|value| value.to_str()).unwrap_or("");
            let candidate_enabled = enabled_name_from_disabled(candidate_name);
            let candidate_stem = Path::new(&candidate_enabled)
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_lowercase();

            if candidate_stem == requested_stem {
                return Some(path);
            }
        }
    }

    find_disabled_pak_file(paths, clean)
}

#[tauri::command]
fn uninstall_pak_mod_files(file_names: Vec<String>, profile_id: Option<String>) -> Result<String, String> {
    if !is_builtin_payday3_profile(profile_id.as_deref()) {
        return Err(profile_not_payday3_message(profile_id.as_deref()));
    }

    if let Some(message) = runtime_mutation_locked_message() {
        return Err(message);
    }

    let paths = detect_payday3_paths_internal()
        .ok_or_else(|| "Payday 3 not detected. Set a manual path in Settings.".to_string())?;

    if file_names.is_empty() {
        return Err("No files were selected for uninstall.".to_string());
    }

    let keep_uninstalled = keep_uninstalled_mods_enabled();
    let trash_root = uninstalled_dir()?.join(current_timestamp());
    if keep_uninstalled {
        fs::create_dir_all(&trash_root)
            .map_err(|err| format!("Failed to create uninstall holding folder: {}", err))?;
    }

    let mut removed = 0usize;
    let mut skipped = Vec::new();

    for file_name in file_names {
        let clean_name = file_name.trim();

        if clean_name.is_empty()
            || clean_name.contains("..")
            || clean_name.contains('/')
            || clean_name.contains('\\')
        {
            skipped.push(format!("Skipped unsafe file name '{}'", clean_name));
            continue;
        }

        let Some(source_path) = resolve_installed_file_path(&paths, clean_name) else {
            skipped.push(format!("Missing {}", clean_name));
            continue;
        };

        let actual_name = source_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(clean_name)
            .to_string();

        let source_parent = source_path.parent().map(PathBuf::from);
        if keep_uninstalled {
            let target_path = trash_root.join(&actual_name);

            if target_path.exists() {
                skipped.push(format!("Already moved target exists: {}", clean_name));
                continue;
            }

            if let Err(rename_err) = fs::rename(&source_path, &target_path) {
                fs::copy(&source_path, &target_path)
                    .map_err(|copy_err| format!("Failed to uninstall {}: rename failed ({}) and copy failed ({})", clean_name, rename_err, copy_err))?;

                fs::remove_file(&source_path)
                    .map_err(|remove_err| format!("Copied {} to uninstall holding folder but failed to remove original: {}", clean_name, remove_err))?;
            }
        } else {
            delete_file_permanently(&source_path, "uninstalled mod")?;
        }

        if let Some(parent) = source_parent {
            for root in disabled_pak_mods_root_candidates(&paths) {
                if parent.starts_with(&root) {
                    remove_empty_dirs_up_to(&parent, &root);
                }
            }
        }

        removed += 1;
    }

    let mut message = if keep_uninstalled {
        format!("Uninstalled {} file(s). Files were moved to: {}", removed, trash_root.display())
    } else {
        format!("Uninstalled {} file(s). Files were permanently deleted.", removed)
    };

    if !skipped.is_empty() {
        message.push_str(" | ");
        message.push_str(&skipped.join("; "));
    }

    Ok(message)
}

#[tauri::command]
fn open_pak_mods_folder(profile_id: Option<String>) -> Result<String, String> {
    if !is_builtin_payday3_profile(profile_id.as_deref()) {
        return Err("This profile does not have a PAYDAY 3 ~mods folder. Configure a profile-specific install path before opening it.".to_string());
    }

    let paths = detect_payday3_paths_internal()
        .ok_or_else(|| "Payday 3 not detected. Set a manual path in Settings.".to_string())?;

    if !paths.pak_mods.exists() {
        fs::create_dir_all(&paths.pak_mods)
            .map_err(|err| format!("Failed to create pak mods folder: {}", err))?;
    }

    Command::new("explorer")
        .arg(&paths.pak_mods)
        .spawn()
        .map_err(|err| format!("Failed to open pak mods folder: {}", err))?;

    Ok(format!("Opened {}", paths.pak_mods.display()))
}

#[tauri::command]
fn open_backups_folder() -> Result<String, String> {
    let backup_root = backups_dir()?;
    fs::create_dir_all(&backup_root)
        .map_err(|err| format!("Failed to create backups folder: {}", err))?;

    Command::new("explorer")
        .arg(&backup_root)
        .spawn()
        .map_err(|err| format!("Failed to open backups folder: {}", err))?;

    Ok(format!("Opened {}", backup_root.display()))
}

#[tauri::command]
fn open_mod_profiles_folder(game_profile_id: String) -> Result<String, String> {
    let game_profile_id = clean_profile_id(&game_profile_id)?;
    let profile_root = mod_profiles_dir_for_game_profile(&game_profile_id)?;
    fs::create_dir_all(&profile_root)
        .map_err(|err| format!("Failed to create profiles folder: {}", err))?;

    Command::new("explorer")
        .arg(&profile_root)
        .spawn()
        .map_err(|err| format!("Failed to open profiles folder: {}", err))?;

    Ok(format!("Opened {}", profile_root.display()))
}

fn open_folder_in_explorer(path: &Path, label: &str) -> Result<String, String> {
    fs::create_dir_all(path)
        .map_err(|err| format!("Failed to create {} folder {}: {}", label, path.display(), err))?;
    Command::new("explorer")
        .arg(path)
        .spawn()
        .map_err(|err| format!("Failed to open {} folder: {}", label, err))?;
    Ok(format!("Opened {}", path.display()))
}

#[tauri::command]
fn open_downloads_folder() -> Result<String, String> {
    open_folder_in_explorer(&downloads_cache_dir()?, "downloads")
}

#[tauri::command]
fn open_extraction_cache_folder() -> Result<String, String> {
    open_folder_in_explorer(&extraction_cache_dir()?, "extraction cache")
}

#[tauri::command]
fn open_receipts_folder() -> Result<String, String> {
    open_folder_in_explorer(&receipts_dir()?, "receipts")
}

#[tauri::command]
fn open_indexes_folder() -> Result<String, String> {
    open_folder_in_explorer(&cache_dir()?, "indexes")
}

#[tauri::command]
fn open_uninstalled_folder() -> Result<String, String> {
    open_folder_in_explorer(&uninstalled_dir()?, "recovery storage")
}

#[tauri::command]
fn open_logs_folder() -> Result<String, String> {
    open_folder_in_explorer(&app_data_dir()?.join("logs"), "logs")
}

#[tauri::command]
fn open_thumbnails_folder() -> Result<String, String> {
    open_folder_in_explorer(&cache_dir()?.join("thumbnails"), "thumbnails")
}
fn directory_size_and_file_count(path: &Path) -> (u64, usize) {
    fn visit(path: &Path, size: &mut u64, count: &mut usize) {
        let Ok(entries) = fs::read_dir(path) else {
            return;
        };

        for entry in entries.flatten() {
            let child = entry.path();
            if child.is_dir() {
                visit(&child, size, count);
            } else if child.is_file() {
                if let Ok(metadata) = fs::metadata(&child) {
                    *size = size.saturating_add(metadata.len());
                    *count += 1;
                }
            }
        }
    }

    if !path.exists() {
        return (0, 0);
    }

    let mut size = 0;
    let mut count = 0;
    visit(path, &mut size, &mut count);
    (size, count)
}

fn direct_child_directory_count(path: &Path) -> usize {
    fs::read_dir(path)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.flatten())
        .filter(|entry| entry.path().is_dir())
        .count()
}

fn direct_child_entry_count(path: &Path) -> usize {
    fs::read_dir(path)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.flatten())
        .count()
}

fn cache_stats_internal() -> Result<CacheStats, String> {
    let app_root = ensure_app_data_dirs()?;
    let cache_root = cache_dir()?;
    let downloads_root = downloads_cache_dir()?;
    let extraction_root = extraction_cache_dir()?;
    let uninstalled_root = uninstalled_dir()?;
    let receipts_root = receipts_dir()?;
    let backups_root = backups_dir()?;
    let logs_root = app_root.join("logs");
    let thumbnails_root = cache_root.join("thumbnails");
    let indexes_root = cache_root.clone();

    for folder in [
        &cache_root,
        &downloads_root,
        &extraction_root,
        &uninstalled_root,
        &receipts_root,
        &backups_root,
        &logs_root,
        &thumbnails_root,
    ] {
        fs::create_dir_all(folder)
            .map_err(|err| format!("Failed to create storage folder {}: {}", folder.display(), err))?;
    }

    let mut download_size = 0u64;
    let mut download_count = 0usize;
    for folder in source_download_cache_dirs()? {
        let (size, count) = directory_size_and_file_count(&folder);
        download_size = download_size.saturating_add(size);
        download_count += count;
    }

    let (extraction_size, _) = directory_size_and_file_count(&extraction_root);
    let (uninstalled_size, _) = directory_size_and_file_count(&uninstalled_root);
    let (receipts_size, receipt_count) = directory_size_and_file_count(&receipts_root);
    let (backups_size, backup_count) = directory_size_and_file_count(&backups_root);
    let (logs_size, log_count) = directory_size_and_file_count(&logs_root);
    let (thumbnails_size, thumbnail_count) = directory_size_and_file_count(&thumbnails_root);

    let mut indexes_size = 0u64;
    let mut index_file_count = 0usize;
    for file in [source_index_file_path()?, hash_cache_file_path()?] {
        if let Ok(metadata) = fs::metadata(&file) {
            if metadata.is_file() {
                indexes_size = indexes_size.saturating_add(metadata.len());
                index_file_count += 1;
            }
        }
    }

    Ok(CacheStats {
        app_data_path: app_root.display().to_string(),
        cache_path: cache_root.display().to_string(),
        download_cache_path: downloads_root.display().to_string(),
        extraction_cache_path: extraction_root.display().to_string(),
        uninstalled_path: uninstalled_root.display().to_string(),
        receipts_path: receipts_root.display().to_string(),
        indexes_path: indexes_root.display().to_string(),
        backups_path: backups_root.display().to_string(),
        logs_path: logs_root.display().to_string(),
        thumbnails_path: thumbnails_root.display().to_string(),
        download_cache_size_bytes: download_size,
        extraction_cache_size_bytes: extraction_size,
        total_cache_size_bytes: download_size
            .saturating_add(extraction_size)
            .saturating_add(indexes_size)
            .saturating_add(thumbnails_size),
        cached_download_count: download_count,
        temporary_extraction_folder_count: direct_child_directory_count(&extraction_root),
        uninstalled_storage_size_bytes: uninstalled_size,
        uninstalled_entry_count: direct_child_entry_count(&uninstalled_root),
        receipts_size_bytes: receipts_size,
        receipt_count,
        indexes_size_bytes: indexes_size,
        index_file_count,
        backups_size_bytes: backups_size,
        backup_count,
        logs_size_bytes: logs_size,
        log_count,
        thumbnails_size_bytes: thumbnails_size,
        thumbnail_count,
    })
}
#[tauri::command]
fn get_cache_stats() -> Result<CacheStats, String> {
    cache_stats_internal()
}

fn remove_dir_contents(path: &Path) -> Result<(u64, usize), String> {
    let before = directory_size_and_file_count(path);
    if !path.exists() {
        fs::create_dir_all(path)
            .map_err(|err| format!("Failed to create cache folder {}: {}", path.display(), err))?;
        return Ok(before);
    }

    for entry in fs::read_dir(path)
        .map_err(|err| format!("Failed to read cache folder {}: {}", path.display(), err))?
    {
        let entry = entry.map_err(|err| format!("Failed to read cache entry: {}", err))?;
        let child = entry.path();
        if child.is_dir() {
            fs::remove_dir_all(&child)
                .map_err(|err| format!("Failed to delete cache folder {}: {}", child.display(), err))?;
        } else if child.is_file() {
            fs::remove_file(&child)
                .map_err(|err| format!("Failed to delete cache file {}: {}", child.display(), err))?;
        }
    }

    Ok(before)
}

#[tauri::command]
fn clear_download_cache() -> Result<String, String> {
    let mut removed_size = 0u64;
    let mut removed_files = 0usize;

    for folder in source_download_cache_dirs()? {
        fs::create_dir_all(&folder)
            .map_err(|err| format!("Failed to prepare download cache folder {}: {}", folder.display(), err))?;
        let (size, count) = remove_dir_contents(&folder)?;
        removed_size = removed_size.saturating_add(size);
        removed_files += count;
    }

    Ok(format!("Cleared download cache: removed {} file(s), {} byte(s).", removed_files, removed_size))
}

#[tauri::command]
fn clear_extraction_cache() -> Result<String, String> {
    let folder = extraction_cache_dir()?;
    fs::create_dir_all(&folder)
        .map_err(|err| format!("Failed to prepare extraction cache folder: {}", err))?;
    let (size, count) = remove_dir_contents(&folder)?;
    Ok(format!("Cleared extraction cache: removed {} file(s), {} byte(s).", count, size))
}

#[tauri::command]
fn clear_all_download_cache() -> Result<String, String> {
    let downloads = clear_download_cache()?;
    let extraction = clear_extraction_cache()?;
    Ok(format!("{} {}", downloads, extraction))
}

#[tauri::command]
fn open_app_data_folder() -> Result<String, String> {
    let root = ensure_app_data_dirs()?;
    Command::new("explorer")
        .arg(&root)
        .spawn()
        .map_err(|err| format!("Failed to open Tsuki data folder: {}", err))?;
    Ok(format!("Opened {}", root.display()))
}

#[tauri::command]
fn open_cache_folder() -> Result<String, String> {
    let root = cache_dir()?;
    fs::create_dir_all(&root)
        .map_err(|err| format!("Failed to create cache folder: {}", err))?;
    Command::new("explorer")
        .arg(&root)
        .spawn()
        .map_err(|err| format!("Failed to open cache folder: {}", err))?;
    Ok(format!("Opened {}", root.display()))
}

#[tauri::command]
fn save_cache_settings(keep_downloaded_archives: bool) -> Result<String, String> {
    let mut settings = load_settings_internal();
    settings.keep_downloaded_archives = keep_downloaded_archives;
    save_settings_internal(&settings)?;
    Ok(if keep_downloaded_archives {
        "Downloaded archives will be kept after successful installs.".to_string()
    } else {
        "Downloaded archives will be deleted after successful installs.".to_string()
    })
}

#[tauri::command]
fn save_uninstall_storage_settings(keep_uninstalled_mods: bool) -> Result<String, String> {
    let mut settings = load_settings_internal();
    settings.keep_uninstalled_mods = keep_uninstalled_mods;
    save_settings_internal(&settings)?;
    Ok(if keep_uninstalled_mods {
        "Uninstalled mods will be moved to Tsuki's uninstalled storage.".to_string()
    } else {
        "Uninstalled mods will be permanently deleted to reclaim disk space.".to_string()
    })
}

#[tauri::command]
fn list_pak_backups() -> Result<Vec<PakBackupInfo>, String> {
    list_pak_backups_internal()
}

#[tauri::command]
fn get_backup_status(state: tauri::State<'_, BackupState>) -> Result<BackupProgress, String> {
    state
        .progress
        .lock()
        .map(|progress| progress.clone())
        .map_err(|_| "Backup status lock is poisoned.".to_string())
}

#[tauri::command]
async fn create_pak_backup(
    app: tauri::AppHandle,
    state: tauri::State<'_, BackupState>,
    backup_name: String,
) -> Result<String, String> {
    {
        let mut progress = state
            .progress
            .lock()
            .map_err(|_| "Backup status lock is poisoned.".to_string())?;

        if progress.is_running {
            return Err("A backup is already running. Wait for it to finish first.".to_string());
        }

        *progress = BackupProgress {
            is_running: true,
            message: "Starting backup...".to_string(),
            current: 0,
            total: 0,
        };
    }

    let app_for_task = app.clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        create_pak_backup_internal(app_for_task, backup_name)
    })
    .await
    .map_err(|err| format!("Backup task failed: {}", err))?;

    if result.is_err() {
        set_backup_progress(
            &app,
            BackupProgress {
                is_running: false,
                message: "Backup failed.".to_string(),
                current: 0,
                total: 0,
            },
        );
    }

    result
}


#[tauri::command]
fn open_backup_file(file_name: String) -> Result<String, String> {
    let backup = backup_info_for_file(&file_name)?;

    Command::new("explorer")
        .arg("/select,")
        .arg(&backup.full_path)
        .spawn()
        .map_err(|err| format!("Failed to open backup in Explorer: {}", err))?;

    Ok(format!("Opened {}", backup.file_name))
}

#[tauri::command]
fn inspect_pak_backup(file_name: String) -> Result<PakBackupInspectResult, String> {
    inspect_pak_backup_internal(file_name)
}

#[tauri::command]
fn restore_pak_backup(file_name: String) -> Result<String, String> {
    let backup = backup_info_for_file(&file_name)?;
    let paths = detect_payday3_paths_internal()
        .ok_or_else(|| "PAYDAY 3 was not detected. Set the game path in Settings first.".to_string())?;

    fs::create_dir_all(&paths.pak_mods)
        .map_err(|err| format!("Failed to create pak mods folder {}: {}", paths.pak_mods.display(), err))?;

    let backup_file = File::open(&backup.full_path)
        .map_err(|err| format!("Failed to open backup zip: {}", err))?;

    let mut archive = ZipArchive::new(backup_file)
        .map_err(|err| format!("Failed to read backup zip: {}", err))?;

    let keep_uninstalled = keep_uninstalled_mods_enabled();
    let holding_root = uninstalled_dir()?.join(format!("backup_restore_conflict_{}", current_timestamp()));
    let mut restored = 0usize;
    let mut moved_conflicts = 0usize;
    let mut notes = Vec::new();

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|err| format!("Failed to read backup zip entry: {}", err))?;

        if entry.is_dir() {
            continue;
        }

        let zip_path = entry.name().replace('\\', "/");
        let file_name = Path::new(&zip_path)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_string();

        if file_name.trim().is_empty()
            || file_name.contains("..")
            || file_name.contains('/')
            || file_name.contains('\\')
        {
            notes.push(format!("Skipped unsafe backup entry {}", zip_path));
            continue;
        }

        let extension = Path::new(&file_name)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();

        if extension != "pak" && extension != "ucas" && extension != "utoc" {
            continue;
        }

        let destination = paths.pak_mods.join(&file_name);

        if destination.exists() && destination.is_file() {
            if let Some(moved) = move_path_to_uninstalled(&destination, &holding_root)? {
                moved_conflicts += 1;
                notes.push(if keep_uninstalled {
                    format!("Moved existing {} to {}", file_name, moved)
                } else {
                    format!("Deleted existing {}", file_name)
                });
            }
        }

        let mut output = File::create(&destination)
            .map_err(|err| format!("Failed to restore {}: {}", destination.display(), err))?;

        io::copy(&mut entry, &mut output)
            .map_err(|err| format!("Failed to write {}: {}", destination.display(), err))?;

        output
            .flush()
            .map_err(|err| format!("Failed to flush {}: {}", destination.display(), err))?;

        restored += 1;
    }

    if restored == 0 {
        return Err(format!("Backup '{}' did not contain any .pak/.ucas/.utoc files to restore.", backup.file_name));
    }

    let _ = sync_installed_state_database();

    let mut message = format!(
        "Restored {} PAK-family file(s) from backup '{}'. {} {} conflicting current file(s){}.",
        restored,
        backup.file_name,
        if keep_uninstalled { "Moved" } else { "Deleted" },
        moved_conflicts,
        if keep_uninstalled { " to Tsuki's uninstalled/conflict folder" } else { "" }
    );

    if !notes.is_empty() {
        message.push_str(&format!(" Notes: {}", notes.into_iter().take(8).collect::<Vec<_>>().join(" | ")));
    }

    Ok(message)
}

#[tauri::command]
fn delete_pak_backup(file_name: String) -> Result<String, String> {
    let backup_root = backups_dir()?;
    let candidate = backup_root.join(&file_name);

    let canonical_root = backup_root
        .canonicalize()
        .map_err(|err| format!("Failed to read backups folder: {}", err))?;

    let canonical_candidate = candidate
        .canonicalize()
        .map_err(|_| "Backup file was not found.".to_string())?;

    if !canonical_candidate.starts_with(&canonical_root) {
        return Err("Refusing to delete a file outside the backups folder.".to_string());
    }

    if canonical_candidate.extension().and_then(|value| value.to_str()) != Some("zip") {
        return Err("Refusing to delete non-zip backup file.".to_string());
    }

    fs::remove_file(&canonical_candidate)
        .map_err(|err| format!("Failed to delete backup: {}", err))?;

    Ok(format!("Deleted backup: {}", file_name))
}

fn format_last_install_diagnostic_for_report() -> String {
    let Some(report) = read_last_install_diagnostic() else {
        return "Last Install Diagnostic: none\n".to_string();
    };

    let mut lines = Vec::new();
    lines.push("Last Install Diagnostic:".to_string());
    lines.push(format!("  Status: {}", report.status));
    lines.push(format!("  Time Unix: {}", report.timestamp_unix));
    lines.push(format!("  Mod: {}", report.mod_name));
    lines.push(format!("  Source: {}", report.source));
    lines.push(format!("  Mod ID: {}", report.mod_id));
    lines.push(format!("  File ID: {}", report.file_id));
    lines.push(format!("  Selected File Name: {}", report.selected_file_name.unwrap_or_else(|| "unknown".to_string())));
    lines.push(format!("  URL Host/Path: {}", report.download_url_host_path.unwrap_or_else(|| "unknown".to_string())));
    lines.push(format!("  HTTP Status: {}", report.http_status.map(|value| value.to_string()).unwrap_or_else(|| "unknown".to_string())));
    lines.push(format!("  Content Type: {}", report.content_type.unwrap_or_else(|| "unknown".to_string())));
    lines.push(format!("  Content-Disposition: {}", report.content_disposition.unwrap_or_else(|| "unknown".to_string())));
    lines.push(format!("  Saved Filename: {}", report.saved_file_name.unwrap_or_else(|| "unknown".to_string())));
    lines.push(format!("  Saved File Kind: {}", report.saved_file_kind.unwrap_or_else(|| "unknown".to_string())));
    lines.push(format!("  Staged File: {}", report.staged_file_path.unwrap_or_else(|| "none".to_string())));
    lines.push(format!("  Archive Kind: {}", report.archive_kind.unwrap_or_else(|| "unknown".to_string())));
    lines.push(format!("  Download Size Bytes: {}", report.download_size_bytes.map(|value| value.to_string()).unwrap_or_else(|| "unknown".to_string())));
    lines.push(format!("  Archive Entry Count: {}", report.archive_entry_count.max(report.entries.len())));
    lines.push(format!("  Installable Count: {}", report.installable_count));
    lines.push(format!("  Skipped Count: {}", report.skipped_count));
    lines.push(format!("  Route Entries: {}", report.entries.len()));
    lines.push(format!("  Installed Files: {}", report.installed_files.len()));
    lines.push(format!("  Replaced Files: {}", report.replaced_files.len()));

    if let Some(error) = report.error {
        lines.push(format!("  Error: {}", error));
    }

    if !report.warnings.is_empty() {
        lines.push("  Warnings:".to_string());

        for warning in report.warnings.iter().take(12) {
            lines.push(format!("    - {}", warning));
        }
    }

    if !report.entries.is_empty() {
        if !report.first_archive_entries.is_empty() {
            lines.push("  First Archive Entries:".to_string());

            for entry in report.first_archive_entries.iter().take(20) {
                lines.push(format!("    - {}", entry));
            }
        }

        lines.push("  Routing:".to_string());

        for entry in report.entries.iter().take(30) {
            lines.push(format!(
                "    - {} -> {} [{} | {} | blocked: {}]",
                entry.archive_path,
                entry.destination,
                entry.route_kind,
                entry.confidence,
                entry.blocked
            ));
            lines.push(format!("      Reason: {}", entry.reason));
        }

        if report.entries.len() > 30 {
            lines.push(format!("    ... {} more route entries", report.entries.len() - 30));
        }
    }

    if !report.installed_files.is_empty() {
        lines.push("  Installed Paths:".to_string());

        for file in report.installed_files.iter().take(30) {
            lines.push(format!("    - {} -> {}", file.archive_path, file.destination));
        }

        if report.installed_files.len() > 30 {
            lines.push(format!("    ... {} more installed files", report.installed_files.len() - 30));
        }
    }

    if let Some(receipt_path) = report.receipt_path {
        lines.push(format!("  Receipt: {}", receipt_path));
    }

    lines.push(String::new());
    lines.join("\n")
}

#[tauri::command]
fn get_last_install_diagnostic() -> Result<String, String> {
    if let Some(report) = read_last_install_diagnostic() {
        serde_json::to_string_pretty(&report)
            .map_err(|err| format!("Failed to serialize last install diagnostic: {}", err))
    } else {
        Ok("No install diagnostic has been recorded yet.".to_string())
    }
}

#[tauri::command]
fn get_debug_report() -> Result<String, String> {
    let app_root = ensure_app_data_dirs()?;
    let settings = load_settings_internal();
    let os = env::consts::OS;
    let arch = env::consts::ARCH;
    let current_dir = env::current_dir()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|_| "unknown".to_string());

    let detected_paths = detect_payday3_paths_internal();
    let path_status = format_path_status(detected_paths.as_ref());
    let pak_file_count = scan_pak_mods_internal()
        .map(|result| result.pak_file_count)
        .unwrap_or(0);
    let backups = list_pak_backups_internal().unwrap_or_default();
    let backup_count = backups.len();
    let backup_total_size: u64 = backups.iter().map(|backup| backup.size_bytes).sum();
    let latest_backup = backups
        .first()
        .map(|backup| backup.file_name.as_str())
        .unwrap_or("none");
    let install_receipts = list_install_receipts_internal().unwrap_or_default();
    let install_receipt_count = install_receipts.len();
    let install_receipt_file_count: usize = install_receipts.iter().map(|receipt| receipt.files.len()).sum();
    let installed_state_records = rebuild_installed_state_database_internal()
        .map(|database| database.records.len())
        .unwrap_or(0);
    let persistent_pairs = read_persistent_pair_database().pairs;
    let persistent_pair_count = persistent_pairs.len();
    let persistent_pair_nexus_count = persistent_pairs.iter().filter(|pair| pair.source.eq_ignore_ascii_case("nexus")).count();
    let persistent_pair_modworkshop_count = persistent_pairs.iter().filter(|pair| pair.source.eq_ignore_ascii_case("modworkshop")).count();
    let source_index = read_source_index_database();
    let source_index_count = source_index.records.len();
    let source_index_nexus_count = source_index.records.values().filter(|record| record.source.eq_ignore_ascii_case("nexus")).count();
    let source_index_modworkshop_count = source_index.records.values().filter(|record| record.source.eq_ignore_ascii_case("modworkshop")).count();
    let hash_cache_count = read_hash_cache().len();
    let cache_stats = cache_stats_internal().ok();

    let manual_path = settings
        .game_path
        .as_deref()
        .unwrap_or("not set");

    let report = format!(
        "Tsuki Mod Manager Debug Report\n\
Version: {version}\n\
Backend: Rust/Tauri online\n\
OS: {os}\n\
Architecture: {arch}\n\
Timestamp Unix: {timestamp}\n\
Current Working Directory: {cwd}\n\
AppData Root: {app_root}\n\
Settings File: {settings_file}\n\
Saved Manual Payday 3 Path: {manual_path}\n\
Saved Theme: {theme_id}\n\
ModWorkshop API Key Saved: {modworkshop_key_saved}\n\
Nexus API Key Saved: {nexus_key_saved}\n\
Nexus Age-Restricted Mods Enabled: {show_age_restricted_nexus}\n\
App Update Manifest URL: {app_update_manifest_url}\n\
Logs Folder: {logs}\n\
Backups Folder: {backups_folder}\n\
Pak Backups: {backup_count}\n\
Pak Backups Total Size Bytes: {backup_total_size}\n\
Latest Pak Backup: {latest_backup}\n\
Install Receipts: {install_receipt_count}\n\
Install Receipt Tracked Files: {install_receipt_file_count}\n\
Cache Folder: {cache}\n\
Download Cache Size Bytes: {download_cache_size_bytes}\n\
Extraction Cache Size Bytes: {extraction_cache_size_bytes}\n\
Cached Downloads: {cached_download_count}\n\
Temporary Extraction Folders: {temporary_extraction_folder_count}\n\
Uninstalled Storage Size Bytes: {uninstalled_storage_size_bytes}\n\
Uninstalled Entry Count: {uninstalled_entry_count}\n\
Receipts Folder: {receipts}\n\
Profiles Folder: {profiles}\n\
Installed State File: {installed_state_file}\n\
Installed State Records: {installed_state_records}\n\
Persistent Pairs File: {persistent_pairs_file}\n\
Persistent Pairs: {persistent_pair_count} (Nexus {persistent_pair_nexus_count}, ModWorkshop {persistent_pair_modworkshop_count})\n\
Source Index Records: {source_index_count} (Nexus {source_index_nexus_count}, ModWorkshop {source_index_modworkshop_count})\n\
Hash Cache Entries: {hash_cache_count}\n\
Nexus Browse Order: live source pages decide ordering/page membership; cache/source-index may only appear as temporary metadata placeholders. Detail files are live-only.\n\
Progress Events: Browse live load/search/detail/download/install + Installed scan/detail/try-pair/reinstall/rebuild\nWrong-game Pair Guard: rejects RAID/PD2/other-game ModWorkshop cards before scoring; exact PAK stem matches can pair\n\
{modworkshop_pairing_diagnostics}\
Nexus GraphQL v2 Endpoint: https://api.nexusmods.com/v2/graphql\n\
{nexus_graphql_diagnostic}\
Audit Cleanup: Home automatic matching capped/manual only; Installed auto-pair disabled on open\n\
Nexus v0.98.1: search command + ordered rebuild, no raw ID browse paging + compile-fixed source-index cache fallback\n\
Release v1.0.7.27.3: compile fix for unused ModWorkshop search page state\nv1.8.32: cleaned profile view/folder opener and unified source detail page template\nv1.8.34: profile cards/folder opener + unified Browse/Installed detail downloads cleanup\nv1.8.35: detail tabs/files/comments/changelog + rebuilt themes and profile sizing\nv1.8.36: file grouping, unified installed details, author fallback, theme surface fixes\n\
v1.8.37: author fallback on cards, responsive details, Browse back restore, Home/Installed theme coverage\n\
v1.8.38: ModWorkshop author-card rescue, faster detail tabs, Settings makeover with dev tools removed from normal view\n\
v1.8.2: setup wizard, session-only debug logs, home ModWorkshop descriptions, faster detail actions, Settings cleanup\n\
{path_status}\n\
Installed Pak Files: {pak_file_count}\n\
Enabled Pak Files: {pak_file_count}\n\
Active Profile: Default\n\
{last_install_diagnostic}\
{runtime_process_diagnostic}\
Last Error: none\n\
Session Debug Log:\n\
- Backend debug report generated for this request\n\
- AppData folders verified during this request\n\
- Settings loaded during this request\n\
- PAYDAY 3 paths checked during this request\n\
- Pak mods indexed during this request\n\
- Backups indexed during this request",
        version = APP_VERSION,
        os = os,
        arch = arch,
        timestamp = current_timestamp(),
        cwd = current_dir,
        app_root = app_root.display(),
        settings_file = settings_file_path()?.display(),
        manual_path = manual_path,
        theme_id = settings.theme_id,
        modworkshop_key_saved = settings.modworkshop_api_key.as_ref().map(|key| !key.is_empty()).unwrap_or(false),
        nexus_key_saved = settings.nexus_api_key.as_ref().map(|key| !key.is_empty()).unwrap_or(false),
        show_age_restricted_nexus = settings.show_age_restricted_nexus,
        app_update_manifest_url = format!("built-in {}", DEFAULT_APP_UPDATE_MANIFEST_URL),
        logs = app_root.join("logs").display(),
        backups_folder = app_root.join("backups").display(),
        backup_count = backup_count,
        backup_total_size = backup_total_size,
        latest_backup = latest_backup,
        install_receipt_count = install_receipt_count,
        install_receipt_file_count = install_receipt_file_count,
        cache = app_root.join("cache").display(),
        download_cache_size_bytes = cache_stats.as_ref().map(|stats| stats.download_cache_size_bytes).unwrap_or(0),
        extraction_cache_size_bytes = cache_stats.as_ref().map(|stats| stats.extraction_cache_size_bytes).unwrap_or(0),
        cached_download_count = cache_stats.as_ref().map(|stats| stats.cached_download_count).unwrap_or(0),
        temporary_extraction_folder_count = cache_stats.as_ref().map(|stats| stats.temporary_extraction_folder_count).unwrap_or(0),
        uninstalled_storage_size_bytes = cache_stats.as_ref().map(|stats| stats.uninstalled_storage_size_bytes).unwrap_or(0),
        uninstalled_entry_count = cache_stats.as_ref().map(|stats| stats.uninstalled_entry_count).unwrap_or(0),
        receipts = app_root.join("receipts").display(),
        profiles = app_root.join("profiles").display(),
        installed_state_file = installed_state_file_path()?.display(),
        installed_state_records = installed_state_records,
        persistent_pairs_file = persistent_pairs_file_path()?.display(),
        persistent_pair_count = persistent_pair_count,
        persistent_pair_nexus_count = persistent_pair_nexus_count,
        persistent_pair_modworkshop_count = persistent_pair_modworkshop_count,
        source_index_count = source_index_count,
        source_index_nexus_count = source_index_nexus_count,
        source_index_modworkshop_count = source_index_modworkshop_count,
        hash_cache_count = hash_cache_count,
        nexus_graphql_diagnostic = format_nexus_graphql_diagnostic_for_report(),
        modworkshop_pairing_diagnostics = format_modworkshop_pairing_diagnostics_for_report(),
        path_status = path_status,
        pak_file_count = pak_file_count,
        last_install_diagnostic = format_last_install_diagnostic_for_report(),
        runtime_process_diagnostic = format_runtime_process_diagnostic_for_report(),
    );

    Ok(report)
}

#[tauri::command]
fn run_health_check() -> Result<String, String> {
    let app_root = ensure_app_data_dirs()?;
    let settings = load_settings_internal();
    let detected_paths = detect_payday3_paths_internal();
    let backups = list_pak_backups_internal().unwrap_or_default();
    let backup_total_size: u64 = backups.iter().map(|backup| backup.size_bytes).sum();

    let mut lines = Vec::new();
    lines.push("Health Check Result".to_string());
    lines.push("✓ Rust backend responded".to_string());
    lines.push(format!("✓ AppData root exists: {}", app_root.display()));
    lines.push(format!("✓ Saved theme: {}", settings.theme_id));
    lines.push(format!(
        "ⓘ ModWorkshop API key saved: {}",
        settings.modworkshop_api_key.as_ref().map(|key| !key.is_empty()).unwrap_or(false)
    ));
    lines.push(format!(
        "ⓘ Nexus API key saved: {}",
        settings.nexus_api_key.as_ref().map(|key| !key.is_empty()).unwrap_or(false)
    ));
    let install_receipts = list_install_receipts_internal().unwrap_or_default();
    let install_receipt_file_count: usize = install_receipts.iter().map(|receipt| receipt.files.len()).sum();
    lines.push(format!("✓ Pak backups found: {}", backups.len()));
    lines.push(format!("✓ Install receipts found: {}", install_receipts.len()));
    lines.push(format!("✓ Receipt tracked files: {}", install_receipt_file_count));
    lines.push(format!("✓ Pak backup space used: {} bytes", backup_total_size));

    match settings.game_path {
        Some(path) => lines.push(format!("✓ Manual path saved: {}", path)),
        None => lines.push("ⓘ Manual path not set. Auto-detection is being used.".to_string()),
    }

    for folder in ["logs", "backups", "cache", "receipts", "profiles", "profile-settings", "profile-data", "game-profile-drafts", "uninstalled", "diagnostics"] {
        let path = app_root.join(folder);
        if path.exists() {
            lines.push(format!("✓ {} folder exists", folder));
        } else {
            lines.push(format!("⚠ {} folder missing", folder));
        }
    }

    match detected_paths {
        Some(paths) => {
            lines.push(format!("✓ Payday 3 detected: {}", paths.game_root.display()));
            lines.push(format!("{} Pak mods folder: {}", if paths.pak_mods.exists() { "✓" } else { "⚠" }, paths.pak_mods.display()));
            lines.push(format!("{} Win64 folder: {}", if paths.win64.exists() { "✓" } else { "⚠" }, paths.win64.display()));
            lines.push(format!("{} UE4SS mods folder: {}", if paths.ue4ss_mods.exists() { "✓" } else { "⚠" }, paths.ue4ss_mods.display()));

            match scan_pak_mods_internal() {
                Ok(scan) => lines.push(format!("✓ Pak-related files found: {}", scan.pak_file_count)),
                Err(error) => lines.push(format!("⚠ Pak scan failed: {}", error)),
            }
        }
        None => {
            lines.push("⚠ Payday 3 path not detected".to_string());
        }
    }

    lines.push("⚠ Restore not implemented yet. Backups can be created and deleted only.".to_string());
    lines.push("ⓘ Pak backups include .pak files only and use no compression for speed.".to_string());
    lines.push("ⓘ UE4SS/Win64 backups require future install receipts and are not guessed.".to_string());
    lines.push("Score: backup foundation online, restore pending".to_string());

    Ok(lines.join("\n"))
}


#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceFileItem {
    id: String,
    name: String,
    version: Option<String>,
    size_label: Option<String>,
    uploaded_at: Option<String>,
    download_url: Option<String>,
    file_type: Option<String>,
    download_count: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceImageItem {
    id: String,
    title: Option<String>,
    image_url: String,
    thumbnail_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceStatItem {
    label: String,
    value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallPreviewItem {
    source_name: String,
    route_kind: String,
    confidence: String,
    destination: String,
    reason: String,
    safety_notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallPreview {
    game_root: String,
    items: Vec<InstallPreviewItem>,
    warnings: Vec<String>,
    blocked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveInspectEntry {
    archive_path: String,
    route_kind: String,
    destination: String,
    confidence: String,
    reason: String,
    blocked: bool,
    size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StagedDownloadResult {
    mod_name: String,
    file_name: String,
    staged_file_path: String,
    staged_folder_path: String,
    size_bytes: u64,
    archive_kind: String,
    entries: Vec<ArchiveInspectEntry>,
    warnings: Vec<String>,
    can_install_later: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppliedInstallFile {
    archive_path: String,
    destination: String,
    size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallApplyResult {
    mod_name: String,
    installed_files: Vec<AppliedInstallFile>,
    replaced_files: Vec<String>,
    receipt_path: String,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallDiagnosticEntry {
    archive_path: String,
    route_kind: String,
    destination: String,
    confidence: String,
    reason: String,
    blocked: bool,
    size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LastInstallDiagnostic {
    timestamp_unix: u64,
    status: String,
    mod_name: String,
    source: String,
    mod_id: String,
    file_id: String,
    #[serde(default)]
    download_url_host_path: Option<String>,
    #[serde(default)]
    http_status: Option<u16>,
    #[serde(default)]
    content_type: Option<String>,
    #[serde(default)]
    content_disposition: Option<String>,
    #[serde(default)]
    selected_file_name: Option<String>,
    #[serde(default)]
    saved_file_name: Option<String>,
    #[serde(default)]
    saved_file_kind: Option<String>,
    staged_file_path: Option<String>,
    staged_folder_path: Option<String>,
    archive_kind: Option<String>,
    download_size_bytes: Option<u64>,
    #[serde(default)]
    archive_entry_count: usize,
    #[serde(default)]
    installable_count: usize,
    #[serde(default)]
    skipped_count: usize,
    #[serde(default)]
    first_archive_entries: Vec<String>,
    entries: Vec<InstallDiagnosticEntry>,
    installed_files: Vec<AppliedInstallFile>,
    replaced_files: Vec<String>,
    receipt_path: Option<String>,
    warnings: Vec<String>,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceModSummary {
    source: String,
    source_id: String,
    uid: Option<String>,
    game_id: Option<String>,
    name: String,
    author: Option<String>,
    author_username: Option<String>,
    author_user_id: Option<String>,
    author_profile_url: Option<String>,
    author_avatar_url: Option<String>,
    version: Option<String>,
    thumbnail_url: Option<String>,
    banner_url: Option<String>,
    page_url: Option<String>,
    updated_at: Option<String>,
    downloads: Option<u64>,
    likes: Option<u64>,
    short_description: Option<String>,
    tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceCategory {
    id: String,
    label: String,
}

#[derive(Debug, Clone)]
struct InstalledMatchCandidate {
    file_name: String,
    normalized_name: String,
    compact_name: String,
    modified_unix: Option<u64>,
    size_bytes: u64,
    sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledSourceMatch {
    source: String,
    source_id: String,
    installed: bool,
    enabled: bool,
    update_available: bool,
    confidence: u32,
    reason: String,
    matched_files: Vec<String>,
    source_file_id: Option<String>,
    source_file_name: Option<String>,
    source_file_category: Option<String>,
    source_file_uploaded_at: Option<String>,
    source_file_version: Option<String>,
    installed_modified_unix: Option<u64>,
    source_updated_at: Option<String>,
    source_updated_unix: Option<u64>,
    match_kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceModDetail {
    source: String,
    source_id: String,
    uid: Option<String>,
    game_id: Option<String>,
    name: String,
    author: Option<String>,
    author_username: Option<String>,
    author_user_id: Option<String>,
    author_profile_url: Option<String>,
    author_avatar_url: Option<String>,
    version: Option<String>,
    thumbnail_url: Option<String>,
    banner_url: Option<String>,
    page_url: Option<String>,
    updated_at: Option<String>,
    downloads: Option<u64>,
    likes: Option<u64>,
    short_description: Option<String>,
    tags: Vec<String>,
    description: String,
    changelog: Option<String>,
    files: Vec<SourceFileItem>,
    images: Vec<SourceImageItem>,
    dependencies: Vec<SourceDependencyItem>,
    comments: Vec<String>,
    bugs: Vec<String>,
    logs: Vec<String>,
    stats: Vec<SourceStatItem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceDependencyItem {
    id: String,
    name: String,
    required: bool,
    optional: bool,
    source_kind: Option<String>,
    game_domain: Option<String>,
    numeric_game_id: Option<String>,
    mod_id: Option<String>,
    url: Option<String>,
    notes: Option<String>,
    version_constraint: Option<String>,
}

trait JsonStringKeys {
    fn find_string(self, value: &serde_json::Value) -> Option<String>;
}

impl JsonStringKeys for &str {
    fn find_string(self, value: &serde_json::Value) -> Option<String> {
        value
            .get(self)
            .and_then(|entry| entry.as_str())
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .map(ToString::to_string)
    }
}

impl JsonStringKeys for &[&str] {
    fn find_string(self, value: &serde_json::Value) -> Option<String> {
        for key in self {
            if let Some(text) = value.get(*key).and_then(|entry| entry.as_str()) {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
        None
    }
}

impl<const N: usize> JsonStringKeys for &[&str; N] {
    fn find_string(self, value: &serde_json::Value) -> Option<String> {
        self.as_slice().find_string(value)
    }
}

fn json_string<K: JsonStringKeys>(value: &serde_json::Value, keys: K) -> Option<String> {
    keys.find_string(value)
}

fn json_u64(value: &serde_json::Value, keys: &[&str]) -> Option<u64> {
    for key in keys {
        if let Some(number) = value.get(*key).and_then(|v| v.as_u64()) {
            return Some(number);
        }
        if let Some(text) = value.get(*key).and_then(|v| v.as_str()) {
            if let Ok(number) = text.parse::<u64>() {
                return Some(number);
            }
        }
    }
    None
}

fn normalize_nexus_id_string(value: &str) -> Option<String> {
    let trimmed = value.trim();

    if trimmed.is_empty()
        || trimmed.eq_ignore_ascii_case("undefined")
        || trimmed.eq_ignore_ascii_case("null")
    {
        return None;
    }

    Some(trimmed.to_string())
}

fn json_id_string(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        let Some(child) = value.get(*key) else {
            continue;
        };

        if let Some(text) = child.as_str() {
            if let Some(normalized) = normalize_nexus_id_string(text) {
                return Some(normalized);
            }
        }

        if let Some(number) = child.as_u64() {
            return Some(number.to_string());
        }

        if let Some(number) = child.as_i64() {
            if number >= 0 {
                return Some(number.to_string());
            }
        }
    }

    None
}

const MODWORKSHOP_PAYDAY3_GAME_ID: &str = "payday-3";
const MODWORKSHOP_PAYDAY3_NUMERIC_GAME_ID: &str = "853";

fn normalize_modworkshop_id_string(value: &str) -> Option<String> {
    let trimmed = value.trim();

    if trimmed.is_empty()
        || trimmed.eq_ignore_ascii_case("undefined")
        || trimmed.eq_ignore_ascii_case("null")
    {
        return None;
    }

    Some(trimmed.to_string())
}

fn json_modworkshop_id_string(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        let Some(child) = value.get(*key) else {
            continue;
        };

        if let Some(text) = child.as_str() {
            if let Some(normalized) = normalize_modworkshop_id_string(text) {
                return Some(normalized);
            }
        }

        if let Some(number) = child.as_u64() {
            return Some(number.to_string());
        }

        if let Some(number) = child.as_i64() {
            if number >= 0 {
                return Some(number.to_string());
            }
        }
    }

    None
}

fn is_modworkshop_payday3_game_id(value: &str) -> bool {
    let normalized = value.trim().to_lowercase().replace('_', "-");

    matches!(
        normalized.as_str(),
        "payday-3" | "payday3" | "pd3" | "payday 3" | "payday_3" | MODWORKSHOP_PAYDAY3_NUMERIC_GAME_ID
    )
}

fn modworkshop_game_id_from_value(value: &serde_json::Value) -> Option<String> {
    json_modworkshop_id_string(value, &["game_id", "gameId", "game", "game_slug", "gameSlug", "game_name", "gameName"])
        .or_else(|| {
            value.get("game")
                .and_then(|game| {
                    json_modworkshop_id_string(game, &["id", "slug", "name", "shortName", "short_name"])
                })
        })
        .or_else(|| {
            value.get("category")
                .and_then(|category| {
                    json_modworkshop_id_string(category, &["game_id", "gameId", "game"])
                })
        })
}

fn json_timestamp_string(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(number) = value.get(*key).and_then(|v| v.as_i64()) {
            return Some(number.to_string());
        }

        if let Some(number) = value.get(*key).and_then(|v| v.as_u64()) {
            return Some(number.to_string());
        }

        if let Some(text) = value.get(*key).and_then(|v| v.as_str()) {
            if !text.trim().is_empty() {
                return Some(text.to_string());
            }
        }
    }

    None
}

fn parse_source_timestamp_to_unix(value: Option<&str>) -> Option<u64> {
    let text = value?.trim();

    if text.is_empty() || text.eq_ignore_ascii_case("unknown") {
        return None;
    }

    if let Ok(number) = text.parse::<u64>() {
        // Nexus/ModWorkshop sometimes return milliseconds.
        if number > 9_999_999_999 {
            return Some(number / 1000);
        }

        return Some(number);
    }

    // Keep this dependency-free. ISO dates are kept in source_updated_at for display,
    // and update checks can still compare exact file IDs/versions through receipts.
    None
}

fn best_nexus_date(value: &serde_json::Value) -> Option<String> {
    json_timestamp_string(value, &[
        "updated_timestamp",
        "updatedTimestamp",
        "updated_time",
        "updatedTime",
        "latest_file_update",
        "latestFileUpdate",
        "created_timestamp",
        "createdTimestamp",
        "created_time",
        "createdTime",
        "uploaded_time",
        "uploadedTime",
    ])
}

fn json_array<'a>(value: &'a serde_json::Value, keys: &[&str]) -> Vec<&'a serde_json::Value> {
    for key in keys {
        if let Some(array) = value.get(*key).and_then(|v| v.as_array()) {
            return array.iter().collect();
        }
    }
    Vec::new()
}

fn unwrap_data(value: serde_json::Value) -> serde_json::Value {
    if let Some(data) = value.get("data") {
        return data.clone();
    }
    value
}

fn absolutize_source_url(source: &str, url: Option<String>) -> Option<String> {
    let raw = url?;
    let trimmed = raw.trim();

    if trimmed.is_empty() {
        return None;
    }

    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return Some(trimmed.to_string());
    }

    if trimmed.starts_with("//") {
        return Some(format!("https:{}", trimmed));
    }

    if source == "modworkshop" {
        if trimmed.starts_with('/') {
            return Some(format!("https://modworkshop.net{}", trimmed));
        }

        return Some(format!("https://modworkshop.net/{}", trimmed.trim_start_matches("./")));
    }

    if source == "nexus" {
        if trimmed.starts_with('/') {
            return Some(format!("https://www.nexusmods.com{}", trimmed));
        }

        return Some(trimmed.to_string());
    }

    Some(trimmed.to_string())
}

fn json_nested_string(value: &serde_json::Value, paths: &[&[&str]]) -> Option<String> {
    for path in paths {
        let mut current = value;

        for key in *path {
            current = current.get(*key)?;
        }

        if let Some(text) = current.as_str() {
            if !text.trim().is_empty() {
                return Some(text.to_string());
            }
        }
    }

    None
}

fn first_media_url(value: &serde_json::Value) -> Option<String> {
    for key in ["thumbnail", "image", "logo", "cover", "banner", "background"] {
        if let Some(text) = value.get(key).and_then(|v| v.as_str()) {
            if !text.trim().is_empty() {
                return Some(text.to_string());
            }
        }

        if let Some(obj) = value.get(key) {
            if let Some(text) = json_string(obj, &["url", "src", "path", "original", "thumb", "thumbnail", "file"]) {
                if !text.starts_with("http://") && !text.starts_with("https://") && text.contains('.') {
                    let prefix = if obj
                        .get("has_thumb")
                        .and_then(|value| value.as_bool())
                        .unwrap_or(false)
                    {
                        "thumbnail_"
                    } else {
                        ""
                    };
                    return Some(format!("https://storage.modworkshop.net/mods/images/{}{}", prefix, text));
                }
                return Some(text);
            }
        }
    }

    for key in ["images", "screenshots", "media"] {
        if let Some(array) = value.get(key).and_then(|v| v.as_array()) {
            for item in array {
                if let Some(text) = json_string(item, &["thumbnail_url", "thumbnailUrl", "thumbnail", "url", "image_url", "imageUrl", "src", "path"]) {
                    return Some(text);
                }
            }
        }
    }

    None
}

fn dependency_id_fragment(value: &str) -> String {
    let clean = value
        .chars()
        .map(|character| if character.is_ascii_alphanumeric() { character.to_ascii_lowercase() } else { '-' })
        .collect::<String>();
    clean.split('-').filter(|part| !part.is_empty()).collect::<Vec<_>>().join("-")
}

fn dependency_identity_from_url(url: &str) -> (Option<String>, Option<String>, Option<String>) {
    let lower = url.to_lowercase();
    if let Some(start) = lower.find("nexusmods.com/") {
        let path = &url[start + "nexusmods.com/".len()..];
        let parts = path.split(&['/', '?', '#'][..]).filter(|part| !part.is_empty()).collect::<Vec<_>>();
        if parts.len() >= 3 && parts[1].eq_ignore_ascii_case("mods") {
            return (Some("nexus".to_string()), Some(parts[0].to_string()), Some(parts[2].to_string()));
        }
    }
    if let Some(start) = lower.find("modworkshop.net/mod/") {
        let rest = &url[start + "modworkshop.net/mod/".len()..];
        let mod_id = rest.split(&['/', '?', '#'][..]).next().unwrap_or_default().trim();
        if !mod_id.is_empty() {
            return (Some("modworkshop".to_string()), None, Some(mod_id.to_string()));
        }
    }
    if lower.contains("github.com/") {
        return (Some("github".to_string()), None, None);
    }
    (Some("external".to_string()), None, None)
}

fn source_dependency_from_value(
    value: &serde_json::Value,
    index: usize,
    fallback_source: Option<&str>,
    fallback_game_domain: Option<&str>,
    fallback_numeric_game_id: Option<&str>,
) -> Option<SourceDependencyItem> {
    let raw_text = value.as_str().map(str::trim).filter(|text| !text.is_empty());
    let url = raw_text
        .filter(|text| text.starts_with("http://") || text.starts_with("https://"))
        .map(ToString::to_string)
        .or_else(|| json_string(value, &["url", "link", "href", "page_url", "pageUrl", "external_url", "externalUrl", "download_url", "downloadUrl"]));
    let name = json_string(value, &["name", "title", "dependency_name", "dependencyName", "mod_name", "modName", "label"])
        .or_else(|| raw_text.filter(|text| !text.starts_with("http://") && !text.starts_with("https://")).map(ToString::to_string))
        .or_else(|| url.as_ref().map(|_| "External dependency".to_string()))?;
    let declared_source = json_string(value, &["source", "provider", "source_kind", "sourceKind"])
        .map(|source| source.to_lowercase());
    let (url_source, url_domain, url_mod_id) = url.as_deref().map(dependency_identity_from_url).unwrap_or((None, None, None));
    let source_kind = url_source.or(declared_source).or_else(|| fallback_source.map(ToString::to_string));
    let mod_id = json_id_string(value, &["mod_id", "modId", "dependency_mod_id", "dependencyModId", "id"])
        .or(url_mod_id);
    let game_domain = json_string(value, &["game_domain", "gameDomain", "domain"])
        .or(url_domain)
        .or_else(|| fallback_game_domain.map(ToString::to_string));
    let numeric_game_id = json_id_string(value, &["game_id", "gameId", "numeric_game_id", "numericGameId"])
        .or_else(|| fallback_numeric_game_id.map(ToString::to_string));
    let optional = value.get("optional").and_then(|entry| entry.as_bool()).unwrap_or_else(|| {
        json_string(value, &["type", "requirement_type", "requirementType", "status"])
            .is_some_and(|kind| kind.to_lowercase().contains("optional"))
    });
    let required = value.get("required").and_then(|entry| entry.as_bool()).unwrap_or(!optional);
    let notes = json_string(value, &["notes", "note", "description", "instructions"]);
    let version_constraint = json_string(value, &["version_constraint", "versionConstraint", "minimum_version", "minimumVersion", "version"]);
    let identity = mod_id.as_deref().or(url.as_deref()).unwrap_or(&name);
    Some(SourceDependencyItem {
        id: format!("source-dependency-{}-{}", dependency_id_fragment(identity), index),
        name,
        required,
        optional,
        source_kind,
        game_domain,
        numeric_game_id,
        mod_id,
        url,
        notes,
        version_constraint,
    })
}

fn collect_source_dependencies_recursive(
    value: &serde_json::Value,
    output: &mut Vec<SourceDependencyItem>,
    fallback_source: Option<&str>,
    fallback_game_domain: Option<&str>,
    fallback_numeric_game_id: Option<&str>,
    depth: usize,
) {
    if depth > 8 { return; }
    match value {
        serde_json::Value::Object(map) => {
            for (key, child) in map {
                let normalized = key.to_lowercase().replace(['_', '-'], "");
                let dependency_container = matches!(normalized.as_str(), "dependencies" | "dependency" | "requirements" | "requirement" | "requiredmods" | "requiredmod" | "offsite dependencies" | "offsitedependencies");
                if dependency_container {
                    match child {
                        serde_json::Value::Array(items) => {
                            for item in items {
                                if let Some(dependency) = source_dependency_from_value(item, output.len(), fallback_source, fallback_game_domain, fallback_numeric_game_id) {
                                    output.push(dependency);
                                }
                            }
                        }
                        _ => {
                            if let Some(dependency) = source_dependency_from_value(child, output.len(), fallback_source, fallback_game_domain, fallback_numeric_game_id) {
                                output.push(dependency);
                            }
                        }
                    }
                } else if depth < 4 {
                    collect_source_dependencies_recursive(child, output, fallback_source, fallback_game_domain, fallback_numeric_game_id, depth + 1);
                }
            }
        }
        serde_json::Value::Array(items) if depth < 4 => {
            for item in items {
                collect_source_dependencies_recursive(item, output, fallback_source, fallback_game_domain, fallback_numeric_game_id, depth + 1);
            }
        }
        _ => {}
    }
}

fn source_dependencies_from_value(
    value: &serde_json::Value,
    fallback_source: Option<&str>,
    fallback_game_domain: Option<&str>,
    fallback_numeric_game_id: Option<&str>,
) -> Vec<SourceDependencyItem> {
    let mut dependencies = Vec::new();
    collect_source_dependencies_recursive(value, &mut dependencies, fallback_source, fallback_game_domain, fallback_numeric_game_id, 0);
    let mut seen = std::collections::BTreeSet::new();
    dependencies.retain(|dependency| {
        let identity = format!("{}|{}|{}", dependency.name.to_lowercase(), dependency.mod_id.as_deref().unwrap_or_default(), dependency.url.as_deref().unwrap_or_default());
        seen.insert(identity)
    });
    dependencies
}

#[derive(Debug, Clone, Default)]
struct SourceAuthorFields {
    display_name: Option<String>,
    username: Option<String>,
    user_id: Option<String>,
    profile_url: Option<String>,
    avatar_url: Option<String>,
}

fn clean_author_value(value: Option<String>) -> Option<String> {
    let text = value?.trim().to_string();
    if text.is_empty()
        || text.eq_ignore_ascii_case("unknown")
        || text.eq_ignore_ascii_case("unknown author")
        || text.eq_ignore_ascii_case("null")
        || text.eq_ignore_ascii_case("undefined")
        || text.chars().all(|ch| ch.is_ascii_digit())
    {
        return None;
    }

    Some(text)
}

fn nested_object<'a>(value: &'a serde_json::Value, keys: &[&str]) -> Option<&'a serde_json::Value> {
    for key in keys {
        if let Some(child) = value.get(*key).filter(|child| child.is_object()) {
            return Some(child);
        }
    }
    None
}

fn modworkshop_user_profile_url(user_id: Option<&str>, username: Option<&str>) -> Option<String> {
    user_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("https://modworkshop.net/user/{}", value))
        .or_else(|| {
            username
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| format!("https://modworkshop.net/user/{}", value))
        })
}

fn modworkshop_user_avatar_url(user: &serde_json::Value) -> Option<String> {
    let avatar = json_string(user, &["avatar", "avatar_url", "avatarUrl", "image", "image_url", "imageUrl"])?;
    let avatar = avatar.trim();
    if avatar.is_empty() {
        return None;
    }

    if avatar.starts_with("http://") || avatar.starts_with("https://") {
        return Some(avatar.to_string());
    }

    let prefix = if user
        .get("avatar_has_thumb")
        .or_else(|| user.get("avatarHasThumb"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
        && !avatar.starts_with("thumbnail_")
    {
        "thumbnail_"
    } else {
        ""
    };

    Some(format!("https://storage.modworkshop.net/users/images/{}{}", prefix, avatar))
}

fn modworkshop_author_fields_from_value(value: &serde_json::Value) -> SourceAuthorFields {
    let user = nested_object(value, &["author", "user", "submitter", "owner", "member", "last_user", "lastUser"]);
    let display_name = clean_author_value(json_string(value, &[
        "author",
        "author_name",
        "authorName",
        "created_by",
        "createdBy",
        "submitter",
        "owner",
        "member",
        "username",
        "user_name",
        "userName",
    ]))
    .or_else(|| user.and_then(|item| clean_author_value(json_string(item, &["display_name", "displayName", "name", "username", "unique_name", "uniqueName"]))));

    let username = clean_author_value(
        user.and_then(|item| json_string(item, &["unique_name", "uniqueName", "username", "name"]))
            .or_else(|| json_string(value, &["author_username", "authorUsername", "username", "user_name", "userName"])),
    );
    let user_id = user
        .and_then(|item| json_id_string(item, &["id", "user_id", "userId"]))
        .or_else(|| json_id_string(value, &["user_id", "userId", "author_id", "authorId", "submitter_id", "submitterId"]));
    let profile_url = user
        .and_then(|item| json_string(item, &["profile_url", "profileUrl", "url"]))
        .and_then(|url| absolutize_source_url("modworkshop", Some(url)))
        .or_else(|| modworkshop_user_profile_url(user_id.as_deref(), username.as_deref()));
    let avatar_url = user.and_then(modworkshop_user_avatar_url);

    SourceAuthorFields {
        display_name,
        username,
        user_id,
        profile_url,
        avatar_url,
    }
}

fn strip_bbcode_tag_once(input: &str, tag_start: &str, tag_end: &str) -> String {
    input.replace(tag_start, "").replace(tag_end, "")
}

fn bbcode_to_text(input: &str) -> String {
    let mut out = input
        .replace("\r\n", "\n")
        .replace("\\r\\n", "\n")
        .replace("\\n", "\n");

    // Convert common block-ish BBCode to spacing first.
    for tag in ["center", "quote", "spoiler"] {
        out = out
            .replace(&format!("[{}]", tag), "\n")
            .replace(&format!("[/{}]", tag), "\n");
    }

    // Headings are often wrapped in size/bold tags.
    out = re_like_replace_bbcode_attr(&out, "size", "\n\n", "\n\n");
    out = re_like_replace_bbcode_attr(&out, "color", "", "");
    out = re_like_replace_bbcode_attr(&out, "font", "", "");
    out = re_like_replace_bbcode_attr(&out, "align", "\n", "\n");

    for tag in ["b", "i", "u", "s"] {
        out = strip_bbcode_tag_once(&out, &format!("[{}]", tag), &format!("[/{}]", tag));
    }

    // Preserve URLs in a clickable way for frontend RichText.
    while let Some(start) = out.to_lowercase().find("[url=") {
        let Some(end_bracket_rel) = out[start..].find(']') else { break; };
        let end_bracket = start + end_bracket_rel;
        let url = out[start + 5..end_bracket].trim_matches('"').trim_matches('\'').to_string();
        let Some(close_rel) = out[end_bracket..].to_lowercase().find("[/url]") else { break; };
        let close = end_bracket + close_rel;
        let label = out[end_bracket + 1..close].trim().to_string();
        let replacement = if label.is_empty() || label == url {
            url
        } else {
            format!("{} ({})", label, url)
        };
        out.replace_range(start..close + 6, &replacement);
    }

    out = out.replace("[url]", "").replace("[/url]", "");

    // Remove any leftover [tag] or [/tag] style markup without eating normal text.
    let mut cleaned = String::new();
    let mut chars = out.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '[' {
            let mut tag = String::new();
            let mut found_end = false;

            while let Some(next) = chars.next() {
                if next == ']' {
                    found_end = true;
                    break;
                }
                tag.push(next);
                if tag.len() > 60 {
                    break;
                }
            }

            if found_end {
                let tag_lower = tag.to_lowercase();
                let looks_like_tag = tag_lower.starts_with('/')
                    || tag_lower.contains('=')
                    || matches!(
                        tag_lower.as_str(),
                        "b" | "i" | "u" | "s" | "center" | "quote" | "spoiler" | "list" | "*" |
                        "size" | "color" | "font" | "align"
                    );

                if looks_like_tag {
                    if tag_lower == "*" {
                        cleaned.push_str("\n• ");
                    }
                    continue;
                }

                cleaned.push('[');
                cleaned.push_str(&tag);
                cleaned.push(']');
            } else {
                cleaned.push('[');
                cleaned.push_str(&tag);
            }
        } else {
            cleaned.push(ch);
        }
    }

    // Remove decoration-only lines.
    let mut lines = Vec::new();
    for line in cleaned.lines() {
        let trimmed = line.trim();
        let decorative = !trimmed.is_empty()
            && trimmed
                .chars()
                .all(|ch| ch.is_whitespace() || matches!(ch, '◆' | '◇' | '•' | '-' | '=' | '_' | '*' | '─'));

        if decorative {
            continue;
        }

        lines.push(trimmed.to_string());
    }

    lines.join("\n")
}

fn re_like_replace_bbcode_attr(input: &str, tag: &str, open_replacement: &str, close_replacement: &str) -> String {
    let mut out = input.to_string();
    let open_prefix = format!("[{}=", tag);
    let open_plain = format!("[{}]", tag);
    let close = format!("[/{}]", tag);

    loop {
        let lower = out.to_lowercase();
        let Some(start) = lower.find(&open_prefix) else { break; };
        let Some(end_rel) = out[start..].find(']') else { break; };
        let end = start + end_rel + 1;
        out.replace_range(start..end, open_replacement);
    }

    out = out.replace(&open_plain, open_replacement);
    out.replace(&close, close_replacement)
}


fn html_to_text(input: &str) -> String {
    let input = bbcode_to_text(input);
    let mut prepared = input
        .replace("\r\n", "\n")
        .replace("<br>", "\n")
        .replace("<br/>", "\n")
        .replace("<br />", "\n")
        .replace("</p>", "\n\n")
        .replace("</div>", "\n\n")
        .replace("</li>", "\n")
        .replace("</h1>", "\n\n")
        .replace("</h2>", "\n\n")
        .replace("</h3>", "\n\n");

    prepared = prepared
        .replace("<p>", "")
        .replace("<li>", "\n- ");

    let mut output = String::new();
    let mut in_tag = false;

    for ch in prepared.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                output.push(' ');
            }
            _ if !in_tag => output.push(ch),
            _ => {}
        }
    }

    let decoded = decode_html_entities(&output);
    let mut lines = Vec::new();

    for line in decoded.lines() {
        let clean = line.split_whitespace().collect::<Vec<_>>().join(" ");
        lines.push(clean);
    }

    let mut final_text = String::new();
    let mut blank_count = 0;

    for line in lines {
        if line.trim().is_empty() {
            blank_count += 1;
            if blank_count <= 1 && !final_text.ends_with("\n\n") {
                final_text.push_str("\n\n");
            }
        } else {
            blank_count = 0;
            if !final_text.is_empty() && !final_text.ends_with('\n') {
                final_text.push('\n');
            }
            final_text.push_str(line.trim());
        }
    }

    final_text.trim().to_string()
}

fn safe_short_description(text: Option<String>) -> Option<String> {
    text.map(|value| {
        let clean = html_to_text(&value);
        clean.chars().take(220).collect::<String>()
    })
}


fn description_quality_score(text: &str) -> usize {
    let lower = text.to_lowercase();

    if text.trim().is_empty() {
        return 0;
    }

    let mut score = text.trim().len();

    for bad in [
        "description was not exposed",
        "no description exposed",
        "enable javascript",
        "cloudflare",
        "access denied",
    ] {
        if lower.contains(bad) {
            score = score.saturating_sub(5000);
        }
    }

    if lower.contains("install") || lower.contains("require") || lower.contains("feature") {
        score += 200;
    }

    if text.contains('\n') {
        score += 100;
    }

    score
}

fn choose_better_description(current: String, candidate: Option<String>) -> String {
    let Some(candidate) = candidate else {
        return current;
    };

    let cleaned = html_to_text(&candidate);

    if description_quality_score(&cleaned) > description_quality_score(&current) {
        cleaned
    } else {
        current
    }
}

fn json_deep_find_string(value: &serde_json::Value, wanted_keys: &[&str], depth: usize) -> Option<String> {
    if depth == 0 {
        return None;
    }

    match value {
        serde_json::Value::Object(map) => {
            for (key, child) in map {
                if wanted_keys.iter().any(|wanted| key.eq_ignore_ascii_case(wanted)) {
                    if let Some(text) = child.as_str() {
                        if !text.trim().is_empty() {
                            return Some(text.to_string());
                        }
                    }
                }
            }

            for child in map.values() {
                if let Some(found) = json_deep_find_string(child, wanted_keys, depth - 1) {
                    return Some(found);
                }
            }

            None
        }
        serde_json::Value::Array(items) => {
            for child in items {
                if let Some(found) = json_deep_find_string(child, wanted_keys, depth - 1) {
                    return Some(found);
                }
            }

            None
        }
        _ => None,
    }
}

fn extract_modworkshop_api_description(data: &serde_json::Value) -> Option<String> {
    json_string(data, &[
        "desc",
        "description",
        "body",
        "content",
        "details",
        "text",
        "summary",
        "short_description",
        "shortDescription",
    ])
    .or_else(|| {
        json_deep_find_string(
            data,
            &["desc", "description", "body", "content", "details", "text", "summary"],
            5,
        )
    })
}


fn http_get_json(url: &str, api_key: Option<&str>) -> Result<serde_json::Value, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("TsukiModManager/0.20")
        .build()
        .map_err(|err| format!("Failed to create HTTP client: {}", err))?;

    let mut request = client.get(url).header("Accept", "application/json, text/html;q=0.9, */*;q=0.8").header("Accept-Language", "en-US,en;q=0.9");

    if let Some(key) = api_key {
        request = request.header("apikey", key);
    }

    let response = request
        .send()
        .map_err(|err| format!("Request failed for {}: {}", url, err))?;

    let status = response.status();
    let text = response
        .text()
        .map_err(|err| format!("Failed to read response body: {}", err))?;

    if !status.is_success() {
        return Err(format!("{} returned HTTP {}: {}", url, status, text.chars().take(240).collect::<String>()));
    }

    serde_json::from_str(&text)
        .map_err(|err| format!("Failed to parse JSON from {}: {}", url, err))
}

fn test_github_public_repository_sync(owner: Option<String>, repository: Option<String>) -> SourceTestConfigResult {
    let requested_repository = owner.is_some() || repository.is_some();
    let parsed = match (owner.as_deref(), repository.as_deref()) {
        (Some(owner), Some(repository)) => github_repository_component(owner)
            .zip(github_repository_component(repository)),
        (None, None) => None,
        _ => {
            return SourceTestConfigResult {
                status: "Failed".to_string(),
                message: "GitHub owner and repository must be provided together.".to_string(),
                user_message: None,
                technical_details: None,
                source_type: Some("github".to_string()),
                reachable: false,
                authenticated: false,
                mapping_valid: false,
                final_url: None,
                http_status: None,
            };
        }
    };

    if requested_repository && parsed.is_none() {
        return SourceTestConfigResult {
            status: "Failed".to_string(),
            message: "GitHub owner or repository contains unsupported characters.".to_string(),
            user_message: None,
            technical_details: None,
            source_type: Some("github".to_string()),
            reachable: false,
            authenticated: false,
            mapping_valid: false,
            final_url: None,
            http_status: None,
        };
    }

    let (api_url, final_url, expected_full_name) = if let Some((owner, repository)) = parsed {
        (
            format!("https://api.github.com/repos/{}/{}", owner, repository),
            Some(format!("https://github.com/{}/{}", owner, repository)),
            Some(format!("{}/{}", owner, repository)),
        )
    } else {
        ("https://api.github.com/rate_limit".to_string(), Some("https://api.github.com".to_string()), None)
    };

    match http_get_json_fast(&api_url, 15) {
        Ok(value) => {
            let resolved_name = json_string(&value, "full_name");
            let detail = expected_full_name
                .as_ref()
                .map(|expected| format!("Public repository API resolved {} as {}.", expected, resolved_name.unwrap_or_else(|| expected.clone())))
                .unwrap_or_else(|| "GitHub public API rate-limit endpoint responded successfully.".to_string());
            SourceTestConfigResult {
                status: "Connected".to_string(),
                message: if expected_full_name.is_some() { "GitHub repository is reachable through the public API.".to_string() } else { "GitHub public API is reachable.".to_string() },
                user_message: None,
                technical_details: Some(format!("{} Endpoint: {}", detail, api_url)),
                source_type: Some("github".to_string()),
                reachable: true,
                authenticated: false,
                mapping_valid: true,
                final_url,
                http_status: Some(200),
            }
        }
        Err(error) => SourceTestConfigResult {
            status: "Failed".to_string(),
            message: "GitHub public API probe failed.".to_string(),
            user_message: Some(if expected_full_name.is_some() { "GitHub could not find or reach this public repository.".to_string() } else { "GitHub's public API could not be reached.".to_string() }),
            technical_details: Some(error),
            source_type: Some("github".to_string()),
            reachable: false,
            authenticated: false,
            mapping_valid: true,
            final_url,
            http_status: None,
        },
    }
}

#[tauri::command]
async fn test_github_public_repository(owner: Option<String>, repository: Option<String>) -> Result<SourceTestConfigResult, String> {
    tauri::async_runtime::spawn_blocking(move || test_github_public_repository_sync(owner, repository))
        .await
        .map_err(|err| format!("GitHub public API task failed: {:?}", err))
}


fn http_post_json(url: &str, body: serde_json::Value, timeout_secs: u64) -> Result<serde_json::Value, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(format!("TsukiModManager/{}", APP_VERSION))
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|err| format!("Failed to create HTTP client: {}", err))?;

    let response = client
        .post(url)
        .header("Accept", "application/json, text/html;q=0.9, */*;q=0.8")
        .header("Content-Type", "application/json")
        .header("Accept-Language", "en-US,en;q=0.9")
        .json(&body)
        .send()
        .map_err(|err| format!("POST request failed for {}: {}", url, err))?;

    let status = response.status();
    let text = response
        .text()
        .map_err(|err| format!("Failed to read response body: {}", err))?;

    if !status.is_success() {
        return Err(format!("{} returned HTTP {}: {}", url, status, text.chars().take(240).collect::<String>()));
    }

    serde_json::from_str(&text)
        .map_err(|err| format!("Failed to parse JSON from {}: {}", url, err))
}


fn nexus_graphql_diagnostic_file_path() -> Result<PathBuf, String> {
    let root = ensure_app_data_dirs()?;
    let diagnostics = root.join("diagnostics");
    fs::create_dir_all(&diagnostics)
        .map_err(|err| format!("Failed to create diagnostics folder: {}", err))?;

    Ok(diagnostics.join("nexus-graphql-last.json"))
}

fn extract_graphql_operation_name(query: &str) -> String {
    for token in ["query", "mutation"] {
        if let Some(index) = query.find(token) {
            let rest = query[index + token.len()..].trim_start();
            let name = rest
                .split(|ch: char| ch == '(' || ch == '{' || ch.is_whitespace())
                .next()
                .unwrap_or("")
                .trim();

            if !name.is_empty() {
                return name.to_string();
            }
        }
    }

    "unknown".to_string()
}

fn graphql_error_messages(value: &serde_json::Value) -> Vec<String> {
    value
        .get("errors")
        .and_then(|errors| errors.as_array())
        .map(|errors| {
            errors
                .iter()
                .take(10)
                .map(|error| {
                    error
                        .get("message")
                        .and_then(|message| message.as_str())
                        .map(|message| message.to_string())
                        .unwrap_or_else(|| error.to_string())
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn graphql_node_count(value: &serde_json::Value) -> usize {
    let data = unwrap_graphql_data(value);
    json_deep_find_array(data, &["nodes"], 8)
        .map(|nodes| nodes.len())
        .unwrap_or(0)
}

fn write_nexus_graphql_diagnostic(
    operation_name: &str,
    variables: &serde_json::Value,
    auth_header_sent: bool,
    bearer_auth_sent: bool,
    http_status: Option<u16>,
    graphql_errors: Vec<String>,
    response_preview: String,
    node_count: usize,
    layer: &str,
) {
    let diagnostic = serde_json::json!({
        "timeUnix": now_unix_seconds(),
        "operationName": operation_name,
        "endpoint": "https://api.nexusmods.com/v2/graphql",
        "variables": variables,
        "authHeaderSent": auth_header_sent,
        "bearerAuthSent": bearer_auth_sent,
        "httpStatus": http_status,
        "graphqlErrors": graphql_errors,
        "responsePreview": response_preview.chars().take(1000).collect::<String>(),
        "nodeCount": node_count,
        "layer": layer,
    });

    if let Ok(path) = nexus_graphql_diagnostic_file_path() {
        if let Ok(text) = serde_json::to_string_pretty(&diagnostic) {
            let _ = fs::write(path, text);
        }
    }
}

fn read_nexus_graphql_diagnostic() -> Option<serde_json::Value> {
    let path = nexus_graphql_diagnostic_file_path().ok()?;
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn format_nexus_graphql_diagnostic_for_report() -> String {
    let Some(value) = read_nexus_graphql_diagnostic() else {
        return "Nexus GraphQL Last Diagnostic: none\n".to_string();
    };

    let operation = json_string(&value, &["operationName"]).unwrap_or_else(|| "unknown".to_string());
    let endpoint = json_string(&value, &["endpoint"]).unwrap_or_else(|| "unknown".to_string());
    let http_status = json_u64(&value, &["httpStatus"])
        .map(|status| status.to_string())
        .unwrap_or_else(|| "none".to_string());
    let auth = value
        .get("authHeaderSent")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let bearer = value
        .get("bearerAuthSent")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let node_count = json_u64(&value, &["nodeCount"]).unwrap_or(0);
    let layer = json_string(&value, &["layer"]).unwrap_or_else(|| "unknown".to_string());
    let errors = value
        .get("graphqlErrors")
        .and_then(|value| value.as_array())
        .map(|items| {
            if items.is_empty() {
                "none".to_string()
            } else {
                items
                    .iter()
                    .take(3)
                    .map(|item| item.as_str().unwrap_or("").to_string())
                    .collect::<Vec<_>>()
                    .join(" | ")
            }
        })
        .unwrap_or_else(|| "none".to_string());

    format!(
        "Nexus GraphQL Last Diagnostic:\n  Operation: {}\n  Endpoint: {}\n  Layer: {}\n  Auth Header Sent: {}\n  Bearer Sent: {}\n  HTTP Status: {}\n  Nodes: {}\n  Errors: {}\n",
        operation,
        endpoint,
        layer,
        auth,
        bearer,
        http_status,
        node_count,
        errors
    )
}

fn http_post_graphql(query: &str, variables: serde_json::Value, api_key: Option<&str>) -> Result<serde_json::Value, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("TsukiModManager/1.04")
        .build()
        .map_err(|err| format!("Failed to create GraphQL HTTP client: {}", err))?;

    let operation_name = extract_graphql_operation_name(query);
    let variables_for_diagnostic = variables.clone();
    let auth_header_sent = api_key.is_some();
    let bearer_auth_sent = api_key.is_some();

    let mut body = serde_json::Map::new();
    body.insert("query".to_string(), serde_json::Value::String(query.to_string()));
    body.insert("variables".to_string(), variables);

    let mut request = client
        .post("https://api.nexusmods.com/v2/graphql")
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .header("Accept-Language", "en-US,en;q=0.9")
        .json(&serde_json::Value::Object(body));

    if let Some(key) = api_key {
        request = request
            .header("apikey", key)
            .bearer_auth(key);
    }

    let response = match request.send() {
        Ok(response) => response,
        Err(err) => {
            write_nexus_graphql_diagnostic(
                &operation_name,
                &variables_for_diagnostic,
                auth_header_sent,
                bearer_auth_sent,
                None,
                vec![err.to_string()],
                err.to_string(),
                0,
                "http-error",
            );

            return Err(format!("Nexus GraphQL request failed: {}", err));
        }
    };

    let status = response.status();
    let status_code = status.as_u16();
    let text = response
        .text()
        .map_err(|err| format!("Failed to read Nexus GraphQL response body: {}", err))?;

    if !status.is_success() {
        write_nexus_graphql_diagnostic(
            &operation_name,
            &variables_for_diagnostic,
            auth_header_sent,
            bearer_auth_sent,
            Some(status_code),
            vec![format!("HTTP {}", status_code)],
            text.clone(),
            0,
            "http-status",
        );

        return Err(format!(
            "Nexus GraphQL returned HTTP {}: {}",
            status,
            text.chars().take(500).collect::<String>()
        ));
    }

    let value: serde_json::Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(err) => {
            write_nexus_graphql_diagnostic(
                &operation_name,
                &variables_for_diagnostic,
                auth_header_sent,
                bearer_auth_sent,
                Some(status_code),
                vec![err.to_string()],
                text.clone(),
                0,
                "json-parse",
            );

            return Err(format!("Failed to parse Nexus GraphQL JSON: {}", err));
        }
    };

    let errors = graphql_error_messages(&value);
    let node_count = graphql_node_count(&value);

    write_nexus_graphql_diagnostic(
        &operation_name,
        &variables_for_diagnostic,
        auth_header_sent,
        bearer_auth_sent,
        Some(status_code),
        errors.clone(),
        text.clone(),
        node_count,
        "graphql",
    );

    if !errors.is_empty() {
        return Err(format!(
            "Nexus GraphQL errors: {}",
            errors.into_iter().take(3).collect::<Vec<_>>().join(" | ")
        ));
    }

    Ok(value)
}

fn json_deep_find_array<'a>(value: &'a serde_json::Value, keys: &[&str], depth: usize) -> Option<&'a Vec<serde_json::Value>> {
    if depth == 0 {
        return None;
    }

    if let Some(object) = value.as_object() {
        for key in keys {
            if let Some(array) = object.get(*key).and_then(|child| child.as_array()) {
                return Some(array);
            }
        }

        for child in object.values() {
            if let Some(found) = json_deep_find_array(child, keys, depth.saturating_sub(1)) {
                return Some(found);
            }
        }
    }

    if let Some(array) = value.as_array() {
        for child in array {
            if let Some(found) = json_deep_find_array(child, keys, depth.saturating_sub(1)) {
                return Some(found);
            }
        }
    }

    None
}

fn json_deep_find_object<'a>(value: &'a serde_json::Value, keys: &[&str], depth: usize) -> Option<&'a serde_json::Map<String, serde_json::Value>> {
    if depth == 0 {
        return None;
    }

    if let Some(object) = value.as_object() {
        for key in keys {
            if let Some(found) = object.get(*key).and_then(|child| child.as_object()) {
                return Some(found);
            }
        }

        for child in object.values() {
            if let Some(found) = json_deep_find_object(child, keys, depth.saturating_sub(1)) {
                return Some(found);
            }
        }
    }

    if let Some(array) = value.as_array() {
        for child in array {
            if let Some(found) = json_deep_find_object(child, keys, depth.saturating_sub(1)) {
                return Some(found);
            }
        }
    }

    None
}

fn unwrap_graphql_data(value: &serde_json::Value) -> &serde_json::Value {
    value.get("data").unwrap_or(value)
}


fn http_get_text(url: &str) -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("TsukiModManager/0.20")
        .build()
        .map_err(|err| format!("Failed to create HTTP client: {}", err))?;

    let response = client
        .get(url)
        .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .map_err(|err| format!("Request failed for {}: {}", url, err))?;

    let status = response.status();
    let text = response
        .text()
        .map_err(|err| format!("Failed to read response body: {}", err))?;

    if !status.is_success() {
        return Err(format!("{} returned HTTP {}: {}", url, status, text.chars().take(700).collect::<String>()));
    }

    Ok(text)
}

fn html_attr(fragment: &str, attr: &str) -> Option<String> {
    let needle = format!("{}=", attr);
    let pos = fragment.find(&needle)?;
    let after = &fragment[pos + needle.len()..];
    let quote = after.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let end = after[1..].find(quote)?;
    Some(after[1..1 + end].to_string())
}

fn html_between(input: &str, start_pat: &str, end_pat: &str) -> Option<String> {
    let start = input.find(start_pat)? + start_pat.len();
    let end = input[start..].find(end_pat)? + start;
    Some(input[start..end].to_string())
}

fn clean_html_text(input: &str) -> String {
    html_to_text(input)
        .replace("  ", " ")
        .trim()
        .to_string()
}


fn decode_html_entities(input: &str) -> String {
    let mut out = input
        .replace("&#x27;", "'")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&quot;", "\"")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ");

    let mut decoded = String::new();
    let mut rest = out.as_str();

    while let Some(pos) = rest.find("&#") {
        decoded.push_str(&rest[..pos]);
        let after = &rest[pos + 2..];

        if let Some(end) = after.find(';') {
            let number = &after[..end];

            if let Ok(value) = number.parse::<u32>() {
                if let Some(ch) = char::from_u32(value) {
                    decoded.push(ch);
                    rest = &after[end + 1..];
                    continue;
                }
            }
        }

        decoded.push_str("&#");
        rest = after;
    }

    decoded.push_str(rest);
    out = decoded;
    out
}

fn clean_mod_name(input: &str) -> String {
    decode_html_entities(input)
        .replace(" | ModWorkshop", "")
        .replace(" - ModWorkshop", "")
        .replace(" | PAYDAY 3 Mods", "")
        .replace(" - PAYDAY 3 Mods", "")
        .replace(" at Payday 3 Nexus", "")
        .replace(" - Mods and community", "")
        .trim()
        .to_string()
}

fn is_bad_modworkshop_listing_name(name: &str) -> bool {
    let clean = name.trim().to_lowercase();

    if clean.is_empty() || clean.chars().all(|ch| ch.is_ascii_digit() || ch.is_whitespace()) {
        return true;
    }

    matches!(
        clean.as_str(),
        "weapons" | "audio" | "interface" | "tools" | "characters" | "music" | "world" |
        "misc" | "masks" | "equipment" | "resources" | "libraries" | "pickups" |
        "custom heists" | "heisters"
    )
}

fn extract_title_from_html(html: &str) -> Option<String> {
    if let Some(title) = html_between(html, "<title>", "</title>") {
        let cleaned = clean_mod_name(&clean_html_text(&title));
        if !cleaned.is_empty() {
            return Some(cleaned);
        }
    }

    None
}

fn extract_meta_content(html: &str, key: &str) -> Option<String> {
    for pattern in [
        format!("property=\"{}\"", key),
        format!("name=\"{}\"", key),
        format!("property='{}'", key),
        format!("name='{}'", key),
    ] {
        let mut search_start = 0;
        while let Some(pos) = html[search_start..].find("<meta") {
            let abs = search_start + pos;
            let end = html[abs..].find('>').map(|value| abs + value)?;
            let tag = &html[abs..=end];
            if tag.contains(&pattern) {
                if let Some(content) = html_attr(tag, "content") {
                    if !content.trim().is_empty() {
                        return Some(content);
                    }
                }
            }
            search_start = end + 1;
        }
    }

    None
}

fn extract_first_img_near(html: &str, center: usize) -> Option<String> {
    let start = center.saturating_sub(1800);
    let end = (center + 1800).min(html.len());
    let window = &html[start..end];

    let mut search_start = 0;
    while let Some(pos) = window[search_start..].find("<img") {
        let abs = search_start + pos;
        let tag_end = window[abs..].find('>').map(|value| abs + value)?;
        let tag = &window[abs..=tag_end];

        if let Some(src) = html_attr(tag, "src")
            .or_else(|| html_attr(tag, "data-src"))
            .or_else(|| html_attr(tag, "data-lazy-src"))
        {
            if !src.contains("avatar") && !src.contains("logo") {
                return absolutize_source_url("modworkshop", Some(src));
            }
        }

        search_start = tag_end + 1;
    }

    None
}


fn extract_first_img_near_for_source(html: &str, center: usize, source: &str) -> Option<String> {
    let start = center.saturating_sub(1800);
    let end = (center + 1800).min(html.len());
    let window = &html[start..end];

    let mut search_start = 0;
    while let Some(pos) = window[search_start..].find("<img") {
        let abs = search_start + pos;
        let tag_end = window[abs..].find('>').map(|value| abs + value)?;
        let tag = &window[abs..=tag_end];

        if let Some(src) = html_attr(tag, "src")
            .or_else(|| html_attr(tag, "data-src"))
            .or_else(|| html_attr(tag, "data-lazy-src"))
        {
            if !src.contains("avatar") && !src.contains("logo") {
                return absolutize_source_url(source, Some(src));
            }
        }

        search_start = tag_end + 1;
    }

    None
}

fn extract_modworkshop_ids_from_html(html: &str) -> Vec<String> {
    let mut ids = Vec::new();
    let mut search_start = 0;

    while let Some(pos) = html[search_start..].find("/mod/") {
        let abs = search_start + pos + "/mod/".len();
        let mut id = String::new();

        for ch in html[abs..].chars() {
            if ch.is_ascii_digit() {
                id.push(ch);
            } else {
                break;
            }
        }

        let next_start = abs + id.len();

        if !id.is_empty() && !ids.contains(&id) {
            ids.push(id);
        }

        search_start = next_start;
    }

    ids
}

fn extract_anchor_text_for_mod(html: &str, id: &str) -> Option<String> {
    let marker = format!("/mod/{}", id);
    let mut search_start = 0;

    while let Some(pos) = html[search_start..].find(&marker) {
        let abs = search_start + pos;
        let tag_start = html[..abs].rfind("<a")?;
        let tag_end = html[abs..].find("</a>").map(|value| abs + value + "</a>".len())?;
        let anchor = &html[tag_start..tag_end];

        if let Some(title) = html_attr(anchor, "title") {
            let cleaned = clean_mod_name(&clean_html_text(&title));
            if !cleaned.is_empty() && !cleaned.eq_ignore_ascii_case("image") {
                return Some(cleaned);
            }
        }

        let cleaned = clean_mod_name(&clean_html_text(anchor));
        if !cleaned.is_empty()
            && !cleaned.eq_ignore_ascii_case("image")
            && !cleaned.to_lowercase().contains("view mod page")
            && !is_bad_modworkshop_listing_name(&cleaned)
        {
            return Some(cleaned);
        }

        search_start = tag_end;
    }

    None
}


fn modworkshop_relative_age_seconds(text: &str) -> Option<u64> {
    let cleaned = clean_html_text(text).to_lowercase();

    if cleaned.contains("just now") || cleaned.contains("moments ago") {
        return Some(0);
    }

    let tokens = cleaned
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|token| !token.trim().is_empty())
        .collect::<Vec<_>>();

    for index in 0..tokens.len() {
        let unit_seconds = match tokens[index] {
            "minute" | "minutes" | "min" | "mins" => 60,
            "hour" | "hours" | "hr" | "hrs" => 60 * 60,
            "day" | "days" => 60 * 60 * 24,
            "week" | "weeks" => 60 * 60 * 24 * 7,
            "month" | "months" => 60 * 60 * 24 * 30,
            "year" | "years" => 60 * 60 * 24 * 365,
            _ => continue,
        };

        if tokens.get(index + 1).copied() != Some("ago") {
            continue;
        }

        let amount = if index > 0 {
            match tokens[index - 1] {
                "a" | "an" => Some(1),
                value => value.parse::<u64>().ok(),
            }
        } else {
            None
        };

        if let Some(amount) = amount {
            return Some(amount.saturating_mul(unit_seconds));
        }
    }

    None
}

fn modworkshop_relative_updated_label(text: &str) -> Option<String> {
    let cleaned = clean_html_text(text).to_lowercase();

    if cleaned.contains("just now") || cleaned.contains("moments ago") {
        return Some("just now".to_string());
    }

    let tokens = cleaned
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|token| !token.trim().is_empty())
        .collect::<Vec<_>>();

    for index in 0..tokens.len() {
        let unit = match tokens[index] {
            "minute" | "minutes" | "min" | "mins" => "minute",
            "hour" | "hours" | "hr" | "hrs" => "hour",
            "day" | "days" => "day",
            "week" | "weeks" => "week",
            "month" | "months" => "month",
            "year" | "years" => "year",
            _ => continue,
        };

        if tokens.get(index + 1).copied() != Some("ago") {
            continue;
        }

        let amount = if index > 0 {
            match tokens[index - 1] {
                "a" | "an" => Some(1),
                value => value.parse::<u64>().ok(),
            }
        } else {
            None
        };

        if let Some(amount) = amount {
            let plural = if amount == 1 { "" } else { "s" };
            return Some(format!("{} {}{} ago", amount, unit, plural));
        }
    }

    None
}

fn modworkshop_relative_updated_at(window: &str) -> Option<String> {
    modworkshop_relative_updated_label(window)
}

fn scrape_modworkshop_summary_from_listing(html: &str, id: &str) -> SourceModSummary {
    let marker = format!("/mod/{}", id);
    let center = html.find(&marker).unwrap_or(0);
    let start = center.saturating_sub(1400);
    let end = (center + 2400).min(html.len());
    let window = &html[start..end];

    let name = extract_anchor_text_for_mod(html, id)
        .or_else(|| html_between(window, ">", "</a>").map(|text| clean_mod_name(&clean_html_text(&text))))
        .filter(|text| !text.is_empty() && !text.contains("Image"))
        .unwrap_or_else(|| format!("ModWorkshop Mod {}", id));

    let thumbnail = extract_first_img_near_for_source(html, center, "modworkshop");
    let updated_at = modworkshop_relative_updated_at(window);

    SourceModSummary {
        source: "modworkshop".to_string(),
        source_id: id.to_string(),
        uid: None,
        game_id: Some("payday-3".to_string()),
        name,
        author: None,
        author_username: None,
        author_user_id: None,
        author_profile_url: None,
        author_avatar_url: None,
        version: None,
        thumbnail_url: thumbnail.clone(),
        banner_url: thumbnail,
        page_url: Some(format!("https://modworkshop.net/mod/{}", id)),
        updated_at,
        downloads: None,
        likes: None,
        short_description: Some("Live ModWorkshop PAYDAY 3 listing card.".to_string()),
        tags: vec!["ModWorkshop".to_string(), "PAYDAY 3".to_string()],
    }
}



fn extract_modworkshop_html_description(html: &str) -> Option<String> {
    let markers = [
        "mod-description",
        "description",
        "markdown-body",
        "content-body",
        "tab-description",
        "modpage-description",
    ];

    for marker in markers {
        if let Some(pos) = html.to_lowercase().find(marker) {
            let start = pos.saturating_sub(500);
            let end = (pos + 9000).min(html.len());
            let window = &html[start..end];
            let cleaned = clean_html_text(window);

            if cleaned.len() > 180
                && !cleaned.to_lowercase().contains("modworkshop uses cookies")
                && !cleaned.to_lowercase().contains("sign in")
            {
                return Some(cleaned);
            }
        }
    }

    None
}

fn modworkshop_dependencies_from_html(html: &str) -> Vec<SourceDependencyItem> {
    let lower = html.to_lowercase();
    let mut dependencies = Vec::new();
    let mut search_from = 0;
    while let Some(relative) = lower[search_from..].find("<a") {
        let start = search_from + relative;
        let Some(tag_relative_end) = html[start..].find('>') else { break; };
        let tag_end = start + tag_relative_end;
        let Some(close_relative) = lower[tag_end + 1..].find("</a>") else { search_from = tag_end + 1; continue; };
        let close = tag_end + 1 + close_relative;
        let context_start = start.saturating_sub(500);
        let context = &lower[context_start..start];
        if context.contains("dependenc") || context.contains("requirement") || context.contains("requires") {
            let tag = &html[start..=tag_end];
            if let Some(raw_url) = html_attr(tag, "href") {
                if let Some(url) = absolutize_source_url("modworkshop", Some(raw_url)) {
                    let name = clean_html_text(&html[tag_end + 1..close]);
                    if !name.is_empty() && name.len() <= 160 {
                        let (source_kind, game_domain, mod_id) = dependency_identity_from_url(&url);
                        dependencies.push(SourceDependencyItem {
                            id: format!("source-dependency-{}-{}", dependency_id_fragment(mod_id.as_deref().unwrap_or(&name)), dependencies.len()),
                            name,
                            required: true,
                            optional: false,
                            source_kind,
                            game_domain,
                            numeric_game_id: None,
                            mod_id,
                            url: Some(url),
                            notes: None,
                            version_constraint: None,
                        });
                    }
                }
            }
        }
        search_from = close + 4;
    }
    let mut seen = std::collections::BTreeSet::new();
    dependencies.retain(|dependency| seen.insert(format!("{}|{}", dependency.name.to_lowercase(), dependency.url.as_deref().unwrap_or_default())));
    dependencies
}

fn scrape_modworkshop_detail_from_html(id: &str, html: &str) -> SourceModDetail {
    let name = extract_title_from_html(html)
        .map(|text| clean_mod_name(&text))
        .unwrap_or_else(|| format!("ModWorkshop Mod {}", id));
    let description = extract_modworkshop_html_description(html)
        .or_else(|| extract_meta_content(html, "og:description").map(|text| clean_html_text(&text)))
        .or_else(|| extract_meta_content(html, "description").map(|text| clean_html_text(&text)))
        .unwrap_or_else(|| "Description was not exposed by the parsed page.".to_string());

    let thumbnail = extract_meta_content(html, "og:image")
        .or_else(|| first_media_url(&serde_json::Value::Null))
        .and_then(|url| absolutize_source_url("modworkshop", Some(url)))
        .or_else(|| extract_first_img_near(html, 0));

    let files = modworkshop_download_files_from_html(id, html);

    let mut images = Vec::new();
    let mut img_search = 0;
    while let Some(pos) = html[img_search..].find("<img") {
        let abs = img_search + pos;
        let tag_end = html[abs..].find('>').map(|value| abs + value).unwrap_or(abs);
        let tag = &html[abs..=tag_end];

        if let Some(url) = html_attr(tag, "src")
            .or_else(|| html_attr(tag, "data-src"))
            .or_else(|| html_attr(tag, "data-lazy-src"))
            .and_then(|url| absolutize_source_url("modworkshop", Some(url)))
        {
            if !url.contains("avatar") && !url.contains("logo") && images.len() < 10 {
                images.push(SourceImageItem {
                    id: format!("image-{}", images.len() + 1),
                    title: html_attr(tag, "alt"),
                    thumbnail_url: Some(url.clone()),
                    image_url: url,
                });
            }
        }

        img_search = tag_end + 1;
    }

    let summary = SourceModSummary {
        source: "modworkshop".to_string(),
        source_id: id.to_string(),
        uid: None,
        game_id: None,
        name,
        author: None,
        author_username: None,
        author_user_id: None,
        author_profile_url: None,
        author_avatar_url: None,
        version: None,
        thumbnail_url: thumbnail.clone(),
        banner_url: thumbnail,
        page_url: Some(format!("https://modworkshop.net/mod/{}", id)),
        updated_at: None,
        downloads: None,
        likes: None,
        short_description: Some(description.chars().take(220).collect()),
        tags: vec!["ModWorkshop".to_string(), "PAYDAY 3".to_string()],
    };

    let mut detail = source_detail_from_summary(summary, description, files, images);
    detail.dependencies = modworkshop_dependencies_from_html(html);
    detail
}

fn format_size_from_value(value: &serde_json::Value) -> Option<String> {
    let bytes = json_u64(value, &["size", "size_bytes", "sizeBytes", "file_size", "fileSize"]);
    bytes.map(|size| {
        if size >= 1024 * 1024 * 1024 {
            format!("{:.1} GB", size as f64 / 1024.0 / 1024.0 / 1024.0)
        } else if size >= 1024 * 1024 {
            format!("{:.1} MB", size as f64 / 1024.0 / 1024.0)
        } else if size >= 1024 {
            format!("{:.1} KB", size as f64 / 1024.0)
        } else {
            format!("{} B", size)
        }
    })
}


fn nexus_summary_from_graphql_node(node: &serde_json::Value) -> Option<SourceModSummary> {
    let id = json_id_string(node, &["modId", "mod_id", "id", "uid"])?;

    let name = json_string(node, &["name", "title", "modName", "mod_name"])
        .unwrap_or_else(|| format!("Nexus Mod {}", id));

    let author = json_string(node, &["author", "uploadedBy", "uploaded_by", "owner", "uploader", "username"])
        .or_else(|| {
            node.get("author")
                .or_else(|| node.get("uploader"))
                .or_else(|| node.get("owner"))
                .and_then(|value| json_string(value, &["name", "username", "displayName", "display_name"]))
        });

    let thumbnail = absolutize_source_url(
        "nexus",
        json_string(node, &[
            "thumbnailUrl",
            "thumbnail_url",
            "thumbnailLargeUrl",
            "thumbnail_large_url",
            "pictureUrl",
            "picture_url",
            "imageUrl",
            "image_url",
            "tileImageUrl",
            "tile_image_url",
            "logo",
        ])
        .or_else(|| {
            node.get("picture")
                .or_else(|| node.get("image"))
                .or_else(|| node.get("thumbnail"))
                .and_then(|value| json_string(value, &["url", "uri", "thumbnailUrl", "imageUrl"]))
        }),
    );

    let mut tags = vec!["Nexus".to_string(), "Payday 3".to_string()];

    for array_key in ["tags", "categories", "modCategories"] {
        if let Some(array) = node.get(array_key).and_then(|value| value.as_array()) {
            for tag in array {
                if let Some(text) = tag
                    .as_str()
                    .map(|value| value.to_string())
                    .or_else(|| json_string(tag, &["name", "title", "label"]))
                {
                    if !tags.iter().any(|existing| existing.eq_ignore_ascii_case(&text)) {
                        tags.push(text);
                    }
                }
            }
        }
    }

    Some(SourceModSummary {
        source: "nexus".to_string(),
        source_id: id.clone(),
        uid: json_id_string(node, &["uid"]),
        game_id: json_id_string(node, &["gameId", "game_id"]),
        name,
        author,
        author_username: None,
        author_user_id: None,
        author_profile_url: None,
        author_avatar_url: None,
        version: json_string(node, &["version", "latestVersion", "latest_file_version"]),
        thumbnail_url: thumbnail.clone(),
        banner_url: absolutize_source_url(
            "nexus",
            json_string(node, &["bannerUrl", "banner_url", "headerImageUrl", "header_image_url"])
        ).or_else(|| thumbnail.clone()),
        page_url: json_string(node, &["url", "pageUrl", "page_url"]).or_else(|| {
            Some(format!("https://www.nexusmods.com/payday3/mods/{}", id))
        }),
        updated_at: json_timestamp_string(node, &[
            "updatedAt",
            "updated_at",
            "lastUpdated",
            "last_updated",
            "modifiedAt",
            "modified_at",
            "createdAt",
            "created_at",
        ]),
        downloads: json_u64(node, &["downloads", "modDownloads", "mod_downloads", "uniqueDownloads", "totalDownloads"]),
        likes: json_u64(node, &["endorsements", "endorsementCount", "endorsement_count", "likes"]),
        short_description: safe_short_description(
            json_string(node, &["summary", "description", "shortDescription", "short_description", "tagline"])
                .map(|text| html_to_text(&text))
        ),
        tags,
    })
}

fn nexus_graphql_nodes_to_summaries(value: &serde_json::Value) -> Vec<SourceModSummary> {
    let data = unwrap_graphql_data(value);
    let arrays = [
        "nodes",
        "edges",
        "items",
        "results",
        "mods",
        "modFiles",
        "files",
        "data",
    ];

    let mut summaries = Vec::new();
    let Some(array) = json_deep_find_array(data, &arrays, 8) else {
        return summaries;
    };

    for item in array {
        let node = item.get("node").unwrap_or(item);

        if let Some(summary) = nexus_summary_from_graphql_node(node) {
            summaries.push(summary);
        }
    }

    summaries
}

fn canonical_nexus_sort(sort: &str) -> &'static str {
    match sort.trim().to_ascii_lowercase().as_str() {
        "published_at" | "added" | "newest" => "added",
        "bumped_at" | "updated" | "recent" => "updated",
        "popular" | "downloads" => "downloads",
        "liked" | "likes" => "liked",
        "name" => "name",
        _ => "updated",
    }
}

fn nexus_graphql_sort_value(sort: &str) -> serde_json::Value {
    let direction = serde_json::json!({ "direction": "DESC" });

    match canonical_nexus_sort(sort) {
        "added" => serde_json::json!({ "createdAt": direction }),
        "downloads" => serde_json::json!({ "downloads": direction }),
        "liked" => serde_json::json!({ "endorsements": direction }),
        "name" => serde_json::json!({ "name": { "direction": "ASC" } }),
        _ => serde_json::json!({ "updatedAt": direction }),
    }
}

fn nexus_graphql_game_filter(game_domain: &str) -> serde_json::Value {
    // Nexus GraphQL docs: Query.mods accepts filter: ModsFilter, and
    // ModsFilter has gameDomainName: [BaseFilterValue!].
    serde_json::json!({
        "gameDomainName": [
            { "value": game_domain, "op": "EQUALS" }
        ]
    })
}

fn nexus_graphql_payday3_filter() -> serde_json::Value {
    nexus_graphql_game_filter("payday3")
}

fn nexus_graphql_query_variants_for_page_for_domain(game_domain: &str, sort: &str, page: u32, count: usize) -> Vec<(&'static str, serde_json::Value)> {
    let sort_value = nexus_graphql_sort_value(sort);
    let filter_value = nexus_graphql_game_filter(game_domain);
    let safe_count = count.clamp(1, 60) as u32;
    let offset = page.saturating_sub(1).saturating_mul(safe_count);

    vec![
        (
            r#"
            query TsukiBrowsePayday3($count: Int, $offset: Int, $filter: ModsFilter, $sort: [ModsSort!]) {
              mods(filter: $filter, sort: $sort, offset: $offset, count: $count) {
                nodes {
                  id
                  uid
                  gameId
                  modId
                  name
                  summary
                  version
                  createdAt
                  updatedAt
                  downloads
                  endorsements
                  author
                  pictureUrl
                  thumbnailUrl
                  thumbnailLargeUrl
                }
                nodesCount
                totalCount
              }
            }
            "#,
            serde_json::json!({
                "count": safe_count,
                "offset": offset,
                "filter": filter_value,
                "sort": [sort_value],
            }),
        ),
        (
            r#"
            query TsukiBrowsePayday3NoSort($count: Int, $offset: Int, $filter: ModsFilter) {
              mods(filter: $filter, offset: $offset, count: $count) {
                nodes {
                  id
                  uid
                  gameId
                  modId
                  name
                  summary
                  version
                  createdAt
                  updatedAt
                  downloads
                  endorsements
                  author
                  pictureUrl
                  thumbnailUrl
                  thumbnailLargeUrl
                }
                nodesCount
                totalCount
              }
            }
            "#,
            serde_json::json!({
                "count": safe_count,
                "offset": offset,
                "filter": filter_value,
            }),
        ),
    ]
}

fn nexus_graphql_query_variants_for_page(sort: &str, page: u32, count: usize) -> Vec<(&'static str, serde_json::Value)> {
    nexus_graphql_query_variants_for_page_for_domain("payday3", sort, page, count)
}

fn url_encode_light(input: &str) -> String {
    let mut output = String::new();

    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => output.push(byte as char),
            b' ' => output.push('+'),
            _ => output.push_str(&format!("%{:02X}", byte)),
        }
    }

    output
}

fn fetch_nexus_graphql_search_mods_for_domain(query_text: &str, api_key: &str, game_domain: &str) -> Result<Vec<SourceModSummary>, String> {
    let query_text = query_text.trim();
    if query_text.len() < 2 {
        return Ok(Vec::new());
    }

    let filter = serde_json::json!({
        "op": "AND",
        "filter": [
            {
                "gameDomainName": [
                    { "value": game_domain, "op": "EQUALS" }
                ]
            },
            {
                "nameStemmed": [
                    { "value": query_text, "op": "MATCHES" }
                ]
            }
        ]
    });

    let query = r#"
        query TsukiSearchPayday3($count: Int, $offset: Int, $filter: ModsFilter, $sort: [ModsSort!]) {
          mods(filter: $filter, sort: $sort, offset: $offset, count: $count) {
            nodes {
              id
              uid
              gameId
              modId
              name
              summary
              version
              createdAt
              updatedAt
              downloads
              endorsements
              author
              pictureUrl
              thumbnailUrl
              thumbnailLargeUrl
            }
            nodesCount
            totalCount
          }
        }
    "#;

    let variables = serde_json::json!({
        "count": 24,
        "offset": 0,
        "filter": filter,
        "sort": [
            {
                "relevance": {
                    "direction": "DESC"
                }
            }
        ],
    });

    let value = http_post_graphql(query, variables, Some(api_key))?;
    Ok(nexus_sort_browser_summaries(
        nexus_graphql_nodes_to_summaries(&value)
            .into_iter()
            .map(|summary| force_nexus_game_summary(summary, game_domain))
            .collect(),
        "updated",
    ))
}

fn fetch_nexus_graphql_search_mods(query_text: &str, api_key: &str) -> Result<Vec<SourceModSummary>, String> {
    fetch_nexus_graphql_search_mods_for_domain(query_text, api_key, "payday3")
}

fn fetch_nexus_website_search_mods_for_domain(query: &str, sort: &str, allow_adult: bool, game_domain: &str) -> Result<Vec<SourceModSummary>, String> {
    let domain = clean_source_slug(game_domain).unwrap_or_else(|| "payday3".to_string());
    let encoded = url_encode_light(query);
    let urls = vec![
        format!("https://www.nexusmods.com/{}/search/?gsearch={}&BH={}", domain, encoded, if allow_adult { 1 } else { 0 }),
        format!("https://www.nexusmods.com/{}/search/?BH={}&gsearch={}", domain, if allow_adult { 1 } else { 0 }, encoded),
    ];

    let mut ids = Vec::new();

    for url in urls {
        if let Ok(html) = http_get_text(&url) {
            ids.extend(extract_nexus_ids_from_html_for_domain(&html, &domain));
        }
    }

    ids.sort();
    ids.dedup();

    let settings = load_settings_internal();
    let Some(api_key) = settings.nexus_api_key else {
        return Ok(Vec::new());
    };

    let mut mods = Vec::new();

    for id in ids.into_iter().take(80) {
        if let Ok(value) = http_get_json(&format!("https://api.nexusmods.com/v1/games/{}/mods/{}.json", domain, id), Some(api_key.as_str())) {
            let summary = nexus_enrich_summary_for_domain(nexus_summary_from_value(&value), api_key.as_str(), &domain);
            if is_clean_nexus_summary_for_browser(&summary) {
                mods.push(summary);
            }
        }
    }

    Ok(nexus_sort_browser_summaries(mods, sort))
}

fn fetch_nexus_website_search_mods(query: &str, sort: &str, allow_adult: bool) -> Result<Vec<SourceModSummary>, String> {
    fetch_nexus_website_search_mods_for_domain(query, sort, allow_adult, "payday3")
}

fn search_nexus_mods_for_query_sync_for_domain(query: String, game_domain: String) -> Result<Vec<SourceModSummary>, String> {
    let query = query.trim().to_string();
    if query.len() < 2 {
        return Ok(Vec::new());
    }
    let game_domain = clean_source_slug(&game_domain).ok_or_else(|| format!("Invalid Nexus game domain: {}", game_domain))?;

    let settings = load_settings_internal();
    let api_key = settings
        .nexus_api_key
        .as_deref()
        .ok_or_else(|| "Nexus API key is not saved. Paste it in Settings first.".to_string())?;

    let mut combined = Vec::<SourceModSummary>::new();

    // Search the Nexus PAYDAY 3 web route for IDs, then hydrate with REST details.
    if let Ok(website) = fetch_nexus_website_search_mods_for_domain(&query, "updated", settings.show_age_restricted_nexus, &game_domain) {
        combined.extend(website.into_iter().map(|summary| nexus_enrich_summary_for_domain(summary, api_key, &game_domain)));
    }

    let compact_query = compact(&query);
    let cached = read_source_index_database()
        .records
        .into_iter()
        .filter(|(_, record)| record.source.eq_ignore_ascii_case("nexus"))
        .map(|(_, record)| record.summary)
        .filter(|summary| source_summary_matches_nexus_domain(summary, &game_domain))
        .filter(|summary| {
            compact(&summary.name).contains(&compact_query)
                || summary
                    .short_description
                    .as_deref()
                    .map(|text| compact(text).contains(&compact_query))
                    .unwrap_or(false)
                || summary.tags.iter().any(|tag| compact(tag).contains(&compact_query))
        })
        .collect::<Vec<_>>();

    combined.extend(cached);

    // Optional GraphQL search is a helper only. If schema/auth changes, search still works.
    if combined.len() < 6 {
        if let Ok(graphql) = fetch_nexus_graphql_search_mods_for_domain(&query, api_key, &game_domain) {
            combined.extend(graphql);
        }
    }

    combined = combined
        .into_iter()
        .map(|summary| force_nexus_game_summary(summary, &game_domain))
        .filter(|summary| source_summary_matches_nexus_domain(summary, &game_domain))
        .collect();
    let mut results = nexus_sort_browser_summaries(nexus_dedupe_summaries(combined), "updated");
    results.sort_by(|a, b| score_search_result_for_query(b, &query).cmp(&score_search_result_for_query(a, &query)));

    upsert_source_index_summaries(&results);
    Ok(results.into_iter().take(80).collect())
}

fn search_nexus_mods_for_query_sync(query: String) -> Result<Vec<SourceModSummary>, String> {
    search_nexus_mods_for_query_sync_for_domain(query, "payday3".to_string())
}

#[tauri::command]
async fn search_nexus_mods_for_query(query: String, profile_id: Option<String>, source_id: Option<String>) -> Result<Vec<SourceModSummary>, String> {
    let source_config = source_config_for_profile_source(profile_id.as_deref(), source_id.as_deref());
    let game_domain = nexus_domain_from_source_config(&source_config)
        .ok_or_else(|| format!("Nexus search needs a Nexus domain or game page URL. Profile ID: {}.", profile_id.as_deref().unwrap_or("unknown")))?;

    tauri::async_runtime::spawn_blocking(move || search_nexus_mods_for_query_sync_for_domain(query, game_domain))
        .await
        .map_err(|err| format!("Nexus search task failed: {:?}", err))?
}


fn fetch_nexus_graphql_mods_page(sort: &str, api_key: &str) -> Result<Vec<SourceModSummary>, String> {
    fetch_nexus_graphql_mods_page_paged(sort, api_key, 1, 24)
}

fn fetch_nexus_graphql_mods_page_paged_for_domain(
    game_domain: &str,
    sort: &str,
    api_key: &str,
    page: u32,
    count: usize,
) -> Result<Vec<SourceModSummary>, String> {
    fetch_nexus_graphql_browse_page(game_domain, sort, api_key, page, count).map(|result| result.mods)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NexusBrowsePage {
    mods: Vec<SourceModSummary>,
    page: u32,
    has_more: bool,
    total_count: Option<u64>,
}

fn nexus_page_has_more(page: u32, count: usize, raw_count: usize, total: Option<u64>) -> bool {
    total.map(|total| u64::from(page) * (count as u64) < total).unwrap_or(raw_count >= count)
}

fn fetch_nexus_graphql_browse_page(
    game_domain: &str,
    sort: &str,
    api_key: &str,
    page: u32,
    count: usize,
) -> Result<NexusBrowsePage, String> {
    let mut errors = Vec::new();
    let game_domain = clean_source_slug(game_domain).ok_or_else(|| format!("Invalid Nexus game domain: {}", game_domain))?;

    for (query, variables) in nexus_graphql_query_variants_for_page_for_domain(&game_domain, sort, page.max(1), count) {
        match http_post_graphql(query, variables, Some(api_key)) {
            Ok(value) => {
                let nodes = value.pointer("/data/mods/nodes").and_then(serde_json::Value::as_array);
                let Some(nodes) = nodes else {
                    errors.push("Nexus GraphQL did not return a mod page.".to_string());
                    continue;
                };
                let total_count = value.pointer("/data/mods/totalCount").and_then(serde_json::Value::as_u64);
                let summaries = nexus_graphql_nodes_to_summaries(&value)
                    .into_iter()
                    .map(|summary| force_nexus_game_summary(summary, &game_domain))
                    .filter(|summary| source_summary_matches_nexus_domain(summary, &game_domain))
                    .filter(is_clean_nexus_summary_for_browser)
                    .collect::<Vec<_>>();

                let sorted = nexus_sort_browser_summaries(nexus_dedupe_summaries(summaries), sort);
                upsert_source_index_summaries(&sorted);
                return Ok(NexusBrowsePage {
                    mods: sorted,
                    page: page.max(1),
                    has_more: nexus_page_has_more(page.max(1), count, nodes.len(), total_count),
                    total_count,
                });
            }
            Err(error) => errors.push(error),
        }
    }

    Err(format!(
        "Nexus GraphQL browse failed. {}",
        errors.into_iter().take(2).collect::<Vec<_>>().join(" | ")
    ))
}

fn fetch_nexus_graphql_mods_page_paged(
    sort: &str,
    api_key: &str,
    page: u32,
    count: usize,
) -> Result<Vec<SourceModSummary>, String> {
    fetch_nexus_graphql_mods_page_paged_for_domain("payday3", sort, api_key, page, count)
}

fn nexus_graphql_detail_queries(game_id: &str, mod_id: &str) -> Vec<(&'static str, serde_json::Value)> {
    vec![
        (
            r#"
            query TsukiModDetail($gameId: ID!, $modId: ID!) {
              mod(gameId: $gameId, modId: $modId) {
                id
                uid
                gameId
                modId
                name
                summary
                description
                version
                createdAt
                updatedAt
                downloads
                endorsements
                author
                pictureUrl
                thumbnailUrl
                thumbnailLargeUrl
                uploader {
                  name
                  memberId
                  avatar
                }
              }
            }
            "#,
            serde_json::json!({ "gameId": game_id, "modId": mod_id }),
        ),
    ]
}

fn lookup_nexus_game_id_for_mod_id(mod_id: &str) -> Option<String> {
    let normalized_mod_id = normalize_nexus_id_string(mod_id)?;

    read_source_index_database()
        .records
        .into_values()
        .filter(|record| record.source.eq_ignore_ascii_case("nexus"))
        .map(|record| record.summary)
        .find_map(|summary| {
            if summary.source_id == normalized_mod_id {
                summary.game_id.and_then(|game_id| normalize_nexus_id_string(&game_id))
            } else {
                None
            }
        })
}

fn fetch_nexus_graphql_mod_detail(game_id: &str, mod_id: &str, api_key: &str) -> Result<SourceModDetail, String> {
    let mut errors = Vec::new();

    for (query, variables) in nexus_graphql_detail_queries(game_id, mod_id) {
        match http_post_graphql(query, variables, Some(api_key)) {
            Ok(value) => {
                let data = unwrap_graphql_data(&value);
                let mod_object = json_deep_find_object(data, &["mod", "node"], 8)
                    .map(|object| serde_json::Value::Object(object.clone()))
                    .unwrap_or_else(|| data.clone());

                let summary = force_nexus_game_summary(nexus_summary_from_graphql_node(&mod_object)
                    .unwrap_or_else(|| SourceModSummary {
                        source: "nexus".to_string(),
                        source_id: mod_id.to_string(),
                        uid: None,
                        game_id: Some(game_id.to_string()),
                        name: format!("Nexus Mod {}", mod_id),
                        author: None,
                        author_username: None,
                        author_user_id: None,
                        author_profile_url: None,
                        author_avatar_url: None,
                        version: None,
                        thumbnail_url: None,
                        banner_url: None,
                        page_url: Some(format!("https://www.nexusmods.com/payday3/mods/{}", mod_id)),
                        updated_at: None,
                        downloads: None,
                        likes: None,
                        short_description: None,
                        tags: vec!["Nexus".to_string(), "Payday 3".to_string()],
                    }), game_id);

                let description = json_string(&mod_object, &["description", "summary", "shortDescription"])
                    .map(|text| html_to_text(&text))
                    .or_else(|| summary.short_description.clone())
                    .unwrap_or_else(|| "No description exposed by Nexus GraphQL.".to_string());

                let images = json_deep_find_array(data, &["images", "media", "screenshots", "nodes", "edges"], 10)
                    .map(|array| {
                        array
                            .iter()
                            .enumerate()
                            .filter_map(|(index, item)| {
                                let node = item.get("node").unwrap_or(item);
                                let image_url = json_string(node, &["imageUrl", "image_url", "url", "uri"])?;

                                Some(SourceImageItem {
                                    id: json_id_string(node, &["id"]).unwrap_or_else(|| format!("image-{}", index)),
                                    title: json_string(node, &["title", "name"]),
                                    thumbnail_url: json_string(node, &["thumbnailUrl", "thumbnail_url", "thumbnail"]),
                                    image_url,
                                })
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();

                if !summary.name.starts_with("Nexus Mod ") {
                    let mut detail = source_detail_from_summary(summary, description, Vec::new(), images);
                    detail.dependencies = source_dependencies_from_value(
                        &mod_object,
                        Some("nexus"),
                        detail.game_id.as_deref(),
                        detail.game_id.as_deref(),
                    );
                    return Ok(detail);
                }

                errors.push("Nexus GraphQL detail returned placeholder data.".to_string());
            }
            Err(error) => errors.push(error),
        }
    }

    Err(format!(
        "Nexus GraphQL detail failed. {}",
        errors.into_iter().take(2).collect::<Vec<_>>().join(" | ")
    ))
}


fn nexus_summary_from_value(item: &serde_json::Value) -> SourceModSummary {
    let id = json_id_string(item, &["mod_id", "modId", "mod_id", "id"]).unwrap_or_else(|| "unknown".to_string());

    let raw_name = json_string(item, &["name", "title", "mod_name", "modName"]);
    let fallback_name = format!("Nexus Mod {}", id);

    SourceModSummary {
        source: "nexus".to_string(),
        source_id: id.clone(),
        uid: json_id_string(item, &["uid"]),
        game_id: json_id_string(item, &["gameId", "game_id"]),
        name: raw_name.unwrap_or(fallback_name),
        author: json_string(item, &["author", "uploaded_by", "uploadedBy", "user", "username"]),
        author_username: None,
        author_user_id: None,
        author_profile_url: None,
        author_avatar_url: None,
        version: json_string(item, &["version", "latest_file_version", "latestFileVersion"]),
        thumbnail_url: absolutize_source_url("nexus", json_string(item, &[
            "picture_url",
            "pictureUrl",
            "thumbnail_url",
            "thumbnailUrl",
            "image_url",
            "imageUrl",
            "logo",
        ])),
        banner_url: None,
        page_url: Some(format!("https://www.nexusmods.com/payday3/mods/{}", id)),
        updated_at: best_nexus_date(item),
        downloads: json_u64(item, &["mod_downloads", "downloads", "unique_downloads", "total_downloads"]),
        likes: json_u64(item, &["endorsement_count", "endorsements", "likes"]),
        short_description: safe_short_description(json_string(item, &["summary", "description", "short_description"])),
        tags: vec!["Nexus".to_string(), "Payday 3".to_string()],
    }
}

fn force_nexus_game_summary(mut summary: SourceModSummary, game_domain: &str) -> SourceModSummary {
    let domain = clean_source_slug(game_domain).unwrap_or_else(|| "payday3".to_string());
    if domain != "payday3" {
        summary.tags.retain(|tag| !tag.eq_ignore_ascii_case("Payday 3"));
    }
    if summary.source_id != "unknown" {
        summary.page_url = Some(format!("https://www.nexusmods.com/{}/mods/{}", domain, summary.source_id));
    }
    if summary.game_id.as_deref().map(|value| value.trim().is_empty()).unwrap_or(true) {
        summary.game_id = Some(domain.clone());
    }
    if !summary.tags.iter().any(|tag| tag.eq_ignore_ascii_case("Nexus")) {
        summary.tags.insert(0, "Nexus".to_string());
    }
    if !summary.tags.iter().any(|tag| tag.eq_ignore_ascii_case(&domain)) {
        summary.tags.push(domain);
    }
    summary
}

fn nexus_detail_from_website_for_domain(summary: &SourceModSummary, game_domain: &str) -> Option<SourceModSummary> {
    let domain = clean_source_slug(game_domain).unwrap_or_else(|| "payday3".to_string());
    let html = http_get_text(&format!("https://www.nexusmods.com/{}/mods/{}", domain, summary.source_id)).ok()?;
    let title = extract_meta_content(&html, "og:title")
        .or_else(|| extract_title_from_html(&html))
        .map(|text| clean_mod_name(&text));

    let thumbnail = extract_meta_content(&html, "og:image")
        .and_then(|url| absolutize_source_url("nexus", Some(url)));

    let description = extract_meta_content(&html, "og:description")
        .or_else(|| extract_meta_content(&html, "description"))
        .map(|text| clean_mod_name(&clean_html_text(&text)));

    Some(force_nexus_game_summary(SourceModSummary {
        source: summary.source.clone(),
        source_id: summary.source_id.clone(),
        uid: None,
        game_id: None,
        name: title
            .filter(|name| !name.is_empty() && !name.starts_with("Nexus Mod "))
            .unwrap_or_else(|| summary.name.clone()),
        author: summary.author.clone(),
        author_username: None,
        author_user_id: None,
        author_profile_url: None,
        author_avatar_url: None,
        version: summary.version.clone(),
        thumbnail_url: thumbnail.clone().or_else(|| summary.thumbnail_url.clone()),
        banner_url: thumbnail.or_else(|| summary.banner_url.clone()),
        page_url: summary.page_url.clone(),
        updated_at: summary.updated_at.clone(),
        downloads: summary.downloads,
        likes: summary.likes,
        short_description: description.or_else(|| summary.short_description.clone()),
        tags: summary.tags.clone(),
    }, &domain))
}

fn nexus_detail_from_website(summary: &SourceModSummary) -> Option<SourceModSummary> {
    nexus_detail_from_website_for_domain(summary, "payday3")
}

fn extract_nexus_ids_from_html_for_domain(html: &str, game_domain: &str) -> Vec<String> {
    let mut ids = Vec::new();
    let domain = clean_source_slug(game_domain).unwrap_or_else(|| "payday3".to_string());
    let needles = [
        format!("/{}/mods/", domain),
        format!("nexusmods.com/{}/mods/", domain),
    ];

    for needle in needles.iter() {
        let mut search_start = 0;

        while let Some(pos) = html[search_start..].find(needle) {
            let abs = search_start + pos + needle.len();
            let mut id = String::new();

            for ch in html[abs..].chars() {
                if ch.is_ascii_digit() {
                    id.push(ch);
                } else {
                    break;
                }
            }

            let next_start = abs + id.len();

            if !id.is_empty() && !ids.contains(&id) {
                ids.push(id);
            }

            search_start = next_start.max(search_start + pos + needle.len());
        }
    }

    ids
}

fn extract_nexus_ids_from_html(html: &str) -> Vec<String> {
    extract_nexus_ids_from_html_for_domain(html, "payday3")
}

fn extract_anchor_text_near(html: &str, center: usize) -> Option<String> {
    let start = center.saturating_sub(900);
    let end = (center + 1600).min(html.len());
    let window = &html[start..end];

    if let Some(title) = html_attr(window, "title") {
        let cleaned = clean_mod_name(&clean_html_text(&title));
        if !cleaned.is_empty()
            && !cleaned.to_lowercase().contains("image")
            && !cleaned.to_lowercase().contains("view")
        {
            return Some(cleaned);
        }
    }

    if let Some(alt) = html_attr(window, "alt") {
        let cleaned = clean_mod_name(&clean_html_text(&alt));
        if !cleaned.is_empty()
            && !cleaned.to_lowercase().contains("image")
            && !cleaned.to_lowercase().contains("view")
        {
            return Some(cleaned);
        }
    }

    for tag in ["<h3", "<h4", "<h2"] {
        if let Some(pos) = window.find(tag) {
            if let Some(gt) = window[pos..].find('>') {
                let body_start = pos + gt + 1;
                if let Some(close) = window[body_start..].find("</") {
                    let cleaned = clean_mod_name(&clean_html_text(&window[body_start..body_start + close]));
                    if !cleaned.is_empty() {
                        return Some(cleaned);
                    }
                }
            }
        }
    }

    None
}

fn scrape_nexus_summary_from_listing_for_domain(html: &str, id: &str, game_domain: &str) -> SourceModSummary {
    let domain = clean_source_slug(game_domain).unwrap_or_else(|| "payday3".to_string());
    let marker = format!("/{}/mods/{}", domain, id);
    let center = html.find(&marker).unwrap_or_else(|| html.find(id).unwrap_or(0));

    let name = extract_anchor_text_near(html, center)
        .unwrap_or_else(|| format!("Nexus Mod {}", id));

    let thumbnail = extract_first_img_near_for_source(html, center, "nexus");

    force_nexus_game_summary(SourceModSummary {
        source: "nexus".to_string(),
        source_id: id.to_string(),
        uid: None,
        game_id: None,
        name,
        author: None,
        author_username: None,
        author_user_id: None,
        author_profile_url: None,
        author_avatar_url: None,
        version: None,
        thumbnail_url: thumbnail.clone(),
        banner_url: thumbnail,
        page_url: Some(format!("https://www.nexusmods.com/{}/mods/{}", domain, id)),
        updated_at: None,
        downloads: None,
        likes: None,
        short_description: Some(format!("Loaded from Nexus Mods {} browse pages.", domain)),
        tags: vec!["Nexus".to_string(), domain.clone()],
    }, &domain)
}

fn scrape_nexus_summary_from_listing(html: &str, id: &str) -> SourceModSummary {
    scrape_nexus_summary_from_listing_for_domain(html, id, "payday3")
}

fn nexus_browse_urls_for_domain(game_domain: &str, page: u32, sort: &str, include_age_restricted: bool) -> Vec<String> {
    let domain = clean_source_slug(game_domain).unwrap_or_else(|| "payday3".to_string());
    let page = page.max(1);
    let sort_fragment = match sort {
        "added" => "created_time",
        "popular" => "popular",
        "downloads" => "downloads",
        "liked" => "endorsements",
        "updated" => "updated_time",
        _ => "updated_time",
    };

    let adult_fragment = if include_age_restricted { "&adult=1&include_adult=1" } else { "" };

    vec![
        format!("https://www.nexusmods.com/{}/mods/?BH=0&page={}&sort={}{adult_fragment}", domain, page, sort_fragment),
        format!("https://www.nexusmods.com/{}/mods/?BH=0&page={}&tab={}{adult_fragment}", domain, page, sort_fragment),
        format!("https://www.nexusmods.com/{}/mods/?BH=0&page={}{adult_fragment}", domain, page),
    ]
}

fn nexus_browse_urls(page: u32, sort: &str, include_age_restricted: bool) -> Vec<String> {
    nexus_browse_urls_for_domain("payday3", page, sort, include_age_restricted)
}

fn fetch_nexus_website_mods_page_for_domain(page: u32, sort: &str, include_age_restricted: bool, game_domain: &str) -> Result<Vec<SourceModSummary>, String> {
    let domain = clean_source_slug(game_domain).unwrap_or_else(|| "payday3".to_string());
    let mut errors = Vec::new();

    for url in nexus_browse_urls_for_domain(&domain, page, sort, include_age_restricted) {
        match http_get_text(&url) {
            Ok(html) => {
                let ids = extract_nexus_ids_from_html_for_domain(&html, &domain);
                let mut mods = Vec::new();

                for id in ids.into_iter().take(40) {
                    let mut summary = scrape_nexus_summary_from_listing_for_domain(&html, &id, &domain);

                    if summary.name.starts_with("Nexus Mod ") || summary.thumbnail_url.is_none() {
                        if let Some(enriched) = nexus_detail_from_website_for_domain(&summary, &domain) {
                            summary = enriched;
                        }
                    }

                    if !summary.name.starts_with("Nexus Mod ") && !summary.name.trim().is_empty() {
                        mods.push(summary);
                    }
                }

                if !mods.is_empty() {
                    return Ok(mods);
                }

                errors.push(format!("{} returned no parsable Nexus mod cards", url));
            }
            Err(error) => errors.push(error),
        }
    }

    Err(format!(
        "Could not load Nexus website browse page. {}",
        errors.into_iter().take(2).collect::<Vec<_>>().join(" | ")
    ))
}

fn fetch_nexus_website_mods_page(page: u32, sort: &str, include_age_restricted: bool) -> Result<Vec<SourceModSummary>, String> {
    fetch_nexus_website_mods_page_for_domain(page, sort, include_age_restricted, "payday3")
}

fn nexus_enrich_summary_for_domain(summary: SourceModSummary, api_key: &str, game_domain: &str) -> SourceModSummary {
    let domain = clean_source_slug(game_domain).unwrap_or_else(|| "payday3".to_string());
    let name_is_placeholder = summary.name == format!("Nexus Mod {}", summary.source_id)
        || summary.name.trim().is_empty();

    let needs_more = name_is_placeholder
        || summary.thumbnail_url.is_none()
        || summary.short_description.is_none()
        || summary.author.is_none();

    if !needs_more || summary.source_id == "unknown" {
        return summary;
    }

    let mut best = summary.clone();

    if let Ok(value) = http_get_json(
        &format!("https://api.nexusmods.com/v1/games/{}/mods/{}.json", domain, best.source_id),
        Some(api_key),
    ) {
        let enriched = nexus_summary_from_value(&value);

        best = SourceModSummary {
            source: best.source,
            source_id: best.source_id,
            uid: best.uid.or(enriched.uid),
            game_id: best.game_id.or(enriched.game_id),
            name: if enriched.name.starts_with("Nexus Mod ") { best.name } else { enriched.name },
            author: enriched.author.or(best.author),
            author_username: enriched.author_username.or(best.author_username),
            author_user_id: enriched.author_user_id.or(best.author_user_id),
            author_profile_url: enriched.author_profile_url.or(best.author_profile_url),
            author_avatar_url: enriched.author_avatar_url.or(best.author_avatar_url),
            version: enriched.version.or(best.version),
            thumbnail_url: enriched.thumbnail_url.or(best.thumbnail_url),
            banner_url: enriched.banner_url.or(best.banner_url),
            page_url: enriched.page_url.or(best.page_url),
            updated_at: enriched.updated_at.or(best.updated_at),
            downloads: enriched.downloads.or(best.downloads),
            likes: enriched.likes.or(best.likes),
            short_description: enriched.short_description.or(best.short_description),
            tags: best.tags,
        };
    }

    if best.name.starts_with("Nexus Mod ") || best.thumbnail_url.is_none() || best.short_description.is_none() {
        if let Some(web) = nexus_detail_from_website_for_domain(&best, &domain) {
            return web;
        }
    }

    force_nexus_game_summary(best, &domain)
}

fn nexus_enrich_summary(summary: SourceModSummary, api_key: &str) -> SourceModSummary {
    nexus_enrich_summary_for_domain(summary, api_key, "payday3")
}



fn source_file_date_score(file: &SourceFileItem) -> i64 {
    let Some(value) = file.uploaded_at.as_ref() else {
        return 0;
    };

    if let Ok(number) = value.parse::<i64>() {
        return if number > 10_000_000_000 { number / 1000 } else { number };
    }

    // Cheap ISO-ish fallback: keep only digits so YYYYMMDD sorts correctly enough.
    let digits: String = value.chars().filter(|ch| ch.is_ascii_digit()).collect();
    digits.get(0..14.min(digits.len())).and_then(|short| short.parse::<i64>().ok()).unwrap_or(0)
}

fn sort_source_files_newest_first(files: &mut Vec<SourceFileItem>) {
    files.sort_by(|a, b| source_file_date_score(b).cmp(&source_file_date_score(a)));
}

fn is_image_or_page_asset_name(value: &str) -> bool {
    let lower = value.to_lowercase();
    let clean = lower.split('?').next().unwrap_or(&lower).trim_matches('"').trim_matches('\'');

    if clean.contains("/images/")
        || clean.contains("/image/")
        || clean.contains("/media/")
        || clean.contains("/thumbnail")
        || clean.contains("/avatar")
    {
        return true;
    }

    [
        ".webp", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".avif", ".ico",
        ".bmp", ".tiff", ".apng", ".webp_", ".png_", ".jpg_", ".jpeg_",
    ]
    .iter()
    .any(|extension| clean.ends_with(extension))
}

fn is_likely_source_download_file(file: &SourceFileItem) -> bool {
    let name = file.name.to_lowercase();
    let url = file.download_url.as_deref().unwrap_or("").to_lowercase();

    if is_image_or_page_asset_name(&name) || is_image_or_page_asset_name(&url) {
        return false;
    }

    if url.contains("/images/")
        || url.contains("/image/")
        || url.contains("/media/")
        || url.contains("/thumbnails/")
        || url.contains("/thumbnail/")
        || url.contains("/avatars/")
        || url.contains("/avatar/")
        || name.starts_with("thumbnail_")
    {
        return false;
    }

    let combined = format!("{} {}", name, url);

    if combined.contains("/download")
        || combined.contains("/files/")
        || combined.contains("/mods/files/")
        || combined.contains("api.modworkshop.net")
        || combined.contains("nexusmods.com")
        || combined.contains("storage.modworkshop.net")
    {
        return true;
    }

    [
        ".zip", ".rar", ".7z", ".pak", ".ucas", ".utoc", ".dll", ".lua", ".ini",
        ".json", ".bk2", ".bik", ".mp4", ".webm", ".wem", ".bnk",
    ]
    .iter()
    .any(|extension| combined.ends_with(extension))
}

fn looks_like_external_mod_manager_download(
    source: &str,
    mod_name: &str,
    file_name: &str,
    description: &str,
    download_url: Option<&str>,
) -> bool {
    let combined = format!(
        "{} {} {} {} {}",
        source,
        mod_name,
        file_name,
        description,
        download_url.unwrap_or("")
    )
    .to_lowercase();

    let manager_markers = [
        "mod manager",
        "modmanager",
        "mod-manager",
        "payday 3 mod manager",
        "payday3 mod manager",
        "pd3 mod manager",
        "moolah mod manager",
        "moolah",
        "tsuki mod manager",
        "tsukimodmanager",
        "vortex",
        "mod organizer",
        "modorganizer",
        "mod organizer 2",
        "mo2",
        "r2modman",
        "gale mod manager",
        "thunderstore mod manager",
        "frosty mod manager",
        "fluffy mod manager",
        "fluffy manager",
        "vortex installer",
        "mod manager installer",
        "manager setup",
        "setup wizard",
        "installer",
    ];

    if manager_markers.iter().any(|marker| combined.contains(marker)) {
        return true;
    }

    let lower_file = file_name.to_lowercase();
    lower_file.ends_with(".exe") || lower_file.ends_with(".msi") || lower_file.ends_with(".appinstaller") || lower_file.ends_with(".msix") || lower_file.ends_with(".bat") || lower_file.ends_with(".cmd")
}

fn filter_source_download_files(files: Vec<SourceFileItem>) -> Vec<SourceFileItem> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();

    for file in files {
        if !is_likely_source_download_file(&file) {
            continue;
        }

        let key = file
            .download_url
            .clone()
            .unwrap_or_else(|| format!("{}::{}", file.id, file.name));

        if seen.insert(key) {
            out.push(file);
        }
    }

    out
}

fn first_modworkshop_storage_url_from_html(html: &str) -> Option<String> {
    let mut pos = 0;

    while let Some(found) = html[pos..].find("https://storage.modworkshop.net/") {
        let start = pos + found;
        let rest = &html[start..];
        let end = rest
            .find(|ch: char| ch.is_whitespace() || ch == '"' || ch == '\'' || ch == '<' || ch == ')' || ch == ']')
            .unwrap_or(rest.len());

        let url = decode_html_entities(rest[..end].trim()).to_string();

        if !url.is_empty() && !is_image_or_page_asset_name(&url) {
            return Some(url);
        }

        pos = start + end;
    }

    None
}

fn read_file_magic(path: &Path) -> Vec<u8> {
    let mut buffer = [0u8; 8];

    if let Ok(mut file) = File::open(path) {
        if let Ok(bytes_read) = file.read(&mut buffer) {
            return buffer[..bytes_read].to_vec();
        }
    }

    Vec::new()
}

fn file_has_zip_magic(path: &Path) -> bool {
    let magic = read_file_magic(path);
    magic.starts_with(b"PK\x03\x04") || magic.starts_with(b"PK\x05\x06") || magic.starts_with(b"PK\x07\x08")
}

fn magic_archive_extension(path: &Path) -> Option<&'static str> {
    let magic = read_file_magic(path);

    if magic.starts_with(b"PK\x03\x04") || magic.starts_with(b"PK\x05\x06") || magic.starts_with(b"PK\x07\x08") {
        return Some("zip");
    }

    if magic.starts_with(b"Rar!\x1A\x07") {
        return Some("rar");
    }

    if magic.starts_with(&[0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]) {
        return Some("7z");
    }

    None
}

fn rename_staged_download_if_fake_zip(staged_file: &Path, source: &str, mod_id: &str, file_id: &str, file_name: &str) -> Result<PathBuf, String> {
    let extension = staged_file
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    if extension != "zip" {
        return Ok(staged_file.to_path_buf());
    }

    if file_has_zip_magic(staged_file) {
        return Ok(staged_file.to_path_buf());
    }

    let detected_extension = magic_archive_extension(staged_file).unwrap_or_else(|| {
        // ModWorkshop often returns a loose .pak from an API/download endpoint with no filename.
        // Older builds saved that as ".zip", then tried to unzip it and failed with EOCD.
        if source.eq_ignore_ascii_case("modworkshop") || source.eq_ignore_ascii_case("nexus") {
            "pak"
        } else {
            "bin"
        }
    });

    let base_name = sanitize_file_component(file_name)
        .trim_end_matches(".zip")
        .trim()
        .to_string();

    let next_name = if base_name.is_empty() || base_name.eq_ignore_ascii_case("latest modworkshop file") {
        let mod_part = sanitize_file_component(mod_id);
        let file_part = sanitize_file_component(file_id);

        if file_part.is_empty() || file_part.eq_ignore_ascii_case("latest") {
            format!("{}_latest.{}", mod_part, detected_extension)
        } else {
            format!("{}_{}.{}", mod_part, file_part, detected_extension)
        }
    } else {
        format!("{}.{}", base_name, detected_extension)
    };

    let next_path = staged_file.with_file_name(next_name);

    if next_path == staged_file {
        return Ok(staged_file.to_path_buf());
    }

    fs::rename(staged_file, &next_path)
        .map_err(|err| format!("Downloaded file was not a ZIP, but failed to rename staged file: {}", err))?;

    Ok(next_path)
}

fn unique_destination_path(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }

    let parent = path.parent().unwrap_or_else(|| Path::new(""));
    let stem = path.file_stem().and_then(|value| value.to_str()).unwrap_or("file");
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("");

    for index in 2..500 {
        let name = if extension.is_empty() {
            format!("{}_{}", stem, index)
        } else {
            format!("{}_{}.{}", stem, index, extension)
        };

        let candidate = parent.join(name);

        if !candidate.exists() {
            return candidate;
        }
    }

    path.to_path_buf()
}

fn open_http_url(url: &str) -> Result<String, String> {
    let trimmed = url.trim();

    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("Only http/https URLs can be opened.".to_string());
    }

    let mut command = Command::new("cmd");
    hide_command_window(&mut command);
    command
        .args(["/C", "start", "", trimmed])
        .spawn()
        .map_err(|err| format!("Failed to open URL: {}", err))?;

    Ok(format!("Opened {}", trimmed))
}

fn first_download_uri(value: &serde_json::Value) -> Option<String> {
    if let Some(array) = value.as_array() {
        for item in array {
            if let Some(uri) = json_string(item, &["URI", "uri", "url", "download_url", "downloadUrl"]) {
                return Some(uri);
            }
        }
    }

    json_string(value, &["URI", "uri", "url", "download_url", "downloadUrl"])
        .or_else(|| {
            for item in json_array(value, &["data", "links", "download_links", "downloadLinks"]) {
                if let Some(uri) = json_string(item, &["URI", "uri", "url", "download_url", "downloadUrl"]) {
                    return Some(uri);
                }
            }

            None
        })
}

#[tauri::command]
fn open_source_file_download(
    source: String,
    mod_id: String,
    file_id: String,
    download_url: Option<String>,
    page_url: Option<String>,
    game_domain: Option<String>,
    profile_id: Option<String>,
) -> Result<String, String> {
    let source_lower = source.to_lowercase();

    if source_lower == "nexus" {
        let settings = load_settings_internal();
        let api_key = settings
            .nexus_api_key
            .as_deref()
            .ok_or_else(|| "Nexus API key is not saved. Paste it in Settings first.".to_string())?;
        let nexus_domain = safe_nexus_game_domain(game_domain.as_deref())
            .or_else(|| {
                let source_config = source_config_for_profile_id(profile_id.as_deref());
                nexus_domain_from_source_config(&source_config)
            })
            .unwrap_or_else(|| "payday3".to_string());

        let url = format!(
            "https://api.nexusmods.com/v1/games/{}/mods/{}/files/{}/download_link.json",
            nexus_domain,
            mod_id.trim(),
            file_id.trim()
        );

        if let Ok(value) = http_get_json(&url, Some(api_key)) {
            if let Some(uri) = first_download_uri(&value) {
                return open_http_url(&uri);
            }
        }

        if let Some(page) = page_url {
            let fallback = if page.contains("?") {
                format!("{}&tab=files&file_id={}", page, file_id.trim())
            } else {
                format!("{}?tab=files&file_id={}", page, file_id.trim())
            };

            return open_http_url(&fallback);
        }

        return Err("Could not resolve a Nexus download link or source page for this file.".to_string());
    }

    if let Some(url) = download_url {
        if !url.trim().is_empty() {
            return open_http_url(&url);
        }
    }

    if let Some(page) = page_url {
        return open_http_url(&page);
    }

    Err("No download URL or source page was available for this file.".to_string())
}


fn source_detail_from_summary(summary: SourceModSummary, description: String, files: Vec<SourceFileItem>, images: Vec<SourceImageItem>) -> SourceModDetail {
    SourceModDetail {
        stats: vec![
            SourceStatItem { label: "Downloads".to_string(), value: summary.downloads.map(|v| v.to_string()).unwrap_or_else(|| "Unknown".to_string()) },
            SourceStatItem { label: "Likes/Endorsements".to_string(), value: summary.likes.map(|v| v.to_string()).unwrap_or_else(|| "Unknown".to_string()) },
            SourceStatItem { label: "Updated".to_string(), value: summary.updated_at.clone().unwrap_or_else(|| "Unknown".to_string()) },
        ],
        comments: Vec::new(),
        bugs: Vec::new(),
        logs: Vec::new(),
        changelog: None,
        description,
        files,
        images,
        dependencies: Vec::new(),
        source: summary.source,
        source_id: summary.source_id,
        uid: summary.uid,
        game_id: summary.game_id,
        name: summary.name,
        author: summary.author,
        author_username: summary.author_username,
        author_user_id: summary.author_user_id,
        author_profile_url: summary.author_profile_url,
        author_avatar_url: summary.author_avatar_url,
        version: summary.version,
        thumbnail_url: summary.thumbnail_url,
        banner_url: summary.banner_url,
        page_url: summary.page_url,
        updated_at: summary.updated_at,
        downloads: summary.downloads,
        likes: summary.likes,
        short_description: summary.short_description,
        tags: summary.tags,
    }
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NexusAccountIntegrationStatus {
    api_key_saved: bool,
    validated: bool,
    user_name: Option<String>,
    can_load_updated_mods: bool,
    can_resolve_download_links: bool,
    notes: Vec<String>,
}

#[tauri::command]
fn nexus_account_integration_status() -> Result<NexusAccountIntegrationStatus, String> {
    let settings = load_settings_internal();
    let Some(api_key) = settings.nexus_api_key.as_deref() else {
        return Ok(NexusAccountIntegrationStatus {
            api_key_saved: false,
            validated: false,
            user_name: None,
            can_load_updated_mods: false,
            can_resolve_download_links: false,
            notes: vec![
                "No Nexus API key is saved. Paste your Nexus API key in Settings first.".to_string(),
                "Nexus website download-history badges are not fully exposed through the basic public metadata path, so Tsuki uses API metadata plus local receipts for update decisions.".to_string(),
            ],
        });
    };

    let validate = http_get_json("https://api.nexusmods.com/v1/users/validate.json", Some(api_key));
    let mut notes = Vec::new();
    let mut user_name = None;
    let validated = match validate {
        Ok(value) => {
            user_name = json_string(&value, &["name", "username", "user_name"]);
            true
        }
        Err(error) => {
            notes.push(format!("Nexus API key validation failed: {}", error));
            false
        }
    };

    let can_load_updated_mods = http_get_json(
        "https://api.nexusmods.com/v1/games/payday3/mods/updated.json?period=1w",
        Some(api_key),
    )
    .is_ok();

    // This verifies the account/API path exists in principle. Actual file link resolution still needs a real mod_id/file_id.
    let can_resolve_download_links = validated;

    notes.push("Tsuki can use Nexus API metadata and file download_link endpoints when a real mod file is selected.".to_string());
    notes.push("Nexus website 'downloaded' history is treated as account-private website state; Tsuki will not guess it. Receipts and exact file IDs remain the source of truth for installed/downloaded state.".to_string());

    Ok(NexusAccountIntegrationStatus {
        api_key_saved: true,
        validated,
        user_name,
        can_load_updated_mods,
        can_resolve_download_links,
        notes,
    })
}



#[tauri::command]
fn get_nexus_graphql_diagnostic() -> Result<String, String> {
    if let Some(value) = read_nexus_graphql_diagnostic() {
        serde_json::to_string_pretty(&value)
            .map_err(|err| format!("Failed to serialize Nexus GraphQL diagnostic: {}", err))
    } else {
        Ok("No Nexus GraphQL diagnostic has been recorded yet. Run Check GraphQL v2 first.".to_string())
    }
}


#[tauri::command]
fn fetch_nexus_updated_mods() -> Result<Vec<SourceModSummary>, String> {
    let settings = load_settings_internal();
    let api_key = settings
        .nexus_api_key
        .as_deref()
        .ok_or_else(|| "Nexus API key is not saved. Paste it in Settings first.".to_string())?;

    let value = http_get_json(
        "https://api.nexusmods.com/v1/games/payday3/mods/updated.json?period=1w",
        Some(api_key),
    )?;

    let array = value
        .as_array()
        .ok_or_else(|| "Nexus updated mods response was not an array.".to_string())?;

    let summaries = array
        .iter()
        .take(30)
        .map(nexus_summary_from_value)
        .map(|summary| nexus_enrich_summary(summary, api_key))
        .collect();

    Ok(summaries)
}


#[tauri::command]
fn nexus_graphql_v2_status() -> Result<String, String> {
    let settings = load_settings_internal();
    let api_key = settings
        .nexus_api_key
        .as_deref()
        .ok_or_else(|| "Nexus API key is not saved. Paste it in Settings first.".to_string())?;

    match fetch_nexus_graphql_mods_page("recent", api_key) {
        Ok(mods) => Ok(format!(
            "Nexus GraphQL v2 diagnostic online. Loaded {} PAYDAY 3 card(s). GraphQL live Browse is eligible and REST/cache remain fallback.",
            mods.len()
        )),
        Err(error) => Ok(format!(
            "Nexus GraphQL v2 diagnostic failed. Browse will fall back to REST/cache. Last GraphQL error: {}",
            error
        )),
    }
}


#[tauri::command]
fn fetch_nexus_mod_detail(mod_id: String, profile_id: Option<String>, game_domain: Option<String>) -> Result<SourceModDetail, String> {
    let settings = load_settings_internal();
    let api_key = settings
        .nexus_api_key
        .as_deref()
        .ok_or_else(|| "Nexus API key is not saved. Paste it in Settings first.".to_string())?;

    let nexus_domain = safe_nexus_game_domain(game_domain.as_deref())
        .or_else(|| {
            let source_config = source_config_for_profile_id(profile_id.as_deref());
            nexus_domain_from_source_config(&source_config)
        })
        .ok_or_else(|| "This profile has no Nexus game mapping. Paste a full Nexus mod page URL or configure a Nexus source for this profile.".to_string())?;

    // GraphQL detail is metadata-only for now. The live schema path works, but
    // files are still more reliable through Nexus REST V1, so never return a
    // GraphQL-only detail page with 0 downloads.
    // File selection needs authoritative REST data first, not a blocking GraphQL enrichment request.
    let graphql_detail: Option<SourceModDetail> = None;

    let mod_value = http_get_json(
        &format!("https://api.nexusmods.com/v1/games/{}/mods/{}.json", nexus_domain, mod_id),
        Some(api_key),
    )?;

    let mut summary = nexus_summary_from_value(&mod_value);
    summary.game_id = summary.game_id.or_else(|| Some(nexus_domain.clone()));
    summary.page_url = Some(format!("https://www.nexusmods.com/{}/mods/{}", nexus_domain, mod_id));
    let description = json_string(&mod_value, &["description", "summary"])
        .map(|text| html_to_text(&text))
        .unwrap_or_else(|| "No description exposed by this API response.".to_string());

    let files_value = http_get_json(
        &format!("https://api.nexusmods.com/v1/games/{}/mods/{}/files.json", nexus_domain, mod_id),
        Some(api_key),
    )
    .unwrap_or(serde_json::Value::Null);

    let mut file_items = json_array(&files_value, &["files", "data"])
        .into_iter()
        .map(|file| {
            let id = json_id_string(file, &["file_id", "fileId", "id"]).unwrap_or_else(|| "unknown".to_string());

            SourceFileItem {
                id: id.clone(),
                name: json_string(file, &["name", "file_name", "fileName"]).unwrap_or_else(|| "Unknown file".to_string()),
                version: json_string(file, &["version"]),
                size_label: format_size_from_value(file),
                uploaded_at: json_timestamp_string(file, &[
                    "uploaded_timestamp",
                    "uploadedTimestamp",
                    "uploaded_time",
                    "uploadedTime",
                    "created_timestamp",
                    "createdTimestamp",
                    "created_time",
                    "createdTime",
                    "date",
                ]),
                download_url: json_string(file, &["download_url", "downloadUrl"]).or_else(|| {
                    Some(format!(
                        "https://www.nexusmods.com/{}/mods/{}?tab=files&file_id={}",
                        nexus_domain,
                        mod_id,
                        id
                    ))
                }),
                file_type: json_string(file, &["category_name"]),
                download_count: None,
            }
        })
        .filter(|file| normalize_nexus_id_string(&file.id).is_some())
        .collect::<Vec<_>>();

    sort_source_files_newest_first(&mut file_items);
    file_items = filter_source_download_files(file_items);

    let images_value = http_get_json(
        &format!("https://api.nexusmods.com/v1/games/{}/mods/{}/images.json", nexus_domain, mod_id),
        Some(api_key),
    )
    .unwrap_or(serde_json::Value::Null);

    let mut image_items = json_array(&images_value, &["images", "data"])
        .into_iter()
        .enumerate()
        .filter_map(|(index, image)| {
            let image_url = json_string(image, &["URI", "uri", "url", "image_url", "imageUrl"])?;
            Some(SourceImageItem {
                id: json_id_string(image, &["id"]).unwrap_or_else(|| format!("image-{}", index)),
                title: json_string(image, &["name", "title"]),
                thumbnail_url: json_string(image, &["thumbnail_url", "thumbnailUrl", "thumbnail"]),
                image_url,
            })
        })
        .collect::<Vec<_>>();

    let mut detail = source_detail_from_summary(summary, description, file_items, image_items);
    detail.dependencies = source_dependencies_from_value(&mod_value, Some("nexus"), Some(&nexus_domain), None);
    for dependency in source_dependencies_from_value(&files_value, Some("nexus"), Some(&nexus_domain), None) {
        if !detail.dependencies.iter().any(|existing| existing.name.eq_ignore_ascii_case(&dependency.name) && existing.mod_id == dependency.mod_id) {
            detail.dependencies.push(dependency);
        }
    }
    detail.game_id = detail.game_id.or_else(|| Some(nexus_domain.clone()));
    detail.page_url = detail
        .page_url
        .or_else(|| Some(format!("https://www.nexusmods.com/{}/mods/{}", nexus_domain, mod_id)));

    if let Some(graphql) = graphql_detail {
        detail.uid = graphql.uid.or(detail.uid);
        detail.game_id = graphql.game_id.or(detail.game_id);

        if graphql.thumbnail_url.is_some() {
            detail.thumbnail_url = graphql.thumbnail_url;
        }

        if graphql.banner_url.is_some() {
            detail.banner_url = graphql.banner_url;
        }

        if graphql.author.is_some() {
            detail.author = graphql.author;
        }

        if graphql.version.is_some() {
            detail.version = graphql.version;
        }

        if graphql.updated_at.is_some() {
            detail.updated_at = graphql.updated_at;
        }

        if graphql.downloads.is_some() {
            detail.downloads = graphql.downloads;
        }

        if graphql.likes.is_some() {
            detail.likes = graphql.likes;
        }

        if !graphql.description.trim().is_empty()
            && !graphql.description.starts_with("No description exposed")
        {
            detail.description = graphql.description;
        }

        if !graphql.images.is_empty() {
            image_items = graphql.images;
            detail.images = image_items;
        }

        detail.logs.push("GraphQL metadata merged. Files are loaded from Nexus REST V1 so the Downloads panel does not go empty.".to_string());
    } else {
        detail.logs.push("GraphQL metadata skipped or unavailable. Files loaded from Nexus REST V1.".to_string());
    }

    if detail.files.is_empty() {
        detail.logs.push("Nexus REST V1 files endpoint returned no installable files. Use Website if the website shows files behind extra permissions.".to_string());
    }

    upsert_source_index_detail(&detail);
    Ok(detail)
}



fn percent_decode_light(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut output = Vec::new();
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = &input[index + 1..index + 3];
            if let Ok(value) = u8::from_str_radix(hex, 16) {
                output.push(value);
                index += 3;
                continue;
            }
        }

        if bytes[index] == b'+' {
            output.push(b' ');
        } else {
            output.push(bytes[index]);
        }

        index += 1;
    }

    String::from_utf8_lossy(&output).to_string()
}

fn file_name_from_download_url(url: &str) -> Option<String> {
    if let Some(filename_pos) = url.find("filename=") {
        let after = &url[filename_pos + "filename=".len()..];
        let raw = after.split('&').next().unwrap_or(after);
        let decoded = percent_decode_light(raw);
        let clean = sanitize_file_component(&decoded);

        if !clean.trim().is_empty() {
            return Some(clean);
        }
    }

    guess_file_name_from_url(url)
}

fn modworkshop_download_files_from_html(mod_id: &str, html: &str) -> Vec<SourceFileItem> {
    let mut files = Vec::new();
    let mut search_start = 0;

    while let Some(pos) = html[search_start..].find("<a") {
        let abs = search_start + pos;
        let tag_end = html[abs..].find('>').map(|value| abs + value).unwrap_or(abs);
        let tag = &html[abs..=tag_end];

        if let Some(raw_href) = html_attr(tag, "href") {
            let href = decode_html_entities(&raw_href);
            let href_lower = href.to_lowercase();

            let looks_like_download = href_lower.contains("storage.modworkshop.net")
                || href_lower.contains("/mods/files/")
                || href_lower.contains("/download");

            if looks_like_download {
                if let Some(url) = absolutize_source_url("modworkshop", Some(href.clone())) {
                    let url_lower = url.to_lowercase();

                    // Avoid install-with-manager links and normal navigation.
                    if !url_lower.starts_with("install:")
                        && !url_lower.contains("modorganizer")
                        && !url_lower.contains("/users/")
                    {
                        let name = file_name_from_download_url(&url)
                            .unwrap_or_else(|| format!("ModWorkshop file {}", files.len() + 1));

                        if !files.iter().any(|existing: &SourceFileItem| existing.download_url.as_deref() == Some(url.as_str())) {
                            files.push(SourceFileItem {
                                id: format!("direct-{}", files.len() + 1),
                                name,
                                version: None,
                                size_label: None,
                                uploaded_at: None,
                                download_url: Some(url),
                                file_type: None,
                                download_count: None,
                            });
                        }
                    }
                }
            }
        }

        search_start = tag_end.saturating_add(1);
    }

    if files.is_empty() {
        // Some rendered/plain parsed pages still expose storage links without normal anchor parsing.
        let mut pos = 0;
        while let Some(found) = html[pos..].find("https://storage.modworkshop.net/") {
            let start = pos + found;
            let rest = &html[start..];
            let end = rest
                .find(|ch: char| ch.is_whitespace() || ch == '"' || ch == '\'' || ch == '<' || ch == ')')
                .unwrap_or(rest.len());
            let url = decode_html_entities(&rest[..end]).trim().to_string();

            if !url.is_empty() && !files.iter().any(|existing: &SourceFileItem| existing.download_url.as_deref() == Some(url.as_str())) {
                let name = file_name_from_download_url(&url)
                    .unwrap_or_else(|| format!("ModWorkshop file {}", files.len() + 1));

                files.push(SourceFileItem {
                    id: format!("direct-{}", files.len() + 1),
                    name,
                    version: None,
                    size_label: None,
                    uploaded_at: None,
                    download_url: Some(url),
                    file_type: None,
                    download_count: None,
                });
            }

            pos = start + end;
        }
    }

    let mut files = prefer_named_modworkshop_files(filter_source_download_files(files));

    if files.is_empty() {
        files.push(SourceFileItem {
            id: "latest".to_string(),
            name: "Latest ModWorkshop file".to_string(),
            version: None,
            size_label: None,
            uploaded_at: None,
            download_url: Some(format!("https://api.modworkshop.net/mods/{}/files/latest/download", mod_id)),
            file_type: None,
            download_count: None,
        });
    }

    files
}


fn is_generic_modworkshop_file_name(name: &str) -> bool {
    let lower = name.trim().to_lowercase();

    if lower == "download" || lower == "latest modworkshop file" || lower == "latest" {
        return true;
    }

    let Some(rest) = lower.strip_prefix("modworkshop file ") else {
        return false;
    };

    !rest.trim().is_empty() && rest.trim().chars().all(|ch| ch.is_ascii_digit())
}

fn name_or_url_has_install_route_hint(file: &SourceFileItem) -> bool {
    let combined = format!(
        "{} {}",
        file.name.to_lowercase(),
        file.download_url.as_deref().unwrap_or("").to_lowercase()
    );

    [
        ".zip", ".rar", ".7z", ".pak", ".ucas", ".utoc", ".dll", ".lua", ".ini",
        ".json", ".toml", ".bk2", ".bik", ".mp4", ".webm", ".usm", ".wmv", ".m4v",
        ".mov", ".wem", ".bnk",
    ]
    .iter()
    .any(|token| combined.contains(token))
        || combined.contains("/mods/")
        || combined.contains("content/movies")
        || combined.contains("/download")
}

fn prefer_named_modworkshop_files(files: Vec<SourceFileItem>) -> Vec<SourceFileItem> {
    let has_named_route_file = files.iter().any(|file| {
                !is_generic_modworkshop_file_name(&file.name)
            && (
                known_download_extension(&file.name).is_some()
                    || name_or_url_has_install_route_hint(file)
            )
    });

    if !has_named_route_file {
        return files;
    }

    files
        .into_iter()
        .filter(|file| {
            !is_generic_modworkshop_file_name(&file.name)
                || known_download_extension(&file.name).is_some()
        })
        .collect()
}


fn modworkshop_file_item_from_json(mod_id: &str, file: &serde_json::Value) -> Option<SourceFileItem> {
    let file_id = json_u64(file, &["id", "file_id", "fileId"])
        .map(|v| v.to_string())
        .or_else(|| json_string(file, &["id", "file_id", "fileId"]))
        .or_else(|| json_u64(file, &["version_id", "versionId"]).map(|v| v.to_string()))
        .or_else(|| json_string(file, &["version_id", "versionId"]))
        .unwrap_or_else(|| "latest".to_string());

    let download_url = absolutize_source_url(
        "modworkshop",
        json_string(file, &[
            "download_url",
            "downloadUrl",
            "download",
            "url",
            "URI",
            "uri",
            "link",
            "href",
        ]),
    )
    .or_else(|| {
        if file_id != "unknown" && file_id != "latest" {
            Some(format!(
                "https://api.modworkshop.net/files/{}/download",
                file_id
            ))
        } else {
            Some(format!(
                "https://api.modworkshop.net/mods/{}/files/latest/download",
                mod_id
            ))
        }
    });

    let mut name = json_string(file, &[
        "filename",
        "file_name",
        "fileName",
        "original_filename",
        "originalFilename",
        "original_name",
        "originalName",
        "stored_name",
        "storedName",
        "display_name",
        "displayName",
        "name",
        "title",
        "path",
    ])
    .map(|value| sanitize_file_component(&clean_html_text(&value)))
    .filter(|value| !value.trim().is_empty());

    if let Some(url_name) = download_url
        .as_ref()
        .and_then(|url| file_name_from_download_url(url))
        .filter(|value| known_download_extension(value).is_some())
    {
        let current_is_generic = name
            .as_ref()
            .map(|value| {
                let lower = value.to_lowercase();
                lower == "download"
                    || lower == "latest"
                    || lower == "latest modworkshop file"
                    || lower.starts_with("modworkshop file")
                    || known_download_extension(value).is_none()
            })
            .unwrap_or(true);

        if current_is_generic {
            name = Some(url_name);
        }
    }

    let name = name.unwrap_or_else(|| {
        if file_id != "latest" && file_id != "unknown" {
            format!("ModWorkshop file {}", file_id)
        } else {
            "Latest ModWorkshop file".to_string()
        }
    });

    let item = SourceFileItem {
        id: file_id,
        name,
        version: json_string(file, &["version", "version_name", "versionName", "version_label", "versionLabel"]),
        size_label: format_size_from_value(file),
        uploaded_at: json_timestamp_string(file, &[
            "uploaded_at",
            "uploadedAt",
            "created_at",
            "createdAt",
            "updated_at",
            "updatedAt",
            "date",
        ]),
        download_url,
        file_type: json_string(file, &["type", "file_type", "fileType", "extension"]),
        download_count: json_u64(file, &["downloads", "download_count", "downloadCount"]),
    };

    if is_likely_source_download_file(&item)
        || known_download_extension(&item.name).is_some()
        || item.download_url.as_deref().unwrap_or("").contains("/download")
    {
        Some(item)
    } else {
        None
    }
}

fn is_real_modworkshop_file_item(mod_id: &str, file: &SourceFileItem) -> bool {
    file.id != mod_id
        && file.id != "unknown"
        && file.id != "latest"
        && !file.id.starts_with("direct-")
        && !file.id.starts_with("download-")
        && (
            !is_generic_modworkshop_file_name(&file.name)
                || file.download_url
                    .as_deref()
                    .map(|url| url.contains("storage.modworkshop.net") || url.contains("api.modworkshop.net/files/"))
                    .unwrap_or(false)
        )
}

fn collect_modworkshop_file_items_recursive(mod_id: &str, value: &serde_json::Value, out: &mut Vec<SourceFileItem>, depth: usize) {
    if depth > 7 {
        return;
    }

    if let Some(object) = value.as_object() {
        let looks_like_file = object.keys().any(|key| {
            matches!(
                key.as_str(),
                "filename"
                    | "file_name"
                    | "fileName"
                    | "original_filename"
                    | "originalFilename"
                    | "download_url"
                    | "downloadUrl"
                    | "file_size"
                    | "fileSize"
                    | "size"
            )
        });

        if looks_like_file {
            if let Some(item) = modworkshop_file_item_from_json(mod_id, value) {
                let key = item
                    .download_url
                    .clone()
                    .unwrap_or_else(|| format!("{}::{}", item.id, item.name));

                if !out.iter().any(|existing| {
                    existing.download_url == item.download_url
                        || existing.id == item.id && existing.name == item.name
                        || existing.download_url.as_deref() == Some(key.as_str())
                }) {
                    out.push(item);
                }
            }
        }

        for child in object.values() {
            collect_modworkshop_file_items_recursive(mod_id, child, out, depth + 1);
        }
    } else if let Some(array) = value.as_array() {
        for child in array {
            collect_modworkshop_file_items_recursive(mod_id, child, out, depth + 1);
        }
    }
}


fn modworkshop_file_items_from_api(mod_id: &str, data: &serde_json::Value) -> Vec<SourceFileItem> {
    let mut files = Vec::new();

    for file in json_array(data, &["files", "downloads", "versions", "attachments", "file"]) {
        if let Some(item) = modworkshop_file_item_from_json(mod_id, file) {
            files.push(item);
        }
    }

    collect_modworkshop_file_items_recursive(mod_id, data, &mut files, 0);

    files = prefer_named_modworkshop_files(filter_source_download_files(files));

    if files.is_empty() {
        files.push(SourceFileItem {
            id: "latest".to_string(),
            name: "Latest ModWorkshop file".to_string(),
            version: None,
            size_label: None,
            uploaded_at: None,
            download_url: Some(format!(
                "https://api.modworkshop.net/mods/{}/files/latest/download",
                mod_id
            )),
            file_type: None,
            download_count: None,
        });
    }

    files
}

#[tauri::command]
fn fetch_modworkshop_mod_detail(mod_id: String, profile_id: Option<String>) -> Result<SourceModDetail, String> {
    let _profile_context = profile_id.as_deref().unwrap_or("unknown");

    let id = mod_id.trim().to_string();
    let page_url = format!("https://modworkshop.net/mod/{}", id);
    // Public metadata and file lists must not depend on a saved authentication key.
    let modworkshop_api_key: Option<String> = None;
    if let Ok(value) = http_get_json_fast(&format!("https://api.modworkshop.net/mods/{}", id), 14) {
        let data = unwrap_data(value);
        if let Some(summary) = modworkshop_summary_from_api_value_for_game(&data, None) {
            let files_value = http_get_json_fast(&format!("https://api.modworkshop.net/mods/{}/files", id), 14)?;
            let mut files = modworkshop_file_items_from_api(&id, &unwrap_data(files_value));
            sort_source_files_newest_first(&mut files);
            let description = extract_modworkshop_api_description(&data).unwrap_or_default();
            let mut detail = source_detail_from_summary(summary, description, files, Vec::new());
            detail.dependencies = source_dependencies_from_value(&data, Some("modworkshop"), None, detail.game_id.as_deref());
            upsert_source_index_detail(&detail);
            return Ok(detail);
        }
    }

    if let Ok(html) = http_get_text(&page_url) {
        let mut detail = scrape_modworkshop_detail_from_html(&id, &html);
        let html_files = modworkshop_download_files_from_html(&id, &html);

        if !html_files.is_empty() {
            detail.files = html_files;
        }

        if let Ok(value) = http_get_json_fast_with_api_key(
            &format!("https://api.modworkshop.net/mods/{}", id),
            10,
            modworkshop_api_key.as_deref(),
        ) {
            let data = unwrap_data(value);
            if let Some(api_summary) = modworkshop_summary_from_api_value_for_game(&data, None) {
                detail.uid = api_summary.uid.or(detail.uid);
                detail.game_id = api_summary.game_id.or(detail.game_id);
                detail.name = if detail.name.starts_with("ModWorkshop Mod ") { api_summary.name } else { detail.name };
                detail.author = api_summary.author.or(detail.author);
                detail.author_username = api_summary.author_username.or(detail.author_username);
                detail.author_user_id = api_summary.author_user_id.or(detail.author_user_id);
                detail.author_profile_url = api_summary.author_profile_url.or(detail.author_profile_url);
                detail.author_avatar_url = api_summary.author_avatar_url.or(detail.author_avatar_url);
                detail.version = api_summary.version.or(detail.version);
                detail.thumbnail_url = api_summary.thumbnail_url.or(detail.thumbnail_url);
                detail.banner_url = detail.banner_url.or_else(|| detail.thumbnail_url.clone());
                detail.page_url = api_summary.page_url.or(detail.page_url);
                detail.updated_at = api_summary.updated_at.or(detail.updated_at);
                detail.downloads = api_summary.downloads.or(detail.downloads);
                detail.likes = api_summary.likes.or(detail.likes);
                detail.short_description = api_summary.short_description.or(detail.short_description);
                for tag in api_summary.tags {
                    if !detail.tags.iter().any(|existing| existing.eq_ignore_ascii_case(&tag)) {
                        detail.tags.push(tag);
                    }
                }
            }

            detail.description = choose_better_description(
                detail.description,
                extract_modworkshop_api_description(&data),
            );
            for dependency in source_dependencies_from_value(&data, Some("modworkshop"), None, detail.game_id.as_deref()) {
                if !detail.dependencies.iter().any(|existing| existing.name.eq_ignore_ascii_case(&dependency.name) && existing.mod_id == dependency.mod_id && existing.url == dependency.url) {
                    detail.dependencies.push(dependency);
                }
            }

            if detail.short_description.is_none()
                || detail
                    .short_description
                    .as_ref()
                    .map(|text| text.trim().is_empty())
                    .unwrap_or(true)
            {
                detail.short_description = safe_short_description(Some(detail.description.clone()));
            }

            detail.files = filter_source_download_files(detail.files);

            let mut api_files = modworkshop_file_items_from_api(&id, &data);
            api_files = prefer_named_modworkshop_files(filter_source_download_files(api_files));

            let mut needs_more_file_lookup = api_files.is_empty()
                || api_files.iter().any(|file| is_generic_modworkshop_file_name(&file.name));

            if needs_more_file_lookup {
                for endpoint in [
                    format!("https://api.modworkshop.net/mods/{}/files", id),
                    format!("https://api.modworkshop.net/mods/{}/versions", id),
                    format!("https://api.modworkshop.net/mods/{}/downloads", id),
                ] {
                    if let Ok(files_value) = http_get_json_fast_with_api_key(
                        &endpoint,
                        10,
                        modworkshop_api_key.as_deref(),
                    ) {
                        let file_data = unwrap_data(files_value);
                        api_files.extend(modworkshop_file_items_from_api(&id, &file_data));
                        api_files = prefer_named_modworkshop_files(filter_source_download_files(api_files));

                        needs_more_file_lookup = api_files.is_empty()
                            || api_files.iter().all(|file| is_generic_modworkshop_file_name(&file.name));

                        if !needs_more_file_lookup {
                            break;
                        }
                    }
                }
            }

            let html_has_only_generic = detail.files.iter().all(|file| {
                let lower = file.name.to_lowercase();
                lower == "download"
                    || lower == "latest modworkshop file"
                    || lower.starts_with("modworkshop file")
                    || known_download_extension(&file.name).is_none()
            });

            let api_has_real_files = api_files
                .iter()
                .any(|file| is_real_modworkshop_file_item(&id, file));

            if !api_files.is_empty()
                && (api_has_real_files || html_has_only_generic || api_files.len() >= detail.files.len())
            {
                detail.files = api_files;
            }

            detail.files = prefer_named_modworkshop_files(filter_source_download_files(detail.files));
        }

        if detail.description.trim().is_empty()
            || detail.description.to_lowercase().contains("description was not exposed")
        {
            detail.description = "No ModWorkshop description was exposed by the page or public API response.".to_string();
        }

        detail.files = filter_source_download_files(detail.files);

        if detail.files.is_empty() {
            detail.files.push(SourceFileItem {
                id: "latest".to_string(),
                name: "Latest ModWorkshop file".to_string(),
                version: None,
                size_label: None,
                uploaded_at: None,
                download_url: Some(format!("https://api.modworkshop.net/mods/{}/files/latest/download", id)),
                file_type: None,
                download_count: None,
            });
        }

        return Ok(detail);
    }

    let value = http_get_json_fast_with_api_key(
        &format!("https://api.modworkshop.net/mods/{}", id),
        10,
        modworkshop_api_key.as_deref(),
    )?;
    let data = unwrap_data(value);

    let name = json_string(&data, &["name", "title"])
        .map(|text| clean_mod_name(&text))
        .unwrap_or_else(|| format!("ModWorkshop Mod {}", id));
    let description = extract_modworkshop_api_description(&data)
        .map(|text| html_to_text(&text))
        .unwrap_or_else(|| "No description exposed by this API response.".to_string());

    let thumbnail = absolutize_source_url(
        "modworkshop",
        first_media_url(&data)
            .or_else(|| find_first_image_like_url(&data, 0))
            .or_else(|| {
                json_nested_string(
                    &data,
                    &[
                        &["thumbnail", "url"],
                        &["thumbnail", "path"],
                        &["image", "url"],
                        &["logo", "url"],
                        &["cover", "url"],
                        &["banner", "url"],
                    ],
                )
            }),
    );

    let author = modworkshop_author_fields_from_value(&data);
    let summary_game_id = modworkshop_game_id_from_value(&data);
    let game_label = summary_game_id
        .as_deref()
        .map(modworkshop_game_display_label)
        .unwrap_or_else(|| "ModWorkshop".to_string());

    let summary = SourceModSummary {
        source: "modworkshop".to_string(),
        source_id: id.clone(),
        uid: None,
        game_id: summary_game_id,
        name,
        author: author.display_name,
        author_username: author.username,
        author_user_id: author.user_id,
        author_profile_url: author.profile_url,
        author_avatar_url: author.avatar_url,
        version: json_string(&data, &["version"]),
        thumbnail_url: thumbnail.clone(),
        banner_url: thumbnail,
        page_url: Some(page_url),
        updated_at: json_string(&data, &["updated_at", "updatedAt", "last_updated", "lastUpdated"]),
        downloads: json_u64(&data, &["downloads", "download_count", "downloadCount"]),
        likes: json_u64(&data, &["likes", "like_count", "likeCount"]),
        short_description: safe_short_description(json_string(&data, &["short_description", "shortDescription", "summary", "description"])),
        tags: if game_label == "ModWorkshop" {
            vec!["ModWorkshop".to_string()]
        } else {
            vec!["ModWorkshop".to_string(), game_label]
        },
    };

    let files = modworkshop_file_items_from_api(&id, &data);

    let mut detail = source_detail_from_summary(summary, description, files, Vec::new());
    detail.dependencies = source_dependencies_from_value(&data, Some("modworkshop"), None, detail.game_id.as_deref());
    upsert_source_index_detail(&detail);
    Ok(detail)
}



fn payday_content_root(paths: &PaydayPaths) -> PathBuf {
    paths.pak_mods.parent().and_then(Path::parent).unwrap().to_path_buf()
}

fn payday_movies_path(paths: &PaydayPaths) -> PathBuf {
    payday_content_root(paths).join("Movies")
}

fn payday_wwise_media_path(paths: &PaydayPaths) -> PathBuf {
    payday_content_root(paths).join("WwiseAudio").join("Media")
}

fn payday_content_paks_path(paths: &PaydayPaths) -> PathBuf {
    payday_content_root(paths).join("Paks")
}

fn payday_content_wwise_path(paths: &PaydayPaths) -> PathBuf {
    payday_content_root(paths).join("WwiseAudio")
}

fn safe_join_under(root: &Path, relative: &str) -> String {
    let clean = normalize_archive_path(relative)
        .trim_start_matches('/')
        .trim_start_matches('\\')
        .to_string();

    let mut out = root.to_path_buf();

    for part in clean.split('/') {
        let trimmed = part.trim();

        if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
            continue;
        }

        out.push(trimmed);
    }

    out.display().to_string()
}

fn strip_after_any_marker_case_insensitive(path: &str, markers: &[&str]) -> Option<String> {
    let normalized = normalize_archive_path(path);
    let lower = normalized.to_lowercase();

    for marker in markers {
        let marker_normalized = normalize_archive_path(marker);
        let marker_lower = marker_normalized.to_lowercase();

        if let Some(pos) = lower.find(&marker_lower) {
            let start = pos + marker_normalized.len();
            let remainder = normalized[start..].trim_start_matches('/').trim_start_matches('\\');

            if !remainder.is_empty() {
                return Some(remainder.to_string());
            }
        }
    }

    None
}

fn relative_after_path_markers(path: &str, markers: &[&str], fallback: &str) -> String {
    strip_after_any_marker_case_insensitive(path, markers).unwrap_or_else(|| fallback.to_string())
}

fn looks_like_root_ue4ss_file(file_name: &str, extension: &str) -> bool {
    let lower = file_name.to_lowercase();

    matches!(extension, "dll" | "ini" | "toml" | "lua")
        || lower.eq_ignore_ascii_case("mods.txt")
        || lower.eq_ignore_ascii_case("enabled.txt")
        || lower.contains("ue4ss")
        || lower.contains("xinput")
        || lower.contains("dwmapi")
}

fn has_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(&needle.to_lowercase()))
}

fn infer_install_preview_item(paths: &PaydayPaths, mod_name: &str, file_name: &str, description: &str) -> InstallPreviewItem {
    let joined = format!("{} {} {}", mod_name, file_name, description).to_lowercase();
    let file_lower = file_name.to_lowercase();
    let mut notes = Vec::new();

    let pak_related = [".pak", ".ucas", ".utoc"].iter().any(|ext| file_lower.ends_with(ext))
        || has_any(&joined, &["~mods", "content\\paks", "content/paks", "logic mod loader", "zmodloader"]);

    let win64_related = has_any(&joined, &[
        "binaries\\win64",
        "binaries/win64",
        "ue4ss",
        "ue4ss.dll",
        "xinput",
        "scripts/main.lua",
        "scripts\\main.lua",
        "lua mod",
        ".lua",
        ".dll",
        "mantlecpp",
        "copy the contents",
        "hot-reloading is not supported",
    ]);

    let movie_related = has_any(&joined, &[
        "movies folder",
        "content\\movies",
        "content/movies",
        "intro",
        "splash",
        "startup video",
        "logo",
        "video replacer",
        ".bk2",
        ".mp4",
        ".webm",
        ".bik",
    ]);

    let audio_related = has_any(&joined, &[
        "wwiseaudio",
        "wwise",
        ".wem",
        ".bnk",
        "soundbank",
        "audio replacer",
        "music replacement",
    ]);

    let route = if movie_related {
        notes.push("Video/movie replacers do not belong in ~mods. They usually replace files under Content\\Movies.".to_string());
        ("movies", payday_movies_path(paths), "high", "description or file name mentions movies/intro/splash/video")
    } else if win64_related {
        notes.push("Win64/UE4SS installs can include DLL/Lua/native files. Preview before copying because these can overwrite loader files.".to_string());
        ("win64", paths.win64.clone(), "high", "description or file name mentions Win64, UE4SS, Lua, DLL, or native companion files")
    } else if audio_related {
        notes.push("Audio replacers may target WwiseAudio\\Media or WwiseAudio\\Localized\\Media. Tsuki will require archive inspection before real install.".to_string());
        ("wwise-audio", payday_wwise_media_path(paths), "medium", "description or file name mentions Wwise/audio replacement")
    } else if pak_related {
        ("pak-mods", paths.pak_mods.clone(), "high", "PAK/UCAS/UTOC or ~mods install pattern detected")
    } else {
        notes.push("Unknown archive layout. Tsuki should inspect the downloaded archive before installing.".to_string());
        ("needs-archive-inspection", paths.pak_mods.clone(), "low", "no strong install-path clue found")
    };

    InstallPreviewItem {
        source_name: if file_name.trim().is_empty() { mod_name.to_string() } else { file_name.to_string() },
        route_kind: route.0.to_string(),
        confidence: route.2.to_string(),
        destination: route.1.display().to_string(),
        reason: route.3.to_string(),
        safety_notes: notes,
    }
}


fn sanitize_file_component(input: &str) -> String {
    let mut out = String::new();

    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | ' ') {
            out.push(ch);
        } else {
            out.push('_');
        }
    }

    let clean = out.trim().trim_matches('.').to_string();

    if clean.is_empty() {
        "download".to_string()
    } else {
        clean.chars().take(140).collect()
    }
}

fn guess_file_name_from_url(url: &str) -> Option<String> {
    let without_query = url.split('?').next().unwrap_or(url);
    let name = without_query
        .rsplit('/')
        .next()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())?;

    Some(sanitize_file_component(name))
}

fn known_download_extension(path_or_name: &str) -> Option<String> {
    let extension = Path::new(path_or_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_lowercase())?;

    if matches!(
        extension.as_str(),
        "zip"
            | "rar"
            | "7z"
            | "pak"
            | "ucas"
            | "utoc"
            | "dll"
            | "lua"
            | "ini"
            | "json"
            | "toml"
            | "bk2"
            | "bik"
            | "mp4"
            | "webm"
            | "usm"
            | "wmv"
            | "m4v"
            | "mov"
            | "wem"
            | "bnk"
    ) {
        Some(extension)
    } else {
        None
    }
}

fn file_looks_like_html_or_error_page(path: &Path) -> bool {
    let mut buffer = [0u8; 256];

    let Ok(mut file) = File::open(path) else {
        return false;
    };

    let Ok(bytes_read) = file.read(&mut buffer) else {
        return false;
    };

    let text = String::from_utf8_lossy(&buffer[..bytes_read]).trim_start().to_lowercase();

    text.starts_with("<!doctype")
        || text.starts_with("<html")
        || text.contains("<title>modworkshop")
        || text.contains("<title>nexus mods")
        || text.contains("cloudflare")
        || text.contains("access denied")
        || (text.starts_with('{')
            && (text.contains("\"error\"")
                || text.contains("\"errors\"")
                || text.contains("\"message\"")
                || text.contains("\"exception\"")))
}

fn validate_staged_download_payload(path: &Path, source: &str, mod_id: &str, file_id: &str) -> Result<(), String> {
    let metadata = fs::metadata(path)
        .map_err(|err| format!("Failed to read staged download metadata: {}", err))?;

    if metadata.len() == 0 {
        return Err("Downloaded file is empty. Source likely returned a bad file link.".to_string());
    }

    if file_looks_like_html_or_error_page(path) {
        return Err(format!(
            "Downloaded payload looks like an HTML/API error page, not a mod file. Source: {}, mod {}, file {}. Refresh the mod detail/files and try again.",
            source, mod_id, file_id
        ));
    }

    Ok(())
}


#[cfg(target_os = "windows")]
fn extract_native_windows_archive(archive_path: &Path, label: &str) -> Result<PathBuf, String> {
    let output_dir = external_archive_extract_dir(archive_path, label)?;
    fs::create_dir_all(&output_dir)
        .map_err(|err| format!("Failed to create native Windows archive extraction folder: {}", err))?;

    let system_root = env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
    let tar = PathBuf::from(system_root).join("System32").join("tar.exe");

    if !tar.exists() {
        return Err("Windows native tar.exe was not found.".to_string());
    }

    let mut command = Command::new(&tar);
    hide_command_window(&mut command);
    let status = command
        .arg("-xf")
        .arg(archive_path)
        .arg("-C")
        .arg(&output_dir)
        .status()
        .map_err(|err| format!("Failed to run Windows native archive extractor: {}", err))?;

    if !status.success() {
        return Err(format!("Windows native archive extractor failed with status {:?}.", status.code()));
    }

    Ok(output_dir)
}

#[cfg(not(target_os = "windows"))]
fn extract_native_windows_archive(_archive_path: &Path, _label: &str) -> Result<PathBuf, String> {
    Err("Windows native archive extractor is only available on Windows.".to_string())
}


fn extract_builtin_7z_archive(archive_path: &Path, label: &str) -> Result<PathBuf, String> {
    let output_dir = external_archive_extract_dir(archive_path, label)?;
    fs::create_dir_all(&output_dir)
        .map_err(|err| format!("Failed to create built-in 7z extraction folder: {}", err))?;

    let mut expanded_bytes = 0u64;
    sevenz_rust::decompress_file_with_extract_fn(archive_path, &output_dir, |entry, reader, destination| {
        let name = entry.name().replace('\\', "/");
        if Path::new(&name).is_absolute() || name.split('/').any(|part| part == ".." || part.contains(':')) || !destination.starts_with(&output_dir) {
            return Err(sevenz_rust::Error::other("Unsafe archive member path"));
        }
        expanded_bytes = expanded_bytes.checked_add(entry.size()).ok_or_else(|| sevenz_rust::Error::other("Archive size overflow"))?;
        if entry.size() > 512 * 1024 * 1024 || expanded_bytes > 2 * 1024 * 1024 * 1024 {
            return Err(sevenz_rust::Error::other("Archive exceeds extraction safety limits"));
        }
        sevenz_rust::default_entry_extract_fn(entry, reader, destination)
    })
        .map_err(|err| format!("Built-in 7z extractor failed: {:?}", err))?;

    Ok(output_dir)
}



fn guess_archive_kind(path: &Path) -> String {
    let ext = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_lowercase();

    match ext.as_str() {
        "zip" => "zip".to_string(),
        "rar" => "rar-external-archive".to_string(),
        "7z" => "7z-external-archive".to_string(),
        "tar" | "gz" | "tgz" | "bz2" | "xz" => "tar-external-archive".to_string(),
        "pak" | "ucas" | "utoc" => "loose-pak-file".to_string(),
        "dll" | "lua" | "ini" | "toml" | "json" => "loose-win64-file".to_string(),
        "bk2" | "bik" | "mp4" | "webm" | "usm" | "wmv" | "m4v" | "mov" => "loose-movie-file".to_string(),
        "wem" | "bnk" => "loose-wwise-file".to_string(),
        _ => "unknown".to_string(),
    }
}

fn normalize_archive_path(input: &str) -> String {
    input.replace('\\', "/")
        .split('/')
        .filter(|part| {
            let trimmed = part.trim();
            !trimmed.is_empty() && trimmed != "." && trimmed != ".."
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn common_archive_root(paths: &[String]) -> Option<String> {
    // Only strip a wrapper folder when every real file actually sits under that folder.
    // A ZIP that contains a single file named SomeMod.pak must not report SomeMod.pak as a wrapper.
    let candidates = paths
        .iter()
        .filter(|path| path.contains('/'))
        .collect::<Vec<_>>();

    if candidates.is_empty() {
        return None;
    }

    let mut roots = candidates
        .iter()
        .filter_map(|path| path.split('/').next())
        .filter(|part| !part.trim().is_empty())
        .map(|part| part.to_string())
        .collect::<Vec<_>>();

    roots.sort();
    roots.dedup();

    if roots.len() == 1 {
        let root = roots.remove(0);

        // Do not strip meaningful game folders.
        let lower = root.to_lowercase();
        let mod_folder = paths.iter().any(|path| path.to_lowercase().starts_with(&format!("{}/scripts/", lower)));
        if mod_folder || matches!(lower.as_str(), "payday3" | "content" | "binaries" | "win64" | "wingdk" | "ue4ss" | "mods" | "scripts") {
            None
        } else {
            Some(root)
        }
    } else {
        None
    }
}

fn strip_common_root(path: &str, root: Option<&str>) -> String {
    let Some(root) = root else {
        return path.to_string();
    };

    let prefix = format!("{}/", root);

    if path.starts_with(&prefix) {
        path[prefix.len()..].to_string()
    } else {
        path.to_string()
    }
}

fn archive_entry_is_folder_marker(path: &str, size_bytes: u64, all_paths: &[String]) -> bool {
    let normalized = normalize_archive_path(path);
    let trimmed = normalized.trim_matches('/').trim_matches('\\');

    if normalized.ends_with('/') || normalized.ends_with('\\') || trimmed.is_empty() {
        return true;
    }

    let folder_prefix = format!("{}/", trimmed.to_lowercase());

    if all_paths.iter().any(|candidate| {
        let candidate_trimmed = candidate.trim_matches('/').trim_matches('\\').to_lowercase();
        candidate_trimmed.starts_with(&folder_prefix)
    }) {
        return true;
    }

    // Some ZIPs contain directory entries without a trailing slash.
    // They are usually zero-byte paths with no extension, for example:
    // ParkourUnleashed
    // Mods
    // Mods/MantleCpp
    if size_bytes == 0 {
        let file_name = trimmed.split('/').last().unwrap_or(trimmed);

        if !file_name.contains('.') {
            return true;
        }
    }

    false
}

#[cfg(not(target_os = "windows"))]
fn is_running_as_admin_internal() -> bool {
    false
}

#[cfg(target_os = "windows")]
#[link(name = "shell32")]
extern "system" {
    fn IsUserAnAdmin() -> i32;

    fn ShellExecuteW(
        hwnd: *mut std::ffi::c_void,
        lp_operation: *const u16,
        lp_file: *const u16,
        lp_parameters: *const u16,
        lp_directory: *const u16,
        n_show_cmd: i32,
    ) -> *mut std::ffi::c_void;
}

#[cfg(target_os = "windows")]
fn is_running_as_admin_internal() -> bool {
    unsafe { IsUserAnAdmin() != 0 }
}

#[cfg(target_os = "windows")]
fn wide_from_os(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
fn wide_from_str(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
fn shell_execute_runas(file: &Path, working_dir: &Path) -> Result<(), String> {
    let operation = wide_from_str("runas");
    let file_wide = wide_from_os(file.as_os_str());
    let directory_wide = wide_from_os(working_dir.as_os_str());

    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            file_wide.as_ptr(),
            std::ptr::null(),
            directory_wide.as_ptr(),
            1,
        )
    } as isize;

    if result <= 32 {
        return Err(format!(
            "Windows did not start the administrator prompt. ShellExecuteW returned code {}.",
            result
        ));
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn shell_execute_open_target(target: &str) -> Result<(), String> {
    let operation = wide_from_str("open");
    let target_wide = wide_from_str(target);

    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            target_wide.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        )
    } as isize;

    if result <= 32 {
        return Err(format!(
            "Windows did not open target '{}'. ShellExecuteW returned code {}.",
            target, result
        ));
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn shell_execute_open_target(target: &str) -> Result<(), String> {
    Command::new("xdg-open")
        .arg(target)
        .spawn()
        .map_err(|err| format!("Failed to open target '{}': {}", target, err))?;

    Ok(())
}

fn find_vdf_block_range(contents: &str, key: &str, search_start: usize) -> Option<(usize, usize, usize)> {
    let key_pattern = format!("\"{}\"", key);
    let key_pos = contents[search_start..].find(&key_pattern)? + search_start;
    let open_rel = contents[key_pos..].find('{')?;
    let open_pos = key_pos + open_rel;

    let mut depth = 0i32;
    let mut in_string = false;
    let mut escaped = false;

    for (offset, ch) in contents[open_pos..].char_indices() {
        if in_string {
            if escaped {
                escaped = false;
                continue;
            }

            if ch == '\\' {
                escaped = true;
                continue;
            }

            if ch == '"' {
                in_string = false;
            }

            continue;
        }

        if ch == '"' {
            in_string = true;
            continue;
        }

        if ch == '{' {
            depth += 1;
        } else if ch == '}' {
            depth -= 1;

            if depth == 0 {
                return Some((key_pos, open_pos, open_pos + offset));
            }
        }
    }

    None
}

fn set_vdf_launch_options(contents: &str, app_id: &str, launch_options: &str) -> Option<String> {
    let app_block = find_vdf_block_range(contents, app_id, 0);

    if let Some((_key_pos, open_pos, close_pos)) = app_block {
        let block = &contents[open_pos..=close_pos];

        if let Some(local_key_pos) = block.find("\"LaunchOptions\"") {
            let absolute_key_pos = open_pos + local_key_pos;
            let after_key = absolute_key_pos + "\"LaunchOptions\"".len();

            if let Some(first_quote_rel) = contents[after_key..].find('"') {
                let first_quote = after_key + first_quote_rel;
                if let Some(second_quote_rel) = contents[first_quote + 1..].find('"') {
                    let second_quote = first_quote + 1 + second_quote_rel;
                    let mut out = String::new();
                    out.push_str(&contents[..first_quote + 1]);
                    out.push_str(launch_options);
                    out.push_str(&contents[second_quote..]);
                    return Some(out);
                }
            }
        }

        let mut out = String::new();
        out.push_str(&contents[..open_pos + 1]);
        out.push_str(&format!("\n\t\t\t\"LaunchOptions\"\t\t\"{}\"", launch_options));
        out.push_str(&contents[open_pos + 1..]);
        return Some(out);
    }

    if let Some((_apps_key, apps_open, _apps_close)) = find_vdf_block_range(contents, "apps", 0) {
        let mut out = String::new();
        out.push_str(&contents[..apps_open + 1]);
        out.push_str(&format!(
            "\n\t\t\"{}\"\n\t\t{{\n\t\t\t\"LaunchOptions\"\t\t\"{}\"\n\t\t}}\n",
            app_id, launch_options
        ));
        out.push_str(&contents[apps_open + 1..]);
        return Some(out);
    }

    None
}

fn infer_steam_root_from_payday(paths: &PaydayPaths) -> Option<PathBuf> {
    let common = paths.game_root.parent()?;
    let steamapps = common.parent()?;

    if common
        .file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("common"))
        .unwrap_or(false)
        && steamapps
            .file_name()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case("steamapps"))
            .unwrap_or(false)
    {
        return steamapps.parent().map(|value| value.to_path_buf());
    }

    None
}

fn steam_root_candidates(paths: &PaydayPaths) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(path) = infer_steam_root_from_payday(paths) {
        candidates.push(path);
    }

    if let Ok(program_files_x86) = env::var("ProgramFiles(x86)") {
        candidates.push(PathBuf::from(program_files_x86).join("Steam"));
    }

    if let Ok(program_files) = env::var("ProgramFiles") {
        candidates.push(PathBuf::from(program_files).join("Steam"));
    }

    candidates.push(PathBuf::from(r"C:\Program Files (x86)\Steam"));

    let mut seen = std::collections::BTreeSet::new();
    candidates
        .into_iter()
        .filter(|path| seen.insert(path.display().to_string().to_lowercase()))
        .collect()
}

fn ensure_steam_payday3_launch_option(paths: &PaydayPaths, launch_options: &str) -> Result<String, String> {
    let mut checked = Vec::new();
    let mut updated = Vec::new();

    for steam_root in steam_root_candidates(paths) {
        let userdata = steam_root.join("userdata");

        if !userdata.exists() {
            checked.push(format!("{} missing", userdata.display()));
            continue;
        }

        let entries = fs::read_dir(&userdata)
            .map_err(|err| format!("Failed to read Steam userdata folder {}: {}", userdata.display(), err))?;

        for entry in entries {
            let entry = entry.map_err(|err| format!("Failed to read Steam userdata entry: {}", err))?;
            let localconfig = entry.path().join("config").join("localconfig.vdf");

            if !localconfig.exists() {
                continue;
            }

            checked.push(localconfig.display().to_string());

            let contents = fs::read_to_string(&localconfig)
                .map_err(|err| format!("Failed to read {}: {}", localconfig.display(), err))?;

            let Some(next_contents) = set_vdf_launch_options(&contents, "1272080", launch_options) else {
                continue;
            };

            if next_contents != contents {
                let backup = localconfig.with_extension(format!("vdf.tsuki-backup-{}", current_timestamp()));
                fs::copy(&localconfig, &backup)
                    .map_err(|err| format!("Failed to backup Steam localconfig: {}", err))?;
                fs::write(&localconfig, next_contents)
                    .map_err(|err| format!("Failed to write Steam localconfig launch options: {}", err))?;
                updated.push(localconfig.display().to_string());
            }
        }
    }

    let label = if launch_options.trim().is_empty() { "blank/vanilla" } else { launch_options };

    if !updated.is_empty() {
        return Ok(format!(
            "Set PAYDAY 3 Steam launch options to {} in {} localconfig file(s).",
            label,
            updated.len()
        ));
    }

    if !checked.is_empty() {
        return Ok(format!(
            "PAYDAY 3 Steam launch options already looked like {} or Steam may need restart to apply localconfig changes.",
            label
        ));
    }

    Err(format!(
        "Could not find Steam userdata/localconfig.vdf to set PAYDAY 3 launch options to {}. Set it manually in Steam Properties if launch mode does not change.",
        label
    ))
}

fn ensure_steam_payday3_fileopenlog_launch_option(paths: &PaydayPaths) -> Result<String, String> {
    ensure_steam_payday3_launch_option(paths, "-fileopenlog")
}

fn steam_payday3_launch_options_contain(paths: &PaydayPaths, needle: &str) -> Result<bool, String> {
    let needle = needle.to_lowercase();

    for steam_root in steam_root_candidates(paths) {
        let userdata = steam_root.join("userdata");
        if !userdata.exists() {
            continue;
        }

        let entries = fs::read_dir(&userdata)
            .map_err(|err| format!("Failed to read Steam userdata folder {}: {}", userdata.display(), err))?;

        for entry in entries {
            let entry = entry.map_err(|err| format!("Failed to read Steam userdata entry: {}", err))?;
            let localconfig = entry.path().join("config").join("localconfig.vdf");
            if !localconfig.exists() {
                continue;
            }

            let contents = fs::read_to_string(&localconfig)
                .map_err(|err| format!("Failed to read {}: {}", localconfig.display(), err))?;

            if let Some((_key_pos, open_pos, close_pos)) = find_vdf_block_range(&contents, "1272080", 0) {
                let block = contents[open_pos..=close_pos].to_lowercase();
                if block.contains(&needle) {
                    return Ok(true);
                }
            }
        }
    }

    Ok(false)
}

fn ensure_steam_payday3_vanilla_launch_option(paths: &PaydayPaths) -> Result<String, String> {
    let message = ensure_steam_payday3_launch_option(paths, "")?;

    if steam_payday3_launch_options_contain(paths, "-fileopenlog")? {
        return Ok(format!(
            "{} Steam localconfig still appears to mention -fileopenlog, so Tsuki will use direct vanilla executable launch to avoid passing Steam launch options.",
            message
        ));
    }

    Ok(format!("{} Confirmed PAYDAY 3 Steam launch options do not contain -fileopenlog.", message))
}



fn relaunch_current_exe_as_admin_internal() -> Result<(), String> {
    let exe = env::current_exe()
        .map_err(|err| format!("Failed to find current Tsuki executable: {}", err))?;
    let working_dir = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));

    #[cfg(target_os = "windows")]
    {
        shell_execute_runas(&exe, &working_dir)?;
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Administrator relaunch is only supported on Windows.".to_string())
    }
}

fn should_auto_relaunch_as_admin() -> bool {
    false
}

fn find_movie_same_name_destination(paths: &PaydayPaths, file_name: &str) -> Option<PathBuf> {
    let movie_root = payday_movies_path(paths);

    fn visit(current: &Path, file_name: &str) -> Option<PathBuf> {
        let entries = fs::read_dir(current).ok()?;

        for entry in entries.flatten() {
            let path = entry.path();

            if path.is_dir() {
                if let Some(found) = visit(&path, file_name) {
                    return Some(found);
                }
                continue;
            }

            if path
                .file_name()
                .and_then(|value| value.to_str())
                .map(|name| name.eq_ignore_ascii_case(file_name))
                .unwrap_or(false)
            {
                return Some(path);
            }
        }

        None
    }

    visit(&movie_root, file_name)
}


fn known_payday_movie_file_name(file_name: &str) -> bool {
    matches!(
        file_name.to_lowercase().as_str(),
        "loadingscreen.bk2"
            | "loadingscreen.mp4"
            | "loadingscreen.webm"
            | "loadingscreen_02.mp4"
            | "pd3_splashscreen_01_intro.mp4"
            | "startup_deepsilver.bk2"
            | "startup_sb7.bk2"
            | "startup_unreal.bk2"
    )
}


fn should_ignore_archive_entry_as_junk_or_manager(path: &str, file_name: &str, extension: &str) -> Option<String> {
    let lower = path.to_lowercase();
    let name = file_name.to_lowercase();

    if lower.contains("__macosx/") || name == ".ds_store" || name == "thumbs.db" || name == "desktop.ini" {
        return Some("OS metadata/helper file, not a mod file.".to_string());
    }

    if lower.contains("fomod/")
        || lower.contains("mod organizer")
        || lower.contains("modorganizer")
        || lower.contains("vortex")
        || lower.contains("r2modman")
        || lower.contains("thunderstore")
        || lower.contains("mod manager")
        || lower.contains("modmanager")
        || name == "moduleconfig.xml"
        || name == "meta.ini"
    {
        return Some("External mod-manager metadata/artifact, not a PAYDAY 3 runtime mod file.".to_string());
    }

    if matches!(extension, "txt" | "md" | "rtf" | "pdf" | "url" | "lnk" | "xml" | "yaml" | "yml" | "log" | "pdb")
        && name != "mods.txt" && name != "enabled.txt" {
        return Some("Readme/documentation/metadata file skipped. Tsuki only installs runtime mod files.".to_string());
    }

    if matches!(extension, "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "ico" | "bmp" | "avif") {
        return Some("Image/preview asset skipped. Tsuki only installs runtime mod files.".to_string());
    }

    None
}


fn payday_ue4ss_relative_path(paths: &PaydayPaths, path: &str) -> String {
    let authored = strip_after_any_marker_case_insensitive(path, &["Binaries/Win64/", "Binaries/WinGDK/"])
        .unwrap_or_else(|| path.to_string());
    let lower = authored.to_lowercase();
    let file_name = authored.rsplit('/').next().unwrap_or(&authored);
    let runtime_prefix = if payday_uses_ue5_layout(paths) { "UE4SS/" } else { "" };
    if lower.starts_with("ue4ss/") {
        return if payday_uses_ue5_layout(paths) { authored } else { authored[6..].to_string() };
    }
    if lower.starts_with("mods/") || lower.contains("/mods/") {
        let tail = relative_after_path_markers(&authored, &["Mods/"], &authored);
        return format!("{}Mods/{}", runtime_prefix, tail);
    }
    if lower == "ue4ss.dll" || lower == "ue4ss-settings.ini" {
        return format!("{}{}", runtime_prefix, file_name);
    }
    if lower.contains("/scripts/") || lower.contains("/dlls/") || lower.ends_with("/enabled.txt") {
        return format!("{}Mods/{}", runtime_prefix, authored);
    }
    if lower.starts_with("scripts/") {
        return format!("{}Mods/LooseLua/{}", runtime_prefix, authored);
    }
    if lower.ends_with(".lua") {
        let stem = Path::new(file_name).file_stem().and_then(|s| s.to_str()).unwrap_or("LooseLua");
        return format!("{}Mods/{}/Scripts/main.lua", runtime_prefix, sanitize_file_component(stem));
    }
    if lower == "mods.txt" { return format!("{}Mods/mods.txt", runtime_prefix); }
    if authored.contains('/') { return format!("{}Mods/{}", runtime_prefix, authored); }
    authored
}

fn infer_archive_entry_destination(paths: &PaydayPaths, archive_path: &str, description: &str) -> ArchiveInspectEntry {
    let normalized = normalize_archive_path(archive_path);
    let lower = normalized.to_lowercase();
    let desc_lower = description.to_lowercase();
    let extension = Path::new(&normalized)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();

    let file_name = normalized
        .split('/')
        .last()
        .unwrap_or(normalized.as_str())
        .to_string();

    let mut route_kind = "needs-review".to_string();
    let mut destination = paths.pak_mods.join(&file_name).display().to_string();
    let mut confidence = "low".to_string();
    let mut reason = "No strong file-path clue found. Needs manual review after archive inspection.".to_string();
    let mut blocked = true;

    if normalized.ends_with('/') || file_name.trim().is_empty() {
        return ArchiveInspectEntry {
            archive_path: normalized,
            route_kind: "folder".to_string(),
            destination: "folder entry skipped".to_string(),
            confidence: "n/a".to_string(),
            reason: "Folder entry, not copied directly.".to_string(),
            blocked: false,
            size_bytes: 0,
        };
    }

    if let Some(skip_reason) = should_ignore_archive_entry_as_junk_or_manager(&normalized, &file_name, &extension) {
        return ArchiveInspectEntry {
            archive_path: normalized,
            route_kind: "ignored-junk".to_string(),
            destination: "ignored".to_string(),
            confidence: "n/a".to_string(),
            reason: skip_reason,
            blocked: true,
            size_bytes: 0,
        };
    }

    // PAK family always goes to the PAYDAY 3 ~mods folder.
    if matches!(extension.as_str(), "pak" | "ucas" | "utoc")
        || lower.contains("content/paks/~mods/")
        || lower.contains("/~mods/")
        || lower.starts_with("~mods/")
    {
        let relative = relative_after_path_markers(
            &normalized,
            &["PAYDAY3/Content/Paks/~mods/", "Content/Paks/~mods/", "Paks/~mods/", "~mods/"],
            &file_name,
        );

        route_kind = "pak-mods".to_string();
        destination = safe_join_under(&paths.pak_mods, &relative);
        confidence = "high".to_string();
        reason = "PAK/UCAS/UTOC files are routed to PAYDAY3/Content/Paks/~mods.".to_string();
        blocked = false;
    }
    // UE4SS root files and UE4SS Mods folder go to Binaries/Win64.
    else if lower.contains("binaries/win64/")
        || lower.contains("binaries/wingdk/")
        || lower.starts_with("ue4ss/")
        || lower.contains("/dlls/")
        || lower.contains("/binaries/win64/")
        || lower.starts_with("mods/")
        || lower.contains("/mods/")
        || lower.starts_with("scripts/")
        || lower.contains("/scripts/")
        || looks_like_root_ue4ss_file(&file_name, &extension)
        || desc_lower.contains("ue4ss")
        || desc_lower.contains("binaries\\win64")
        || desc_lower.contains("binaries/win64")
        || desc_lower.contains("scripts/main.lua")
        || desc_lower.contains("mods folder")
    {
        let relative = payday_ue4ss_relative_path(paths, &normalized);

        route_kind = "win64".to_string();
        destination = safe_join_under(&paths.win64, &relative);
        confidence = "high".to_string();
        reason = format!("UE4SS archive tree preserved for {} under {}.", if payday_uses_ue5_layout(paths) { "UE5.5 (UE4SS/Mods)" } else { "UE4.27 (Mods)" }, paths.win64.display());
        blocked = false;
    }
    // Movies, intro skips, and video replacers go to Content/Movies.
    else if lower.contains("content/movies/")
        || known_payday_movie_file_name(&file_name)
        || matches!(extension.as_str(), "bk2" | "bik" | "mp4" | "webm" | "usm" | "wmv" | "m4v" | "mov")
        || lower.contains("intro")
        || lower.contains("splash")
        || lower.contains("startup")
        || lower.contains("loading")
        || lower.contains("cinematic")
        || lower.contains("legal")
        || lower.contains("bink")
        || lower.contains("splashscreen")
        || lower.contains("splash_screen")
        || lower.contains("logo")
        || desc_lower.contains("intro skip")
        || desc_lower.contains("video replacer")
        || desc_lower.contains("movie replacer")
        || desc_lower.contains("fast launch")
        || desc_lower.contains("skip launch")
        || desc_lower.contains("skip intro")
        || desc_lower.contains("no intro")
        || desc_lower.contains("startup video")
        || desc_lower.contains("splash videos")
        || desc_lower.contains("blank video")
        || desc_lower.contains("movies folder")
    {
        let relative = relative_after_path_markers(
            &normalized,
            &[
                "PAYDAY3/PAYDAY3/Content/Movies/",
                "PAYDAY3/Content/Movies/",
                "Content/Movies/",
                "Movies/",
                "PAYDAY3/Content/PAYDAY3/Content/Movies/",
            ],
            &file_name,
        );

        route_kind = "movies".to_string();

        if let Some(existing_movie) = find_movie_same_name_destination(paths, &file_name) {
            destination = existing_movie.display().to_string();
            reason = format!(
                "Movie/video replacer matched existing PAYDAY 3 movie filename '{}'; replacing exact same-name file in Content/Movies.",
                file_name
            );
        } else {
            destination = safe_join_under(&payday_movies_path(paths), &relative);
            reason = "Movie/video/intro replacer route detected; routed to PAYDAY3/Content/Movies.".to_string();
        }

        confidence = "high".to_string();
        blocked = false;
    }
    // Wwise audio routes are now routed only when the archive contains clear Wwise paths.
    else if lower.contains("content/wwiseaudio/")
        || lower.contains("wwiseaudio/media/")
        || lower.contains("wwiseaudio/localized/media/")
    {
        let relative = relative_after_path_markers(
            &normalized,
            &["PAYDAY3/Content/WwiseAudio/", "Content/WwiseAudio/", "WwiseAudio/"],
            &file_name,
        );

        route_kind = "wwise-audio".to_string();
        destination = safe_join_under(&payday_content_wwise_path(paths), &relative);
        confidence = "medium".to_string();
        reason = "Explicit WwiseAudio path detected; routed under PAYDAY3/Content/WwiseAudio.".to_string();
        blocked = false;
    }
    // Loose WEM/BNK without a Wwise path is still too risky.
    else if matches!(extension.as_str(), "wem" | "bnk") || desc_lower.contains("wwise") || desc_lower.contains("audio replacer") {
        route_kind = "wwise-audio-needs-path".to_string();
        destination = safe_join_under(&payday_wwise_media_path(paths), &file_name);
        confidence = "low".to_string();
        reason = "Loose Wwise/audio file found, but no exact WwiseAudio path was present. Needs manual review.".to_string();
        blocked = true;
    }

    ArchiveInspectEntry {
        archive_path: normalized,
        route_kind,
        destination,
        confidence,
        reason,
        blocked,
        size_bytes: 0,
    }
}

fn archive_tool_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(path_var) = env::var("PATH") {
        for folder in env::split_paths(&path_var) {
            candidates.push(folder.join("7z.exe"));
            candidates.push(folder.join("7za.exe"));
            candidates.push(folder.join("7zr.exe"));
        }
    }

    candidates.push(PathBuf::from(r"C:\Program Files\7-Zip\7z.exe"));
    candidates.push(PathBuf::from(r"C:\Program Files (x86)\7-Zip\7z.exe"));
    candidates.push(PathBuf::from(r"C:\Program Files\NanaZip\NanaZipC.exe"));
    candidates.push(PathBuf::from(r"C:\Program Files\WinRAR\WinRAR.exe"));

    candidates
}

fn find_external_archive_tool() -> Option<PathBuf> {
    archive_tool_candidates()
        .into_iter()
        .find(|candidate| candidate.exists())
}

fn external_archive_extract_dir(archive_path: &Path, label: &str) -> Result<PathBuf, String> {
    let _ = archive_path;
    Ok(downloads_cache_dir()?
        .join("external_extract")
        .join(format!(
            "{}_{}",
            sanitize_file_component(label).chars().take(20).collect::<String>(),
            SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_nanos()).unwrap_or_default()
        )))
}

fn extract_external_archive(archive_path: &Path, label: &str) -> Result<PathBuf, String> {
    let ext = archive_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();

    if ext == "7z" {
        if let Ok(path) = extract_builtin_7z_archive(archive_path, label) {
            return Ok(path);
        }
        // If the built-in extractor cannot handle an edge-case archive, fall through to 7-Zip/NanaZip.
    }

    if ext == "rar" {
        if let Ok(path) = extract_native_windows_archive(archive_path, label) {
            return Ok(path);
        }
        // Windows 11 23H2+ can extract RAR through native tar/libarchive. If unavailable, fall through.
    }

    let tool = find_external_archive_tool()
        .ok_or_else(|| {
            if ext == "rar" {
                "RAR extraction still needs 7-Zip, NanaZip, or WinRAR. Rust's safe built-in path currently covers 7z; RAR is kept external to avoid breaking Windows builds with a C++ unrar dependency.".to_string()
            } else {
                "Archive support needs built-in 7z or 7-Zip/7za/NanaZip/WinRAR installed and visible to Tsuki.".to_string()
            }
        })?;

    let output_dir = external_archive_extract_dir(archive_path, label)?;
    fs::create_dir_all(&output_dir)
        .map_err(|err| format!("Failed to create external archive extraction folder: {}", err))?;

    let tool_name = tool
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();

    let status = if tool_name.contains("winrar") {
        let mut command = Command::new(&tool);
        hide_command_window(&mut command);
        command
            .arg("x")
            .arg("-ibck")
            .arg("-y")
            .arg(archive_path)
            .arg(&output_dir)
            .status()
            .map_err(|err| format!("Failed to run {}: {}", tool.display(), err))?
    } else {
        let mut command = Command::new(&tool);
        hide_command_window(&mut command);
        command
            .arg("x")
            .arg("-y")
            .arg(format!("-o{}", output_dir.display()))
            .arg(archive_path)
            .status()
            .map_err(|err| format!("Failed to run {}: {}", tool.display(), err))?
    };

    if !status.success() {
        return Err(format!(
            "Archive tool failed with status {:?}. Tool: {}",
            status.code(),
            tool.display()
        ));
    }

    Ok(output_dir)
}

fn collect_files_recursive(root: &Path) -> Result<Vec<(String, PathBuf, u64)>, String> {
    fn visit(root: &Path, current: &Path, out: &mut Vec<(String, PathBuf, u64)>) -> Result<(), String> {
        for entry in fs::read_dir(current)
            .map_err(|err| format!("Failed to read extracted folder {}: {}", current.display(), err))?
        {
            let entry = entry.map_err(|err| format!("Failed to read extracted entry: {}", err))?;
            let path = entry.path();

            if path.is_dir() {
                visit(root, &path, out)?;
                continue;
            }

            if !path.is_file() {
                continue;
            }

            let relative = path
                .strip_prefix(root)
                .map(|value| normalize_archive_path(&value.display().to_string()))
                .unwrap_or_else(|_| {
                    path.file_name()
                        .and_then(|value| value.to_str())
                        .map(normalize_archive_path)
                        .unwrap_or_else(|| "unknown_file".to_string())
                });

            let size = fs::metadata(&path).ok().map(|metadata| metadata.len()).unwrap_or(0);
            out.push((relative, path, size));
        }

        Ok(())
    }

    let mut out = Vec::new();
    visit(root, root, &mut out)?;
    out.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
    Ok(out)
}

fn cleanup_temp_extraction_folder(path: &Path, warnings: &mut Vec<String>) {
    if !path.exists() {
        return;
    }

    if let Err(error) = fs::remove_dir_all(path) {
        warnings.push(format!(
            "Temporary extraction folder could not be deleted automatically: {} ({})",
            path.display(),
            error
        ));
    }
}


fn inspect_staged_file(paths: &PaydayPaths, staged_file: &Path, description: &str) -> Result<(String, Vec<ArchiveInspectEntry>, Vec<String>), String> {
    let mut warnings = Vec::new();
    let archive_kind = guess_archive_kind(staged_file);

    if archive_kind == "zip" && file_has_zip_magic(staged_file) {
        let file = File::open(staged_file)
            .map_err(|err| format!("Failed to open staged zip: {}", err))?;
        let mut archive = ZipArchive::new(file)
            .map_err(|err| format!("Failed to read zip archive: {}", err))?;

        let mut raw_paths = Vec::new();
        for index in 0..archive.len() {
            let item = archive
                .by_index(index)
                .map_err(|err| format!("Failed to inspect zip entry {}: {}", index, err))?;
            raw_paths.push(normalize_archive_path(item.name()));
        }

        let root = common_archive_root(&raw_paths);
        let stripped_paths = raw_paths
            .iter()
            .map(|path| strip_common_root(path, root.as_deref()))
            .collect::<Vec<_>>();
        let mut entries = Vec::new();

        for index in 0..archive.len() {
            let item = archive
                .by_index(index)
                .map_err(|err| format!("Failed to inspect zip entry {}: {}", index, err))?;

            let stripped = strip_common_root(&normalize_archive_path(item.name()), root.as_deref());
            let entry_size = item.size();

            let mut entry = if item.is_dir() || archive_entry_is_folder_marker(&stripped, entry_size, &stripped_paths) {
                ArchiveInspectEntry {
                    archive_path: stripped,
                    route_kind: "folder".to_string(),
                    destination: "folder entry skipped".to_string(),
                    confidence: "n/a".to_string(),
                    reason: "Folder entry, not copied directly.".to_string(),
                    blocked: false,
                    size_bytes: 0,
                }
            } else {
                infer_archive_entry_destination(paths, &stripped, description)
            };
            entry.size_bytes = entry_size;
            entries.push(entry);
        }

        if let Some(root) = root {
            warnings.push(format!(
                "Archive has a wrapper folder '{}'. Tsuki stripped it for routing, like copying the folder contents.",
                root
            ));
        }

        return Ok((archive_kind, entries, warnings));
    }

    if archive_kind.contains("external-archive") {
        match extract_external_archive(staged_file, "inspect") {
            Ok(extracted_root) => {
                let files = match collect_files_recursive(&extracted_root) {
                    Ok(files) => files,
                    Err(error) => {
                        cleanup_temp_extraction_folder(&extracted_root, &mut warnings);
                        return Err(error);
                    }
                };
                let raw_paths = files.iter().map(|(relative, _, _)| relative.clone()).collect::<Vec<_>>();
                let root = common_archive_root(&raw_paths);
                let stripped_paths = raw_paths
                    .iter()
                    .map(|path| strip_common_root(path, root.as_deref()))
                    .collect::<Vec<_>>();

                let mut entries = Vec::new();

                for (relative, _path, size) in files {
                    let stripped = strip_common_root(&relative, root.as_deref());

                    if archive_entry_is_folder_marker(&stripped, size, &stripped_paths) {
                        entries.push(ArchiveInspectEntry {
                            archive_path: stripped,
                            route_kind: "folder".to_string(),
                            destination: "folder entry skipped".to_string(),
                            confidence: "n/a".to_string(),
                            reason: "Folder entry, not copied directly.".to_string(),
                            blocked: false,
                            size_bytes: 0,
                        });
                        continue;
                    }

                    let mut entry = infer_archive_entry_destination(paths, &stripped, description);
                    entry.size_bytes = size;
                    entries.push(entry);
                }

                warnings.push(format!(
                    "Archive extracted for inspection with built-in 7z or an installed archive tool into {}.",
                    extracted_root.display()
                ));

                if let Some(root) = root {
                    warnings.push(format!(
                        "Archive has a wrapper folder '{}'. Tsuki stripped it for routing, like copying the folder contents.",
                        root
                    ));
                }

                cleanup_temp_extraction_folder(&extracted_root, &mut warnings);

                return Ok((archive_kind, entries, warnings));
            }
            Err(error) => {
                warnings.push(error.clone());

                let name = staged_file
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("download")
                    .to_string();

                let mut entry = infer_archive_entry_destination(paths, &name, description);
                entry.blocked = true;
                entry.reason = format!("{} External archive extraction is required before install: {}", entry.reason, error);

                return Ok((archive_kind, vec![entry], warnings));
            }
        }
    }

    if archive_kind == "zip" && !file_has_zip_magic(staged_file) {
        warnings.push("Downloaded file used a .zip name but is not a ZIP. Tsuki is treating it as a loose file instead.".to_string());
    }

    if archive_kind.contains("needs-external-inspection") {
        warnings.push("This archive type is not inspectable yet inside Tsuki. ZIP works now; RAR/7z support comes next.".to_string());

        let name = staged_file
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("download")
            .to_string();

        let mut entry = infer_archive_entry_destination(paths, &name, description);
        entry.blocked = true;
        entry.reason = format!("{} Archive must be inspected before install.", entry.reason);

        return Ok((archive_kind, vec![entry], warnings));
    }

    let name = staged_file
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("download")
        .to_string();

    let metadata = fs::metadata(staged_file).ok();
    let mut entry = infer_archive_entry_destination(paths, &name, description);
    entry.size_bytes = metadata.map(|value| value.len()).unwrap_or(0);

    Ok((archive_kind, vec![entry], warnings))
}

fn resolve_source_file_download_url(
    source: &str,
    mod_id: &str,
    file_id: &str,
    download_url: Option<String>,
    nexus_game_domain: Option<&str>,
) -> Result<String, String> {
    if source.eq_ignore_ascii_case("nexus") {
        let settings = load_settings_internal();
        let api_key = settings
            .nexus_api_key
            .as_deref()
            .ok_or_else(|| "Nexus API key is not saved. Paste it in Settings first.".to_string())?;
        let nexus_domain = safe_nexus_game_domain(nexus_game_domain)
            .unwrap_or_else(|| "payday3".to_string());

        let url = format!(
            "https://api.nexusmods.com/v1/games/{}/mods/{}/files/{}/download_link.json",
            nexus_domain,
            mod_id.trim(),
            file_id.trim()
        );

        let value = http_get_json(&url, Some(api_key))?;

        return first_download_uri(&value)
            .ok_or_else(|| "Nexus did not return a direct download link for this file.".to_string());
    }

    if source.eq_ignore_ascii_case("modworkshop") {
        let mod_id = mod_id.trim();
        let clean_file_id = file_id.trim();

        if let Some(url) = download_url.as_ref().filter(|url| !url.trim().is_empty()) {
            let url_lower = url.to_lowercase();

            if url_lower.contains("storage.modworkshop.net") && !is_image_or_page_asset_name(url) {
                return Ok(url.to_string());
            }

            // ModWorkshop /download endpoints sometimes return a page or redirect.
            // Keep them as candidates, but first try to recover the real storage link from the page.
            if !is_image_or_page_asset_name(url) && !url_lower.contains("/images/") && !url_lower.contains("/thumbnail") {
                if let Ok(html) = http_get_text(&format!("https://modworkshop.net/mod/{}", mod_id)) {
                    let files = modworkshop_download_files_from_html(mod_id, &html);

                    if let Some(file) = files.iter().find(|file| {
                        file.id == clean_file_id || clean_file_id == "latest" || file.download_url.as_deref() == Some(url.as_str())
                    }) {
                        if let Some(real_url) = file.download_url.as_ref() {
                            if real_url.contains("storage.modworkshop.net") && !is_image_or_page_asset_name(real_url) {
                                return Ok(real_url.to_string());
                            }
                        }
                    }

                    if let Some(real_url) = first_modworkshop_storage_url_from_html(&html) {
                        return Ok(real_url);
                    }
                }

                return Ok(url.to_string());
            }
        }

        if !clean_file_id.is_empty()
            && clean_file_id != "unknown"
            && clean_file_id != "latest"
            && !clean_file_id.starts_with("download-")
            && !clean_file_id.starts_with("direct-")
        {
            let modworkshop_api_key = load_settings_internal().modworkshop_api_key;
            if let Ok(value) = http_get_json_fast_with_api_key(
                &format!("https://api.modworkshop.net/files/{}", clean_file_id),
                8,
                modworkshop_api_key.as_deref(),
            ) {
                let data = unwrap_data(value);
                if let Some(file) = modworkshop_file_item_from_json(mod_id, &data) {
                    if let Some(url) = file.download_url {
                        return Ok(url);
                    }
                }
            }

            return Ok(format!(
                "https://api.modworkshop.net/files/{}/download",
                clean_file_id
            ));
        }

        if let Ok(html) = http_get_text(&format!("https://modworkshop.net/mod/{}", mod_id)) {
            let files = modworkshop_download_files_from_html(mod_id, &html);

            if let Some(file) = files.iter().find(|file| {
                file.id == clean_file_id || clean_file_id == "latest" || clean_file_id.starts_with("direct-")
            }) {
                if let Some(url) = file.download_url.as_ref() {
                    return Ok(url.to_string());
                }
            }

            if let Some(file) = files.first() {
                if let Some(url) = file.download_url.as_ref() {
                    return Ok(url.to_string());
                }
            }

            if let Some(real_url) = first_modworkshop_storage_url_from_html(&html) {
                return Ok(real_url);
            }
        }

        return Ok(format!("https://modworkshop.net/mod/{}/download", mod_id));
    }

    download_url
        .filter(|url| !url.trim().is_empty())
        .ok_or_else(|| "This source did not expose a direct download URL. Open the source page for now.".to_string())
}

fn push_unique_url(urls: &mut Vec<String>, url: String) {
    if !url.trim().is_empty() && !urls.iter().any(|existing| existing == &url) {
        urls.push(url);
    }
}

fn source_file_download_candidates(
    source: &str,
    mod_id: &str,
    file_id: &str,
    download_url: Option<String>,
    nexus_game_domain: Option<&str>,
) -> Vec<String> {
    let mut urls = Vec::new();
    let caller_url_allowed = !source.eq_ignore_ascii_case("nexus") && !source.eq_ignore_ascii_case("modworkshop");
    let trusted_download_url = if caller_url_allowed { download_url.clone() } else { None };

    if let Ok(primary) = resolve_source_file_download_url(source, mod_id, file_id, trusted_download_url.clone(), nexus_game_domain) {
        push_unique_url(&mut urls, primary);
    }

    if source.eq_ignore_ascii_case("nexus") {
        let clean_mod_id = mod_id.trim();
        let clean_file_id = file_id.trim();
        let nexus_domain = safe_nexus_game_domain(nexus_game_domain)
            .unwrap_or_else(|| "payday3".to_string());

        if !clean_mod_id.is_empty() && !clean_file_id.is_empty() && clean_file_id != "unknown" {
            if let Some(api_key) = load_settings_internal().nexus_api_key {
                let endpoint = format!(
                    "https://api.nexusmods.com/v1/games/{}/mods/{}/files/{}/download_link.json",
                    nexus_domain,
                    clean_mod_id,
                    clean_file_id
                );

                if let Ok(value) = http_get_json(&endpoint, Some(api_key.as_str())) {
                    if let Some(uri) = first_download_uri(&value) {
                        push_unique_url(&mut urls, uri);
                    }
                }
            }

            push_unique_url(
                &mut urls,
                format!(
                    "https://www.nexusmods.com/{}/mods/{}?tab=files&file_id={}",
                    nexus_domain,
                    clean_mod_id,
                    clean_file_id
                ),
            );
        }
    }

    if source.eq_ignore_ascii_case("modworkshop") {
        let mod_id = mod_id.trim();
        let file_id = file_id.trim();

        if !file_id.is_empty()
            && file_id != "unknown"
            && file_id != "latest"
            && !file_id.starts_with("direct-")
            && !file_id.starts_with("download-")
        {
            push_unique_url(
                &mut urls,
                format!("https://api.modworkshop.net/files/{}/download", file_id),
            );
            push_unique_url(
                &mut urls,
                format!("https://api.modworkshop.net/mods/{}/files/{}/download", mod_id, file_id),
            );
            push_unique_url(
                &mut urls,
                format!("https://modworkshop.net/mod/{}/download/{}", mod_id, file_id),
            );
        }

        push_unique_url(
            &mut urls,
            format!("https://api.modworkshop.net/mods/{}/files/latest/download", mod_id),
        );
        push_unique_url(
            &mut urls,
            format!("https://api.modworkshop.net/mods/{}/download", mod_id),
        );
        push_unique_url(
            &mut urls,
            format!("https://modworkshop.net/mod/{}/download", mod_id),
        );
    }

    if caller_url_allowed {
        if let Some(url) = download_url {
            push_unique_url(&mut urls, url);
        }
    }

    urls
}

#[derive(Debug, Clone)]
struct DownloadHttpDiagnostic {
    url_host_path: String,
    http_status: u16,
    content_type: Option<String>,
    content_disposition: Option<String>,
    size_bytes: u64,
}

fn safe_url_host_path(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|parsed| {
            let host = parsed.host_str()?.to_string();
            Some(format!("{}{}", host, parsed.path()))
        })
        .unwrap_or_else(|| url.split('?').next().unwrap_or(url).to_string())
}

fn archive_installable_count(entries: &[ArchiveInspectEntry]) -> usize {
    entries
        .iter()
        .filter(|entry| entry.route_kind != "folder" && !entry.blocked)
        .count()
}

fn archive_skipped_count(entries: &[ArchiveInspectEntry]) -> usize {
    entries
        .iter()
        .filter(|entry| entry.route_kind != "folder" && entry.blocked)
        .count()
}

fn first_archive_entries(entries: &[ArchiveInspectEntry]) -> Vec<String> {
    entries
        .iter()
        .filter(|entry| entry.route_kind != "folder")
        .take(20)
        .map(|entry| entry.archive_path.clone())
        .collect()
}

fn apply_archive_diagnostic_summary(report: &mut LastInstallDiagnostic, entries: &[ArchiveInspectEntry]) {
    report.archive_entry_count = entries.len();
    report.installable_count = archive_installable_count(entries);
    report.skipped_count = archive_skipped_count(entries);
    report.first_archive_entries = first_archive_entries(entries);
}

fn write_stage_download_diagnostic(
    status: &str,
    source: &str,
    mod_id: &str,
    file_id: &str,
    mod_name: &str,
    selected_file_name: &str,
    staged_file: &Path,
    stage_root: &Path,
    size_bytes: u64,
    download_http: Option<&DownloadHttpDiagnostic>,
    archive_kind: Option<String>,
    entries: &[ArchiveInspectEntry],
    warnings: Vec<String>,
    error: Option<String>,
) {
    let mut report = LastInstallDiagnostic {
        timestamp_unix: now_unix_seconds(),
        status: status.to_string(),
        mod_name: mod_name.to_string(),
        source: source.to_string(),
        mod_id: mod_id.to_string(),
        file_id: file_id.to_string(),
        download_url_host_path: download_http.map(|value| value.url_host_path.clone()),
        http_status: download_http.map(|value| value.http_status),
        content_type: download_http.and_then(|value| value.content_type.clone()),
        content_disposition: download_http.and_then(|value| value.content_disposition.clone()),
        selected_file_name: Some(selected_file_name.to_string()),
        saved_file_name: staged_file
            .file_name()
            .and_then(|value| value.to_str())
            .map(|value| value.to_string()),
        saved_file_kind: Some(guess_archive_kind(staged_file)),
        staged_file_path: Some(staged_file.display().to_string()),
        staged_folder_path: Some(stage_root.display().to_string()),
        archive_kind,
        download_size_bytes: Some(size_bytes),
        archive_entry_count: 0,
        installable_count: 0,
        skipped_count: 0,
        first_archive_entries: Vec::new(),
        entries: entries.iter().map(archive_entry_to_diagnostic).collect(),
        installed_files: Vec::new(),
        replaced_files: Vec::new(),
        receipt_path: None,
        warnings,
        error,
    };

    apply_archive_diagnostic_summary(&mut report, entries);
    write_last_install_diagnostic(&report);
}

fn download_url_to_file_with_depth(url: &str, destination: &Path, depth: u8) -> Result<DownloadHttpDiagnostic, String> {
    if depth > 3 {
        return Err("Download resolution looped too many times.".to_string());
    }

    let client = reqwest::blocking::Client::builder()
        .user_agent("TsukiModManager/0.60")
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|err| format!("Failed to create download client: {}", err))?;

    let mut response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/octet-stream, application/zip, */*")
        .header(reqwest::header::REFERER, "https://modworkshop.net/")
        .send()
        .map_err(|err| format!("Download request failed for {}: {}", url, err))?;

    let status = response.status();
    let final_url_host_path = safe_url_host_path(response.url().as_str());
    if !status.is_success() {
        return Err(format!(
            "Download server returned HTTP {} from {}.",
            status.as_u16(),
            final_url_host_path
        ));
    }

    let content_type_raw = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    let content_disposition = response
        .headers()
        .get(reqwest::header::CONTENT_DISPOSITION)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    let content_type = content_type_raw.as_deref().unwrap_or("").to_lowercase();

    if content_type.contains("text/html") {
        let mut html = String::new();
        response
            .read_to_string(&mut html)
            .map_err(|err| format!("Failed to read download page from {}: {}", final_url_host_path, err))?;

        if let Some(storage_url) = first_modworkshop_storage_url_from_html(&html) {
            return download_url_to_file_with_depth(&storage_url, destination, depth + 1);
        }

        return Err(format!(
            "Download returned an HTML page instead of a file from {} (HTTP {}, content-type {}). No direct storage link was found.",
            final_url_host_path,
            status.as_u16(),
            content_type_raw.as_deref().unwrap_or("unknown")
        ));
    }

    if content_type.contains("application/json") {
        let mut body = String::new();
        response
            .read_to_string(&mut body)
            .map_err(|err| format!("Failed to read JSON download response from {}: {}", final_url_host_path, err))?;

        return Err(format!(
            "Download returned JSON instead of an archive from {} (HTTP {}, content-type {}). Body starts with: {}",
            final_url_host_path,
            status.as_u16(),
            content_type_raw.as_deref().unwrap_or("unknown"),
            body.chars().take(180).collect::<String>()
        ));
    }

    let mut output = File::create(destination)
        .map_err(|err| format!("Failed to create staged download: {}", err))?;

    let bandwidth_limit_mb_s = load_settings_internal().download_bandwidth_limit_mb_s;
    let mut bytes = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    let started = Instant::now();

    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|err| format!("Failed to read download: {}", err))?;
        if read == 0 {
            break;
        }

        output
            .write_all(&buffer[..read])
            .map_err(|err| format!("Failed to save download: {}", err))?;
        bytes = bytes.saturating_add(read as u64);

        if bandwidth_limit_mb_s > 0 {
            let bytes_per_second = bandwidth_limit_mb_s.saturating_mul(1024 * 1024).max(1) as f64;
            let target_elapsed = bytes as f64 / bytes_per_second;
            let actual_elapsed = started.elapsed().as_secs_f64();
            if target_elapsed > actual_elapsed {
                std::thread::sleep(Duration::from_secs_f64((target_elapsed - actual_elapsed).min(2.0)));
            }
        }
    }

    Ok(DownloadHttpDiagnostic {
        url_host_path: final_url_host_path,
        http_status: status.as_u16(),
        content_type: content_type_raw,
        content_disposition,
        size_bytes: bytes,
    })
}

fn download_url_to_file_with_diagnostic(url: &str, destination: &Path) -> Result<DownloadHttpDiagnostic, String> {
    download_url_to_file_with_depth(url, destination, 0)
}

fn diagnostics_dir() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("diagnostics"))
}

fn last_install_diagnostic_path() -> Result<PathBuf, String> {
    Ok(diagnostics_dir()?.join("last_install.json"))
}

fn now_unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn archive_entry_to_diagnostic(entry: &ArchiveInspectEntry) -> InstallDiagnosticEntry {
    InstallDiagnosticEntry {
        archive_path: entry.archive_path.clone(),
        route_kind: entry.route_kind.clone(),
        destination: entry.destination.clone(),
        confidence: entry.confidence.clone(),
        reason: entry.reason.clone(),
        blocked: entry.blocked,
        size_bytes: entry.size_bytes,
    }
}

fn write_last_install_diagnostic(report: &LastInstallDiagnostic) {
    if let Ok(folder) = diagnostics_dir() {
        let _ = fs::create_dir_all(&folder);

        if let Ok(contents) = serde_json::to_string_pretty(report) {
            let _ = fs::write(folder.join("last_install.json"), contents);
        }
    }
}

fn read_last_install_diagnostic() -> Option<LastInstallDiagnostic> {
    let path = last_install_diagnostic_path().ok()?;
    let contents = fs::read_to_string(path).ok()?;
    serde_json::from_str(&contents).ok()
}


fn move_conflicting_file_out_of_way(path: &Path, label: &str) -> Result<Option<String>, String> {
    if !path.exists() || path.is_dir() {
        return Ok(None);
    }

    if !keep_uninstalled_mods_enabled() {
        delete_file_permanently(path, "conflicting install path")?;
        return Ok(Some(format!("Deleted {}", path.display())));
    }

    let holding_root = uninstalled_dir()?.join(format!("conflict_{}_{}", sanitize_file_component(label), current_timestamp()));
    fs::create_dir_all(&holding_root)
        .map_err(|err| format!("Failed to create conflict holding folder: {}", err))?;

    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("conflict_file");

    let target_path = unique_destination_path(&holding_root.join(file_name));

    if let Err(rename_err) = fs::rename(path, &target_path) {
        fs::copy(path, &target_path)
            .map_err(|copy_err| format!("Failed to move conflicting file {}: rename failed ({}) and copy failed ({})", path.display(), rename_err, copy_err))?;

        fs::remove_file(path)
            .map_err(|remove_err| format!("Copied conflicting file {} but failed to remove original: {}", path.display(), remove_err))?;
    }

    Ok(Some(target_path.display().to_string()))
}

fn move_existing_destination_file_for_install(destination: &Path, label: &str) -> Result<Option<String>, String> {
    if !destination.exists() || destination.is_dir() {
        return Ok(None);
    }

    if !keep_uninstalled_mods_enabled() {
        delete_file_permanently(destination, "replaced install file")?;
        return Ok(Some(format!("Deleted {}", destination.display())));
    }

    let holding_root = uninstalled_dir()?.join(format!("replaced_{}_{}", sanitize_file_component(label), current_timestamp()));
    fs::create_dir_all(&holding_root)
        .map_err(|err| format!("Failed to create replaced-file holding folder: {}", err))?;

    let file_name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("replaced_file");

    let target_path = unique_destination_path(&holding_root.join(file_name));

    if let Err(rename_err) = fs::rename(destination, &target_path) {
        fs::copy(destination, &target_path)
            .map_err(|copy_err| format!("Failed to move existing destination {}: rename failed ({}) and copy failed ({})", destination.display(), rename_err, copy_err))?;

        fs::remove_file(destination)
            .map_err(|remove_err| format!("Copied existing destination {} but failed to remove original: {}", destination.display(), remove_err))?;
    }

    Ok(Some(target_path.display().to_string()))
}


fn ensure_parent_directory_for_install(destination: &Path, label: &str) -> Result<Option<String>, String> {
    let Some(parent) = destination.parent() else {
        return Ok(None);
    };

    let mut moved = Vec::new();
    let mut current = PathBuf::new();

    for component in parent.components() {
        current.push(component.as_os_str());

        if current.exists() && current.is_file() {
            if let Some(moved_path) = move_conflicting_file_out_of_way(&current, label)? {
                moved.push(moved_path);
            }
        }
    }

    fs::create_dir_all(parent)
        .map_err(|err| format!("Failed to create destination folder {}: {}", parent.display(), err))?;

    if moved.is_empty() {
        Ok(None)
    } else {
        Ok(Some(moved.join("; ")))
    }
}

fn path_is_allowed_destination(paths: &PaydayPaths, destination: &Path) -> bool {
    destination.starts_with(&paths.pak_mods)
        || destination.starts_with(payday_content_paks_path(paths))
        || destination.starts_with(payday_movies_path(paths))
        || destination.starts_with(payday_content_wwise_path(paths))
        || destination.starts_with(&paths.win64)
}

fn move_existing_files_to_uninstalled(paths: &PaydayPaths, file_names: &[String], label: &str) -> Result<Vec<String>, String> {
    if file_names.is_empty() {
        return Ok(Vec::new());
    }

    let keep_uninstalled = keep_uninstalled_mods_enabled();
    let trash_root = uninstalled_dir()?.join(format!("{}_{}", sanitize_file_component(label), current_timestamp()));
    if keep_uninstalled {
        fs::create_dir_all(&trash_root)
            .map_err(|err| format!("Failed to create update holding folder: {}", err))?;
    }

    let mut moved = Vec::new();

    for file_name in file_names {
        let clean_name = file_name.trim();

        if clean_name.is_empty()
            || clean_name.contains("..")
            || clean_name.contains('/')
            || clean_name.contains('\\')
        {
            continue;
        }

        let Some(source_path) = resolve_installed_file_path(paths, clean_name) else {
            continue;
        };

        let actual_name = source_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(clean_name)
            .to_string();

        if keep_uninstalled {
            let target_path = trash_root.join(&actual_name);

            if let Some(parent) = target_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|err| format!("Failed to prepare update holding folder: {}", err))?;
            }

            if let Err(rename_err) = fs::rename(&source_path, &target_path) {
                fs::copy(&source_path, &target_path)
                    .map_err(|copy_err| format!("Failed to move old file {}: rename failed ({}) and copy failed ({})", clean_name, rename_err, copy_err))?;

                fs::remove_file(&source_path)
                    .map_err(|remove_err| format!("Copied old file {} but failed to remove original: {}", clean_name, remove_err))?;
            }

            moved.push(target_path.display().to_string());
        } else {
            delete_file_permanently(&source_path, "replaced install file")?;
            moved.push(format!("Deleted {}", source_path.display()));
        }
    }

    Ok(moved)
}

fn write_install_receipt(
    mod_name: &str,
    source: &str,
    mod_id: &str,
    file_id: &str,
    source_file_name: Option<String>,
    source_file_category: Option<String>,
    source_file_uploaded_at: Option<String>,
    source_file_version: Option<String>,
    version: Option<String>,
    author: Option<String>,
    thumbnail_url: Option<String>,
    banner_url: Option<String>,
    page_url: Option<String>,
    files: &[AppliedInstallFile],
) -> Result<String, String> {
    let receipt_root = receipts_dir()?;
    fs::create_dir_all(&receipt_root)
        .map_err(|err| format!("Failed to create receipts folder: {}", err))?;

    let receipt_id = format!(
        "{}_{}_{}_{}",
        sanitize_file_component(source),
        sanitize_file_component(mod_id),
        sanitize_file_component(file_id),
        current_timestamp()
    );

    let receipt = InstallReceipt {
        id: receipt_id.clone(),
        display_name: mod_name.to_string(),
        source: source.to_string(),
        mod_type: "source-install".to_string(),
        source_mod_id: Some(mod_id.to_string()),
        source_file_id: Some(file_id.to_string()),
        source_file_name,
        source_file_category,
        source_file_uploaded_at,
        source_file_version,
        version,
        author,
        thumbnail_url,
        banner_url,
        page_url,
        installed_at_unix: SystemTime::now().duration_since(UNIX_EPOCH).ok().map(|duration| duration.as_secs()),
        enabled: None,
        profile_id: Some(BUILTIN_PAYDAY3_PROFILE_ID.to_string()),
        notes: None,
        files: files.iter().map(|file| {
            let destination_path = PathBuf::from(&file.destination);
            let sha256 = sha256_file(&destination_path).ok();

            InstallReceiptFile {
                relative_path: file.destination.clone(),
                size_bytes: Some(file.size_bytes),
                sha256,
                original_path: None,
                backup_path: None,
            }
        }).collect(),
    };

    let receipt_path = receipt_root.join(format!("{}.json", receipt_id));
    let contents = serde_json::to_string_pretty(&receipt)
        .map_err(|err| format!("Failed to serialize install receipt: {}", err))?;

    fs::write(&receipt_path, contents)
        .map_err(|err| format!("Failed to write install receipt: {}", err))?;

    let _ = source_catalog::index_receipt(BUILTIN_PAYDAY3_PROFILE_ID, &receipt);
    let _ = sync_installed_state_database();

    Ok(receipt_path.display().to_string())
}

fn install_staged_file_to_game_internal(
    staged_file_path: &str,
    mod_name: &str,
    source: &str,
    mod_id: &str,
    file_id: &str,
    source_file_name: Option<String>,
    source_file_category: Option<String>,
    source_file_uploaded_at: Option<String>,
    source_file_version: Option<String>,
    version: Option<String>,
    author: Option<String>,
    thumbnail_url: Option<String>,
    banner_url: Option<String>,
    page_url: Option<String>,
    description: &str,
    replace_file_names: Vec<String>,
) -> Result<InstallApplyResult, String> {
    let previous_diagnostic = read_last_install_diagnostic().filter(|report| {
        report.source.eq_ignore_ascii_case(source)
            && report.mod_id == mod_id
            && report.file_id == file_id
    });

    let mut diagnostic = LastInstallDiagnostic {
        timestamp_unix: now_unix_seconds(),
        status: "started".to_string(),
        mod_name: mod_name.to_string(),
        source: source.to_string(),
        mod_id: mod_id.to_string(),
        file_id: file_id.to_string(),
        download_url_host_path: previous_diagnostic
            .as_ref()
            .and_then(|report| report.download_url_host_path.clone()),
        http_status: previous_diagnostic.as_ref().and_then(|report| report.http_status),
        content_type: previous_diagnostic
            .as_ref()
            .and_then(|report| report.content_type.clone()),
        content_disposition: previous_diagnostic
            .as_ref()
            .and_then(|report| report.content_disposition.clone()),
        selected_file_name: previous_diagnostic
            .as_ref()
            .and_then(|report| report.selected_file_name.clone()),
        saved_file_name: Path::new(staged_file_path)
            .file_name()
            .and_then(|value| value.to_str())
            .map(|value| value.to_string()),
        saved_file_kind: Some(guess_archive_kind(Path::new(staged_file_path))),
        staged_file_path: Some(staged_file_path.to_string()),
        staged_folder_path: Path::new(staged_file_path)
            .parent()
            .map(|value| value.display().to_string()),
        archive_kind: None,
        download_size_bytes: None,
        archive_entry_count: 0,
        installable_count: 0,
        skipped_count: 0,
        first_archive_entries: Vec::new(),
        entries: Vec::new(),
        installed_files: Vec::new(),
        replaced_files: Vec::new(),
        receipt_path: None,
        warnings: Vec::new(),
        error: None,
    };

    let result = (|| -> Result<InstallApplyResult, String> {

        let paths = detect_payday3_paths_internal()
            .ok_or_else(|| "Payday 3 was not detected. Set the game path in Settings first.".to_string())?;

        let mut staged_file = PathBuf::from(staged_file_path);

        if !staged_file.exists() {
            return Err(format!("Staged file does not exist: {}", staged_file.display()));
        }

        staged_file = rename_staged_download_if_fake_zip(&staged_file, source, mod_id, file_id, mod_name)?;
        diagnostic.staged_file_path = Some(staged_file.display().to_string());
        diagnostic.saved_file_name = staged_file
            .file_name()
            .and_then(|value| value.to_str())
            .map(|value| value.to_string());
        diagnostic.saved_file_kind = Some(guess_archive_kind(&staged_file));
        diagnostic.download_size_bytes = fs::metadata(&staged_file).ok().map(|value| value.len());

        let (archive_kind, entries, mut warnings) = inspect_staged_file(&paths, &staged_file, description)?;
        validate_payday_ue5_dependencies(&paths, &entries)?;

        diagnostic.archive_kind = Some(archive_kind.clone());
        diagnostic.entries = entries.iter().map(archive_entry_to_diagnostic).collect();
        apply_archive_diagnostic_summary(&mut diagnostic, &entries);
        diagnostic.warnings = warnings.clone();

        let installable_entries = entries
            .iter()
            .filter(|entry| entry.route_kind != "folder" && !entry.blocked)
            .collect::<Vec<_>>();

        let blocked_entries = entries
            .iter()
            .filter(|entry| entry.route_kind != "folder" && entry.blocked)
            .collect::<Vec<_>>();

        if installable_entries.is_empty() {
            let reasons = blocked_entries
                .iter()
                .take(8)
                .map(|entry| format!("{}: {}", entry.archive_path, entry.reason))
                .collect::<Vec<_>>()
                .join(" | ");
            return Err(format!(
                "No safe installable files were found. Blocked entries: {}",
                if reasons.is_empty() { "none".to_string() } else { reasons }
            ));
        }

        if !blocked_entries.is_empty() {
            warnings.push(format!(
                "Skipped {} blocked/non-game entry(s) while installing safe routed files: {}",
                blocked_entries.len(),
                blocked_entries
                    .iter()
                    .take(6)
                    .map(|entry| entry.archive_path.clone())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
            diagnostic.warnings = warnings.clone();
        }

        let replaced_files = move_existing_files_to_uninstalled(&paths, &replace_file_names, mod_name)?;
        diagnostic.replaced_files = replaced_files.clone();

        let mut installed_files = Vec::new();

        if archive_kind == "zip" && file_has_zip_magic(&staged_file) {
            let file = File::open(&staged_file)
                .map_err(|err| format!("Failed to open staged zip for install: {}", err))?;
            let mut archive = ZipArchive::new(file)
                .map_err(|err| format!("Failed to read staged zip for install: {}", err))?;

            let mut raw_paths = Vec::new();
            for index in 0..archive.len() {
                let item = archive
                    .by_index(index)
                    .map_err(|err| format!("Failed to inspect zip entry {}: {}", index, err))?;
                raw_paths.push(normalize_archive_path(item.name()));
            }

            let root = common_archive_root(&raw_paths);
            let stripped_paths = raw_paths
                .iter()
                .map(|path| strip_common_root(path, root.as_deref()))
                .collect::<Vec<_>>();

            for index in 0..archive.len() {
                let mut item = archive
                    .by_index(index)
                    .map_err(|err| format!("Failed to read zip entry {}: {}", index, err))?;

                let stripped = strip_common_root(&normalize_archive_path(item.name()), root.as_deref());

                if item.is_dir() || archive_entry_is_folder_marker(&stripped, item.size(), &stripped_paths) {
                    continue;
                }

                let entry = infer_archive_entry_destination(&paths, &stripped, description);

                if entry.route_kind == "folder" {
                    continue;
                }

                if entry.blocked {
                    warnings.push(format!("Skipped blocked entry {}: {}", entry.archive_path, entry.reason));
                    continue;
                }

                let destination = PathBuf::from(&entry.destination);

                if !path_is_allowed_destination(&paths, &destination) {
                    return Err(format!("Refused unsafe destination: {}", destination.display()));
                }

                if let Some(moved_conflict) = ensure_parent_directory_for_install(&destination, mod_name)? {
                    warnings.push(format!("Moved old broken file-that-should-be-a-folder before install: {}", moved_conflict));
                    diagnostic.replaced_files.push(moved_conflict);
                }

                if destination.exists() && destination.is_dir() {
                    if item.size() == 0 {
                        continue;
                    }

                    return Err(format!("Refusing to overwrite directory with file: {}", destination.display()));
                }

                if let Some(replaced_existing) = move_existing_destination_file_for_install(&destination, mod_name)? {
                    warnings.push(format!("Moved existing destination file before install: {}", replaced_existing));
                    diagnostic.replaced_files.push(replaced_existing);
                }

                let mut output = File::create(&destination)
                    .map_err(|err| format!("Failed to create destination {}: {}", destination.display(), err))?;

                io::copy(&mut item, &mut output)
                    .map_err(|err| format!("Failed to extract {}: {}", entry.archive_path, err))?;

                installed_files.push(AppliedInstallFile {
                    archive_path: entry.archive_path,
                    destination: destination.display().to_string(),
                    size_bytes: entry.size_bytes,
                });
            }
        } else if archive_kind.contains("external-archive") {
            let extracted_root = extract_external_archive(&staged_file, mod_name)?;
            let files = match collect_files_recursive(&extracted_root) {
                Ok(files) => files,
                Err(error) => {
                    cleanup_temp_extraction_folder(&extracted_root, &mut warnings);
                    return Err(error);
                }
            };
            let raw_paths = files.iter().map(|(relative, _, _)| relative.clone()).collect::<Vec<_>>();
            let root = common_archive_root(&raw_paths);
            let stripped_paths = raw_paths
                .iter()
                .map(|path| strip_common_root(path, root.as_deref()))
                .collect::<Vec<_>>();

            warnings.push(format!(
                "Archive extracted for install with built-in 7z or an installed archive tool into {}.",
                extracted_root.display()
            ));

            for (relative, source_path, size) in files {
                let stripped = strip_common_root(&relative, root.as_deref());

                if archive_entry_is_folder_marker(&stripped, size, &stripped_paths) {
                    continue;
                }

                let mut entry = infer_archive_entry_destination(&paths, &stripped, description);
                entry.size_bytes = size;

                if entry.route_kind == "folder" {
                    continue;
                }

                if entry.blocked {
                    warnings.push(format!("Skipped blocked entry {}: {}", entry.archive_path, entry.reason));
                    continue;
                }

                let destination = PathBuf::from(&entry.destination);

                if !path_is_allowed_destination(&paths, &destination) {
                    return Err(format!("Refused unsafe destination: {}", destination.display()));
                }

                if let Some(moved_conflict) = ensure_parent_directory_for_install(&destination, mod_name)? {
                    warnings.push(format!("Moved old broken file-that-should-be-a-folder before install: {}", moved_conflict));
                    diagnostic.replaced_files.push(moved_conflict);
                }

                if destination.exists() && destination.is_dir() {
                    if size == 0 {
                        continue;
                    }

                    return Err(format!("Refusing to overwrite directory with file: {}", destination.display()));
                }

                if let Some(replaced_existing) = move_existing_destination_file_for_install(&destination, mod_name)? {
                    warnings.push(format!("Moved existing destination file before install: {}", replaced_existing));
                    diagnostic.replaced_files.push(replaced_existing);
                }

                fs::copy(&source_path, &destination)
                    .map_err(|err| format!("Failed to copy extracted file {} into game folder: {}", source_path.display(), err))?;

                installed_files.push(AppliedInstallFile {
                    archive_path: entry.archive_path,
                    destination: destination.display().to_string(),
                    size_bytes: entry.size_bytes,
                });
            }

            cleanup_temp_extraction_folder(&extracted_root, &mut warnings);
        } else {
            let entry = installable_entries[0];
            let destination = PathBuf::from(&entry.destination);

            if !path_is_allowed_destination(&paths, &destination) {
                return Err(format!("Refused unsafe destination: {}", destination.display()));
            }

            if let Some(moved_conflict) = ensure_parent_directory_for_install(&destination, mod_name)? {
                warnings.push(format!("Moved old broken file-that-should-be-a-folder before install: {}", moved_conflict));
            }

            if destination.exists() && destination.is_dir() {
                return Err(format!("Refusing to overwrite directory with file: {}", destination.display()));
            }

            if let Some(replaced_existing) = move_existing_destination_file_for_install(&destination, mod_name)? {
                warnings.push(format!("Moved existing destination file before install: {}", replaced_existing));
                diagnostic.replaced_files.push(replaced_existing);
            }

            fs::copy(&staged_file, &destination)
                .map_err(|err| format!("Failed to copy file into game folder: {}", err))?;

            installed_files.push(AppliedInstallFile {
                archive_path: entry.archive_path.clone(),
                destination: destination.display().to_string(),
                size_bytes: entry.size_bytes,
            });
        }

        if installed_files.is_empty() {
            return Err("No files were copied into the game folder.".to_string());
        }

        warnings.push(if keep_uninstalled_mods_enabled() {
            "Installed into detected PAYDAY 3 paths. Old update files were moved to the uninstalled holding folder when provided.".to_string()
        } else {
            "Installed into detected PAYDAY 3 paths. Old update files were permanently deleted when provided.".to_string()
        });

        let receipt_path = write_install_receipt(
            mod_name,
            source,
            mod_id,
            file_id,
            source_file_name,
            source_file_category,
            source_file_uploaded_at,
            source_file_version,
            version,
            author,
            thumbnail_url,
            banner_url,
            page_url,
            &installed_files,
        )?;

        if !load_settings_internal().keep_downloaded_archives {
            match fs::remove_file(&staged_file) {
                Ok(_) => {
                    warnings.push(format!(
                        "Deleted staged downloaded archive after successful install because Keep Downloaded Archives is off: {}",
                        staged_file.display()
                    ));
                    if let Some(parent) = staged_file.parent() {
                        if let Ok(download_root) = downloads_cache_dir() {
                            remove_empty_dirs_up_to(parent, &download_root);
                        }
                    }
                }
                Err(error) => warnings.push(format!(
                    "Could not delete staged downloaded archive {} after install: {}",
                    staged_file.display(),
                    error
                )),
            }
        }

        let mut all_replaced_files = replaced_files.clone();
        for replaced in &diagnostic.replaced_files {
            if !all_replaced_files.iter().any(|existing| existing == replaced) {
                all_replaced_files.push(replaced.clone());
            }
        }

        diagnostic.installed_files = installed_files.clone();
        diagnostic.replaced_files = all_replaced_files.clone();
        diagnostic.receipt_path = Some(receipt_path.clone());
        diagnostic.warnings = warnings.clone();

        Ok(InstallApplyResult {
            mod_name: mod_name.to_string(),
            installed_files,
            replaced_files: all_replaced_files,
            receipt_path,
            warnings,
        })
    })();

    match &result {
        Ok(_) => {
            diagnostic.status = "success".to_string();
            diagnostic.error = None;
        }
        Err(error) => {
            diagnostic.status = "failed".to_string();
            diagnostic.error = Some(error.clone());
        }
    }

    write_last_install_diagnostic(&diagnostic);

    result
}

#[tauri::command]
async fn install_staged_file_to_game(
    staged_file_path: String,
    mod_name: String,
    source: String,
    mod_id: String,
    file_id: String,
    source_file_name: Option<String>,
    source_file_category: Option<String>,
    source_file_uploaded_at: Option<String>,
    source_file_version: Option<String>,
    version: Option<String>,
    author: Option<String>,
    thumbnail_url: Option<String>,
    banner_url: Option<String>,
    page_url: Option<String>,
    description: String,
    replace_file_names: Vec<String>,
    profile_id: Option<String>,
) -> Result<InstallApplyResult, String> {
    let profile_id = require_game_profile_installation(profile_id.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        if !is_builtin_payday3_profile(Some(&profile_id)) {
            if !replace_file_names.is_empty() {
                return Err("Remove the previous receipt-owned mod before installing its replacement for this profile.".to_string());
            }
            return profile_installs::install_profile_source_file(&profile_id, Path::new(&staged_file_path), &source, &mod_id, &file_id, &mod_name, version, author, thumbnail_url, page_url);
        }
        install_staged_file_to_game_internal(
            &staged_file_path,
            &mod_name,
            &source,
            &mod_id,
            &file_id,
            source_file_name,
            source_file_category,
            source_file_uploaded_at,
            source_file_version,
            version,
            author,
            thumbnail_url,
            banner_url,
            page_url,
            &description,
            replace_file_names,
        )
    })
    .await
    .map_err(|err| format!("Install task failed: {:?}", err))?
}


#[tauri::command]
async fn stage_source_file_download(
    source: String,
    mod_id: String,
    file_id: String,
    file_name: String,
    download_url: Option<String>,
    mod_name: String,
    description: String,
    game_domain: Option<String>,
    profile_id: Option<String>,
) -> Result<StagedDownloadResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let profile_id = require_game_profile_installation(profile_id.as_deref())?;
        if source.eq_ignore_ascii_case("modworkshop") {
            let config = source_config_for_profile_id(Some(&profile_id));
            let expected_game = modworkshop_game_route_from_source_config(&config).ok_or("This profile has no configured ModWorkshop game mapping.")?;
            let version = modworkshop_profile_game_version(Some(&profile_id), &expected_game);
            let value = http_get_json_fast(&format!("https://api.modworkshop.net/mods/{}", percent_encode_query(&mod_id)), 14)?;
            let summary = modworkshop_summary_from_api_value_for_game(&unwrap_data(value), None).ok_or("Could not verify ModWorkshop engine compatibility before download.")?;
            if !modworkshop_summary_matches_game(&summary, &expected_game) {
                return Err(format!("This ModWorkshop mod does not belong to the selected game's verified mapping: {}.", expected_game));
            }
            if let Some(version) = version {
                if !modworkshop_version_matches(&summary.tags, &version) {
                    return Err(format!("This mod is incompatible with the selected PAYDAY 3 {} profile. Select the matching game version before downloading.", version));
                }
            }
        }

        if is_image_or_page_asset_name(&file_name) || download_url.as_deref().map(is_image_or_page_asset_name).unwrap_or(false) {
            return Err("That item is a page image/thumbnail, not a downloadable mod file. Refresh this mod page with v0.59 so Tsuki can use the real Files endpoint.".to_string());
        }

        if looks_like_external_mod_manager_download(&source, &mod_name, &file_name, &description, download_url.as_deref()) {
            return Err("Blocked external mod manager download. Tsuki does not download/install other mod managers; open that page manually if you intentionally need it.".to_string());
        }

        if source.eq_ignore_ascii_case("modworkshop")
            && is_generic_modworkshop_file_name(&file_name)
            && known_download_extension(&file_name).is_none()
            && download_url
                .as_deref()
                .map(|url| !url.to_lowercase().contains("/download") && !url.to_lowercase().contains("storage.modworkshop.net"))
                .unwrap_or(true)
        {
            return Err(format!(
                "Blocked generic ModWorkshop placeholder '{}'. Choose a named file like .pak/.zip/.dll/.ini/Mods-folder archive. Tsuki blocks placeholders only when no usable download endpoint is available.",
                file_name
            ));
        }

        let settings = load_settings_internal();
        let _download_guard = acquire_staged_download_guard(settings.simultaneous_downloads)?;
        let paths = if is_builtin_payday3_profile(Some(&profile_id)) {
            Some(detect_payday3_paths_internal().ok_or_else(|| "PAYDAY 3 was not detected. Set the game path in Settings first.".to_string())?)
        } else { None };

        let source_config = if source.eq_ignore_ascii_case("nexus") {
            source_config_for_profile_id(Some(&profile_id))
        } else {
            serde_json::Value::Null
        };
        let nexus_domain = safe_nexus_game_domain(game_domain.as_deref())
            .or_else(|| nexus_domain_from_source_config(&source_config));
        let download_candidates = source_file_download_candidates(&source, &mod_id, &file_id, download_url.clone(), nexus_domain.as_deref());

        if download_candidates.is_empty() {
            return Err("This source did not expose a download URL.".to_string());
        }

        let direct_url = download_candidates
            .first()
            .cloned()
            .unwrap_or_else(|| "download.zip".to_string());

        let stage_root = downloads_cache_dir()?
            .join(sanitize_file_component(&profile_id))
            .join(sanitize_file_component(&source))
            .join(sanitize_file_component(&mod_id))
            .join(sanitize_file_component(&file_id));

        fs::create_dir_all(&stage_root)
            .map_err(|err| format!("Failed to create staging folder: {}", err))?;

        let clean_source_name = sanitize_file_component(&file_name);
        let guessed_from_url = guess_file_name_from_url(&direct_url)
            .filter(|name| known_download_extension(name).is_some());

        let guessed = if known_download_extension(&clean_source_name).is_some() {
            clean_source_name
        } else if let Some(url_name) = guessed_from_url.clone() {
            let url_extension = known_download_extension(&url_name).unwrap_or_else(|| "zip".to_string());

            // Prefer the human/source file name over ModWorkshop/Nexus random storage blobs.
            // Example: "Keycard Outline Fix" + random-url.pak => "Keycard Outline Fix.pak".
            format!("{}.{}", clean_source_name, url_extension)
        } else if !clean_source_name.trim().is_empty() {
            format!("{}.zip", clean_source_name)
        } else {
            "download.zip".to_string()
        };

        let mut staged_file = stage_root.join(guessed);
        let mut last_download_error = String::new();
        let mut size_bytes: Option<u64> = None;
        let mut download_http: Option<DownloadHttpDiagnostic> = None;

        let attempts = settings.download_retry_count.saturating_add(1).clamp(1, 7);
        for candidate in download_candidates {
            if is_image_or_page_asset_name(&candidate) {
                last_download_error = format!("Skipped page image/thumbnail URL instead of downloading it: {}", candidate);
                continue;
            }

            for attempt in 0..attempts {
                match download_url_to_file_with_diagnostic(&candidate, &staged_file) {
                    Ok(diagnostic) => {
                        size_bytes = Some(diagnostic.size_bytes);
                        download_http = Some(diagnostic);
                        break;
                    }
                    Err(error) => {
                        last_download_error = format!(
                            "{} attempt {}/{} -> {}",
                            candidate,
                            attempt + 1,
                            attempts,
                            error
                        );
                        let _ = fs::remove_file(&staged_file);
                        if attempt + 1 < attempts {
                            std::thread::sleep(Duration::from_millis(350 * (attempt as u64 + 1)));
                        }
                    }
                }
            }

            if size_bytes.is_some() {
                break;
            }
        }

        let size_bytes = match size_bytes {
            Some(bytes) => bytes,
            None => {
                let error = if last_download_error.is_empty() {
                    "Every download candidate was rejected before download.".to_string()
                } else {
                    format!("All download candidates failed. Last error: {}", last_download_error)
                };
                let warnings = if last_download_error.is_empty() {
                    Vec::new()
                } else {
                    vec![last_download_error.clone()]
                };

                write_stage_download_diagnostic(
                    "failed",
                    &source,
                    &mod_id,
                    &file_id,
                    &mod_name,
                    &file_name,
                    &staged_file,
                    &stage_root,
                    0,
                    download_http.as_ref(),
                    None,
                    &[],
                    warnings,
                    Some(error.clone()),
                );

                return Err(error);
            }
        };

        if let Err(error) = validate_staged_download_payload(&staged_file, &source, &mod_id, &file_id) {
            write_stage_download_diagnostic(
                "failed",
                &source,
                &mod_id,
                &file_id,
                &mod_name,
                &file_name,
                &staged_file,
                &stage_root,
                size_bytes,
                download_http.as_ref(),
                None,
                &[],
                Vec::new(),
                Some(error.clone()),
            );
            return Err(error);
        }

        let fake_zip_label = {
            let clean_file_name = sanitize_file_component(&file_name);
            let lower = clean_file_name.to_lowercase();

            if !clean_file_name.trim().is_empty()
                && lower != "download"
                && lower != "latest modworkshop file"
                && !lower.starts_with("modworkshop file")
            {
                clean_file_name
            } else {
                mod_name.clone()
            }
        };

        staged_file = match rename_staged_download_if_fake_zip(&staged_file, &source, &mod_id, &file_id, &fake_zip_label) {
            Ok(path) => path,
            Err(error) => {
                write_stage_download_diagnostic(
                    "failed",
                    &source,
                    &mod_id,
                    &file_id,
                    &mod_name,
                    &file_name,
                    &staged_file,
                    &stage_root,
                    size_bytes,
                    download_http.as_ref(),
                    None,
                    &[],
                    Vec::new(),
                    Some(error.clone()),
                );
                return Err(error);
            }
        };

        let inspection = if let Some(paths) = paths.as_ref() {
            inspect_staged_file(paths, &staged_file, &description)
        } else {
            profile_installs::inspect_profile_source_file(&profile_id, &staged_file)
        };
        let (archive_kind, entries, mut warnings) = match inspection {
            Ok(result) => result,
            Err(error) => {
                write_stage_download_diagnostic(
                    "failed",
                    &source,
                    &mod_id,
                    &file_id,
                    &mod_name,
                    &file_name,
                    &staged_file,
                    &stage_root,
                    size_bytes,
                    download_http.as_ref(),
                    None,
                    &[],
                    Vec::new(),
                    Some(error.clone()),
                );
                return Err(error);
            }
        };

        if entries.iter().any(|entry| entry.blocked) {
            warnings.push("One or more entries are blocked until the installer has safer handling for this route.".to_string());
        }

        warnings.push(format!("Downloaded to profile-scoped staging and inspected using {} install rules.", profile_id));

        write_stage_download_diagnostic(
            "staged",
            &source,
            &mod_id,
            &file_id,
            &mod_name,
            &file_name,
            &staged_file,
            &stage_root,
            size_bytes,
            download_http.as_ref(),
            Some(archive_kind.clone()),
            &entries,
            warnings.clone(),
            None,
        );

        Ok(StagedDownloadResult {
            mod_name,
            file_name,
            staged_file_path: staged_file.display().to_string(),
            staged_folder_path: stage_root.display().to_string(),
            size_bytes,
            archive_kind,
            can_install_later: !entries.iter().any(|entry| entry.blocked) && entries.iter().any(|entry| entry.route_kind != "folder"),
            entries,
            warnings,
        })
    })
    .await
    .map_err(|err| format!("Download task failed: {:?}", err))?
}


#[tauri::command]
fn preview_source_mod_install(
    mod_name: String,
    source: String,
    description: String,
    file_names: Vec<String>,
) -> Result<InstallPreview, String> {
    let paths = detect_payday3_paths_internal()
        .ok_or_else(|| "Payday 3 was not detected. Set the game path in Settings first.".to_string())?;

    let mut warnings = Vec::new();

    warnings.push("Preview only: v0.28 does not copy files yet. It is checking install destinations first.".to_string());
    warnings.push("Real installs will require archive inspection plus a receipt before copy/uninstall is enabled.".to_string());

    let names = if file_names.is_empty() {
        vec![mod_name.clone()]
    } else {
        file_names
    };

    let mut items = Vec::new();

    for file_name in names {
        items.push(infer_install_preview_item(&paths, &mod_name, &file_name, &description));
    }

    if source.to_lowercase().contains("nexus") {
        warnings.push("Nexus downloads may require the saved API key and account permissions. Age-restricted visibility follows your Nexus account settings.".to_string());
    }

    Ok(InstallPreview {
        game_root: paths.game_root.display().to_string(),
        items,
        warnings,
        blocked: false,
    })
}



fn split_camel_for_match(input: &str) -> String {
    let mut output = String::new();
    let mut previous: Option<char> = None;

    for ch in input.chars() {
        if let Some(prev) = previous {
            if (prev.is_ascii_lowercase() && ch.is_ascii_uppercase())
                || (prev.is_ascii_alphabetic() && ch.is_ascii_digit())
                || (prev.is_ascii_digit() && ch.is_ascii_alphabetic())
            {
                output.push(' ');
            }
        }

        output.push(ch);
        previous = Some(ch);
    }

    output
}

fn normalize_mod_match_text(input: &str) -> String {
    let mut text = split_camel_for_match(input).to_lowercase();

    for ext in [".pak", ".ucas", ".utoc", ".zip", ".rar", ".7z"] {
        if text.ends_with(ext) {
            let new_len = text.len().saturating_sub(ext.len());
            text.truncate(new_len);
        }
    }

    // Priority prefixes like 999_ModName or 001-ModName.
    let trimmed = text.trim_start_matches(|ch: char| ch.is_ascii_digit());
    text = trimmed.trim_start_matches(['_', '-', ' ']).to_string();

    // Common Unreal/PAK suffixes.
    for suffix in ["_p", "-p", " p", "_0", "-0", " windows", " win64"] {
        if text.ends_with(suffix) {
            let new_len = text.len().saturating_sub(suffix.len());
            text.truncate(new_len);
        }
    }

    let mut cleaned = String::new();
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() {
            cleaned.push(ch);
        } else {
            cleaned.push(' ');
        }
    }

    let stop_words = [
        "the", "a", "an", "and", "or", "for", "to", "of", "payday", "payday3", "pd3",
        "pak", "mod", "mods", "final", "main", "file", "files", "windows", "win64",
        "content", "paks", "release", "latest", "version",
    ];

    let tokens = cleaned
        .split_whitespace()
        .filter(|token| token.len() > 1)
        .filter(|token| !stop_words.contains(token))
        .filter(|token| {
            let lower = token.to_lowercase();
            if lower.starts_with('v') && lower[1..].chars().all(|ch| ch.is_ascii_digit() || ch == '.') {
                return false;
            }

            if lower.chars().all(|ch| ch.is_ascii_digit()) {
                // Keep short meaningful title numbers like Battlefield 1 / 2042.
                // Drop long storage/file ids like 98921.
                return lower.len() <= 4;
            }

            true
        })
        .map(|token| token.to_string())
        .collect::<Vec<_>>();

    tokens.join(" ")
}

fn compact(input: &str) -> String {
    input
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .map(|ch| ch.to_ascii_lowercase())
        .collect()
}

fn compact_match_text(input: &str) -> String {
    input.chars().filter(|ch| ch.is_ascii_alphanumeric()).collect()
}

fn modworkshop_source_has_file_proof(source: &SourceModSummary) -> bool {
    let combined = format!(
        "{} {} {}",
        source.short_description.as_deref().unwrap_or(""),
        source.tags.join(" "),
        source.page_url.as_deref().unwrap_or("")
    )
    .to_lowercase();

    [".pak", ".ucas", ".utoc", ".zip", ".rar", ".7z", "_p.pak", "/files/", "file_id", "fileid"]
        .iter()
        .any(|token| combined.contains(token))
}

fn modworkshop_candidate_is_installed_pak(candidate: &InstalledMatchCandidate) -> bool {
    candidate
        .file_name
        .to_lowercase()
        .split(", ")
        .any(|name| name.trim().ends_with(".pak") || name.trim().ends_with(".ucas") || name.trim().ends_with(".utoc"))
}

fn modworkshop_reason_is_exact_stem_proof(reason: &str) -> bool {
    let lower = reason.to_lowercase();

    lower.contains("exact normalized filename/title match")
        || lower.contains("installed filename appears as a distinctive title chunk")
        || lower.contains("compact filename/title match")
        || lower.contains("filename containment")
}





fn token_list(input: &str) -> Vec<String> {
    let mut tokens = input
        .split_whitespace()
        .map(|token| token.to_string())
        .filter(|token| token.len() > 1)
        .collect::<Vec<_>>();

    tokens.sort();
    tokens.dedup();
    tokens
}

fn source_updated_unix(summary: &SourceModSummary) -> Option<u64> {
    let value = summary.updated_at.as_ref()?.trim();

    if let Ok(number) = value.parse::<u64>() {
        return Some(if number > 10_000_000_000 { number / 1000 } else { number });
    }

    // ISO-lite fallback: not perfect without a date parser, but enough to compare same-year dates poorly.
    // Update notices stay conservative if we cannot parse a real Unix timestamp.
    None
}

fn build_installed_match_candidates() -> Result<Vec<InstalledMatchCandidate>, String> {
    let scan = scan_pak_mods_internal()?;
    let mut grouped: std::collections::BTreeMap<String, InstalledMatchCandidate> = std::collections::BTreeMap::new();

    for file in scan.pak_mods {
        let enabled_name = enabled_name_from_disabled(&file.file_name);
        let normalized = normalize_mod_match_text(&enabled_name);

        if normalized.trim().is_empty() {
            continue;
        }

        let compact = compact_match_text(&normalized);
        let key = normalized.clone();

        grouped
            .entry(key)
            .and_modify(|existing| {
                if file.modified_unix > existing.modified_unix {
                    existing.modified_unix = file.modified_unix;
                }

                existing.size_bytes = existing.size_bytes.saturating_add(file.size_bytes);

                if existing.sha256.is_none() {
                    existing.sha256 = file.sha256.clone();
                }

                if !existing.file_name.contains(&file.file_name) {
                    existing.file_name = format!("{}, {}", existing.file_name, file.file_name);
                }
            })
            .or_insert(InstalledMatchCandidate {
                file_name: file.file_name,
                normalized_name: normalized,
                compact_name: compact,
                modified_unix: file.modified_unix,
                size_bytes: file.size_bytes,
                sha256: file.sha256,
            });
    }

    Ok(grouped.into_values().collect())
}

fn installed_file_mentions_source_id(source: &SourceModSummary, candidate: &InstalledMatchCandidate) -> bool {
    let id = source.source_id.trim();

    if id.len() < 4 || !id.chars().all(|ch| ch.is_ascii_digit()) {
        return false;
    }

    let mut number_buffer = String::new();
    let mut numbers = Vec::new();

    for ch in candidate.file_name.chars() {
        if ch.is_ascii_digit() {
            number_buffer.push(ch);
        } else if !number_buffer.is_empty() {
            numbers.push(number_buffer.clone());
            number_buffer.clear();
        }
    }

    if !number_buffer.is_empty() {
        numbers.push(number_buffer);
    }

    numbers.iter().any(|value| value == id)
}

fn pairing_weak_token(token: &str) -> bool {
    matches!(
        token,
        "a"
            | "an"
            | "the"
            | "and"
            | "or"
            | "for"
            | "with"
            | "without"
            | "payday"
            | "payday3"
            | "pd3"
            | "pd"
            | "mod"
            | "mods"
            | "pak"
            | "file"
            | "files"
            | "client"
            | "server"
            | "side"
            | "update"
            | "updated"
            | "latest"
            | "final"
            | "version"
            | "v1"
            | "v2"
            | "v3"
            | "fix"
            | "fixed"
            | "better"
            | "improved"
            | "simple"
            | "new"
            | "old"
            | "request"
            | "repost"
            | "sound"
            | "sounds"
            | "audio"
            | "music"
            | "voice"
            | "vo"
            | "sfx"
            | "ui"
            | "hud"
            | "menu"
            | "movie"
            | "video"
            | "intro"
            | "startup"
            | "loading"
            | "screen"
            | "replacer"
            | "replacement"
            | "pack"
            | "bundle"
            | "main"
            | "win64"
            | "windows"
            | "ue4ss"
            | "moolah"
            | "logic"
            | "loader"
    )
}

fn pairing_tokens(value: &str) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();

    token_list(value)
        .into_iter()
        .filter(|token| token.len() > 1)
        .filter(|token| !token.chars().all(|ch| ch.is_ascii_digit()))
        .filter(|token| seen.insert(token.clone()))
        .collect()
}

fn pairing_strong_tokens(value: &str) -> Vec<String> {
    pairing_tokens(value)
        .into_iter()
        .filter(|token| !pairing_weak_token(token))
        .filter(|token| token.len() >= 3)
        .collect()
}

fn pairing_payload_hint_from_text(value: &str) -> String {
    let lower = value.to_lowercase();

    if lower.contains(".pak") || lower.contains(".ucas") || lower.contains(".utoc") {
        return "pak".to_string();
    }

    if lower.contains(".bk2")
        || lower.contains(".bik")
        || lower.contains(".mp4")
        || lower.contains(".webm")
        || lower.contains("loading screen")
        || lower.contains("login video")
        || lower.contains("splashscreen")
        || lower.contains("startup")
    {
        return "movie".to_string();
    }

    if lower.contains("ue4ss")
        || lower.contains("mods/")
        || lower.contains("mods\\")
        || lower.contains(".lua")
        || lower.contains(".dll")
        || lower.contains(".ini")
        || lower.contains("logic mod loader")
        || lower.contains("moolah")
    {
        return "ue4ss".to_string();
    }

    if lower.contains(".wem") || lower.contains(".bnk") || lower.contains("wwise") {
        return "audio".to_string();
    }

    "unknown".to_string()
}

fn pairing_payload_hint_for_source(source: &SourceModSummary) -> String {
    let mut text = source.name.clone();

    for tag in &source.tags {
        text.push(' ');
        text.push_str(tag);
    }

    if let Some(description) = source.short_description.as_ref() {
        text.push(' ');
        text.push_str(description);
    }

    pairing_payload_hint_from_text(&text)
}

fn pairing_payload_hint_for_candidate(candidate: &InstalledMatchCandidate) -> String {
    pairing_payload_hint_from_text(&candidate.file_name)
}

fn source_alias_texts(source: &SourceModSummary) -> Vec<(String, String)> {
    let mut aliases = vec![("name".to_string(), source.name.clone())];

    let cleanup_pairs = [
        ("Sound Replacement", ""),
        ("sound replacement", ""),
        ("Login Video", ""),
        ("login video", ""),
        ("Movie Replacer", ""),
        ("movie replacer", ""),
        ("Request", ""),
        ("request", ""),
        ("PAYDAY 3", ""),
        ("Payday 3", ""),
        ("PD3", ""),
    ];

    let mut cleaned = source.name.clone();
    for (from, to) in cleanup_pairs {
        cleaned = cleaned.replace(from, to);
    }

    if cleaned.trim().len() > 2 && cleaned.trim() != source.name.trim() {
        aliases.push(("clean-name".to_string(), cleaned));
    }

    for chunk in source.name.split(['[', ']', '(', ')', '-', '–', '|', ':', '/', '\\']) {
        let trimmed = chunk.trim();
        let normalized = normalize_mod_match_text(trimmed);
        let strong = pairing_strong_tokens(&normalized);

        if trimmed.len() > 2 && trimmed.len() < 60 && !strong.is_empty() {
            aliases.push(("name-part".to_string(), trimmed.to_string()));
        }
    }

    for tag in &source.tags {
        let trimmed = tag.trim();
        let normalized = normalize_mod_match_text(trimmed);
        let strong = pairing_strong_tokens(&normalized);

        if trimmed.len() > 2 && trimmed.len() < 140 && !strong.is_empty() {
            aliases.push(("tag-or-file".to_string(), trimmed.to_string()));

            let cleaned_fileish = trimmed
                .replace("_P.pak", "")
                .replace("_p.pak", "")
                .replace(".pak", "")
                .replace(".zip", "")
                .replace(".rar", "")
                .replace(".7z", "")
                .replace('_', " ")
                .replace('-', " ");

            if cleaned_fileish.trim() != trimmed && cleaned_fileish.trim().len() > 2 {
                aliases.push(("file-stem-alias".to_string(), cleaned_fileish));
            }
        }
    }

    if let Some(description) = source.short_description.as_ref() {
        for chunk in description.split(['\n', '\r', ',', ';', '|']) {
            let trimmed = chunk.trim();
            if trimmed.len() > 2 && trimmed.len() < 180 {
                let normalized = normalize_mod_match_text(trimmed);
                let strong = pairing_strong_tokens(&normalized);

                if !strong.is_empty() && (trimmed.contains('.') || strong.len() >= 2) {
                    aliases.push(("description-alias".to_string(), trimmed.to_string()));
                }
            }
        }
    }

    let mut seen = std::collections::BTreeSet::new();
    aliases
        .into_iter()
        .filter_map(|(kind, text)| {
            let normalized = normalize_mod_match_text(&text);

            if normalized.is_empty() || seen.contains(&normalized) {
                return None;
            }

            seen.insert(normalized.clone());
            Some((kind, normalized))
        })
        .collect()
}

fn exact_file_stem_match(source_norm: &str, candidate: &InstalledMatchCandidate) -> bool {
    let source_compact = compact_match_text(source_norm);
    let candidate_compact = candidate.compact_name.clone();

    if candidate_compact.len() < 6 || source_compact.len() < 6 {
        return false;
    }

    source_compact == candidate_compact
        || source_compact.contains(&candidate_compact)
        || candidate_compact.contains(&source_compact)
}

fn match_score_against_normalized_text(
    source_id: &str,
    kind: &str,
    source_norm: &str,
    source_payload: &str,
    candidate: &InstalledMatchCandidate,
) -> (u32, String) {
    if source_norm.is_empty() || candidate.normalized_name.is_empty() {
        return (0, "empty normalized name".to_string());
    }

    let candidate_payload = pairing_payload_hint_for_candidate(candidate);
    let source_strong = pairing_strong_tokens(source_norm);
    let installed_strong = pairing_strong_tokens(&candidate.normalized_name);
    let common_strong: Vec<String> = source_strong
        .iter()
        .filter(|token| installed_strong.contains(token))
        .cloned()
        .collect();

    if source_payload != "unknown" && candidate_payload != "unknown" && source_payload != candidate_payload {
        return (
            0,
            format!(
                "payload mismatch blocked pairing: source looks like {}, installed file looks like {}",
                source_payload, candidate_payload
            ),
        );
    }

    if candidate.normalized_name == source_norm {
        return (100, format!("{} exact normalized filename/title match: '{}'", kind, source_norm));
    }

    if installed_file_name_exactly_in_source_title(source_norm, candidate)
        && !installed_strong.is_empty()
    {
        return (
            94,
            format!(
                "{} installed filename appears as a distinctive title chunk: '{}' ↔ '{}'",
                kind, candidate.normalized_name, source_norm
            ),
        );
    }

    if exact_file_stem_match(source_norm, candidate) && common_strong.len() >= 2 {
        return (
            92,
            format!(
                "{} compact filename/title match with {} strong shared token(s): {}",
                kind,
                common_strong.len(),
                common_strong.join(", ")
            ),
        );
    }

    if common_strong.len() >= 3 {
        return (
            88,
            format!(
                "{} strong-token proof: {} shared distinctive tokens ({})",
                kind,
                common_strong.len(),
                common_strong.join(", ")
            ),
        );
    }

    if common_strong.len() == 2 && exact_file_stem_match(source_norm, candidate) {
        return (
            86,
            format!(
                "{} filename containment plus two strong tokens: {}",
                kind,
                common_strong.join(", ")
            ),
        );
    }

    if common_strong.len() >= 2 {
        let installed_token_count = installed_strong.len().max(1);
        let coverage = (common_strong.len() * 100) / installed_token_count;

        // Creator-prefixed manual files like abkarino_FbiServer_P.pak should still pair
        // to "FBI Server..." when the source title covers most distinctive filename tokens.
        if coverage >= 60 || installed_token_count <= common_strong.len() + 1 {
            return (
                87,
                format!(
                    "{} token-coverage proof: source covers {}/{} installed distinctive token(s): {}",
                    kind,
                    common_strong.len(),
                    installed_token_count,
                    common_strong.join(", ")
                ),
            );
        }
    }

    if common_strong.len() == 2 {
        return (
            64,
            format!(
                "{} possible only: two shared distinctive tokens but no filename proof ({})",
                kind,
                common_strong.join(", ")
            ),
        );
    }

    if common_strong.len() == 1 {
        return (
            35,
            format!(
                "{} weak possible only: one shared distinctive token ({})",
                kind,
                common_strong.join(", ")
            ),
        );
    }

    let source_tokens = pairing_tokens(source_norm);
    let installed_tokens = pairing_tokens(&candidate.normalized_name);
    let weak_common = source_tokens
        .iter()
        .filter(|token| installed_tokens.contains(token) && pairing_weak_token(token))
        .count();

    if weak_common > 0 {
        return (
            8,
            format!(
                "{} blocked: only weak/common words overlap between source {} and installed file",
                kind, source_id
            ),
        );
    }

    (0, "no proof-level overlap".to_string())
}

fn installed_file_name_exactly_in_source_title(source_norm: &str, candidate: &InstalledMatchCandidate) -> bool {
    let source_compact = compact_match_text(source_norm);
    let candidate_compact = candidate.compact_name.clone();

    if candidate_compact.len() < 6 {
        return false;
    }

    source_compact.contains(&candidate_compact)
}

fn match_score(source: &SourceModSummary, candidate: &InstalledMatchCandidate) -> (u32, String) {
    if installed_file_mentions_source_id(source, candidate) {
        return (99, format!("installed filename contains source mod ID {}", source.source_id));
    }

    let source_payload = pairing_payload_hint_for_source(source);
    let mut best_score = 0;
    let mut best_reason = "no proof-level alias matched".to_string();

    for (kind, normalized) in source_alias_texts(source) {
        let (score, reason) = match_score_against_normalized_text(
            &source.source_id,
            &kind,
            &normalized,
            &source_payload,
            candidate,
        );

        if score > best_score {
            best_score = score;
            best_reason = reason;
        }
    }

    (best_score, best_reason)
}
fn matched_files_conflict_key(files: &[String]) -> String {
    let mut clean = files
        .iter()
        .map(|file| file.trim().to_lowercase())
        .filter(|file| !file.is_empty())
        .collect::<Vec<_>>();

    clean.sort();
    clean.dedup();
    clean.join("||")
}

fn unpair_duplicate_claim(
    result: &mut InstalledSourceMatch,
    file_key: &str,
    claimant_count: usize,
    kept: bool,
) {
    result.installed = false;
    result.enabled = false;
    result.update_available = false;
    result.confidence = result.confidence.min(85);
    result.matched_files.clear();
    result.match_kind = "ambiguous-duplicate".to_string();

    if kept {
        result.reason = format!(
            "Not auto-paired: {} source cards tried to claim the same installed file(s), and this one lost the one-to-one tiebreak. Claimed file(s): {}",
            claimant_count,
            file_key
        );
    } else {
        result.reason = format!(
            "Not auto-paired: {} source cards tried to claim the same installed file(s) with no safe winner. Claimed file(s): {}",
            claimant_count,
            file_key
        );
    }
}

fn enforce_one_to_one_pairings(results: &mut [InstalledSourceMatch]) {
    let mut claims: std::collections::BTreeMap<String, Vec<usize>> = std::collections::BTreeMap::new();

    for (index, result) in results.iter().enumerate() {
        if !result.installed || result.match_kind == "receipt" || result.match_kind == "receipt-hash" || result.matched_files.is_empty() {
            continue;
        }

        let key = matched_files_conflict_key(&result.matched_files);

        if !key.is_empty() {
            claims.entry(key).or_default().push(index);
        }
    }

    for (file_key, indexes) in claims {
        if indexes.len() <= 1 {
            continue;
        }

        let mut ranked = indexes.clone();
        ranked.sort_by(|a, b| {
            let left = &results[*a];
            let right = &results[*b];

            let left_kind_bonus = if left.match_kind == "source-id" { 1000 } else { 0 };
            let right_kind_bonus = if right.match_kind == "source-id" { 1000 } else { 0 };

            let left_score = left.confidence + left_kind_bonus;
            let right_score = right.confidence + right_kind_bonus;

            right_score
                .cmp(&left_score)
                .then_with(|| left.source_id.cmp(&right.source_id))
        });

        let winner = ranked[0];
        let winner_score = results[winner].confidence + if results[winner].match_kind == "source-id" { 1000 } else { 0 };
        let second_score = ranked
            .get(1)
            .map(|index| results[*index].confidence + if results[*index].match_kind == "source-id" { 1000 } else { 0 })
            .unwrap_or(0);

        let safe_winner = results[winner].match_kind == "source-id" || winner_score.saturating_sub(second_score) >= 12;

        if safe_winner {
            for index in ranked.into_iter().skip(1) {
                unpair_duplicate_claim(&mut results[index], &file_key, indexes.len(), true);
            }

            results[winner].reason = format!(
                "{}; one-to-one guard kept this source because it beat {} duplicate claim(s) for the same installed file(s)",
                results[winner].reason,
                indexes.len().saturating_sub(1)
            );
        } else {
            for index in ranked {
                unpair_duplicate_claim(&mut results[index], &file_key, indexes.len(), false);
            }
        }
    }
}





fn modworkshop_pairing_diagnostic_file_path() -> Result<PathBuf, String> {
    let root = ensure_app_data_dirs()?;
    let diagnostics = root.join("diagnostics");
    fs::create_dir_all(&diagnostics)
        .map_err(|err| format!("Failed to create diagnostics folder: {}", err))?;

    Ok(diagnostics.join("modworkshop-pairing-last.json"))
}

fn write_modworkshop_pairing_diagnostics(items: &[ModWorkshopPairingDiagnostic]) {
    if let Ok(path) = modworkshop_pairing_diagnostic_file_path() {
        let payload = serde_json::json!({
            "timeUnix": now_unix_seconds(),
            "items": items,
        });

        if let Ok(text) = serde_json::to_string_pretty(&payload) {
            let _ = fs::write(path, text);
        }
    }
}

fn read_modworkshop_pairing_diagnostics() -> Option<serde_json::Value> {
    let path = modworkshop_pairing_diagnostic_file_path().ok()?;
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModWorkshopPairingDiagnostic {
    installed_file: String,
    normalized_file_name: String,
    compact_stem: String,
    best_candidate: Option<String>,
    best_mod_id: Option<String>,
    best_score: u32,
    status: String,
    reason: String,
    action: String,
    file_names_checked: Vec<String>,
}

fn diagnose_modworkshop_pairing_internal() -> Result<Vec<ModWorkshopPairingDiagnostic>, String> {
    let installed_candidates = build_installed_match_candidates()?;
    let source_index = read_source_index_database();
    let mut modworkshop_sources = source_index
        .records
        .into_values()
        .filter(|record| record.source.eq_ignore_ascii_case("modworkshop"))
        .map(|record| record.summary)
        .collect::<Vec<_>>();

    modworkshop_sources.sort_by(|a, b| a.source_id.cmp(&b.source_id));
    modworkshop_sources.dedup_by(|a, b| a.source_id == b.source_id);

    let matches = match_installed_source_mods(modworkshop_sources.clone(), None)?;
    let mut paired_files = std::collections::BTreeSet::new();

    for matched in matches.iter().filter(|item| item.installed) {
        for file in &matched.matched_files {
            paired_files.insert(enabled_name_from_disabled(file).to_lowercase());
        }
    }

    let mut diagnostics = Vec::new();

    for candidate in installed_candidates {
        let candidate_files = candidate
            .file_name
            .split(", ")
            .map(|value| enabled_name_from_disabled(value.trim()).to_lowercase())
            .collect::<Vec<_>>();

        if candidate_files.iter().any(|file| paired_files.contains(file)) {
            continue;
        }

        let mut best_score = 0u32;
        let mut best_reason = "no_source_card_found".to_string();
        let mut best_candidate: Option<SourceModSummary> = None;
        let mut best_files_checked = Vec::new();
        let mut wrong_game_rejected = false;
        let mut wrong_game_reason = String::new();

        for source in &modworkshop_sources {
            if !source_summary_is_payday3_safe(source) {
                let (score, reason) = match_score(source, &candidate);
                if score > best_score {
                    wrong_game_rejected = true;
                    wrong_game_reason = format!("wrong_game_rejected: {}", source.name);
                    best_score = 0;
                    best_candidate = Some(source.clone());
                    best_reason = reason;
                }
                continue;
            }

            let (score, reason) = match_score(source, &candidate);
            if score > best_score {
                best_score = score;
                best_reason = reason;
                best_candidate = Some(source.clone());
                best_files_checked = source
                    .tags
                    .iter()
                    .filter(|tag| tag.to_lowercase().contains(".pak")
                        || tag.to_lowercase().contains(".zip")
                        || tag.to_lowercase().contains(".rar")
                        || tag.to_lowercase().contains(".7z"))
                    .take(12)
                    .cloned()
                    .collect::<Vec<_>>();
            }
        }

        let has_file_proof = best_candidate
            .as_ref()
            .map(modworkshop_source_has_file_proof)
            .unwrap_or(false);
        let has_exact_stem_proof = best_score >= 94
            && modworkshop_candidate_is_installed_pak(&candidate)
            && modworkshop_reason_is_exact_stem_proof(&best_reason);

        let (status, reason, action) = if wrong_game_rejected {
            (
                "rejected".to_string(),
                if wrong_game_reason.is_empty() { "wrong_game_rejected".to_string() } else { wrong_game_reason },
                "not paired".to_string(),
            )
        } else if best_candidate.is_none() {
            (
                "unpaired".to_string(),
                "no_source_card_found".to_string(),
                "open Browse/ModWorkshop and search this filename".to_string(),
            )
        } else if best_score >= 90 && (has_file_proof || has_exact_stem_proof) {
            (
                "paired_candidate".to_string(),
                if has_exact_stem_proof { "exact_pak_stem_match".to_string() } else { "exact_file_name_or_stem_match".to_string() },
                "safe to auto-pair on next re-pair".to_string(),
            )
        } else if best_score >= 60 {
            (
                "manual_candidate".to_string(),
                "weak_title_only_match_rejected".to_string(),
                "manual review required; no source file proof".to_string(),
            )
        } else {
            (
                "unpaired".to_string(),
                if best_score == 0 { "missing_receipt_or_pair_proof".to_string() } else { "filename_too_generic_or_weak".to_string() },
                "leave unpaired or search manually".to_string(),
            )
        };

        diagnostics.push(ModWorkshopPairingDiagnostic {
            installed_file: candidate.file_name.clone(),
            normalized_file_name: candidate.normalized_name.clone(),
            compact_stem: candidate.compact_name.clone(),
            best_candidate: best_candidate.as_ref().map(|source| source.name.clone()),
            best_mod_id: best_candidate.as_ref().map(|source| source.source_id.clone()),
            best_score,
            status,
            reason,
            action,
            file_names_checked: best_files_checked,
        });
    }

    diagnostics.sort_by(|a, b| b.best_score.cmp(&a.best_score).then(a.installed_file.cmp(&b.installed_file)));
    Ok(diagnostics)
}

fn format_modworkshop_pairing_diagnostics_for_report() -> String {
    let Some(value) = read_modworkshop_pairing_diagnostics() else {
        return "ModWorkshop Pairing Diagnostics: not run yet. Use Installed -> Diagnose MW.\n".to_string();
    };

    let time_unix = json_u64(&value, &["timeUnix"]).unwrap_or(0);
    let items = value
        .get("items")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();

    let mut lines = Vec::new();
    lines.push(format!("ModWorkshop Pairing Diagnostics: last run at {}", time_unix));

    if items.is_empty() {
        lines.push("  All visible ModWorkshop candidates are paired or no unpaired .pak candidates were found.".to_string());
    } else {
        for item in items.iter().take(12) {
            let installed_file = json_string(item, &["installedFile"]).unwrap_or_else(|| "unknown".to_string());
            let status = json_string(item, &["status"]).unwrap_or_else(|| "unknown".to_string());
            let score = json_u64(item, &["bestScore"]).unwrap_or(0);
            let reason = json_string(item, &["reason"]).unwrap_or_else(|| "unknown".to_string());
            let candidate = json_string(item, &["bestCandidate"]).unwrap_or_else(|| "none".to_string());
            let mod_id = json_string(item, &["bestModId"]).unwrap_or_else(|| "none".to_string());
            let action = json_string(item, &["action"]).unwrap_or_else(|| "none".to_string());

            lines.push(format!(
                "  - {} | status={} score={} reason={} candidate={} modId={} action={}",
                installed_file,
                status,
                score,
                reason,
                candidate,
                mod_id,
                action,
            ));
        }

        if items.len() > 12 {
            lines.push(format!("  ... {} more unpaired diagnostic item(s)", items.len() - 12));
        }
    }

    lines.push(String::new());
    lines.join("\n")
}

#[tauri::command]
fn diagnose_modworkshop_pairing() -> Result<String, String> {
    let items = diagnose_modworkshop_pairing_internal()?;
    write_modworkshop_pairing_diagnostics(&items);
    let mut lines = Vec::new();

    lines.push("ModWorkshop Pairing Diagnostics".to_string());

    if items.is_empty() {
        lines.push("All visible ModWorkshop candidates are paired or no unpaired .pak candidates were found.".to_string());
    } else {
        for item in items.iter().take(30) {
            lines.push(format!(
                "{}\n  status: {}\n  score: {}\n  reason: {}\n  candidate: {}\n  modId: {}\n  action: {}\n  files checked: {}",
                item.installed_file,
                item.status,
                item.best_score,
                item.reason,
                item.best_candidate.as_deref().unwrap_or("none"),
                item.best_mod_id.as_deref().unwrap_or("none"),
                item.action,
                if item.file_names_checked.is_empty() { "none".to_string() } else { item.file_names_checked.join(", ") },
            ));
        }

        if items.len() > 30 {
            lines.push(format!("... {} more item(s). Debug Report shows the first 12.", items.len() - 30));
        }
    }

    Ok(lines.join("\n"))
}

#[tauri::command]
fn remove_raid_ww2_bad_install() -> Result<String, String> {
    let receipts = list_install_receipts_internal().unwrap_or_default();

    if let Some(receipt) = receipts.into_iter().find(|receipt| {
        receipt.source.eq_ignore_ascii_case("modworkshop")
            && (
                receipt.source_mod_id.as_deref() == Some("45334")
                || receipt.display_name.to_lowercase().contains("raid: world war ii")
                || receipt.display_name.to_lowercase().contains("raid_ world war ii")
                || receipt.display_name.to_lowercase().contains("no camera limits")
            )
    }) {
        return uninstall_receipt_internal(&receipt);
    }

    let paths = detect_payday3_paths_internal()
        .ok_or_else(|| "PAYDAY 3 was not detected. Set the game path in Settings first.".to_string())?;

    let keep_uninstalled = keep_uninstalled_mods_enabled();
    let holding_root = uninstalled_dir()?.join(format!("uninstall_bad_raid_ww2_{}", current_timestamp()));
    if keep_uninstalled {
        fs::create_dir_all(&holding_root)
            .map_err(|err| format!("Failed to create uninstall holding folder: {}", err))?;
    }

    let mut moved = Vec::new();
    for file_name in ["mod.lua", "mod.xml"] {
        let path = paths.win64.join(file_name);
        if let Some(moved_path) = move_path_to_uninstalled(&path, &holding_root)? {
            moved.push(moved_path);
        }
    }

    let _ = sync_installed_state_database();

    if moved.is_empty() {
        Err("No RAID WW2 receipt was found and mod.lua/mod.xml were not present in Win64.".to_string())
    } else {
        Ok(format!(
            "Removed suspected RAID WW2 loose files. {} {} file(s){}.",
            if keep_uninstalled { "Moved" } else { "Deleted" },
            moved.len(),
            if keep_uninstalled { format!(" to {}", holding_root.display()) } else { String::new() }
        ))
    }
}

#[tauri::command]
fn match_installed_source_mods(source_mods: Vec<SourceModSummary>, profile_id: Option<String>) -> Result<Vec<InstalledSourceMatch>, String> {
    if !is_builtin_payday3_profile(profile_id.as_deref()) {
        return source_catalog::match_profile_sources(&source_mods, profile_id.as_deref().unwrap_or(BUILTIN_PAYDAY3_PROFILE_ID));
    }

    let indexed_hash_matches = source_catalog::match_profile_sources(&source_mods, BUILTIN_PAYDAY3_PROFILE_ID)?;
    let installed_candidates = build_installed_match_candidates()?;
    let _ = prune_stale_receipts_internal();
    let receipts = list_install_receipts_internal().unwrap_or_default();
    let detected_paths = detect_payday3_paths_internal();
    let mut results = Vec::new();

    for source_mod in source_mods {
        if !source_summary_is_payday3_safe(&source_mod) {
            results.push(InstalledSourceMatch {
                source: source_mod.source.clone(),
                source_id: source_mod.source_id.clone(),
                installed: false,
                enabled: false,
                update_available: false,
                confidence: 0,
                reason: "Rejected source card because it appears to be for another game, not PAYDAY 3.".to_string(),
                matched_files: Vec::new(),
                source_file_id: None,
                source_file_name: None,
                source_file_category: None,
                source_file_uploaded_at: None,
                source_file_version: None,
                installed_modified_unix: None,
                source_updated_at: source_mod.updated_at.clone(),
                source_updated_unix: parse_source_timestamp_to_unix(source_mod.updated_at.as_deref()),
                match_kind: "wrong-game".to_string(),
            });
            continue;
        }

        let mut best_score = 0;
        let mut best_reason = "No proof-level installed file match.".to_string();
        let mut best_files: Vec<String> = Vec::new();
        let mut best_modified: Option<u64> = None;
        let mut best_enabled = true;
        let mut best_receipt_live = true;
        let mut best_source_file_id: Option<String> = None;
        let mut best_source_file_name: Option<String> = None;
        let mut best_source_file_category: Option<String> = None;
        let mut best_source_file_uploaded_at: Option<String> = None;
        let mut best_source_file_version: Option<String> = None;
        let mut match_kind = "unpaired".to_string();

        for receipt in &receipts {
            let exact_source = receipt.source.eq_ignore_ascii_case(&source_mod.source);
            let exact_id = receipt
                .source_mod_id
                .as_ref()
                .map(|id| id == &source_mod.source_id)
                .unwrap_or(false);

            if exact_source && exact_id {
                best_score = 100;
                best_reason = "exact live install receipt source/id match".to_string();
                best_files = receipt.files.iter().map(|file| file.relative_path.clone()).collect();
                best_modified = receipt.installed_at_unix;
                best_source_file_id = receipt.source_file_id.clone();
                best_source_file_name = receipt.source_file_name.clone();
                best_source_file_category = receipt.source_file_category.clone();
                best_source_file_uploaded_at = receipt.source_file_uploaded_at.clone();
                best_source_file_version = receipt.source_file_version.clone().or(receipt.version.clone());
                best_enabled = detected_paths
                    .as_ref()
                    .map(|paths| receipt_enabled_internal(paths, receipt))
                    .unwrap_or(true);
                best_receipt_live = detected_paths
                    .as_ref()
                    .map(|paths| receipt_has_live_files_internal(paths, receipt))
                    .unwrap_or(true);
                match_kind = "receipt".to_string();

                if !best_receipt_live {
                    let receipt_hashes = receipt
                        .files
                        .iter()
                        .filter_map(|file| file.sha256.as_ref())
                        .map(|hash| hash.to_lowercase())
                        .collect::<Vec<_>>();

                    if !receipt_hashes.is_empty() {
                        for candidate in &installed_candidates {
                            if let Some(candidate_hash) = candidate.sha256.as_ref() {
                                if receipt_hashes.iter().any(|hash| hash == &candidate_hash.to_lowercase()) {
                                    best_receipt_live = true;
                                    best_files = candidate
                                        .file_name
                                        .split(", ")
                                        .map(|value| value.trim().to_string())
                                        .filter(|value| !value.is_empty())
                                        .collect();
                                    best_modified = candidate.modified_unix;
                                    best_reason = "exact source/id receipt recovered by SHA-256 hash match to installed file".to_string();
                                    match_kind = "receipt-hash".to_string();
                                    break;
                                }
                            }
                        }
                    }
                }

                break;
            }
        }

        if best_score < 100 {
            let mut hits: Vec<(u32, String, InstalledMatchCandidate)> = Vec::new();

            for candidate in &installed_candidates {
                let (score, reason) = match_score(&source_mod, candidate);

                if score >= 35 {
                    hits.push((score, reason, candidate.clone()));
                }
            }

            hits.sort_by(|a, b| b.0.cmp(&a.0));

            if let Some((top_score, top_reason, top_candidate)) = hits.first() {
                let second_score = hits.get(1).map(|value| value.0).unwrap_or(0);
                let margin = top_score.saturating_sub(second_score);

                best_score = *top_score;
                best_reason = if second_score > 0 {
                    format!("{}; second-best score {}, margin {}", top_reason, second_score, margin)
                } else {
                    top_reason.clone()
                };
                best_modified = top_candidate.modified_unix;

                let has_mw_file_proof = !source_mod.source.eq_ignore_ascii_case("modworkshop")
                    || modworkshop_source_has_file_proof(&source_mod)
                    || top_reason.contains("tag-or-file")
                    || top_reason.contains("file-stem-alias")
                    || top_reason.contains("description-alias");

                let has_mw_exact_stem_proof = source_mod.source.eq_ignore_ascii_case("modworkshop")
                    && modworkshop_candidate_is_installed_pak(top_candidate)
                    && *top_score >= 94
                    && modworkshop_reason_is_exact_stem_proof(top_reason);

                let proof_accept = if source_mod.source.eq_ignore_ascii_case("modworkshop") {
                    // v1.0.7.1: exact installed PAK title/stem matches are proof enough.
                    // Title-only fuzzy/token matches still stay manual.
                    (*top_score >= 90 && has_mw_file_proof) || has_mw_exact_stem_proof
                } else {
                    *top_score >= 92
                        || (*top_score >= 86 && margin >= 14)
                        || (*top_score >= 88 && second_score < 78)
                };

                if proof_accept {
                    let mut paired_file_names = std::collections::BTreeSet::<String>::new();

                    for value in top_candidate.file_name.split(", ") {
                        let trimmed = value.trim();
                        if !trimmed.is_empty() {
                            paired_file_names.insert(trimmed.to_string());
                        }
                    }

                    // v1.0.7.4: Some ModWorkshop mods install multiple pak files.
                    // If multiple installed files prove against the same source card, keep
                    // them grouped under that one source instead of pairing only the first hit.
                    if source_mod.source.eq_ignore_ascii_case("modworkshop") {
                        for (score, reason, candidate) in hits.iter().skip(1) {
                            let candidate_has_file_proof = modworkshop_source_has_file_proof(&source_mod)
                                || reason.contains("tag-or-file")
                                || reason.contains("file-stem-alias")
                                || reason.contains("description-alias");

                            let candidate_has_exact_stem_proof = modworkshop_candidate_is_installed_pak(candidate)
                                && *score >= 87
                                && (
                                    modworkshop_reason_is_exact_stem_proof(reason)
                                    || reason.contains("token-coverage proof")
                                    || reason.contains("strong-token proof")
                                );

                            let candidate_accept = (*score >= 90 && candidate_has_file_proof)
                                || candidate_has_exact_stem_proof;

                            if candidate_accept {
                                for value in candidate.file_name.split(", ") {
                                    let trimmed = value.trim();
                                    if !trimmed.is_empty() {
                                        paired_file_names.insert(trimmed.to_string());
                                    }
                                }

                                if candidate.modified_unix > best_modified {
                                    best_modified = candidate.modified_unix;
                                }
                            }
                        }
                    }

                    best_files = paired_file_names.into_iter().collect();

                    if best_files.len() > 1 {
                        best_reason = format!("{}; grouped {} installed file(s) for this source mod", best_reason, best_files.len());
                    }

                    match_kind = if top_reason.contains("source mod ID") {
                        "source-id".to_string()
                    } else {
                        "proof-filename".to_string()
                    };
                } else {
                    match_kind = "suggestion".to_string();
                    best_files = Vec::new();
                    if source_mod.source.eq_ignore_ascii_case("modworkshop") && !has_mw_file_proof && !has_mw_exact_stem_proof {
                        best_reason = format!("Not auto-paired: title/token match only. ModWorkshop source card has no source file proof: {}", best_reason);
                    } else {
                        best_reason = format!("Not auto-paired: {}", best_reason);
                    }
                }
            }
        }

        if best_score < 100 {
            if let Some(proof) = indexed_hash_matches.iter().find(|proof| proof.installed && proof.source == source_mod.source && proof.source_id == source_mod.source_id) {
                best_score = 100;
                best_reason = proof.reason.clone();
                best_files = proof.matched_files.clone();
                best_source_file_id = proof.source_file_id.clone();
                best_source_file_name = proof.source_file_name.clone();
                best_source_file_version = proof.source_file_version.clone();
                best_enabled = proof.enabled;
                match_kind = "sha256".to_string();
            }
        }
        let installed = if match_kind == "receipt" || match_kind == "receipt-hash" {
            best_receipt_live
        } else {
            matches!(match_kind.as_str(), "source-id" | "proof-filename" | "sha256")
        };

        let source_update_unix = source_updated_unix(&source_mod);

        let update_available = installed
            && source_update_unix.is_some()
            && best_modified.is_some()
            && source_update_unix.unwrap_or(0) > best_modified.unwrap_or(0).saturating_add(86_400);

        results.push(InstalledSourceMatch {
            source: source_mod.source.clone(),
            source_id: source_mod.source_id.clone(),
            installed,
            enabled: best_enabled,
            update_available,
            confidence: if installed { best_score.max(86) } else { best_score.min(85) },
            reason: best_reason,
            matched_files: if installed { best_files } else { Vec::new() },
            source_file_id: if installed { best_source_file_id } else { None },
            source_file_name: if installed { best_source_file_name } else { None },
            source_file_category: if installed { best_source_file_category } else { None },
            source_file_uploaded_at: if installed { best_source_file_uploaded_at } else { None },
            source_file_version: if installed { best_source_file_version } else { None },
            installed_modified_unix: best_modified,
            source_updated_at: source_mod.updated_at.clone(),
            source_updated_unix: source_update_unix,
            match_kind,
        });
    }

    enforce_one_to_one_pairings(&mut results);

    Ok(results)
}


#[tauri::command]
async fn fetch_modworkshop_categories(game_id: String, profile_id: Option<String>, profile_name: Option<String>) -> Result<Vec<SourceCategory>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let game_id = normalize_modworkshop_game_route(&game_id)?;
        let url = format!("https://api.modworkshop.net/games/{}/categories", game_id);
        let value = http_get_json_fast(&url, 10)
            .map_err(|error| format!(
                "ModWorkshop category request failed. Profile ID: {}. Profile name: {}. ModWorkshop game ID: {}. Request URL: {}. Cache available: unknown to backend. Cache used: false. Error: {}",
                profile_id.as_deref().unwrap_or("unknown"),
                profile_name.as_deref().unwrap_or("unknown"),
                game_id,
                url,
                error,
            ))?;
        let categories = parse_modworkshop_categories(value);
        if categories.is_empty() {
            return Err(format!(
                "ModWorkshop categories genuinely unavailable. Profile ID: {}. Profile name: {}. ModWorkshop game ID: {}. Request URL: {}. HTTP status: 200. Parsed zero usable categories.",
                profile_id.as_deref().unwrap_or("unknown"),
                profile_name.as_deref().unwrap_or("unknown"),
                game_id,
                url,
            ));
        }
        Ok(categories)
    })
    .await
    .map_err(|err| format!("ModWorkshop category task failed: {:?}", err))?
}

#[tauri::command]
async fn fetch_modworkshop_browse_live_page(
    page: u32,
    sort: Option<String>,
    query: Option<String>,
    category_id: Option<String>,
    game_id: Option<String>,
    profile_id: Option<String>,
) -> Result<Vec<SourceModSummary>, String> {
    let requested_game_id = game_id
        .or_else(|| {
            if is_builtin_payday3_profile(profile_id.as_deref()) {
                Some(MODWORKSHOP_PAYDAY3_GAME_ID.to_string())
            } else {
                None
            }
        })
        .ok_or_else(|| {
            format!(
                "ModWorkshop browse needs a profile ModWorkshop game ID. Profile ID: {}.",
                profile_id.as_deref().unwrap_or("unknown")
            )
        })?;

    tauri::async_runtime::spawn_blocking(move || {
        let sort_mode = sort.unwrap_or_else(|| "recent".to_string());
        let version = modworkshop_profile_game_version(profile_id.as_deref(), &requested_game_id);
        let mods = fetch_modworkshop_mods_page_for_version(&requested_game_id, page, &sort_mode, query.as_deref(), category_id.as_deref(), version.as_deref())?;

        upsert_source_index_summaries(&mods);
        Ok(mods)
    })
    .await
    .map_err(|err| format!("ModWorkshop direct live task failed: {:?}", err))?
}

#[tauri::command]
async fn diagnose_modworkshop_browse_live(profile_id: Option<String>) -> Result<String, String> {
    if !is_builtin_payday3_profile(profile_id.as_deref()) {
        return Ok("ModWorkshop PAYDAY 3 diagnostics are disabled for this profile. Configure a profile-specific ModWorkshop game mapping before probing live routes.".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let url = "https://modworkshop.net/g/payday-3?page=1";
        let mut lines = Vec::new();

        match http_get_text_fast(url, 14) {
            Ok(html) => {
                let ids = extract_modworkshop_ids_from_html(&html);
                let cards = parse_modworkshop_public_page_cards(&html, 12);
                lines.push(format!("Public page OK: {} bytes, {} mod link id(s), {} parsed card(s).", html.len(), ids.len(), cards.len()));
                lines.push(format!("URL: {}", url));
                if !cards.is_empty() {
                    lines.push(format!(
                        "First cards: {}",
                        cards
                            .iter()
                            .take(5)
                            .map(|card| format!("{} ({})", card.name, card.source_id))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ));
                }
            }
            Err(error) => {
                lines.push(format!("Public page failed: {}", error));
            }
        }

        let api_url = "https://api.modworkshop.net/mods?game=payday-3&page=1&sort=updated";
        match http_get_json_fast(api_url, 4) {
            Ok(value) => {
                let api_cards = parse_modworkshop_list(value);
                lines.push(format!("API probe OK: {} parsed card(s).", api_cards.len()));
            }
            Err(error) => lines.push(format!("API probe failed: {}", error)),
        }

        Ok(lines.join("\\n"))
    })
    .await
    .map_err(|err| format!("ModWorkshop live diagnostic task failed: {:?}", err))?
}

#[tauri::command]
async fn fetch_source_mods_page(
    source: String,
    page: u32,
    sort: Option<String>,
    profile_id: Option<String>,
    source_id: Option<String>,
) -> Result<Vec<SourceModSummary>, String> {
    let source_config = source_config_for_profile_source(profile_id.as_deref(), source_id.as_deref());
    let diagnostic_config = source_config.clone();
    let diagnostic_source = source.clone();
    let diagnostic_profile_id = profile_id.clone().unwrap_or_else(|| "unknown".to_string());
    let diagnostic_source_id = source_id.clone().unwrap_or_else(|| source.clone());
    let result = tauri::async_runtime::spawn_blocking(move || fetch_source_mods_page_sync(source, page, sort, source_config))
        .await
        .map_err(|err| format!("Source loader task failed: {:?}", err))?;
    if let Err(error) = &result {
        if diagnostic_source.eq_ignore_ascii_case("nexus") {
            let domain = nexus_domain_from_source_config(&diagnostic_config).unwrap_or_else(|| "missing".to_string());
            let game_id = config_string(&diagnostic_config, "nexusGameId").unwrap_or_else(|| "missing".to_string());
            let profile_name = config_string(&diagnostic_config, "nexusGameName").unwrap_or_else(|| "unknown".to_string());
            let api_key_present = load_settings_internal().nexus_api_key.as_deref().map(str::trim).map(|value| !value.is_empty()).unwrap_or(false);
            let http_status = error
                .split("HTTP ")
                .nth(1)
                .and_then(|value| value.split_whitespace().next())
                .unwrap_or("unavailable");
            let route = error
                .split_whitespace()
                .find(|value| value.starts_with("https://"))
                .map(|value| value.trim_end_matches(':'))
                .unwrap_or("profile-specific Nexus metadata/listing route");
            eprintln!(
                "Nexus request failed | profile_id={} | profile_name={} | source_id={} | domain={} | numeric_game_id={} | route={} | http_status={} | api_key_present={} | live_data=false | cache_fallback=exact-profile-source-domain-game-id-only | cache_reason=live_request_failed | response_body_preview={}",
                diagnostic_profile_id,
                profile_name,
                diagnostic_source_id,
                domain,
                game_id,
                route,
                http_status,
                api_key_present,
                error.chars().take(500).collect::<String>(),
            );
        }
    }
    result
}

#[tauri::command]
async fn fetch_nexus_browse_page(
    page: u32,
    sort: Option<String>,
    profile_id: Option<String>,
    source_id: Option<String>,
) -> Result<NexusBrowsePage, String> {
    let config = source_config_for_profile_source(profile_id.as_deref(), source_id.as_deref());
    tauri::async_runtime::spawn_blocking(move || {
        let domain = nexus_domain_from_source_config(&config)
            .ok_or_else(|| "This profile has no Nexus game domain.".to_string())?;
        validate_nexus_source_mapping(&domain, config_string(&config, "nexusGameId").as_deref())?;
        let settings = load_settings_internal();
        let api_key = settings.nexus_api_key.as_deref().map(str::trim).filter(|key| !key.is_empty())
            .ok_or_else(|| "Missing Nexus API key. Add it in Settings first.".to_string())?;
        fetch_nexus_graphql_browse_page(&domain, sort.as_deref().unwrap_or("updated"), api_key, page.max(1), 20)
    }).await.map_err(|error| format!("Nexus browse task failed: {}", error))?
}

fn fetch_source_mods_page_sync(
    source: String,
    page: u32,
    sort: Option<String>,
    source_config: serde_json::Value,
) -> Result<Vec<SourceModSummary>, String> {
    let sort_mode = sort.unwrap_or_else(|| "recent".to_string());

    let result = match source.as_str() {
        "nexus" => {
            let domain = nexus_domain_from_source_config(&source_config)
                .ok_or_else(|| "Nexus Browse needs a Nexus domain or full game page URL in this profile.".to_string())?;
            validate_nexus_source_mapping(&domain, config_string(&source_config, "nexusGameId").as_deref())?;
            fetch_nexus_mods_page_for_domain(&domain, page, &sort_mode)
        }
        "modworkshop" => {
            let game_route = modworkshop_game_route_from_source_config(&source_config)
                .ok_or_else(|| "ModWorkshop Browse needs a slug, numeric game ID, or full game page URL in this profile.".to_string())?;
            fetch_modworkshop_mods_page_for_version(&game_route, page, &sort_mode, None, None, config_string(&source_config, "gameVersion").as_deref())
        }
        other => Err(format!("Unknown source: {}", other)),
    };

    match result {
        Ok(mods) if !mods.is_empty() => {
            upsert_source_index_summaries(&mods);
            Ok(mods)
        }
        Ok(_) => Ok(Vec::new()),
        Err(error) => {
            Err(error)
        }
    }
}


fn is_clean_nexus_summary_for_browser(summary: &SourceModSummary) -> bool {
    let name = summary.name.trim();

    !name.is_empty()
        && name != "unknown"
        && !name.starts_with("Nexus Mod ")
        && !name.starts_with("Nexus Mod unknown")
        && summary.source_id != "unknown"
}

fn source_summary_is_external_mod_manager(summary: &SourceModSummary) -> bool {
    let text = format!(
        "{} {} {} {} {}",
        summary.name,
        summary.short_description.as_deref().unwrap_or(""),
        summary.page_url.as_deref().unwrap_or(""),
        summary.tags.join(" "),
        summary.author.as_deref().unwrap_or("")
    )
    .to_lowercase();

    let markers = [
        "tsuki mod manager",
        "tsukimodmanager",
        "modrex mod manager",
        "moolah mod manager",
        "mod organizer",
        "vortex",
        "external mod manager",
        "mod manager",
        "modmanager",
        "manager setup",
    ];

    markers.iter().any(|marker| text.contains(marker))
}

fn source_summary_is_payday3_safe(summary: &SourceModSummary) -> bool {
    if source_summary_is_external_mod_manager(summary) {
        return false;
    }
    let text = format!(
        "{} {} {} {} {}",
        summary.name,
        summary.short_description.as_deref().unwrap_or(""),
        summary.page_url.as_deref().unwrap_or(""),
        summary.tags.join(" "),
        summary.game_id.as_deref().unwrap_or("")
    )
    .to_lowercase();

    let foreign_markers = [
        "raid: world war ii",
        "raid world war ii",
        "raid ww2",
        "world war ii mods",
        "payday 2",
        "pd2 mods",
        "ready or not",
        "left 4 dead",
        "blade & sorcery",
    ];

    if foreign_markers.iter().any(|marker| text.contains(marker)) {
        return false;
    }

    if summary.source.eq_ignore_ascii_case("nexus") {
        return summary
            .page_url
            .as_deref()
            .map(|url| url.to_lowercase().contains("/payday3/"))
            .unwrap_or(true);
    }

    if summary.source.eq_ignore_ascii_case("modworkshop") {
        if let Some(game_id) = summary.game_id.as_deref() {
            if !is_modworkshop_payday3_game_id(game_id) {
                return false;
            }

            return true;
        }

        // Soft allow only when metadata clearly says PAYDAY 3. This prevents
        // ModWorkshop search leaks from other games from ever entering scoring.
        return text.contains("payday 3")
            || text.contains("payday3")
            || text.contains("pd3")
            || text.contains("/g/payday-3/")
            || summary.tags.iter().any(|tag| tag.eq_ignore_ascii_case("PAYDAY 3"));
    }

    true
}

fn classify_nexus_live_error(error: String) -> String {
    let lower = error.to_ascii_lowercase();
    let cause = if lower.contains("http 401") || lower.contains("unauthorized") {
        "Unauthorized Nexus API key"
    } else if lower.contains("http 429") || lower.contains("rate limit") {
        "Nexus API rate limited"
    } else if lower.contains("http 404") || lower.contains("game not found") {
        "Nexus game not found"
    } else if lower.contains("timed out") || lower.contains("dns") || lower.contains("connect") || lower.contains("network") {
        "Nexus network error"
    } else {
        "Nexus API request failed"
    };
    format!("{}: {}", cause, error)
}

fn validate_nexus_source_mapping(game_domain: &str, expected_game_id: Option<&str>) -> Result<(), String> {
    let domain = clean_source_slug(game_domain).ok_or_else(|| format!("Invalid Nexus game domain: {}", game_domain))?;
    let settings = load_settings_internal();
    let api_key = settings
        .nexus_api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Missing Nexus API key. Paste it in Settings first.".to_string())?;
    let route = format!("https://api.nexusmods.com/v1/games/{}.json", domain);
    let metadata = http_get_json(&route, Some(api_key)).map_err(classify_nexus_live_error)?;
    if let Some(expected) = expected_game_id.map(str::trim).filter(|value| !value.is_empty()) {
        if !source_id_is_numeric(expected) {
            return Err(format!("Invalid numeric Nexus game ID: {}", expected));
        }
        let actual = json_id_string(&metadata, &["id"]).ok_or_else(|| format!("Nexus game metadata for {} did not include a numeric ID. Route: {}", domain, route))?;
        if actual != expected {
            return Err(format!("Nexus numeric game ID mismatch for domain {}: configured {}, API returned {}. Route: {}", domain, expected, actual, route));
        }
    }
    Ok(())
}

fn source_summary_matches_nexus_domain(summary: &SourceModSummary, game_domain: &str) -> bool {
    if source_summary_is_external_mod_manager(summary) {
        return false;
    }
    let domain = clean_source_slug(game_domain).unwrap_or_else(|| "payday3".to_string());
    if domain == "payday3" {
        return source_summary_is_payday3_safe(summary);
    }
    if !summary.source.eq_ignore_ascii_case("nexus") {
        return true;
    }
    let page_matches = summary
        .page_url
        .as_deref()
        .map(|url| url.to_ascii_lowercase().contains(&format!("/{}/mods/", domain)))
        .unwrap_or(false);
    let game_matches = summary
        .game_id
        .as_deref()
        .map(|value| value.eq_ignore_ascii_case(&domain))
        .unwrap_or(false);
    page_matches || game_matches
}

fn source_date_score(summary: &SourceModSummary) -> i64 {
    summary
        .updated_at
        .as_ref()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0)
}

fn nexus_sort_browser_summaries(mut summaries: Vec<SourceModSummary>, sort: &str) -> Vec<SourceModSummary> {
    match canonical_nexus_sort(sort) {
        "added" => summaries.sort_by(|a, b| {
            b.source_id
                .parse::<u64>()
                .unwrap_or(0)
                .cmp(&a.source_id.parse::<u64>().unwrap_or(0))
                .then(source_date_score(b).cmp(&source_date_score(a)))
        }),
        "downloads" => summaries.sort_by(|a, b| b.downloads.unwrap_or(0).cmp(&a.downloads.unwrap_or(0))),
        "liked" => summaries.sort_by(|a, b| b.likes.unwrap_or(0).cmp(&a.likes.unwrap_or(0))),
        "name" => summaries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase())),
        _ => summaries.sort_by(|a, b| source_date_score(b).cmp(&source_date_score(a))),
    }

    summaries
}


fn modworkshop_sort_browser_summaries(mut summaries: Vec<SourceModSummary>, sort: &str) -> Vec<SourceModSummary> {
    match sort {
        "downloads" | "popular" => summaries.sort_by(|a, b| b.downloads.unwrap_or(0).cmp(&a.downloads.unwrap_or(0)).then(source_date_score(b).cmp(&source_date_score(a)))),
        "liked" => summaries.sort_by(|a, b| b.likes.unwrap_or(0).cmp(&a.likes.unwrap_or(0)).then(source_date_score(b).cmp(&source_date_score(a)))),
        "added" => summaries.sort_by(|a, b| b.source_id.parse::<u64>().unwrap_or(0).cmp(&a.source_id.parse::<u64>().unwrap_or(0))),
        "name" => summaries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase())),
        _ => summaries.sort_by(|a, b| source_date_score(b).cmp(&source_date_score(a))),
    }

    summaries
}

fn dedupe_modworkshop_summaries_preserve_order(summaries: Vec<SourceModSummary>) -> Vec<SourceModSummary> {
    let mut seen = std::collections::BTreeSet::<String>::new();
    let mut deduped = Vec::<SourceModSummary>::new();

    for summary in summaries {
        let key = summary.source_id.clone();
        if seen.insert(key) {
            deduped.push(summary);
        }
    }

    deduped
}

fn nexus_file_names_for_mod(mod_id: &str, api_key: &str) -> Vec<String> {
    let Ok(files_value) = http_get_json(
        &format!("https://api.nexusmods.com/v1/games/payday3/mods/{}/files.json", mod_id),
        Some(api_key),
    ) else {
        return Vec::new();
    };

    json_array(&files_value, &["files", "data"])
        .into_iter()
        .filter_map(|file| json_string(file, &["name", "file_name", "fileName"]))
        .filter(|name| !name.trim().is_empty())
        .take(12)
        .collect()
}

fn nexus_summary_with_file_aliases(summary: SourceModSummary, api_key: &str) -> SourceModSummary {
    let mut summary = nexus_enrich_summary(summary, api_key);
    let file_names = nexus_file_names_for_mod(&summary.source_id, api_key);

    if file_names.is_empty() {
        return summary;
    }

    let mut tags = summary.tags.clone();

    for file_name in &file_names {
        let cleaned = clean_mod_name(file_name);
        if cleaned.len() > 2 && !tags.iter().any(|tag| tag.eq_ignore_ascii_case(&cleaned)) {
            tags.push(cleaned);
        }
    }

    let alias_text = file_names
        .iter()
        .map(|name| clean_mod_name(name))
        .filter(|name| name.len() > 2)
        .collect::<Vec<_>>()
        .join(" ");

    let short_description = match summary.short_description.take() {
        Some(existing) if !alias_text.is_empty() => Some(format!("{} {}", existing, alias_text)),
        Some(existing) => Some(existing),
        None if !alias_text.is_empty() => Some(alias_text),
        None => None,
    };

    summary.tags = tags;
    summary.short_description = short_description;
    summary
}

fn build_nexus_payday3_index_sync(_max_id: u32) -> Result<Vec<SourceModSummary>, String> {
    let settings = load_settings_internal();
    let api_key = settings
        .nexus_api_key
        .as_deref()
        .ok_or_else(|| "Nexus API key is not saved. Paste it in Settings first.".to_string())?;

    let mut combined = Vec::<SourceModSummary>::new();

    // REST buckets are reliable and fast enough for PAYDAY 3 scale.
    for sort in ["updated", "added", "downloads", "liked"] {
        combined.extend(nexus_rest_collect(api_key, sort, 12));
    }

    // Website pages are used only as a secondary ordering/card source.
    combined.extend(nexus_website_collect("updated", settings.show_age_restricted_nexus, 3));

    // Keep what the user already viewed/downloaded, but never as raw unsorted truth.
    combined.extend(nexus_cached_index_page(1, "updated", 240));

    let mut summaries = nexus_sort_browser_summaries(nexus_dedupe_summaries(combined.into_iter().filter(source_summary_is_payday3_safe).collect()), "updated");

    // Enrich only the top chunk. This avoids the old ID sweep freeze.
    summaries = summaries
        .into_iter()
        .take(180)
        .enumerate()
        .map(|(index, summary)| {
            if index < 35 {
                nexus_summary_with_file_aliases(nexus_enrich_summary(summary, api_key), api_key)
            } else {
                summary
            }
        })
        .collect::<Vec<_>>();

    summaries = nexus_sort_browser_summaries(nexus_dedupe_summaries(summaries), "updated");

    upsert_source_index_summaries(&summaries);
    Ok(summaries)
}

#[tauri::command]
async fn build_nexus_payday3_index(max_id: u32) -> Result<Vec<SourceModSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || build_nexus_payday3_index_sync(max_id))
        .await
        .map_err(|err| format!("Nexus index task failed: {:?}", err))?
}

fn nexus_dedupe_summaries(summaries: Vec<SourceModSummary>) -> Vec<SourceModSummary> {
    let mut map = std::collections::BTreeMap::<String, SourceModSummary>::new();

    for summary in summaries {
        if summary.source_id != "unknown" && is_clean_nexus_summary_for_browser(&summary) && !source_summary_is_external_mod_manager(&summary) {
            let identity = format!("{}:{}", summary.page_url.as_deref().unwrap_or(summary.game_id.as_deref().unwrap_or("unknown")), summary.source_id);
            map.entry(identity)
                .and_modify(|existing| {
                    if existing.name.starts_with("Nexus Mod ") && !summary.name.starts_with("Nexus Mod ") {
                        existing.name = summary.name.clone();
                    }
                    if existing.thumbnail_url.is_none() {
                        existing.thumbnail_url = summary.thumbnail_url.clone();
                    }
                    if existing.banner_url.is_none() {
                        existing.banner_url = summary.banner_url.clone();
                    }
                    if existing.author.is_none() {
                        existing.author = summary.author.clone();
                    }
                    if existing.version.is_none() {
                        existing.version = summary.version.clone();
                    }
                    if existing.short_description.is_none() {
                        existing.short_description = summary.short_description.clone();
                    }
                    if existing.updated_at.is_none() {
                        existing.updated_at = summary.updated_at.clone();
                    }
                    if existing.downloads.is_none() {
                        existing.downloads = summary.downloads;
                    }
                    if existing.likes.is_none() {
                        existing.likes = summary.likes;
                    }
                    for tag in &summary.tags {
                        if !existing.tags.iter().any(|existing_tag| existing_tag.eq_ignore_ascii_case(tag)) {
                            existing.tags.push(tag.clone());
                        }
                    }
                })
                .or_insert(summary);
        }
    }

    map.into_values().collect()
}

fn nexus_rest_endpoint_order(sort: &str) -> Vec<&'static str> {
    match canonical_nexus_sort(sort) {
        "added" => vec![
            "latest_added.json",
            "updated.json?period=1w",
            "updated.json?period=1m",
            "trending.json",
        ],
        "downloads" => vec![
            "trending.json",
            "updated.json?period=1m",
            "updated.json?period=1w",
            "latest_added.json",
        ],
        "liked" => vec![
            "trending.json",
            "updated.json?period=1m",
            "updated.json?period=1w",
            "latest_added.json",
        ],
        _ => vec![
            "updated.json?period=1w",
            "updated.json?period=1m",
            "latest_added.json",
            "trending.json",
        ],
    }
}

fn nexus_rest_collect_for_domain(api_key: &str, sort: &str, enrich_limit: usize, game_domain: &str) -> Vec<SourceModSummary> {
    let domain = clean_source_slug(game_domain).unwrap_or_else(|| "payday3".to_string());
    let mut summaries = Vec::<SourceModSummary>::new();

    for endpoint in nexus_rest_endpoint_order(sort) {
        let url = format!("https://api.nexusmods.com/v1/games/{}/mods/{}", domain, endpoint);

        let Ok(value) = http_get_json(&url, Some(api_key)) else {
            continue;
        };

        let Some(array) = value.as_array() else {
            continue;
        };

        for item in array.iter().take(100) {
            let summary = force_nexus_game_summary(nexus_summary_from_value(item), &domain);
            if is_clean_nexus_summary_for_browser(&summary) && source_summary_matches_nexus_domain(&summary, &domain) {
                summaries.push(summary);
            }
        }
    }

    let mut summaries = nexus_dedupe_summaries(summaries);
    summaries = nexus_sort_browser_summaries(summaries, sort);

    if enrich_limit > 0 {
        summaries = summaries
            .into_iter()
            .enumerate()
            .map(|(index, summary)| {
                if index < enrich_limit {
                    nexus_enrich_summary_for_domain(summary, api_key, &domain)
                } else {
                    summary
                }
            })
            .collect::<Vec<_>>();
    }

    nexus_sort_browser_summaries(nexus_dedupe_summaries(summaries), sort)
}

fn nexus_rest_collect(api_key: &str, sort: &str, enrich_limit: usize) -> Vec<SourceModSummary> {
    nexus_rest_collect_for_domain(api_key, sort, enrich_limit, "payday3")
}

fn nexus_cached_index_page_for_domain(page: u32, sort: &str, page_size: usize, game_domain: &str) -> Vec<SourceModSummary> {
    let domain = clean_source_slug(game_domain).unwrap_or_else(|| "payday3".to_string());
    let start = page.saturating_sub(1) as usize * page_size;

    let cached = read_source_index_database()
        .records
        .into_values()
        .filter(|record| record.source.eq_ignore_ascii_case("nexus"))
        .map(|record| record.summary)
        .filter(|summary| source_summary_matches_nexus_domain(summary, &domain))
        .filter(is_clean_nexus_summary_for_browser)
        .collect::<Vec<_>>();

    let mut sorted = nexus_sort_browser_summaries(nexus_dedupe_summaries(cached), sort);

    if start < sorted.len() {
        sorted.drain(start..sorted.len().min(start + page_size)).collect()
    } else if page == 1 {
        sorted.into_iter().take(page_size).collect()
    } else {
        Vec::new()
    }
}

fn nexus_cached_index_page(page: u32, sort: &str, page_size: usize) -> Vec<SourceModSummary> {
    nexus_cached_index_page_for_domain(page, sort, page_size, "payday3")
}

fn nexus_website_collect_for_domain(sort: &str, allow_adult: bool, max_pages: u32, game_domain: &str) -> Vec<SourceModSummary> {
    let mut combined = Vec::new();
    let domain = clean_source_slug(game_domain).unwrap_or_else(|| "payday3".to_string());

    for page in 1..=max_pages {
        if let Ok(mut web) = fetch_nexus_website_mods_page_for_domain(page, sort, allow_adult, &domain) {
            combined.append(&mut web);
        }
    }

    nexus_sort_browser_summaries(nexus_dedupe_summaries(combined), sort)
}

fn nexus_website_collect(sort: &str, allow_adult: bool, max_pages: u32) -> Vec<SourceModSummary> {
    nexus_website_collect_for_domain(sort, allow_adult, max_pages, "payday3")
}

fn fetch_nexus_mods_page_for_domain(game_domain: &str, page: u32, sort: &str) -> Result<Vec<SourceModSummary>, String> {
    let game_domain = clean_source_slug(game_domain).ok_or_else(|| format!("Invalid Nexus game domain: {}", game_domain))?;
    let page = page.max(1);
    let sort = canonical_nexus_sort(sort);
    let settings = load_settings_internal();
    let api_key = settings
        .nexus_api_key
        .as_deref()
        .ok_or_else(|| "Nexus API key is not saved. Paste it in Settings first.".to_string())?;

    fetch_nexus_graphql_browse_page(&game_domain, sort, api_key, page, 20).map(|result| result.mods)
}

fn fetch_nexus_mods_page(page: u32, sort: &str) -> Result<Vec<SourceModSummary>, String> {
    fetch_nexus_mods_page_for_domain("payday3", page, sort)
}

fn modworkshop_list_candidates(data: &serde_json::Value) -> Vec<&serde_json::Value> {
    if let Some(array) = data.as_array() {
        return array.iter().collect();
    }

    for key in ["mods", "results", "items", "data"] {
        if let Some(array) = data.get(key).and_then(|v| v.as_array()) {
            return array.iter().collect();
        }
    }

    Vec::new()
}

fn parse_modworkshop_list_for_game(value: serde_json::Value, game_id: &str) -> Vec<SourceModSummary> {
    let data = unwrap_data(value);
    modworkshop_list_candidates(&data)
        .into_iter()
        .filter(|item| modworkshop_game_id_from_value(item).is_some())
        .filter_map(|item| modworkshop_summary_from_api_value_for_game(item, Some(game_id)))
        .filter(|summary| modworkshop_summary_matches_game(summary, game_id))
        .map(|summary| force_modworkshop_game_summary(summary, game_id))
        .take(40)
        .collect()
}

fn parse_modworkshop_list(value: serde_json::Value) -> Vec<SourceModSummary> {
    parse_modworkshop_list_for_game(value, MODWORKSHOP_PAYDAY3_GAME_ID)
        .into_iter()
        .filter(source_summary_is_payday3_safe)
        .collect()
}

fn parse_modworkshop_categories(value: serde_json::Value) -> Vec<SourceCategory> {
    let data = unwrap_data(value);
    let candidates = if let Some(array) = data.as_array() {
        array.iter().collect::<Vec<_>>()
    } else {
        json_array(&data, &["categories", "items", "results", "data"])
    };
    let mut categories = Vec::<SourceCategory>::new();
    let mut seen = std::collections::BTreeSet::<String>::new();

    for item in candidates {
        let Some(id) = json_modworkshop_id_string(item, &["id", "category_id", "categoryId"]) else {
            continue;
        };
        let Some(label) = json_string(item, &["name", "label", "title"]) else {
            continue;
        };
        let label = clean_html_text(&label);
        if label.trim().is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        categories.push(SourceCategory { id, label });
    }

    categories.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
    categories
}


fn percent_encode_query(input: &str) -> String {
    let mut output = String::new();

    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => output.push(byte as char),
            b' ' => output.push('+'),
            _ => output.push_str(&format!("%{:02X}", byte)),
        }
    }

    output
}

fn find_first_image_like_url(value: &serde_json::Value, depth: usize) -> Option<String> {
    if depth > 7 {
        return None;
    }

    if let Some(text) = value.as_str() {
        let lower = text.to_lowercase();
        let looks_image = lower.contains(".webp")
            || lower.contains(".png")
            || lower.contains(".jpg")
            || lower.contains(".jpeg")
            || lower.contains("storage.modworkshop")
            || lower.contains("/images/")
            || lower.contains("/image/")
            || lower.contains("/thumb")
            || lower.contains("thumbnail");

        let bad = lower.contains("avatar")
            || lower.contains("user/")
            || lower.contains("profile")
            || lower.contains("discord");

        if looks_image && !bad {
            return Some(text.to_string());
        }

        return None;
    }

    if let Some(object) = value.as_object() {
        for key in [
            "thumbnail_url",
            "thumbnailUrl",
            "thumbnail",
            "thumb",
            "image_url",
            "imageUrl",
            "image",
            "cover",
            "cover_url",
            "coverUrl",
            "banner",
            "banner_url",
            "bannerUrl",
            "logo",
            "url",
            "src",
            "path",
        ] {
            if let Some(child) = object.get(key) {
                if let Some(found) = find_first_image_like_url(child, depth + 1) {
                    return Some(found);
                }
            }
        }

        for child in object.values() {
            if let Some(found) = find_first_image_like_url(child, depth + 1) {
                return Some(found);
            }
        }
    }

    if let Some(array) = value.as_array() {
        for child in array {
            if let Some(found) = find_first_image_like_url(child, depth + 1) {
                return Some(found);
            }
        }
    }

    None
}


fn modworkshop_game_display_label(game_id: &str) -> String {
    let normalized = game_id.trim().to_lowercase().replace('_', "-");
    match normalized.as_str() {
        "payday-3" | "payday3" | "pd3" | MODWORKSHOP_PAYDAY3_NUMERIC_GAME_ID => "PAYDAY 3".to_string(),
        "payday-2" | "payday2" | "pd2" | "1" => "PAYDAY 2".to_string(),
        other => other
            .split('-')
            .filter(|part| !part.is_empty())
            .map(|part| {
                let mut chars = part.chars();
                match chars.next() {
                    Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                    None => String::new(),
                }
            })
            .collect::<Vec<_>>()
            .join(" "),
    }
}

fn normalize_modworkshop_game_route(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("ModWorkshop game id is required.".to_string());
    }

    let normalized = trimmed.to_lowercase().replace('_', "-").replace(' ', "-");
    let mapped = match normalized.as_str() {
        "payday3" | "pd3" | "853" => "payday-3",
        "payday2" | "pd2" | "1" => "payday-2",
        "2" | "payday-the-heist" | "pdth" => "pdth",
        other => other,
    };

    if mapped
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    {
        Ok(mapped.to_string())
    } else {
        Err(format!("Invalid ModWorkshop game id: {}", trimmed))
    }
}

fn modworkshop_summary_matches_game(summary: &SourceModSummary, requested_game_id: &str) -> bool {
    let Ok(requested) = normalize_modworkshop_game_route(requested_game_id) else {
        return false;
    };

    let Some(actual) = summary.game_id.as_deref() else {
        return false;
    };

    normalize_modworkshop_game_route(actual)
        .map(|actual| actual == requested)
        .unwrap_or(false)
}

fn force_modworkshop_game_summary(mut summary: SourceModSummary, game_id: &str) -> SourceModSummary {
    if !summary.source.eq_ignore_ascii_case("modworkshop") {
        return summary;
    }

    let normalized = normalize_modworkshop_game_route(game_id).unwrap_or_else(|_| game_id.to_string());
    let label = modworkshop_game_display_label(&normalized);
    summary.game_id = Some(normalized);
    summary.tags.retain(|tag| {
        let clean = tag.trim().to_lowercase();
        clean != "payday 3" && clean != "payday3" && clean != "payday 2" && clean != "payday2"
    });
    if !summary.tags.iter().any(|tag| tag.eq_ignore_ascii_case(&label)) {
        summary.tags.push(label);
    }
    summary
}

fn modworkshop_summary_from_api_value_for_game(item: &serde_json::Value, fallback_game_id: Option<&str>) -> Option<SourceModSummary> {
    let id = json_modworkshop_id_string(item, &["id", "mod_id", "modId"])?;

    let name = json_string(item, &["name", "title"])
        .map(|value| clean_mod_name(&value))
        .unwrap_or_else(|| format!("ModWorkshop Mod {}", id));

    let game_id = modworkshop_game_id_from_value(item)
        .or_else(|| fallback_game_id.map(|value| value.to_string()));

    let mut tags = vec!["ModWorkshop".to_string()];
    if let Some(label) = game_id.as_deref().map(modworkshop_game_display_label) {
        if !label.trim().is_empty() {
            tags.push(label);
        }
    }

    for tag in json_array(item, &["tags", "categories", "game", "games"]) {
        if json_modworkshop_id_string(tag, &["id"]).as_deref() == Some("97")
            && normalize_modworkshop_game_route(game_id.as_deref().unwrap_or_default()).ok().as_deref() == Some(MODWORKSHOP_PAYDAY3_GAME_ID)
            && !tags.iter().any(|tag| tag.eq_ignore_ascii_case("UE4.27")) {
            tags.push("UE4.27".to_string());
        }
        if let Some(tag_name) = json_string(tag, &["name", "title", "slug"]) {
            if !tags.iter().any(|existing| existing.eq_ignore_ascii_case(&tag_name)) {
                tags.push(tag_name);
            }
        } else if let Some(tag_text) = tag.as_str() {
            if !tags.iter().any(|existing| existing.eq_ignore_ascii_case(tag_text)) {
                tags.push(tag_text.to_string());
            }
        }
    }

    let file_aliases = modworkshop_file_items_from_api(&id, item)
        .into_iter()
        .map(|file| file.name)
        .filter(|name| !is_generic_modworkshop_file_name(name))
        .take(8)
        .collect::<Vec<_>>();

    for file_name in &file_aliases {
        if !tags.iter().any(|tag| tag.eq_ignore_ascii_case(file_name)) {
            tags.push(file_name.clone());
        }
    }

    let mut short_description = safe_short_description(json_string(item, &["description", "summary", "short_description", "shortDescription"]));

    if !file_aliases.is_empty() {
        let alias_text = file_aliases
            .iter()
            .map(|name| clean_mod_name(name))
            .collect::<Vec<_>>()
            .join(" ");

        short_description = match short_description {
            Some(existing) => Some(format!("{} {}", existing, alias_text)),
            None => Some(alias_text),
        };
    }

    let author = modworkshop_author_fields_from_value(item);

    Some(SourceModSummary {
        source: "modworkshop".to_string(),
        source_id: id.clone(),
        uid: None,
        game_id,
        name,
        author: author.display_name,
        author_username: author.username,
        author_user_id: author.user_id,
        author_profile_url: author.profile_url,
        author_avatar_url: author.avatar_url,
        version: json_string(item, &["version"]),
        thumbnail_url: absolutize_source_url(
            "modworkshop",
            first_media_url(item)
                .or_else(|| find_first_image_like_url(item, 0))
                .or_else(|| {
                    json_nested_string(
                        item,
                        &[
                            &["thumbnail", "url"],
                            &["thumbnail", "path"],
                            &["thumbnail", "original"],
                            &["image", "url"],
                            &["image", "path"],
                            &["logo", "url"],
                            &["cover", "url"],
                            &["cover", "path"],
                            &["banner", "url"],
                            &["banner", "path"],
                            &["preview", "url"],
                            &["preview", "path"],
                        ],
                    )
                }),
        ),
        banner_url: None,
        page_url: Some(format!("https://modworkshop.net/mod/{}", id)),
        updated_at: json_timestamp_string(item, &[
            "updated_at",
            "updatedAt",
            "updated_timestamp",
            "updatedTimestamp",
            "last_updated",
            "lastUpdated",
            "modified_at",
            "modifiedAt",
            "created_at",
            "createdAt",
            "date",
            "published_at",
            "publishedAt",
        ]),
        downloads: json_u64(item, &["downloads", "download_count", "downloadCount", "downloads_count", "downloadsCount"]),
        likes: json_u64(item, &["likes", "liked", "like_count", "likeCount", "likes_count", "likesCount", "score", "rating"]),
        short_description,
        tags,
    })
}

fn modworkshop_summary_from_api_value(item: &serde_json::Value) -> Option<SourceModSummary> {
    modworkshop_summary_from_api_value_for_game(item, Some(MODWORKSHOP_PAYDAY3_GAME_ID))
}

fn force_payday3_modworkshop_summary(mut summary: SourceModSummary) -> SourceModSummary {
    if summary.source.eq_ignore_ascii_case("modworkshop") {
        summary.game_id = summary.game_id.or_else(|| Some(MODWORKSHOP_PAYDAY3_GAME_ID.to_string()));
        if !summary.tags.iter().any(|tag| tag.eq_ignore_ascii_case("PAYDAY 3")) {
            summary.tags.push("PAYDAY 3".to_string());
        }
    }

    summary
}

fn source_summary_search_text(summary: &SourceModSummary) -> String {
    let mut parts = vec![
        summary.name.clone(),
        summary.author.clone().unwrap_or_default(),
        summary.short_description.clone().unwrap_or_default(),
        summary.page_url.clone().unwrap_or_default(),
    ];

    parts.extend(summary.tags.clone());
    parts.join(" ")
}

fn score_search_result_for_query(summary: &SourceModSummary, query: &str) -> u32 {
    let title = normalize_mod_match_text(&summary.name);
    let author = normalize_mod_match_text(summary.author.as_deref().unwrap_or(""));
    let tags = normalize_mod_match_text(&summary.tags.join(" "));
    let description = normalize_mod_match_text(summary.short_description.as_deref().unwrap_or(""));
    let source = normalize_mod_match_text(&source_summary_search_text(summary));
    let query_norm = normalize_mod_match_text(query);

    if source.is_empty() || query_norm.is_empty() {
        return 0;
    }

    let title_compact = compact_match_text(&title);
    let author_compact = compact_match_text(&author);
    let tags_compact = compact_match_text(&tags);
    let description_compact = compact_match_text(&description);
    let source_compact = compact_match_text(&source);
    let query_compact = compact_match_text(&query_norm);

    if title_compact == query_compact {
        return 1000;
    }

    if query_compact.len() > 1 && title_compact.contains(&query_compact) {
        return 920;
    }

    if query_compact.len() > 1 && author_compact.contains(&query_compact) {
        return 760;
    }

    if query_compact.len() > 1 && tags_compact.contains(&query_compact) {
        return 680;
    }

    if query_compact.len() > 1 && description_compact.contains(&query_compact) {
        return 560;
    }

    if source_compact.len() > 3 && query_compact.len() > 3
        && (source_compact.contains(&query_compact) || query_compact.contains(&source_compact))
    {
        return 520;
    }

    let source_tokens = token_list(&source);
    let title_tokens = token_list(&title);
    let query_tokens = token_list(&query_norm);

    if source_tokens.is_empty() || query_tokens.is_empty() {
        return 0;
    }

    let common_source = query_tokens
        .iter()
        .filter(|token| source_tokens.contains(token))
        .count();
    let common_title = query_tokens
        .iter()
        .filter(|token| title_tokens.contains(token))
        .count();

    let source_score = ((common_source as f32 / query_tokens.len() as f32) * 360.0).round() as u32;
    let title_bonus = ((common_title as f32 / query_tokens.len() as f32) * 260.0).round() as u32;
    source_score.saturating_add(title_bonus)
}


fn modworkshop_summary_with_file_aliases(mut summary: SourceModSummary) -> SourceModSummary {
    summary.game_id = summary.game_id.or_else(|| Some(MODWORKSHOP_PAYDAY3_GAME_ID.to_string()));

    let Ok(detail) = fetch_modworkshop_mod_detail(summary.source_id.clone(), None) else {
        return summary;
    };

    if summary.name.starts_with("ModWorkshop Mod ") && !detail.name.starts_with("ModWorkshop Mod ") {
        summary.name = detail.name.clone();
    }

    summary.author = summary.author.or(detail.author.clone());
    summary.version = summary.version.or(detail.version.clone());
    summary.thumbnail_url = summary.thumbnail_url.or(detail.thumbnail_url.clone());
    summary.banner_url = summary.banner_url.or(detail.banner_url.clone());
    summary.updated_at = summary.updated_at.or(detail.updated_at.clone());
    summary.downloads = summary.downloads.or(detail.downloads);
    summary.likes = summary.likes.or(detail.likes);
    summary.short_description = summary.short_description.or(detail.short_description.clone());

    let mut tags = summary.tags.clone();
    if !tags.iter().any(|tag| tag.eq_ignore_ascii_case("PAYDAY 3")) {
        tags.push("PAYDAY 3".to_string());
    }

    for file in detail.files.iter().take(12) {
        if !is_generic_modworkshop_file_name(&file.name)
            && !tags.iter().any(|tag| tag.eq_ignore_ascii_case(&file.name))
        {
            tags.push(file.name.clone());
        }
    }

    if !detail.files.is_empty() {
        let alias_text = detail
            .files
            .iter()
            .filter(|file| !is_generic_modworkshop_file_name(&file.name))
            .map(|file| clean_mod_name(&file.name))
            .filter(|name| name.len() > 2)
            .take(12)
            .collect::<Vec<_>>()
            .join(" ");

        if !alias_text.trim().is_empty() {
            summary.short_description = match summary.short_description.take() {
                Some(existing) => Some(format!("{} {}", existing, alias_text)),
                None => Some(alias_text),
            };
        }
    }

    summary.tags = tags;
    force_payday3_modworkshop_summary(summary)
}

fn modworkshop_search_haystack(summary: &SourceModSummary) -> String {
    [
        summary.name.clone(),
        summary.author.clone().unwrap_or_default(),
        summary.short_description.clone().unwrap_or_default(),
        summary.page_url.clone().unwrap_or_default(),
        summary.tags.join(" "),
    ]
    .join(" ")
    .to_lowercase()
}

fn modworkshop_search_matches(summary: &SourceModSummary, query: &str) -> bool {
    let haystack = modworkshop_search_haystack(summary);
    let query = query.to_lowercase();
    let tokens = query
        .split_whitespace()
        .map(|token| token.trim())
        .filter(|token| token.len() >= 2)
        .collect::<Vec<_>>();

    if tokens.is_empty() {
        return false;
    }

    haystack.contains(&query)
        || tokens.iter().all(|token| haystack.contains(*token))
        || tokens.iter().filter(|token| haystack.contains(*token)).count() >= tokens.len().saturating_sub(1).max(1)
        || score_search_result_for_query(summary, query.as_str()) >= 5
}

fn push_unique_modworkshop_result(results: &mut Vec<SourceModSummary>, summary: SourceModSummary) {
    if summary.source.eq_ignore_ascii_case("modworkshop")
        && source_summary_is_payday3_safe(&summary)
        && !results.iter().any(|existing| existing.source_id == summary.source_id)
    {
        results.push(force_payday3_modworkshop_summary(summary));
    }
}

fn search_modworkshop_mods_for_query_sync(query: String, page: Option<u32>) -> Result<Vec<SourceModSummary>, String> {
    let query = query.trim().to_string();

    if query.len() < 2 {
        return Ok(Vec::new());
    }

    let page = page.unwrap_or(1).max(1);
    let per_page = 24usize;
    let encoded = percent_encode_query(&query);
    let mut results = Vec::<SourceModSummary>::new();
    let mut route_notes = Vec::<String>::new();

    // Cache/index can contribute aliases, but live routes still decide the result set.
    let database = read_source_index_database();
    let mut indexed_results = Vec::<SourceModSummary>::new();
    for record in database.records.values() {
        if !record.source.eq_ignore_ascii_case("modworkshop") {
            continue;
        }

        let mut summary = record.summary.clone();
        if !record.file_names.is_empty() {
            let alias_text = record.file_names.join(" ");
            summary.short_description = Some(format!("{} {}", summary.short_description.clone().unwrap_or_default(), alias_text));
            for file_name in &record.file_names {
                if !summary.tags.iter().any(|tag| tag.eq_ignore_ascii_case(file_name)) {
                    summary.tags.push(file_name.clone());
                }
            }
        }

        if modworkshop_search_matches(&summary, &query) {
            push_unique_modworkshop_result(&mut indexed_results, summary);
        }
    }

    for summary in indexed_results {
        push_unique_modworkshop_result(&mut results, summary);
    }

    // 1) Current public/API search probes. These are kept, but they are no longer trusted as the only path.
    let post_body_variants = [
        serde_json::json!({ "query": query.clone(), "limit": 80, "game": "payday-3" }),
        serde_json::json!({ "search": query.clone(), "limit": 80, "game": "payday-3" }),
        serde_json::json!({ "query": query.clone(), "limit": 80, "ids": ["payday-3", "PAYDAY 3", "pd3"] }),
    ];

    for endpoint in [
        "https://api.modworkshop.net/mods/search",
        "https://api.modworkshop.net/search/mods",
        "https://api.modworkshop.net/search",
    ] {
        for body in &post_body_variants {
            match http_post_json(endpoint, body.clone(), 8) {
                Ok(value) => {
                    let data = unwrap_data(value);
                    let mut added = 0usize;
                    let arrays = [
                        json_array(&data, &["data", "mods", "results", "items"]),
                        data.as_array().map(|items| items.iter().collect()).unwrap_or_default(),
                    ];

                    for array in arrays {
                        for item in array {
                            if let Some(summary) = modworkshop_summary_from_api_value(item) {
                                if modworkshop_search_matches(&summary, &query) {
                                    push_unique_modworkshop_result(&mut results, summary);
                                    added += 1;
                                }
                            }
                        }
                    }
                    route_notes.push(format!("{} POST added {}", endpoint, added));
                }
                Err(error) => route_notes.push(format!("{} POST failed: {}", endpoint, error)),
            }
        }
    }

    let api_urls = [
        // Current public API shape from api.modworkshop.net docs: /games/{game_id}/mods.
        format!("https://api.modworkshop.net/games/payday-3/mods?query={}&page={}", encoded, page),
        format!("https://api.modworkshop.net/games/payday-3/mods?search={}&page={}", encoded, page),
        format!("https://api.modworkshop.net/games/payday-3/mods?name={}&page={}", encoded, page),
        // Generic endpoint fallbacks retained for older/API-proxy behavior.
        format!("https://api.modworkshop.net/mods?query={}&game=payday-3&page={}", encoded, page),
        format!("https://api.modworkshop.net/mods?search={}&game=payday-3&page={}", encoded, page),
        format!("https://api.modworkshop.net/mods?name={}&game=payday-3&page={}", encoded, page),
        format!("https://api.modworkshop.net/mods?query={}&game_id=payday-3&page={}", encoded, page),
        // Legacy PHP API fallback used by older ModWorkshop tooling.
        format!("https://api.modworkshop.net/api.php?command=Search&query={}&game=payday-3&page={}", encoded, page),
        format!("https://api.modworkshop.net/api.php?command=SearchMods&query={}&game=payday-3&page={}", encoded, page),
    ];

    for url in api_urls {
        match http_get_json_fast(&url, 8) {
            Ok(value) => {
                let mut added = 0usize;
                for summary in parse_modworkshop_list(value) {
                    if modworkshop_search_matches(&summary, &query) {
                        push_unique_modworkshop_result(&mut results, summary);
                        added += 1;
                    }
                }
                route_notes.push(format!("{} GET added {}", url, added));
            }
            Err(error) => route_notes.push(format!("{} GET failed: {}", url, error)),
        }
    }

    // 2) Public HTML search/game routes.
    let html_urls = [
        format!("https://modworkshop.net/g/payday-3?query={}&page={}", encoded, page),
        format!("https://modworkshop.net/g/payday-3?search={}&page={}", encoded, page),
        format!("https://modworkshop.net/g/payday-3/mods?query={}&page={}", encoded, page),
        format!("https://modworkshop.net/g/payday-3/mods?search={}&page={}", encoded, page),
        format!("https://modworkshop.net/mods?query={}&game=payday-3&page={}", encoded, page),
        format!("https://modworkshop.net/mods?search={}&game=payday-3&page={}", encoded, page),
        format!("https://modworkshop.net/search/mods?query={}&game=payday-3&page={}", encoded, page),
        format!("https://modworkshop.net/search?query={}&game=payday-3&page={}", encoded, page),
    ];

    for url in html_urls {
        match http_get_text_fast(&url, 10) {
            Ok(html) => {
                let mut added = 0usize;
                for summary in parse_modworkshop_public_page_cards(&html, 80)
                    .into_iter()
                    .chain(scrape_modworkshop_public_page_cards_by_block(&html, 80).into_iter())
                {
                    if modworkshop_search_matches(&summary, &query) {
                        push_unique_modworkshop_result(&mut results, summary);
                        added += 1;
                    }
                }
                route_notes.push(format!("{} HTML added {}", url, added));
            }
            Err(error) => route_notes.push(format!("{} HTML failed: {}", url, error)),
        }
    }

    // 3) Source index. This is instant and catches previously-seen cards/files.
    let database = read_source_index_database();
    let mut index_added = 0usize;
    for record in database.records.values() {
        if !record.source.eq_ignore_ascii_case("modworkshop") {
            continue;
        }

        let mut summary = record.summary.clone();
        if !record.file_names.is_empty() {
            let alias_text = record.file_names.join(" ");
            summary.short_description = Some(format!("{} {}", summary.short_description.clone().unwrap_or_default(), alias_text));
            for file_name in &record.file_names {
                if !summary.tags.iter().any(|tag| tag.eq_ignore_ascii_case(file_name)) {
                    summary.tags.push(file_name.clone());
                }
            }
        }

        if modworkshop_search_matches(&summary, &query) {
            push_unique_modworkshop_result(&mut results, summary);
            index_added += 1;
        }
    }
    route_notes.push(format!("source-index added {}", index_added));

    // 4) Deterministic PAYDAY 3 page crawl. This is the reliable rebuild path when the API search returns zero.
    // Keep it capped so it does not freeze the app, but wide enough to make normal searches useful.
    if results.len() < 12 {
        let mut crawled_pages = 0usize;
        let start_page = ((page - 1) * 10 + 1).max(1);
        let end_page = start_page.saturating_add(14);

        for browse_page in start_page..=end_page {
            if results.len() >= 48 {
                break;
            }

            match fetch_modworkshop_mods_page(browse_page, "updated") {
                Ok(page_mods) => {
                    crawled_pages += 1;
                    for summary in page_mods {
                        if modworkshop_search_matches(&summary, &query) {
                            push_unique_modworkshop_result(&mut results, summary);
                        }
                    }
                }
                Err(error) => route_notes.push(format!("crawl page {} failed: {}", browse_page, error)),
            }
        }
        route_notes.push(format!("crawled {} PAYDAY 3 page(s)", crawled_pages));
    }

    // Enrich only a small front slice so names/file aliases improve without turning search into tar.
    let mut enriched = Vec::<SourceModSummary>::new();
    for summary in results.into_iter() {
        if enriched.len() < 16 {
            enriched.push(modworkshop_summary_with_file_aliases(summary));
        } else {
            enriched.push(summary);
        }
    }

    enriched.sort_by(|a, b| {
        score_search_result_for_query(b, &query)
            .cmp(&score_search_result_for_query(a, &query))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    enriched.retain(source_summary_is_payday3_safe);
    enriched.dedup_by(|a, b| a.source_id == b.source_id);

    let start = ((page - 1) as usize).saturating_mul(per_page);
    let page_results = enriched.into_iter().skip(start).take(per_page).collect::<Vec<_>>();

    if page_results.is_empty() {
        eprintln!("ModWorkshop search for '{}' returned zero. Routes: {}", query, route_notes.join(" | "));
    }

    upsert_source_index_summaries(&page_results);
    Ok(page_results)
}

fn modworkshop_sort_query_value(sort: &str) -> &'static str {
    match sort {
        "downloads" => "downloads",
        "liked" | "popular" => "popular",
        "added" => "published",
        "updated" | "recent" | _ => "updated",
    }
}

fn modworkshop_filter_href_from_html(html: &str, filter: &str) -> Option<String> {
    let wanted = clean_html_text(filter).to_lowercase();
    let mut search_start = 0usize;

    while let Some(pos) = html[search_start..].find("<a") {
        let abs = search_start + pos;
        let Some(tag_end_rel) = html[abs..].find('>') else { break; };
        let tag_end = abs + tag_end_rel;
        let tag = &html[abs..=tag_end];
        let Some(href) = html_attr(tag, "href") else {
            search_start = tag_end + 1;
            continue;
        };
        let close = html[tag_end + 1..].find("</a>").map(|value| tag_end + 1 + value).unwrap_or(tag_end + 1);
        let label = clean_html_text(&html[tag_end + 1..close]).to_lowercase();

        if !label.is_empty() && (label == wanted || label.contains(&wanted) || wanted.contains(&label)) {
            let absolute = absolutize_source_url("modworkshop", Some(href.clone())).unwrap_or(href);
            if absolute.contains("category=") || absolute.contains("tag") || absolute.contains("/g/payday-3") {
                return Some(absolute);
            }
        }

        search_start = close.saturating_add(4);
    }

    None
}

fn modworkshop_filter_urls(filter: &str, page: u32, sort: &str) -> Vec<String> {
    let encoded = percent_encode_query(filter);
    let sort_value = modworkshop_sort_query_value(sort);
    let page = page.max(1);
    let mut urls = Vec::new();

    if let Ok(html) = http_get_text_fast("https://modworkshop.net/g/payday-3/mods?page=1", 8) {
        if let Some(href) = modworkshop_filter_href_from_html(&html, filter) {
            let sep = if href.contains('?') { "&" } else { "?" };
            urls.push(format!("{}{}page={}&sort={}", href, sep, page, sort_value));
            urls.push(format!("{}{}sort={}&page={}", href, sep, sort_value, page));
        }
    }

    urls.extend([
        format!("https://modworkshop.net/g/payday-3/mods?category={}&page={}&sort={}", encoded, page, sort_value),
        format!("https://modworkshop.net/g/payday-3/mods?tags={}&page={}&sort={}", encoded, page, sort_value),
        format!("https://modworkshop.net/g/payday-3/mods?tag={}&page={}&sort={}", encoded, page, sort_value),
        format!("https://modworkshop.net/g/payday-3/mods?search={}&page={}&sort={}", encoded, page, sort_value),
        format!("https://modworkshop.net/g/payday-3/mods?query={}&page={}&sort={}", encoded, page, sort_value),
    ]);

    urls.sort();
    urls.dedup();
    urls
}

fn fetch_modworkshop_filter_page_sync(filter: String, page: Option<u32>, sort: Option<String>) -> Result<Vec<SourceModSummary>, String> {
    let filter = filter.trim().to_string();
    if filter.is_empty() || filter.eq_ignore_ascii_case("all") {
        return fetch_modworkshop_mods_page(page.unwrap_or(1), &sort.unwrap_or_else(|| "recent".to_string()));
    }

    let page = page.unwrap_or(1).max(1);
    let sort = sort.unwrap_or_else(|| "recent".to_string());
    let mut results = Vec::<SourceModSummary>::new();
    let mut notes = Vec::<String>::new();

    for url in modworkshop_filter_urls(&filter, page, &sort) {
        match http_get_text_fast(&url, 10) {
            Ok(html) => {
                let before = results.len();
                for summary in parse_modworkshop_public_page_cards(&html, 90)
                    .into_iter()
                    .chain(scrape_modworkshop_public_page_cards_by_block(&html, 90).into_iter())
                {
                    if modworkshop_search_matches(&summary, &filter) || summary.tags.iter().any(|tag| tag.eq_ignore_ascii_case(&filter)) {
                        push_unique_modworkshop_result(&mut results, summary);
                    }
                }
                notes.push(format!("{} added {}", url, results.len().saturating_sub(before)));
            }
            Err(error) => notes.push(format!("{} failed: {}", url, error)),
        }

        if results.len() >= 36 {
            break;
        }
    }

    if results.len() < 12 {
        for summary in search_modworkshop_mods_for_query_sync(filter.clone(), Some(page))? {
            push_unique_modworkshop_result(&mut results, summary);
        }
    }

    results = modworkshop_sort_browser_summaries(results, &sort);
    results.retain(|summary| source_summary_is_payday3_safe(summary));
    results.dedup_by(|a, b| a.source_id == b.source_id);
    upsert_source_index_summaries(&results);

    if results.is_empty() {
        eprintln!("ModWorkshop filter '{}' returned zero. Routes: {}", filter, notes.join(" | "));
    }

    Ok(results.into_iter().take(72).collect())
}

#[tauri::command]
async fn fetch_modworkshop_filter_page(filter: String, page: Option<u32>, sort: Option<String>, profile_id: Option<String>) -> Result<Vec<SourceModSummary>, String> {
    if !is_builtin_payday3_profile(profile_id.as_deref()) {
        return Ok(Vec::new());
    }

    tauri::async_runtime::spawn_blocking(move || fetch_modworkshop_filter_page_sync(filter, page, sort))
        .await
        .map_err(|err| format!("ModWorkshop filter task failed: {:?}", err))?
}

#[tauri::command]
async fn search_modworkshop_mods_for_query(
    query: String,
    page: Option<u32>,
    profile_id: Option<String>,
    game_id: Option<String>,
    category_id: Option<String>,
) -> Result<Vec<SourceModSummary>, String> {
    let requested_game_id = game_id
        .or_else(|| {
            if is_builtin_payday3_profile(profile_id.as_deref()) {
                Some(MODWORKSHOP_PAYDAY3_GAME_ID.to_string())
            } else {
                None
            }
        })
        .ok_or_else(|| {
            format!(
                "ModWorkshop search needs a profile ModWorkshop game ID. Profile ID: {}.",
                profile_id.as_deref().unwrap_or("unknown")
            )
        })?;

    tauri::async_runtime::spawn_blocking(move || {
        let normalized_game_id = normalize_modworkshop_game_route(&requested_game_id)?;
        let page_number = page.unwrap_or(1).max(1);
        let version = modworkshop_profile_game_version(profile_id.as_deref(), &normalized_game_id);
        match fetch_modworkshop_mods_page_for_version(&normalized_game_id, page_number, "best_match", Some(query.as_str()), category_id.as_deref(), version.as_deref()) {
            Ok(mods) => Ok(mods),
            Err(error) if normalized_game_id == MODWORKSHOP_PAYDAY3_GAME_ID && version.is_none() => {
                eprintln!("ModWorkshop scoped search failed, falling back to legacy PAYDAY 3 probes: {}", error);
                search_modworkshop_mods_for_query_sync(query, Some(page_number))
            }
            Err(error) => Err(error),
        }
    })
    .await
    .map_err(|err| format!("ModWorkshop search task failed: {:?}", err))?
}



fn http_get_json_fast_with_api_key(url: &str, timeout_secs: u64, api_key: Option<&str>) -> Result<serde_json::Value, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("TsukiModManager/0.20")
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|err| format!("Failed to create HTTP client: {}", err))?;

    let mut request = client
        .get(url)
        .header("Accept", "application/json, text/html;q=0.9, */*;q=0.8")
        .header("Accept-Language", "en-US,en;q=0.9");

    if let Some(key) = api_key.map(str::trim).filter(|key| !key.is_empty()) {
        request = request
            .header("apikey", key)
            .header("X-API-Key", key)
            .header("Authorization", format!("Bearer {}", key));
    }

    let response = request
        .send()
        .map_err(|err| format!("Request failed for {}: {}", url, err))?;

    let status = response.status();
    let text = response
        .text()
        .map_err(|err| format!("Failed to read response body: {}", err))?;

    if !status.is_success() {
        let preview = text
            .chars()
            .take(600)
            .collect::<String>()
            .replace('\n', " ")
            .replace('\r', " ");
        return Err(format!(
            "{} returned HTTP {}. Body preview: {}",
            url,
            status,
            if preview.trim().is_empty() { "<empty>" } else { preview.trim() }
        ));
    }

    serde_json::from_str(&text)
        .map_err(|err| format!("Failed to parse JSON from {}: {}", url, err))
}

fn http_get_json_fast(url: &str, timeout_secs: u64) -> Result<serde_json::Value, String> {
    http_get_json_fast_with_api_key(url, timeout_secs, None)
}

fn http_get_text_fast(url: &str, timeout_secs: u64) -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("TsukiModManager/0.20")
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|err| format!("Failed to create HTTP client: {}", err))?;

    let response = client
        .get(url)
        .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .map_err(|err| format!("Request failed for {}: {}", url, err))?;

    let status = response.status();
    let text = response
        .text()
        .map_err(|err| format!("Failed to read response body: {}", err))?;

    if !status.is_success() {
        return Err(format!("{} returned HTTP {}", url, status));
    }

    Ok(text)
}

fn parse_modworkshop_public_page_cards(html: &str, page_size: usize) -> Vec<SourceModSummary> {
    let ids = extract_modworkshop_ids_from_html(html);
    let mut mods = Vec::new();

    for id in ids.into_iter().take(page_size) {
        let mut summary = scrape_modworkshop_summary_from_listing(html, &id);

        if is_bad_modworkshop_listing_name(&summary.name) {
            summary.name = format!("ModWorkshop Mod {}", id);
        }

        if !summary.tags.iter().any(|tag| tag.eq_ignore_ascii_case("PAYDAY 3")) {
            summary.tags.push("PAYDAY 3".to_string());
        }

        mods.push(summary);
    }

    mods
}


fn modworkshop_api_browse_probe_urls(page: u32, sort: &str) -> Vec<String> {
    let page = page.max(1);
    let sort_name = match sort {
        "downloads" => "downloads",
        "liked" => "likes",
        "popular" => "score",
        "added" | "updated" | "recent" | _ => "published_at",
    };

    vec![
        format!("https://api.modworkshop.net/games/{}/mods?page={}&sort={}", MODWORKSHOP_PAYDAY3_GAME_ID, page, sort_name),
        format!("https://api.modworkshop.net/games/{}/mods?page={}&sort={}", MODWORKSHOP_PAYDAY3_NUMERIC_GAME_ID, page, sort_name),
        format!("https://api.modworkshop.net/games/{}/mods?page={}", MODWORKSHOP_PAYDAY3_GAME_ID, page),
    ]
}


fn modworkshop_game_page_public_urls(page: u32, sort: &str) -> Vec<String> {
    let page = page.max(1);
    let root = "https://modworkshop.net/g/payday-3/mods";
    let legacy_root = "https://modworkshop.net/g/payday-3";

    let sort_candidates = match sort {
        "downloads" => vec!["downloads", "popular"],
        "liked" | "popular" => vec!["popular", "likes"],
        "added" => vec!["publish_date", "published", "created", "added"],
        "updated" | "recent" | _ => vec!["last_updated", "updated", "recent"],
    };

    let mut urls = Vec::new();

    // The /mods listing is the paginated PAYDAY 3 browser. The game landing page
    // is kept as a last-ditch compatibility route for older markup.
    urls.push(format!("{}?page={}", root, page));

    for sort_name in sort_candidates {
        urls.push(format!("{}?sort={}&page={}", root, sort_name, page));
        urls.push(format!("{}?page={}&sort={}", root, page, sort_name));
    }

    urls.push(format!("{}?page={}", legacy_root, page));

    urls
}

fn modworkshop_rank_public_page_cards(mut mods: Vec<SourceModSummary>, page: u32) -> Vec<SourceModSummary> {
    let _ = page;

    for summary in mods.iter_mut() {
        summary.game_id = Some("payday-3".to_string());

        if summary.short_description.as_deref().map(|value| value.contains("Loaded from the PAYDAY 3")).unwrap_or(true) {
            summary.short_description = Some("Live ModWorkshop PAYDAY 3 listing card.".to_string());
        }

        if !summary.tags.iter().any(|tag| tag.eq_ignore_ascii_case("PAYDAY 3")) {
            summary.tags.push("PAYDAY 3".to_string());
        }
    }

    mods
}


fn scrape_modworkshop_summary_from_segment(full_html: &str, segment: &str, id: &str, full_center: usize, order_index: usize, title_hint: Option<&str>) -> SourceModSummary {
    let segment_center = segment.find(&format!("/mod/{}", id)).unwrap_or(0);
    let name = title_hint
        .map(|value| clean_mod_name(&clean_html_text(value)))
        .filter(|text| !text.is_empty() && !text.contains("Image"))
        .or_else(|| extract_anchor_text_for_mod(segment, id))
        .or_else(|| extract_anchor_text_for_mod(full_html, id))
        .or_else(|| html_between(segment, ">", "</a>").map(|text| clean_mod_name(&clean_html_text(&text))))
        .filter(|text| !text.is_empty() && !text.contains("Image"))
        .unwrap_or_else(|| format!("ModWorkshop Mod {}", id));

    let thumbnail = extract_first_img_near_for_source(segment, segment_center, "modworkshop")
        .or_else(|| extract_first_img_near_for_source(full_html, full_center, "modworkshop"));

    let _ = order_index;
    let updated_at = modworkshop_relative_updated_at(segment);

    SourceModSummary {
        source: "modworkshop".to_string(),
        source_id: id.to_string(),
        uid: None,
        game_id: Some("payday-3".to_string()),
        name,
        author: None,
        author_username: None,
        author_user_id: None,
        author_profile_url: None,
        author_avatar_url: None,
        version: None,
        thumbnail_url: thumbnail.clone(),
        banner_url: thumbnail,
        page_url: Some(format!("https://modworkshop.net/mod/{}", id)),
        updated_at,
        downloads: None,
        likes: None,
        short_description: Some("Live ModWorkshop PAYDAY 3 listing card.".to_string()),
        tags: vec!["ModWorkshop".to_string(), "PAYDAY 3".to_string()],
    }
}


fn extract_modworkshop_title_link_positions(html: &str) -> Vec<(String, usize, String)> {
    let mut result = Vec::<(String, usize, String)>::new();
    let mut seen = std::collections::BTreeSet::<String>::new();
    let mut search_start = 0;

    while let Some(pos) = html[search_start..].find("/mod/") {
        let abs = search_start + pos;
        let id_start = abs + "/mod/".len();
        let mut id = String::new();

        for ch in html[id_start..].chars() {
            if ch.is_ascii_digit() {
                id.push(ch);
            } else {
                break;
            }
        }

        let next_start = id_start + id.len();

        if id.is_empty() || seen.contains(&id) {
            search_start = next_start.max(search_start + pos + 5);
            continue;
        }

        let Some(tag_start) = html[..abs].rfind("<a") else {
            search_start = next_start.max(search_start + pos + 5);
            continue;
        };

        let Some(tag_end_relative) = html[abs..].find("</a>") else {
            search_start = next_start.max(search_start + pos + 5);
            continue;
        };

        let tag_end = abs + tag_end_relative + "</a>".len();
        let anchor = &html[tag_start..tag_end];

        let title = html_attr(anchor, "title")
            .map(|value| clean_mod_name(&clean_html_text(&value)))
            .or_else(|| Some(clean_mod_name(&clean_html_text(anchor))))
            .unwrap_or_default();

        let lower = title.to_lowercase();
        let bad_title = title.trim().is_empty()
            || lower == "image"
            || lower == "thumbnail"
            || lower == "avatar"
            || lower.contains("image:")
            || lower.contains("view mod")
            || lower.contains("mod page")
            || is_bad_modworkshop_listing_name(&title);

        if !bad_title {
            seen.insert(id.clone());
            result.push((id, tag_start, title));
        }

        search_start = tag_end.max(next_start.max(search_start + pos + 5));
    }

    result
}

fn scrape_modworkshop_public_page_cards_by_block(html: &str, page_size: usize) -> Vec<SourceModSummary> {
    let title_positions = extract_modworkshop_title_link_positions(html);
    let mut cards = Vec::<SourceModSummary>::new();

    for (index, (id, title_pos, title)) in title_positions.iter().enumerate() {
        let next_title_pos = title_positions
            .iter()
            .skip(index + 1)
            .map(|(_, next, _)| *next)
            .find(|next| *next > *title_pos)
            .unwrap_or_else(|| (*title_pos + 5200).min(html.len()));

        // Start before the title link so the thumbnail/image link stays inside this card.
        // End at the next *title* link, not the next /mod link. This prevents a thumbnail
        // link from chopping the current card before its visible "x ago" date.
        let start = title_pos.saturating_sub(1400);
        let end = next_title_pos.min(html.len());

        if start >= end {
            continue;
        }

        let segment = &html[start..end];

        // Real listing cards carry visible relative ages. This filters nav/footer links.
        if modworkshop_relative_age_seconds(segment).is_none() {
            continue;
        }

        let summary = scrape_modworkshop_summary_from_segment(html, segment, id, *title_pos, index, Some(title));

        if source_summary_is_payday3_safe(&summary) {
            cards.push(summary);
        }

        if cards.len() >= page_size {
            break;
        }
    }

    cards
}

fn modworkshop_api_sort_value(sort: &str) -> &'static str {
    match sort {
        "published_at" | "added" => "published_at",
        "bumped_at" | "updated" | "recent" => "bumped_at",
        "downloads" => "downloads",
        "likes" | "liked" => "likes",
        "views" => "views",
        "score" | "popular" => "score",
        "name" => "name",
        "best_match" => "score",
        _ => "bumped_at",
    }
}

fn modworkshop_api_browse_urls_for_game(game_id: &str, page: u32, sort: &str, query: Option<&str>, category_id: Option<&str>) -> Vec<String> {
    let page = page.max(1);
    let sort_name = modworkshop_api_sort_value(sort);
    let root = format!("https://api.modworkshop.net/games/{}/mods?page={}&sort={}", game_id, page, sort_name);
    let mut urls = Vec::new();
    let mut add_url = |base: String| {
        let mut url = base;
        if let Some(category_id) = category_id.map(str::trim).filter(|value| !value.is_empty()) {
            url.push_str("&category_id=");
            url.push_str(&percent_encode_query(category_id));
        }
        if let Some(query) = query.map(str::trim).filter(|value| !value.is_empty()) {
            url.push_str("&query=");
            url.push_str(&percent_encode_query(query));
        }
        urls.push(url);
    };

    add_url(root.clone());

    if query.map(str::trim).filter(|value| !value.is_empty()).is_some() {
        let mut search_url = format!("https://api.modworkshop.net/games/{}/mods?page={}&sort={}", game_id, page, sort_name);
        if let Some(category_id) = category_id.map(str::trim).filter(|value| !value.is_empty()) {
            search_url.push_str("&category_id=");
            search_url.push_str(&percent_encode_query(category_id));
        }
        search_url.push_str("&search=");
        search_url.push_str(&percent_encode_query(query.unwrap_or_default().trim()));
        urls.push(search_url);
    }

    urls.sort();
    urls.dedup();
    urls
}

fn modworkshop_public_browse_urls_for_game(game_id: &str, page: u32, sort: &str, query: Option<&str>, category_id: Option<&str>) -> Vec<String> {
    let page = page.max(1);
    let sort_value = modworkshop_sort_query_value(sort);
    let root = format!("https://modworkshop.net/g/{}/mods", game_id);
    let legacy_root = format!("https://modworkshop.net/g/{}", game_id);
    let mut urls = vec![format!("{}?page={}&sort={}", root, page, sort_value)];

    if let Some(category_id) = category_id.map(str::trim).filter(|value| !value.is_empty()) {
        urls.push(format!("{}?category_id={}&page={}&sort={}", root, percent_encode_query(category_id), page, sort_value));
    }

    if let Some(query) = query.map(str::trim).filter(|value| !value.is_empty()) {
        let encoded = percent_encode_query(query);
        urls.push(format!("{}?query={}&page={}&sort={}", root, encoded, page, sort_value));
        urls.push(format!("{}?search={}&page={}&sort={}", root, encoded, page, sort_value));
    }

    urls.push(format!("{}?page={}&sort={}", legacy_root, page, sort_value));
    urls.sort();
    urls.dedup();
    urls
}

fn modworkshop_profile_game_version(profile_id: Option<&str>, game_id: &str) -> Option<String> {
    let is_payday3 = normalize_modworkshop_game_route(game_id).ok().as_deref() == Some(MODWORKSHOP_PAYDAY3_GAME_ID);
    if !is_payday3 { return None; }
    let profile_id = profile_id.unwrap_or(BUILTIN_PAYDAY3_PROFILE_ID);
    let version = load_profile_settings_internal(profile_id).game_version
        .or_else(|| read_game_profile_draft(profile_id).ok().and_then(|draft| draft_overview_string(&draft, "gameVersion")))
        .filter(|version| matches!(version.as_str(), "UE4.27" | "UE5.5"))
        .unwrap_or_else(|| "UE5.5".to_string());
    Some(version)
}

fn modworkshop_version_matches(tags: &[String], version: &str) -> bool {
    let legacy = tags.iter().any(|tag| tag.eq_ignore_ascii_case("UE4.27"));
    if version == "UE4.27" { legacy } else { !legacy }
}

fn fetch_modworkshop_mods_page_for_version(game_id: &str, page: u32, sort: &str, query: Option<&str>, category_id: Option<&str>, version: Option<&str>) -> Result<Vec<SourceModSummary>, String> {
    let game_id = normalize_modworkshop_game_route(game_id)?;
    let Some(version) = version.filter(|_| game_id == MODWORKSHOP_PAYDAY3_GAME_ID) else {
        return fetch_modworkshop_mods_page_for_game(&game_id, page, sort, query, category_id);
    };
    let filter = if version == "UE4.27" { "tags%5B%5D=97" } else { "block_tags%5B%5D=97" };
    let url = modworkshop_api_browse_urls_for_game(&game_id, page, sort, query, category_id).into_iter().next().ok_or("No ModWorkshop API URL")?;
    let value = http_get_json_fast(&format!("{}&{}&limit=20", url, filter), 14)?;
    // Do not fall back to scraped pages: they omit engine tags and bypass compatibility filtering.
    Ok(parse_modworkshop_list_for_game(value, &game_id).into_iter().filter(|summary| modworkshop_version_matches(&summary.tags, version)).collect())
}

fn fetch_modworkshop_mods_page_for_game(game_id: &str, page: u32, sort: &str, query: Option<&str>, category_id: Option<&str>) -> Result<Vec<SourceModSummary>, String> {
    let game_id = normalize_modworkshop_game_route(game_id)?;
    let page = page.max(1);
    let page_size = 24usize;
    let query = query.map(str::trim).filter(|value| !value.is_empty());
    let category_id = category_id.map(str::trim).filter(|value| !value.is_empty());
    let mut notes = Vec::new();

    for url in modworkshop_api_browse_urls_for_game(&game_id, page, sort, query, category_id) {
        match http_get_json_fast(&url, 10) {
            Ok(value) => {
                let mut mods = parse_modworkshop_list_for_game(value, &game_id);
                if let Some(query) = query {
                    mods.retain(|summary| modworkshop_search_matches(summary, query));
                }
                let mods = modworkshop_sort_browser_summaries(dedupe_modworkshop_summaries_preserve_order(mods), sort)
                    .into_iter()
                    .take(page_size)
                    .collect::<Vec<_>>();
                return Ok(mods);
            }
            Err(error) => notes.push(format!("{} failed: {}", url, error)),
        }
    }

    // HTML cards do not prove game identity; never relabel them as the requested game.

    Err(format!("ModWorkshop live browser failed for game {} page {}. {}", game_id, page, notes.join(" | ")))
}

fn fetch_modworkshop_mods_page(page: u32, sort: &str) -> Result<Vec<SourceModSummary>, String> {
    let page = page.max(1);
    let page_size = 24usize;
    let mut notes = Vec::new();

    let prefer_public_order = matches!(sort, "recent" | "updated" | "added");

    if prefer_public_order {
        for url in modworkshop_game_page_public_urls(page, sort) {
            match http_get_text_fast(&url, 18) {
                Ok(html) => {
                    let mods = dedupe_modworkshop_summaries_preserve_order(scrape_modworkshop_public_page_cards_by_block(&html, page_size * 2))
                        .into_iter()
                        .map(|summary| force_payday3_modworkshop_summary(summary))
                        .filter(source_summary_is_payday3_safe)
                        .take(page_size)
                        .collect::<Vec<_>>();

                    if !mods.is_empty() {
                        return Ok(modworkshop_rank_public_page_cards(mods, page));
                    }

                    notes.push(format!("{} parsed zero PAYDAY 3 mod cards from {} byte HTML.", url, html.len()));
                }
                Err(error) => notes.push(format!("{} failed: {}", url, error)),
            }
        }
    }

    // Public ModWorkshop browsing works without an API key. Attach a saved key
    // when present, but never require one for public PAYDAY 3 browse pages.
    let modworkshop_api_key = load_settings_internal().modworkshop_api_key;
    for url in modworkshop_api_browse_probe_urls(page, sort) {
        match http_get_json_fast_with_api_key(&url, 8, modworkshop_api_key.as_deref()) {
            Ok(value) => {
                let mods = parse_modworkshop_list(value)
                    .into_iter()
                    .filter(source_summary_is_payday3_safe)
                    .collect::<Vec<_>>();

                let mods = modworkshop_sort_browser_summaries(dedupe_modworkshop_summaries_preserve_order(mods), sort)
                    .into_iter()
                    .take(page_size)
                    .collect::<Vec<_>>();

                if !mods.is_empty() {
                    return Ok(mods);
                }

                notes.push(format!("{} API parsed zero PAYDAY 3 cards.", url));
            }
            Err(error) => notes.push(format!("{} API failed: {}", url, error)),
        }
    }

    if !prefer_public_order {
        for url in modworkshop_game_page_public_urls(page, sort) {
            match http_get_text_fast(&url, 18) {
                Ok(html) => {
                    let mods = modworkshop_sort_browser_summaries(
                        dedupe_modworkshop_summaries_preserve_order(scrape_modworkshop_public_page_cards_by_block(&html, page_size * 2)),
                        sort,
                    )
                    .into_iter()
                    .take(page_size)
                    .collect::<Vec<_>>();

                    if !mods.is_empty() {
                        return Ok(modworkshop_rank_public_page_cards(mods, page));
                    }

                    notes.push(format!("{} parsed zero PAYDAY 3 mod cards from {} byte HTML.", url, html.len()));
                }
                Err(error) => notes.push(format!("{} failed: {}", url, error)),
            }
        }
    }

    Err(format!("ModWorkshop live browser rebuild failed. {}", notes.join(" | ")))
}







#[tauri::command]
fn window_minimize(app: tauri::AppHandle) -> Result<String, String> {
    let window = app
        .get_window("main")
        .or_else(|| app.windows().into_values().next())
        .ok_or_else(|| "Main window was not found.".to_string())?;

    window.minimize().map_err(|err| format!("Failed to minimize window: {}", err))?;
    Ok("Window minimized.".to_string())
}

#[tauri::command]
fn window_toggle_maximize(app: tauri::AppHandle) -> Result<String, String> {
    let window = app
        .get_window("main")
        .or_else(|| app.windows().into_values().next())
        .ok_or_else(|| "Main window was not found.".to_string())?;

    if window.is_maximized().unwrap_or(false) {
        window.unmaximize().map_err(|err| format!("Failed to restore window: {}", err))?;
        Ok("Window restored.".to_string())
    } else {
        window.maximize().map_err(|err| format!("Failed to maximize window: {}", err))?;
        Ok("Window maximized.".to_string())
    }
}

#[tauri::command]
fn window_close(app: tauri::AppHandle) -> Result<String, String> {
    let window = app
        .get_window("main")
        .or_else(|| app.windows().into_values().next())
        .ok_or_else(|| "Main window was not found.".to_string())?;

    window.close().map_err(|err| format!("Failed to close window: {}", err))?;
    Ok("Window closed.".to_string())
}

#[tauri::command]
fn window_start_dragging(app: tauri::AppHandle) -> Result<String, String> {
    let window = app
        .get_window("main")
        .or_else(|| app.windows().into_values().next())
        .ok_or_else(|| "Main window was not found.".to_string())?;

    window.start_dragging().map_err(|err| format!("Failed to start dragging window: {}", err))?;
    Ok("Window dragging started.".to_string())
}


fn saved_window_state_is_visible(state: &SavedWindowState) -> bool {
    state.width >= 900
        && state.height >= 600
        && state.width <= 8000
        && state.height <= 5000
        && state.x > -32000
        && state.y > -32000
}

fn default_window_size_for(settings: &AppSettings) -> (u32, u32) {
    match settings.interface_density.as_str() {
        "compact" => (1360, 820),
        "spacious" => (1600, 940),
        _ => (1500, 900),
    }
}

fn apply_initial_window_state(window: &tauri::WebviewWindow) -> Result<(), String> {
    let settings = load_settings_internal();
    let _ = window.set_decorations(false);
    let _ = window.set_resizable(true);
    let _ = window.set_min_size(Some(tauri::Size::Logical(tauri::LogicalSize {
        width: 1100.0,
        height: 700.0,
    })));

    if settings.remember_window_state {
        if let Some(state) = settings.window_state.as_ref().filter(|state| saved_window_state_is_visible(state)) {
            let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize {
                width: state.width,
                height: state.height,
            }));
            let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                x: state.x,
                y: state.y,
            }));
            if state.maximized.unwrap_or(false) {
                let _ = window.maximize();
            }
            return Ok(());
        }
    }

    let (width, height) = default_window_size_for(&settings);
    let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize { width, height }));
    let _ = window.center();
    Ok(())
}

fn persist_window_state(window: &tauri::WebviewWindow) {
    let mut settings = load_settings_internal();
    if !settings.remember_window_state {
        return;
    }

    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };

    settings.window_state = Some(SavedWindowState {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized: Some(window.is_maximized().unwrap_or(false)),
    });

    let _ = save_settings_internal(&settings);
}

fn register_window_state_persistence(window: &tauri::WebviewWindow) {
    let window_for_events = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) | WindowEvent::CloseRequested { .. } => {
            persist_window_state(&window_for_events);
        }
        _ => {}
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[cfg(test)]
mod profile_settings_tests {
    #[test]
    fn allowmods_runtime_diagnostics_use_the_latest_recorded_session() {
        assert!(allowmods_patch_failed("Starting C++ mod 'AllowModsMod'\n[AllowModsMod]: Delegate not found. Unable to patch."));
        assert!(!allowmods_patch_failed("Starting C++ mod 'AllowModsMod'\n[AllowModsMod]: Unable to patch.\nStarting C++ mod 'AllowModsMod'\n[AllowModsMod]: Init."));
        assert!(!allowmods_patch_failed("[OtherMod]: Unable to patch."));
    }
    #[test]
    fn app_update_version_matches_package_metadata() {
        assert_eq!(super::APP_VERSION, env!("CARGO_PKG_VERSION"));
        assert!(!super::version_is_newer(super::APP_VERSION, super::APP_VERSION));
    }
    use super::*;

    #[test]
    fn payday_engine_versions_route_distinct_ue4ss_trees() {
        let root = std::env::temp_dir().join("tsuki-pd3-layout-fixture");
        let ue5 = payday_paths_for_version(&root, "UE5.5");
        let ue4 = payday_paths_for_version(&root, "UE4.27");
        for (input, output) in [
            ("Mods/MyMod/Scripts/main.lua", "UE4SS/Mods/MyMod/Scripts/main.lua"),
            ("MyMod/Scripts/main.lua", "UE4SS/Mods/MyMod/Scripts/main.lua"),
            ("UE4SS/UE4SS_Signatures/GNatives.lua", "UE4SS/UE4SS_Signatures/GNatives.lua"),
            ("UE4SS/Mods/AllowModsMod/dlls/AllowModsMod.dll", "UE4SS/Mods/AllowModsMod/dlls/AllowModsMod.dll"),
            ("UE4SS/Mods/mods.txt", "UE4SS/Mods/mods.txt"),
            ("MyMod/enabled.txt", "UE4SS/Mods/MyMod/enabled.txt"),
            ("dwmapi.dll", "dwmapi.dll"),
            ("UE4SS.dll", "UE4SS/UE4SS.dll"),
        ] {
            let entry = infer_archive_entry_destination(&ue5, input, "UE4SS");
            assert!(!entry.blocked, "{}: {}", input, entry.reason);
            assert_eq!(Path::new(&entry.destination), ue5.win64.join(output));
        }
        assert_eq!(payday_ue4ss_relative_path(&ue4, "Mods/MyMod/Scripts/main.lua"), "Mods/MyMod/Scripts/main.lua");
        assert!(common_archive_root(&["MyMod/Scripts/main.lua".to_string()]).is_none());
        assert!(common_archive_root(&["UE4SS/UE4SS.dll".to_string()]).is_none());
        let pak = infer_archive_entry_destination(&ue5, "Example_P.pak", "");
        assert!(validate_payday_ue5_dependencies(&ue5, &[pak]).is_err());
    }

    #[test]
    fn payday_missing_receipt_is_not_live_even_when_disabled() {
        let root = std::env::temp_dir().join(format!("tsuki-receipt-presence-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        let paths = payday_paths_for_version(&root, "UE5.5");
        let original = paths.ue4ss_mods.join("Example/Scripts/main.lua");
        let receipt: InstallReceipt = serde_json::from_value(serde_json::json!({
            "id": "fixture", "displayName": "Example", "source": "local", "modType": "ue4ss", "enabled": false,
            "files": [{"relativePath": original.display().to_string()}]
        })).unwrap();
        let record = installed_state_record_from_receipt(&paths, &receipt);
        assert!(!record.files.iter().any(|file| file.live));
        let disabled = disabled_destination_for_receipt_file(&paths, &receipt, &original, &receipt.files[0]);
        fs::create_dir_all(disabled.parent().unwrap()).unwrap();
        fs::write(&disabled, b"fixture").unwrap();
        assert!(installed_state_record_from_receipt(&paths, &receipt).files.iter().any(|file| file.live));
        fs::remove_file(disabled).unwrap();
        assert!(!installed_state_record_from_receipt(&paths, &receipt).files.iter().any(|file| file.live));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn modworkshop_lists_reject_other_games_and_unidentified_cards() {
        let fixture = serde_json::json!({ "data": [
            { "id": 10, "name": "Legacy PD3", "game_id": 853, "tags": [{ "id": 97 }] },
            { "id": 11, "name": "PD2", "game_id": 1, "tags": [{ "id": 97, "name": "UE4.27" }] },
            { "id": 12, "name": "Unknown", "category": { "name": "PAYDAY 3" } },
            { "id": 13, "name": "PDTH", "game_id": 2 }
        ] });
        let payday3 = parse_modworkshop_list_for_game(fixture.clone(), "853");
        assert_eq!(payday3.len(), 1);
        assert_eq!(payday3[0].source_id, "10");
        assert!(modworkshop_version_matches(&payday3[0].tags, "UE4.27"));
        assert!(!modworkshop_version_matches(&payday3[0].tags, "UE5.5"));
        let payday2 = parse_modworkshop_list_for_game(fixture.clone(), "payday-2");
        assert_eq!(payday2.len(), 1);
        assert_eq!(payday2[0].source_id, "11");
        let heist = parse_modworkshop_list_for_game(fixture, "pdth");
        assert_eq!(heist.len(), 1);
        assert_eq!(heist[0].source_id, "13");
    }

    #[test]
    fn structured_builtin_sources_resolve_without_legacy_fields() {
        for (profile, expected) in [("builtin.payday2", "payday-2"), ("builtin.payday-the-heist", "pdth"), ("builtin.payday3", "payday-3")] {
            let config = builtin_profile_source_config(profile).unwrap();
            assert_eq!(modworkshop_game_route_from_source_config(&config).as_deref(), Some(expected));
        }
        let config = builtin_profile_source_config("builtin.outlast-trials").unwrap();
        assert_eq!(nexus_domain_from_source_config(&config).as_deref(), Some("theoutlasttrials"));
        let mut config = builtin_profile_source_config("builtin.payday3").unwrap();
        config["modworkshopSlug"] = serde_json::json!("payday-2");
        assert_eq!(modworkshop_game_route_from_source_config(&config).as_deref(), Some("payday-3"));
    }

    #[test]
    fn payday3_engine_filter_distinguishes_ue4ss_from_ue427() {
        assert!(modworkshop_version_matches(&["UE4SS".to_string()], "UE5.5"));
        assert!(!modworkshop_version_matches(&["UE4.27".to_string()], "UE5.5"));
        assert!(modworkshop_version_matches(&["ue4.27".to_string()], "UE4.27"));
        assert!(!modworkshop_version_matches(&["UE4SS".to_string()], "UE4.27"));
    }

    #[test]
    fn payday3_game_version_migrates_to_ue5_and_preserves_legacy_choice() {
        let current = normalize_profile_settings(ProfileSettings::default(), BUILTIN_PAYDAY3_PROFILE_ID);
        assert_eq!(current.game_version.as_deref(), Some("UE5.5"));
        let legacy = normalize_profile_settings(ProfileSettings { game_version: Some("UE4.27".to_string()), ..Default::default() }, BUILTIN_PAYDAY3_PROFILE_ID);
        let saved = serde_json::to_string(&legacy).unwrap();
        let restored: ProfileSettings = serde_json::from_str(&saved).unwrap();
        assert_eq!(restored.game_version.as_deref(), Some("UE4.27"));
    }

    #[test]
    fn steam_manifest_value_reads_exact_quoted_keys() {
        let manifest = r#"
        "AppState"
        {
            "appid"        "218620"
            "installdir"   "PAYDAY 2"
        }
        "#;

        assert_eq!(steam_manifest_value(manifest, "installdir").as_deref(), Some("PAYDAY 2"));
        assert_eq!(steam_manifest_value(manifest, "app").as_deref(), None);
    }

    #[test]
    fn spider_man_2_launch_mapping_prefers_current_executable() {
        assert_eq!(profile_installs::builtin_profile_executable_markers("builtin.spider-man-2"), &["Spider-Man2.exe", "SpiderMan2.exe"]);
        assert_eq!(builtin_profile_steam_app_ids("builtin.spider-man-2"), &["2651280"]);
        assert_eq!(split_launch_arguments(r#"-windowed "profile test""#), vec!["-windowed", "profile test"]);
    }

    #[test]
    fn normalize_profile_settings_forces_requested_profile_id() {
        let settings = ProfileSettings {
            profile_id: "wrong.profile".to_string(),
            browser_mode_override: "sideways".to_string(),
            preferred_browser_source: "nexus".to_string(),
            enabled_sources: vec!["nexus".to_string(), "bad".to_string(), "nexus".to_string()],
            backup_retention_count: 900,
            game_root_override: Some("  C:\\Games\\Example  ".to_string()),
            executable_override: Some("   ".to_string()),
            ..ProfileSettings::default()
        };

        let normalized = normalize_profile_settings(settings, "profile.two");

        assert_eq!(normalized.profile_id, "profile.two");
        assert_eq!(normalized.browser_mode_override, "inherit");
        assert_eq!(normalized.preferred_browser_source, "nexus");
        assert_eq!(normalized.enabled_sources, vec!["nexus".to_string()]);
        assert_eq!(normalized.backup_retention_count, 50);
        assert_eq!(normalized.game_root_override.as_deref(), Some("C:\\Games\\Example"));
        assert!(normalized.executable_override.is_none());
    }

    #[test]
    fn reset_profile_settings_scope_keeps_profile_isolated() {
        let mut settings = normalize_profile_settings(ProfileSettings::default(), "profile.alpha");
        settings.browser_mode_override = "embedded".to_string();
        settings.preferred_browser_source = "modworkshop".to_string();
        settings.remember_last_website = false;
        let defaults = normalize_profile_settings(ProfileSettings::default(), "profile.alpha");

        reset_profile_settings_scope(&mut settings, &defaults, "browsing").unwrap();

        assert_eq!(settings.profile_id, "profile.alpha");
        assert_eq!(settings.browser_mode_override, "inherit");
        assert_eq!(settings.preferred_browser_source, "auto");
        assert!(settings.remember_last_website);
    }

    #[test]
    fn modworkshop_game_routes_normalize_profile_mappings() {
        assert_eq!(normalize_modworkshop_game_route("853").unwrap(), "payday-3");
        assert_eq!(normalize_modworkshop_game_route("PAYDAY 2").unwrap(), "payday-2");
        assert_eq!(normalize_modworkshop_game_route("ready_or_not").unwrap(), "ready-or-not");
        assert!(normalize_modworkshop_game_route("../payday-2").is_err());
    }

    #[test]
    fn profile_source_config_splits_names_slugs_ids_and_urls() {
        let draft = serde_json::json!({
            "overview": {},
            "sections": {
                "sources": [
                    {
                        "title": "Nexus Mods",
                        "fields": [
                            { "label": "Source Type", "value": "nexus" },
                            { "label": "Display Name", "value": "Nexus Mods" },
                            { "label": "Human Game Name", "value": "Ready or Not" },
                            { "label": "Nexus Game ID", "value": "1234" },
                            { "label": "Nexus Game Page URL", "value": "https://www.nexusmods.com/readyornot/mods/?tab=popular" }
                        ]
                    },
                    {
                        "title": "ModWorkshop",
                        "fields": [
                            { "label": "Source Type", "value": "modworkshop" },
                            { "label": "Display Name", "value": "ModWorkshop" },
                            { "label": "Human Game Name", "value": "The Outlast Trials" },
                            { "label": "ModWorkshop Game ID", "value": "999" },
                            { "label": "ModWorkshop Game Page URL", "value": "https://modworkshop.net/g/the-outlast-trials/mods/?category_id=7" }
                        ]
                    }
                ]
            }
        });
        let config = source_config_from_draft(&draft);

        assert_eq!(config.get("nexusGameName").and_then(|value| value.as_str()), Some("Ready or Not"));
        assert_eq!(config.get("nexusDomain").and_then(|value| value.as_str()), Some("readyornot"));
        assert_eq!(config.get("nexusGameId").and_then(|value| value.as_str()), Some("1234"));
        assert_eq!(config.get("modworkshopGameName").and_then(|value| value.as_str()), Some("The Outlast Trials"));
        assert_eq!(config.get("modworkshopSlug").and_then(|value| value.as_str()), Some("the-outlast-trials"));
        assert_eq!(config.get("modworkshopGameId").and_then(|value| value.as_str()), Some("999"));
        let sources = config.get("sources").and_then(|value| value.as_array()).expect("ordered sources");
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].get("gamePageUrl").and_then(|value| value.as_str()), Some("https://www.nexusmods.com/readyornot/mods/?tab=popular"));
        assert_eq!(sources[0].get("gameName").and_then(|value| value.as_str()), Some("Ready or Not"));
        assert_eq!(sources[1].get("gameName").and_then(|value| value.as_str()), Some("The Outlast Trials"));
    }

    #[test]
    fn four_profile_sources_keep_stable_identity_and_order() {
        let source = |id: &str, title: &str, provider: &str, mode: &str, url: &str| serde_json::json!({
            "id": id,
            "title": title,
            "enabled": true,
            "fields": [
                { "label": "Source Instance ID", "value": id },
                { "label": "Source Type", "value": provider },
                { "label": "Display Name", "value": title },
                { "label": "Browse Mode", "value": mode },
                { "label": if provider == "nexus" { "Nexus Domain" } else { "ModWorkshop Slug" }, "value": if provider == "nexus" { "payday2" } else { "payday-2" } },
                { "label": if provider == "nexus" { "Nexus Game ID" } else { "ModWorkshop Game ID" }, "value": if provider == "nexus" { "305" } else { "1" } },
                { "label": if provider == "nexus" { "Nexus Game Page URL" } else { "ModWorkshop Game Page URL" }, "value": url },
                { "label": "Embedded Start URL", "value": url }
            ]
        });
        let draft = serde_json::json!({ "sections": { "sources": [
            source("source-payday2-modworkshop-api", "ModWorkshop", "modworkshop", "Built-in/API", "https://modworkshop.net/g/payday-2/mods"),
            source("source-payday2-nexus-api", "Nexus Mods", "nexus", "Built-in/API", "https://www.nexusmods.com/payday2"),
            source("source-payday2-modworkshop-browser", "ModWorkshop Browser", "modworkshop", "Embedded", "https://modworkshop.net/g/payday-2/mods"),
            source("source-payday2-nexus-browser", "Nexus Browser", "nexus", "Embedded", "https://www.nexusmods.com/payday2/mods")
        ] } });
        let config = source_config_from_draft(&draft);
        let sources = config.get("sources").and_then(|value| value.as_array()).expect("ordered source array");
        assert_eq!(sources.len(), 4);
        assert_eq!(sources.iter().filter(|source| source.get("provider").and_then(|value| value.as_str()) == Some("nexus")).count(), 2);
        assert_eq!(sources.iter().filter(|source| source.get("provider").and_then(|value| value.as_str()) == Some("modworkshop")).count(), 2);
        assert_eq!(sources.iter().filter_map(|source| source.get("id").and_then(|value| value.as_str())).collect::<Vec<_>>(), vec![
            "source-payday2-modworkshop-api",
            "source-payday2-nexus-api",
            "source-payday2-modworkshop-browser",
            "source-payday2-nexus-browser",
        ]);
        assert_eq!(source_names_from_config(&config, None).len(), 4);
    }

    #[test]
    fn builtin_borderlands_sources_keep_variant_specific_nexus_identity() {
        let config = builtin_profile_source_config("builtin.borderlands").expect("Borderlands source config");
        let sources = config.get("sources").and_then(|value| value.as_array()).expect("source array");
        assert_eq!(sources.len(), 4);
        assert_eq!(sources.iter().filter_map(|source| json_string(source, "id")).collect::<Vec<_>>(), vec![
            "borderlands-nexus-api",
            "borderlands-nexus-browser",
            "borderlands-enhanced-nexus-api",
            "borderlands-enhanced-nexus-browser",
        ]);
        assert_eq!(sources[0].get("providerSlug").and_then(|value| value.as_str()), Some("borderlands"));
        assert_eq!(sources[0].get("providerGameId").and_then(|value| value.as_str()), Some("360"));
        assert_eq!(sources[2].get("providerSlug").and_then(|value| value.as_str()), Some("borderlandsgotyenhanced"));
        assert_eq!(sources[2].get("providerGameId").and_then(|value| value.as_str()), Some("2776"));
        let selected = source_config_for_profile_source(Some("builtin.borderlands"), Some("borderlands-enhanced-nexus-api"));
        assert_eq!(nexus_domain_from_source_config(&selected).as_deref(), Some("borderlandsgotyenhanced"));
        assert_eq!(config_string(&selected, "nexusGameId").as_deref(), Some("2776"));
    }

    #[test]
    fn builtin_borderlands2_sources_never_fall_back_to_payday() {
        let config = builtin_profile_source_config("builtin.borderlands2").expect("Borderlands 2 source config");
        let sources = config.get("sources").and_then(|value| value.as_array()).expect("source array");
        assert_eq!(sources.len(), 2);
        assert!(sources.iter().all(|source| source.get("providerSlug").and_then(|value| value.as_str()) == Some("borderlands2")));
        assert!(sources.iter().all(|source| source.get("providerGameId").and_then(|value| value.as_str()) == Some("428")));
        assert!(sources.iter().all(|source| !source.to_string().contains("payday")));
    }

    #[test]
    fn every_builtin_profile_has_exact_catalog_sources() {
        let expected = [
            ("builtin.cyberpunk2077", "cyberpunk2077", "3333"),
            ("builtin.outlast-trials", "theoutlasttrials", "5376"),
            ("builtin.payday-the-heist", "paydaytheheist", "4339"),
            ("builtin.payday2", "payday2", "648"),
            (BUILTIN_PAYDAY3_PROFILE_ID, "payday3", "5717"),
            ("builtin.resident-evil-7", "residentevil7", "3111"),
            ("builtin.resident-evil-village", "residentevilvillage", "3669"),
            ("builtin.resident-evil-requiem", "residentevilrequiem", "8863"),
            ("builtin.borderlands2", "borderlands2", "428"),
            ("builtin.borderlands3", "borderlands3", "2953"),
            ("builtin.borderlands4", "borderlands4", "8148"),
            ("builtin.tiny-tinas-wonderlands", "tinytinaswonderlands", "4394"),
            ("builtin.spider-man-remastered", "marvelsspidermanremastered", "4536"),
            ("builtin.spider-man-2", "marvelsspiderman2", "6082"),
            ("builtin.monster-hunter-wilds", "monsterhunterwilds", "6993"),
        ];
        for (profile_id, domain, game_id) in expected {
            let config = builtin_profile_source_config(profile_id).unwrap_or_else(|| panic!("missing source config for {}", profile_id));
            let sources = config.get("sources").and_then(|value| value.as_array()).expect("source array");
            let nexus = sources.iter().find(|source| json_string(source, "provider").as_deref() == Some("nexus") && json_string(source, "browseMode").as_deref() == Some("api")).unwrap_or_else(|| panic!("missing Nexus API source for {}", profile_id));
            assert_eq!(json_string(nexus, "providerSlug").as_deref(), Some(domain));
            assert_eq!(json_string(nexus, "providerGameId").as_deref(), Some(game_id));
        }

        for (profile_id, slug, game_id) in [
            ("builtin.payday-the-heist", "pdth", "2"),
            ("builtin.payday2", "payday-2", "1"),
            (BUILTIN_PAYDAY3_PROFILE_ID, "payday-3", "853"),
        ] {
            let config = builtin_profile_source_config(profile_id).expect("PAYDAY source config");
            let sources = config.get("sources").and_then(|value| value.as_array()).expect("source array");
            let modworkshop = sources.iter().find(|source| json_string(source, "provider").as_deref() == Some("modworkshop") && json_string(source, "browseMode").as_deref() == Some("api")).expect("ModWorkshop API source");
            assert_eq!(json_string(modworkshop, "providerSlug").as_deref(), Some(slug));
            assert_eq!(json_string(modworkshop, "providerGameId").as_deref(), Some(game_id));
        }
    }

    #[test]
    fn legacy_nexus_api_source_recovers_its_saved_browser_source() {
        let draft = serde_json::json!({
            "sourceConfigMigrationVersion": 2,
            "sections": { "sources": [{
                "id": "source-payday2-nexus-api",
                "title": "Nexus Mods",
                "enabled": true,
                "fields": [
                    { "label": "Source Instance ID", "value": "source-payday2-nexus-api" },
                    { "label": "Source Type", "value": "nexus" },
                    { "label": "Display Name", "value": "Nexus Mods" },
                    { "label": "Browse Mode", "value": "Built-in/API" },
                    { "label": "Human Game Name", "value": "PAYDAY 2" },
                    { "label": "Nexus Domain", "value": "games" },
                    { "label": "Nexus Game ID", "value": "648" },
                    { "label": "Nexus Game Page URL", "value": "https://www.nexusmods.com/games/payday2" },
                    { "label": "Embedded Start URL", "value": "https://www.nexusmods.com/payday2/mods" },
                    { "label": "Allowed Domains", "value": "nexusmods.com, www.nexusmods.com" }
                ]
            }] }
        });

        let config = source_config_from_draft(&draft);
        let sources = config.get("sources").and_then(|value| value.as_array()).expect("source array");
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].get("id").and_then(|value| value.as_str()), Some("source-payday2-nexus-api"));
        assert_eq!(sources[0].get("providerSlug").and_then(|value| value.as_str()), Some("payday2"));
        assert_eq!(sources[1].get("id").and_then(|value| value.as_str()), Some("source-payday2-nexus-api.browser"));
        assert_eq!(sources[1].get("displayName").and_then(|value| value.as_str()), Some("Nexus Browser"));
        assert_eq!(sources[1].get("browseMode").and_then(|value| value.as_str()), Some("webview_window"));
    }

    #[test]
    fn legacy_modworkshop_game_id_slug_migrates_without_breaking_payday2() {
        let draft = serde_json::json!({
            "overview": {},
            "sections": {
                "sources": [{
                    "title": "ModWorkshop",
                    "fields": [
                        { "label": "Source Type", "value": "modworkshop" },
                        { "label": "Selected ModWorkshop Game", "value": "PAYDAY 2" },
                        { "label": "ModWorkshop Game ID", "value": "payday-2" }
                    ]
                }]
            }
        });
        let config = source_config_from_draft(&draft);

        assert_eq!(config.get("modworkshopGameName").and_then(|value| value.as_str()), Some("PAYDAY 2"));
        assert_eq!(config.get("modworkshopSlug").and_then(|value| value.as_str()), Some("payday-2"));
        assert!(config.get("modworkshopGameId").is_none());
        assert_eq!(modworkshop_game_route_from_source_config(&config).as_deref(), Some("payday-2"));
    }

    #[test]
    fn modworkshop_payday_alias_url_is_canonicalized_for_managed_browsing() {
        let parsed = parse_modworkshop_game_url_fields("https://modworkshop.net/g/payday2/mods")
            .expect("ModWorkshop PAYDAY 2 URL should parse");

        assert_eq!(parsed.0.as_deref(), Some("payday-2"));
        assert_eq!(parsed.2, "https://modworkshop.net/g/payday-2/mods");

        let draft = serde_json::json!({
            "overview": {},
            "sections": {
                "sources": [{
                    "title": "ModWorkshop Browser",
                    "fields": [
                        { "label": "Source Type", "value": "embedded" },
                        { "label": "Starting Page URL", "value": "https://modworkshop.net/g/payday2/mods" }
                    ]
                }]
            }
        });
        let config = source_config_from_draft(&draft);
        let source = config.get("sources").and_then(|value| value.as_array()).and_then(|sources| sources.first()).expect("managed source");
        assert_eq!(source.get("startUrl").and_then(|value| value.as_str()), Some("https://modworkshop.net/g/payday-2/mods"));
    }

    #[test]
    fn github_source_survives_runtime_config_conversion() {
        let draft = serde_json::json!({
            "overview": {},
            "sections": {
                "sources": [{
                    "id": "github-source",
                    "title": "GitHub Releases",
                    "fields": [
                        { "label": "Source Type", "value": "github" },
                        { "label": "Repository URL", "value": "https://github.com/owner/repository/releases" },
                        { "label": "Browse Mode", "value": "Built-in/API" }
                    ]
                }]
            }
        });
        let config = source_config_from_draft(&draft);
        let source = config.get("sources").and_then(|value| value.as_array()).and_then(|sources| sources.first()).expect("GitHub source");

        assert_eq!(source.get("provider").and_then(|value| value.as_str()), Some("github"));
        assert_eq!(source.get("providerSlug").and_then(|value| value.as_str()), Some("owner"));
        assert_eq!(source.get("providerGameId").and_then(|value| value.as_str()), Some("repository"));
        assert_eq!(source.get("gamePageUrl").and_then(|value| value.as_str()), Some("https://github.com/owner/repository"));
    }

    #[test]
    fn modworkshop_categories_parse_real_api_shape() {
        let categories = parse_modworkshop_categories(serde_json::json!({
            "data": [
                { "id": 20, "name": "HUD", "game_id": 853 },
                { "id": "5", "name": "Audio" },
                { "id": "20", "name": "HUD Duplicate" },
                { "id": "", "name": "Broken" }
            ]
        }));

        assert_eq!(categories.len(), 2);
        assert!(categories.iter().any(|category| category.id == "5" && category.label == "Audio"));
        assert!(categories.iter().any(|category| category.id == "20" && category.label == "HUD"));
    }

    #[test]
    fn modworkshop_browse_urls_use_scoped_game_and_category_id() {
        let urls = modworkshop_api_browse_urls_for_game("payday-2", 2, "updated", Some("hud names"), Some("17"));

        assert!(urls.iter().any(|url| url.starts_with("https://api.modworkshop.net/games/payday-2/mods?page=2")));
        assert!(urls.iter().all(|url| url.contains("category_id=17")));
        assert!(urls.iter().all(|url| !url.contains("category=17")));
        assert!(urls.iter().any(|url| url.contains("query=hud+names")));
    }

    #[test]
    fn modworkshop_summary_uses_nested_user_author_fields() {
        assert_eq!(extract_modworkshop_api_description(&serde_json::json!({
            "desc": "Actual mod description",
            "files": [{"description": "Filename only"}]
        })).as_deref(), Some("Actual mod description"));
        let summary = modworkshop_summary_from_api_value_for_game(&serde_json::json!({
            "id": 12345,
            "name": "Better Masks",
            "game_id": 1,
            "user": {
                "id": 77,
                "name": "Actual Author",
                "unique_name": "actual_author",
                "avatar": "avatar.webp",
                "avatar_has_thumb": true
            }
        }), Some("payday-2")).expect("summary");

        assert_eq!(summary.source_id, "12345");
        assert_eq!(summary.game_id.as_deref(), Some("1"));
        assert_eq!(summary.author.as_deref(), Some("Actual Author"));
        assert_eq!(summary.author_username.as_deref(), Some("actual_author"));
        assert_eq!(summary.author_user_id.as_deref(), Some("77"));
        assert_eq!(summary.author_profile_url.as_deref(), Some("https://modworkshop.net/user/77"));
        assert_eq!(summary.author_avatar_url.as_deref(), Some("https://storage.modworkshop.net/users/images/thumbnail_avatar.webp"));
    }

    #[test]
    fn nexus_frontend_sort_names_map_to_api_sort_names() {
        assert_eq!(canonical_nexus_sort("published_at"), "added");
        assert_eq!(canonical_nexus_sort("bumped_at"), "updated");
        assert_eq!(canonical_nexus_sort("likes"), "liked");
        assert_eq!(canonical_nexus_sort("downloads"), "downloads");
    }

    #[test]
    fn nexus_dedupe_keeps_other_games_and_game_scoped_ids() {
        let node = serde_json::json!({"modId": 42, "name": "Sample HUD", "gameId": 648});
        let payday2 = force_nexus_game_summary(nexus_summary_from_graphql_node(&node).unwrap(), "payday2");
        let outlast = force_nexus_game_summary(nexus_summary_from_graphql_node(&node).unwrap(), "theoutlasttrials");
        let cards = nexus_dedupe_summaries(vec![payday2.clone(), payday2, outlast]);
        assert_eq!(cards.len(), 2);
        assert!(cards.iter().all(|card| !card.tags.iter().any(|tag| tag == "Payday 3")));
    }

    #[test]
    fn nexus_pagination_uses_server_counts_not_filtered_card_count() {
        assert!(nexus_page_has_more(1, 20, 20, Some(45)));
        assert!(nexus_page_has_more(2, 20, 20, Some(45)));
        assert!(!nexus_page_has_more(3, 20, 5, Some(45)));
        assert!(!nexus_page_has_more(1, 20, 0, Some(0)));
        assert!(nexus_page_has_more(1, 20, 20, None));
        assert!(!nexus_page_has_more(2, 20, 4, None));
    }

    #[test]
    fn nexus_browse_pages_share_the_ui_page_size_and_domain() {
        for (page, offset) in [(1, 0), (2, 20), (3, 40)] {
            let variants = nexus_graphql_query_variants_for_page_for_domain("cyberpunk2077", "updated", page, 20);
            assert_eq!(variants[0].1["offset"], offset);
            assert_eq!(variants[0].1["count"], 20);
            assert_eq!(variants[0].1["filter"]["gameDomainName"][0]["value"], "cyberpunk2077");
        }
    }

    #[test]
    fn nexus_newest_uses_created_at_and_latest_added() {
        assert_eq!(
            nexus_graphql_sort_value("published_at"),
            serde_json::json!({ "createdAt": { "direction": "DESC" } })
        );
        assert_eq!(nexus_rest_endpoint_order("published_at")[0], "latest_added.json");
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(BackupState {
            progress: Mutex::new(BackupProgress::default()),
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            if let Ok(root) = ensure_app_data_dirs() {
                if let Err(err) = text_encoding::run_persisted_text_encoding_migration(&root) {
                    eprintln!("Text encoding migration skipped: {}", err);
                }
            }

            // Restore any crashed vanilla temp session when Tsuki starts and PAYDAY 3 is not running.
            if read_vanilla_launch_session().is_some() && !payday_process_running() {
                let _ = restore_mods_after_vanilla_launch();
            }

            if should_auto_relaunch_as_admin() {
                if relaunch_current_exe_as_admin_internal().is_ok() {
                    std::process::exit(0);
                }
            }

            if let Some(window) = app.get_webview_window("main") {
                let _ = apply_initial_window_state(&window);
                register_window_state_persistence(&window);
                let _ = window.show();
                let _ = window.set_focus();
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            managed_loaders::managed_loader_status,
            managed_loaders::managed_loader_action,
            window_minimize,
            window_toggle_maximize,
            window_close,
            window_start_dragging,
            get_app_settings,
            save_app_settings,
            get_profile_settings,
            save_profile_settings,
            reset_profile_settings,
            open_profile_settings_folder,
            open_game_profile_data_folder,
            list_game_profile_drafts,
            create_game_profile_draft,
            save_game_profile_draft,
            delete_game_profile_draft,
            duplicate_game_profile_draft,
            detect_game_profile_installations,
            export_game_profile_draft_to_path,
            activate_game_profile_runtime,
            get_profile_launch_mapping,
            launch_active_profile_vanilla,
            launch_active_profile_modded,
            open_game_profile_draft_runtime,
            preview_game_profile_setup,
            run_profile_creator_test_action,
            save_profile_artwork_data_url,
            cache_profile_artwork_remote_url,
            import_profile_artwork_image,
            resolve_profile_artwork_image_src,
            scan_game_folder_basic,
            read_profile_creator_import_file,
            write_profile_creator_text_file,
            test_profile_source_config,
            test_github_public_repository,
            export_app_settings_to_path,
            import_app_settings_from_path,
            reset_app_settings,
            migrate_text_encoding_stores,
            save_game_path,
            clear_game_path,
            save_theme,
            save_source_api_keys,
            clear_source_api_keys,
            save_app_update_settings,
            check_app_update,
            download_and_launch_app_update,
            open_external_url,
            open_embedded_browser_window,
            is_embedded_browser_window_open,
            get_embedded_browser_status,
            set_embedded_browser_bounds,
            control_embedded_browser_window,
            open_installed_mod_file_location,
            launch_payday3_vanilla,
            launch_payday3_modded,
            restore_mods_after_vanilla,
            payday3_runtime_lock_status,
            is_running_as_admin,
            relaunch_tsuki_as_admin,
            open_source_file_download,
            stage_source_file_download,
            install_staged_file_to_game,
            profile_installs::analyze_drag_drop_install,
            profile_installs::install_drag_drop_item,
            profile_installs::prepare_external_manager_handoff,
            profile_installs::get_external_manager_target,
            fetch_modworkshop_categories,
            fetch_source_mods_page,
            fetch_nexus_browse_page,
            fetch_modworkshop_browse_live_page,
            fetch_modworkshop_filter_page,
            diagnose_modworkshop_browse_live,
            diagnose_modworkshop_categories,
            match_installed_source_mods,
            source_catalog::match_installed_source_index_v2,
            diagnose_modworkshop_pairing,
            remove_raid_ww2_bad_install,
            list_source_index,
            get_source_index_status,
            get_source_index_diagnostics,
            refresh_source_index_v2_remote,
            refresh_source_index_v2_remote_if_stale,
            fetch_nexus_updated_mods,
            fetch_nexus_mod_detail,
            nexus_graphql_v2_status,
            get_nexus_graphql_diagnostic,
            nexus_account_integration_status,
            build_nexus_payday3_index,
            fetch_modworkshop_mod_detail,
            search_modworkshop_mods_for_query,
            search_nexus_mods_for_query,
            preview_source_mod_install,
            open_nexus_login_page,
            verify_source_settings,
            list_install_receipts,
            prune_stale_install_receipts,
            get_dependency_report,
            list_receipt_repair_items,
            remove_receipt_by_id,
            validate_movie_replacer_receipts,
            list_managed_installs,
            list_installed_state_records,
            list_persistent_source_pairs,
            persist_confirmed_source_pair,
            check_installed_source_updates,
            set_managed_install_enabled,
            set_source_install_enabled,
            uninstall_source_install,
            uninstall_managed_install,
            list_mod_profiles,
            save_current_mod_profile,
            apply_mod_profile,
            delete_mod_profile,
            get_debug_report,
            get_last_install_diagnostic,
            record_runtime_process_diagnostic,
            run_health_check,
            detect_payday3_path,
            detect_active_profile_path,
            scan_pak_mods,
            set_pak_mod_files_enabled,
            uninstall_pak_mod_files,
            open_pak_mods_folder,
            open_backups_folder,
            open_mod_profiles_folder,
            open_downloads_folder,
            open_extraction_cache_folder,
            open_receipts_folder,
            open_indexes_folder,
            open_uninstalled_folder,
            open_logs_folder,
            open_thumbnails_folder,
            open_app_data_folder,
            open_cache_folder,
            get_cache_stats,
            clear_download_cache,
            clear_extraction_cache,
            clear_all_download_cache,
            save_cache_settings,
            save_uninstall_storage_settings,
            list_pak_backups,
            open_backup_file,
            inspect_pak_backup,
            restore_pak_backup,
            get_backup_status,
            create_pak_backup,
            delete_pak_backup
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
