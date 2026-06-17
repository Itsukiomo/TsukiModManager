use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
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
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};
use zip::write::SimpleFileOptions;
use zip::ZipArchive;
use sha2::{Digest, Sha256};

mod source_models;
mod source_http;
mod nexus;
mod modworkshop;

const APP_VERSION: &str = "1.8.2";
const APP_DIR_NAME: &str = "Tsuki Mod Manager";
const SETTINGS_FILE_NAME: &str = "settings.json";
const DEFAULT_THEME_ID: &str = "moonveil";
// Fill this with your real public latest.json URL before final release,
// or set it in Settings -> App Update on the user's machine.
// Example: https://raw.githubusercontent.com/<you>/<repo>/main/latest.json
const DEFAULT_APP_UPDATE_MANIFEST_URL: &str = "https://raw.githubusercontent.com/Itsukiomo/TsukiModManager/main/latest.json";

static LAUNCH_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

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
    name: String,
    created_unix: u64,
    enabled_pak_files: Vec<String>,
    enabled_receipt_ids: Vec<String>,
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
        match set_pak_mod_files_enabled(session.pak_files.clone(), true) {
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
#[serde(rename_all = "camelCase", default)]
struct AppSettings {
    game_path: Option<String>,
    theme_id: String,
    modworkshop_api_key: Option<String>,
    nexus_api_key: Option<String>,
    show_age_restricted_nexus: bool,
    app_update_manifest_url: Option<String>,
    keep_downloaded_archives: bool,
    keep_uninstalled_mods: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            game_path: None,
            theme_id: DEFAULT_THEME_ID.to_string(),
            modworkshop_api_key: None,
            nexus_api_key: None,
            show_age_restricted_nexus: true,
            app_update_manifest_url: None,
            keep_downloaded_archives: true,
            keep_uninstalled_mods: false,
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
    download_cache_size_bytes: u64,
    extraction_cache_size_bytes: u64,
    total_cache_size_bytes: u64,
    cached_download_count: usize,
    temporary_extraction_folder_count: usize,
    uninstalled_storage_size_bytes: u64,
    uninstalled_entry_count: usize,
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

fn ensure_app_data_dirs() -> Result<PathBuf, String> {
    let root = app_data_dir()?;

    for folder in ["logs", "backups", "cache", "receipts", "profiles", "uninstalled", "diagnostics"] {
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
    const MAX_SOURCE_INDEX_RECORDS: usize = 1500;

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
            .take(MAX_SOURCE_INDEX_RECORDS)
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
fn list_source_index(source: Option<String>, limit: Option<usize>) -> Result<Vec<SourceModSummary>, String> {
    let database = read_source_index_database();
    let source_filter = source.map(|value| value.to_lowercase());
    let max_items = limit.unwrap_or(1200).clamp(1, 5000);

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


fn load_settings_internal() -> AppSettings {
    let Ok(settings_path) = settings_file_path() else {
        return AppSettings::default();
    };

    let Ok(contents) = fs::read_to_string(settings_path) else {
        return AppSettings::default();
    };

    serde_json::from_str::<AppSettings>(&contents).unwrap_or_default()
}

fn save_settings_internal(settings: &AppSettings) -> Result<(), String> {
    let root = ensure_app_data_dirs()?;
    let settings_path = root.join(SETTINGS_FILE_NAME);
    let contents = serde_json::to_string_pretty(settings)
        .map_err(|err| format!("Failed to serialize settings: {}", err))?;

    fs::write(settings_path, contents).map_err(|err| format!("Failed to save settings: {}", err))
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
    PaydayPaths {
        game_root: game_root.to_path_buf(),
        pak_mods: game_root.join("PAYDAY3").join("Content").join("Paks").join("~mods"),
        win64: game_root.join("PAYDAY3").join("Binaries").join("Win64"),
        ue4ss_mods: game_root
            .join("PAYDAY3")
            .join("Binaries")
            .join("Win64")
            .join("Mods"),
    }
}

fn is_payday3_root(path: &Path) -> bool {
    path.join("PAYDAY3").join("Content").join("Paks").exists()
        && path.join("PAYDAY3").join("Binaries").join("Win64").exists()
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

fn detect_payday3_paths_internal() -> Option<PaydayPaths> {
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
fn set_pak_mod_files_enabled(file_names: Vec<String>, enabled: bool) -> Result<String, String> {
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

        if let Ok(relative) = path.strip_prefix(&paths.win64) {
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
        "modworkshop" => fetch_modworkshop_mod_detail(record.id.clone()),
        "nexus" => fetch_nexus_mod_detail(record.id.clone()),
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

#[tauri::command]
fn check_installed_source_updates() -> Result<Vec<SourceUpdateStatus>, String> {
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
fn list_installed_state_records() -> Result<Vec<InstalledStateRecord>, String> {
    sync_installed_state_database()
}


fn prune_stale_receipts_internal() -> Result<usize, String> {
    // v1.8.31: Conservative by design. Installed receipts are Tsuki's ownership ledger.
    // Auto-pruning before the UI has finished discovering disabled PAK/UE4SS storage
    // can orphan mods and make disabled Win64/UE4SS installs disappear. Explicit
    // uninstall commands remove receipts directly, so background refresh should not.
    Ok(0)
}

#[tauri::command]
fn prune_stale_install_receipts() -> Result<String, String> {
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
fn uninstall_managed_install(receipt_id: String) -> Result<String, String> {
    let receipt = find_receipt_by_id(&receipt_id)?;
    uninstall_receipt_internal(&receipt)
}

#[tauri::command]
fn uninstall_source_install(source: String, source_id: String) -> Result<String, String> {
    let receipt = find_receipt_by_source(&source, &source_id)?;
    uninstall_receipt_internal(&receipt)
}

#[tauri::command]
fn set_source_install_enabled(source: String, source_id: String, enabled: bool) -> Result<String, String> {
    let receipt = find_receipt_by_source(&source, &source_id)?;
    set_receipt_mod_enabled_internal(&receipt.id, enabled)
}

#[tauri::command]
fn list_managed_installs() -> Result<Vec<ManagedInstallInfo>, String> {
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
fn set_managed_install_enabled(receipt_id: String, enabled: bool) -> Result<String, String> {
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
fn get_dependency_report() -> Result<DependencyReport, String> {
    let paths = detect_payday3_paths_internal()
        .ok_or_else(|| "Payday 3 not detected. Set a manual path in Settings.".to_string())?;

    let mut items = Vec::new();
    let mut warnings = Vec::new();

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
fn list_receipt_repair_items() -> Result<Vec<ReceiptRepairItem>, String> {
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
fn remove_receipt_by_id(receipt_id: String) -> Result<String, String> {
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
fn validate_movie_replacer_receipts() -> Result<Vec<MovieValidationItem>, String> {
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


fn legacy_mod_profiles_dir() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("profiles"))
}

fn mod_profiles_dir() -> Result<PathBuf, String> {
    if let Some(paths) = detect_payday3_paths_internal() {
        return Ok(paths.pak_mods.join("Tsuki_Profiles"));
    }

    legacy_mod_profiles_dir()
}

fn profile_file_name(name: &str) -> String {
    let clean = sanitize_file_component(name);

    if clean.is_empty() {
        format!("Profile_{}.json", current_timestamp())
    } else {
        format!("{}.json", clean)
    }
}

#[tauri::command]
fn list_mod_profiles() -> Result<Vec<ModProfile>, String> {
    let folder = mod_profiles_dir()?;
    fs::create_dir_all(&folder)
        .map_err(|err| format!("Failed to create profiles folder: {}", err))?;

    let mut profiles = Vec::new();

    for entry in fs::read_dir(&folder)
        .map_err(|err| format!("Failed to read profiles folder: {}", err))?
    {
        let entry = entry.map_err(|err| format!("Failed to read profile entry: {}", err))?;
        let path = entry.path();

        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }

        let Ok(contents) = fs::read_to_string(&path) else {
            continue;
        };

        if let Ok(profile) = serde_json::from_str::<ModProfile>(&contents) {
            profiles.push(profile);
        }
    }

    profiles.sort_by(|a, b| b.created_unix.cmp(&a.created_unix));
    Ok(profiles)
}

#[tauri::command]
fn save_current_mod_profile(name: String) -> Result<ModProfile, String> {
    let profile_name = if name.trim().is_empty() {
        format!("Profile {}", current_timestamp())
    } else {
        name.trim().to_string()
    };

    let scan = scan_pak_mods_internal()?;
    let enabled_pak_files = scan
        .pak_mods
        .into_iter()
        .filter(|file| file.enabled)
        .map(|file| enabled_name_from_disabled(&file.file_name))
        .collect::<Vec<_>>();

    let paths = detect_payday3_paths_internal()
        .ok_or_else(|| "Payday 3 not detected. Set a manual path in Settings.".to_string())?;

    let enabled_receipt_ids = list_install_receipts_internal()?
        .into_iter()
        .filter(|receipt| receipt_enabled_internal(&paths, receipt))
        .map(|receipt| receipt.id)
        .collect::<Vec<_>>();

    let profile = ModProfile {
        id: sanitize_file_component(&profile_name),
        name: profile_name.clone(),
        created_unix: now_unix_seconds(),
        enabled_pak_files,
        enabled_receipt_ids,
    };

    let folder = mod_profiles_dir()?;
    fs::create_dir_all(&folder)
        .map_err(|err| format!("Failed to create profiles folder: {}", err))?;

    let path = folder.join(profile_file_name(&profile_name));
    let contents = serde_json::to_string_pretty(&profile)
        .map_err(|err| format!("Failed to serialize profile: {}", err))?;

    fs::write(&path, contents)
        .map_err(|err| format!("Failed to write profile: {}", err))?;

    Ok(profile)
}

#[tauri::command]
fn apply_mod_profile(profile_id: String) -> Result<String, String> {
    let profiles = list_mod_profiles()?;
    let profile = profiles
        .into_iter()
        .find(|profile| profile.id == profile_id || profile.name == profile_id)
        .ok_or_else(|| format!("Profile not found: {}", profile_id))?;

    let scan = scan_pak_mods_internal()?;
    let mut enabled_paks = Vec::new();
    let mut disabled_paks = Vec::new();

    for file in scan.pak_mods {
        let enabled_name = enabled_name_from_disabled(&file.file_name);

        if profile.enabled_pak_files.iter().any(|wanted| wanted.eq_ignore_ascii_case(&enabled_name)) {
            enabled_paks.push(file.file_name);
        } else {
            disabled_paks.push(file.file_name);
        }
    }

    if !enabled_paks.is_empty() {
        let _ = set_pak_mod_files_enabled(enabled_paks, true)?;
    }

    if !disabled_paks.is_empty() {
        let _ = set_pak_mod_files_enabled(disabled_paks, false)?;
    }

    let receipts = list_install_receipts_internal()?;
    let mut receipt_changes = 0usize;

    for receipt in receipts {
        if receipt.files.iter().all(|file| receipt_is_pak_file_path(&file.relative_path)) {
            continue;
        }

        let should_enable = profile.enabled_receipt_ids.iter().any(|id| id == &receipt.id);
        set_receipt_mod_enabled_internal(&receipt.id, should_enable)?;
        receipt_changes += 1;
    }

    Ok(format!(
        "Applied profile '{}'. PAK enabled targets: {}. Managed installs touched: {}.",
        profile.name,
        profile.enabled_pak_files.len(),
        receipt_changes
    ))
}



#[tauri::command]
fn delete_mod_profile(profile_id: String) -> Result<String, String> {
    let target = profile_id.trim();
    if target.is_empty() {
        return Err("Profile id is required.".to_string());
    }

    let folder = mod_profiles_dir()?;
    fs::create_dir_all(&folder)
        .map_err(|err| format!("Failed to create profiles folder: {}", err))?;

    let mut removed = 0usize;
    let mut matched_name = None::<String>;

    for entry in fs::read_dir(&folder)
        .map_err(|err| format!("Failed to read profiles folder: {}", err))?
    {
        let entry = entry.map_err(|err| format!("Failed to read profile entry: {}", err))?;
        let path = entry.path();

        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }

        let file_stem_matches = path
            .file_stem()
            .and_then(|value| value.to_str())
            .map(|stem| stem.eq_ignore_ascii_case(target) || stem.eq_ignore_ascii_case(&sanitize_file_component(target)))
            .unwrap_or(false);

        let profile_matches = fs::read_to_string(&path)
            .ok()
            .and_then(|contents| serde_json::from_str::<ModProfile>(&contents).ok())
            .map(|profile| {
                let matches = profile.id.eq_ignore_ascii_case(target)
                    || profile.name.eq_ignore_ascii_case(target)
                    || sanitize_file_component(&profile.name).eq_ignore_ascii_case(target);

                if matches {
                    matched_name = Some(profile.name);
                }

                matches
            })
            .unwrap_or(false);

        if file_stem_matches || profile_matches {
            fs::remove_file(&path)
                .map_err(|err| format!("Failed to delete profile {}: {}", path.display(), err))?;
            removed += 1;
        }
    }

    if removed == 0 {
        return Err(format!("Profile not found: {}", target));
    }

    Ok(format!(
        "Deleted profile '{}' ({} file{} removed).",
        matched_name.unwrap_or_else(|| target.to_string()),
        removed,
        if removed == 1 { "" } else { "s" }
    ))
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
fn list_install_receipts() -> Result<Vec<InstallReceipt>, String> {
    list_install_receipts_internal()
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
            "Launched PAYDAY 3 directly from {} for vanilla mode. This avoids Steam Launch Options like -fileopenlog.",
            exe.display()
        ));
    }

    Err(format!(
        "Could not find a PAYDAY 3 executable for direct vanilla launch. Checked: {}",
        checked.join(" | ")
    ))
}

#[cfg(target_os = "windows")]
fn payday_process_running() -> bool {
    let output = match Command::new("tasklist").output() {
        Ok(output) => output,
        Err(_) => return false,
    };

    let text = String::from_utf8_lossy(&output.stdout).to_lowercase();
    [
        "payday3client-win64-shipping.exe",
        "payday3-win64-shipping.exe",
        "payday3_win64_shipping.exe",
        "payday3client.exe",
        "payday3.exe",
    ]
    .iter()
    .any(|name| text.contains(name))
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

    let destination_string = destination.display().to_string();
    Command::new("cmd")
        .args(["/C", "start", ""])
        .arg(&destination_string)
        .spawn()
        .map_err(|err| format!("Downloaded update but failed to launch installer: {}", err))?;

    Ok(format!(
        "Downloaded Tsuki {} to {} and launched the installer. Close Tsuki when the installer asks.",
        latest,
        destination.display()
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
    open_http_url(&url)
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
    Command::new("cmd")
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
    let allowed = [
        "moonveil",
        "neon-rift",
        "aqua-ghost",
        "basic-dark",
        "basic-light",
        "midnight",
        "crimson-noir",
        "solar-byte",
        "deep-space",
        "sakura-night",
        "void-rose",
        "solar-dusk",
        "mono-eclipse",
    ];

    if !allowed.contains(&theme_id.as_str()) {
        return Err(format!("Unknown theme: {}", theme_id));
    }

    let mut settings = load_settings_internal();
    settings.theme_id = theme_id.clone();
    save_settings_internal(&settings)?;

    Ok(format!("Saved theme: {}", theme_id))
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
fn scan_pak_mods() -> Result<PakScanResult, String> {
    scan_pak_mods_internal()
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
fn uninstall_pak_mod_files(file_names: Vec<String>) -> Result<String, String> {
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
fn open_pak_mods_folder() -> Result<String, String> {
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
fn open_mod_profiles_folder() -> Result<String, String> {
    let profile_root = mod_profiles_dir()?;
    fs::create_dir_all(&profile_root)
        .map_err(|err| format!("Failed to create profiles folder: {}", err))?;

    Command::new("explorer")
        .arg(&profile_root)
        .spawn()
        .map_err(|err| format!("Failed to open profiles folder: {}", err))?;

    Ok(format!("Opened {}", profile_root.display()))
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
    fs::create_dir_all(&downloads_root)
        .map_err(|err| format!("Failed to create downloads cache folder: {}", err))?;
    fs::create_dir_all(&extraction_root)
        .map_err(|err| format!("Failed to create extraction cache folder: {}", err))?;
    fs::create_dir_all(&uninstalled_root)
        .map_err(|err| format!("Failed to create uninstalled storage folder: {}", err))?;

    let mut download_size = 0u64;
    let mut download_count = 0usize;
    for folder in source_download_cache_dirs()? {
        let (size, count) = directory_size_and_file_count(&folder);
        download_size = download_size.saturating_add(size);
        download_count += count;
    }

    let (extraction_size, _) = directory_size_and_file_count(&extraction_root);
    let (uninstalled_size, _) = directory_size_and_file_count(&uninstalled_root);

    Ok(CacheStats {
        app_data_path: app_root.display().to_string(),
        cache_path: cache_root.display().to_string(),
        download_cache_path: downloads_root.display().to_string(),
        extraction_cache_path: extraction_root.display().to_string(),
        uninstalled_path: uninstalled_root.display().to_string(),
        download_cache_size_bytes: download_size,
        extraction_cache_size_bytes: extraction_size,
        total_cache_size_bytes: download_size.saturating_add(extraction_size),
        cached_download_count: download_count,
        temporary_extraction_folder_count: direct_child_directory_count(&extraction_root),
        uninstalled_storage_size_bytes: uninstalled_size,
        uninstalled_entry_count: direct_child_entry_count(&uninstalled_root),
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

    for folder in ["logs", "backups", "cache", "receipts", "profiles", "uninstalled", "diagnostics"] {
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

#[derive(Debug, Clone, Serialize)]
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
    comments: Vec<String>,
    bugs: Vec<String>,
    logs: Vec<String>,
    stats: Vec<SourceStatItem>,
}

fn json_string(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(text) = value.get(*key).and_then(|v| v.as_str()) {
            if !text.trim().is_empty() {
                return Some(text.to_string());
            }
        }
    }
    None
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
                    json_modworkshop_id_string(category, &["game_id", "gameId", "game", "slug", "name"])
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
        .replace("<li>", "\n• ");

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
            &["description", "body", "content", "details", "text", "summary"],
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
        return Err(format!("{} returned HTTP {}", url, status));
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
    detail.comments = vec!["Comments are not available from the current public parsed payload yet.".to_string()];
    detail.bugs = vec!["ModWorkshop does not expose a Nexus-style bugs tab here.".to_string()];
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

fn nexus_graphql_sort_value(sort: &str) -> serde_json::Value {
    let direction = serde_json::json!({ "direction": "DESC" });

    match sort {
        "added" => serde_json::json!({ "createdAt": direction }),
        "popular" | "downloads" => serde_json::json!({ "downloads": direction }),
        "liked" => serde_json::json!({ "endorsements": direction }),
        "name" => serde_json::json!({ "name": { "direction": "ASC" } }),
        _ => serde_json::json!({ "updatedAt": direction }),
    }
}

fn nexus_graphql_payday3_filter() -> serde_json::Value {
    // Nexus GraphQL docs: Query.mods accepts filter: ModsFilter, and
    // ModsFilter has gameDomainName: [BaseFilterValue!].
    serde_json::json!({
        "gameDomainName": [
            { "value": "payday3", "op": "EQUALS" }
        ]
    })
}

fn nexus_graphql_query_variants_for_page(sort: &str, page: u32, count: usize) -> Vec<(&'static str, serde_json::Value)> {
    let sort_value = nexus_graphql_sort_value(sort);
    let filter_value = nexus_graphql_payday3_filter();
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

fn fetch_nexus_graphql_search_mods(query_text: &str, api_key: &str) -> Result<Vec<SourceModSummary>, String> {
    let query_text = query_text.trim();
    if query_text.len() < 2 {
        return Ok(Vec::new());
    }

    let filter = serde_json::json!({
        "op": "AND",
        "filter": [
            {
                "gameDomainName": [
                    { "value": "payday3", "op": "EQUALS" }
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
    Ok(nexus_sort_browser_summaries(nexus_graphql_nodes_to_summaries(&value), "updated"))
}

fn fetch_nexus_website_search_mods(query: &str, sort: &str, allow_adult: bool) -> Result<Vec<SourceModSummary>, String> {
    let encoded = url_encode_light(query);
    let urls = vec![
        format!("https://www.nexusmods.com/payday3/search/?gsearch={}&BH={}", encoded, if allow_adult { 1 } else { 0 }),
        format!("https://www.nexusmods.com/payday3/search/?BH={}&gsearch={}", if allow_adult { 1 } else { 0 }, encoded),
    ];

    let mut ids = Vec::new();

    for url in urls {
        if let Ok(html) = http_get_text(&url) {
            ids.extend(extract_nexus_ids_from_html(&html));
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
        if let Ok(value) = http_get_json(&format!("https://api.nexusmods.com/v1/games/payday3/mods/{}.json", id), Some(api_key.as_str())) {
            let summary = nexus_enrich_summary(nexus_summary_from_value(&value), api_key.as_str());
            if is_clean_nexus_summary_for_browser(&summary) {
                mods.push(summary);
            }
        }
    }

    Ok(nexus_sort_browser_summaries(mods, sort))
}

fn search_nexus_mods_for_query_sync(query: String) -> Result<Vec<SourceModSummary>, String> {
    let query = query.trim().to_string();
    if query.len() < 2 {
        return Ok(Vec::new());
    }

    let settings = load_settings_internal();
    let api_key = settings
        .nexus_api_key
        .as_deref()
        .ok_or_else(|| "Nexus API key is not saved. Paste it in Settings first.".to_string())?;

    let mut combined = Vec::<SourceModSummary>::new();

    // Search the Nexus PAYDAY 3 web route for IDs, then hydrate with REST details.
    if let Ok(website) = fetch_nexus_website_search_mods(&query, "updated", settings.show_age_restricted_nexus) {
        combined.extend(website.into_iter().map(|summary| nexus_enrich_summary(summary, api_key)));
    }

    let compact_query = compact(&query);
    let cached = read_source_index_database()
        .records
        .into_iter()
        .filter(|(_, record)| record.source.eq_ignore_ascii_case("nexus"))
        .map(|(_, record)| record.summary)
        .filter(source_summary_is_payday3_safe)
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
        if let Ok(graphql) = fetch_nexus_graphql_search_mods(&query, api_key) {
            combined.extend(graphql);
        }
    }

    combined.retain(source_summary_is_payday3_safe);
    let mut results = nexus_sort_browser_summaries(nexus_dedupe_summaries(combined), "updated");
    results.sort_by(|a, b| score_search_result_for_query(b, &query).cmp(&score_search_result_for_query(a, &query)));

    upsert_source_index_summaries(&results);
    Ok(results.into_iter().take(80).collect())
}

#[tauri::command]
async fn search_nexus_mods_for_query(query: String) -> Result<Vec<SourceModSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || search_nexus_mods_for_query_sync(query))
        .await
        .map_err(|err| format!("Nexus search task failed: {:?}", err))?
}


fn fetch_nexus_graphql_mods_page(sort: &str, api_key: &str) -> Result<Vec<SourceModSummary>, String> {
    fetch_nexus_graphql_mods_page_paged(sort, api_key, 1, 24)
}

fn fetch_nexus_graphql_mods_page_paged(
    sort: &str,
    api_key: &str,
    page: u32,
    count: usize,
) -> Result<Vec<SourceModSummary>, String> {
    let mut errors = Vec::new();

    for (query, variables) in nexus_graphql_query_variants_for_page(sort, page.max(1), count) {
        match http_post_graphql(query, variables, Some(api_key)) {
            Ok(value) => {
                let summaries = nexus_graphql_nodes_to_summaries(&value)
                    .into_iter()
                    .filter(source_summary_is_payday3_safe)
                    .filter(is_clean_nexus_summary_for_browser)
                    .collect::<Vec<_>>();

                if !summaries.is_empty() {
                    let sorted = nexus_sort_browser_summaries(summaries, sort);
                    upsert_source_index_summaries(&sorted);
                    return Ok(sorted);
                }

                errors.push("Nexus GraphQL query returned no parsable mods.".to_string());
            }
            Err(error) => errors.push(error),
        }
    }

    Err(format!(
        "Nexus GraphQL browse failed. {}",
        errors.into_iter().take(2).collect::<Vec<_>>().join(" | ")
    ))
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

                let summary = nexus_summary_from_graphql_node(&mod_object)
                    .unwrap_or_else(|| SourceModSummary {
                        source: "nexus".to_string(),
                        source_id: mod_id.to_string(),
                        uid: None,
                        game_id: Some(game_id.to_string()),
                        name: format!("Nexus Mod {}", mod_id),
                        author: None,
                        version: None,
                        thumbnail_url: None,
                        banner_url: None,
                        page_url: Some(format!("https://www.nexusmods.com/payday3/mods/{}", mod_id)),
                        updated_at: None,
                        downloads: None,
                        likes: None,
                        short_description: None,
                        tags: vec!["Nexus".to_string(), "Payday 3".to_string()],
                    });

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
                    let detail = source_detail_from_summary(summary, description, Vec::new(), images);
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

fn nexus_detail_from_website(summary: &SourceModSummary) -> Option<SourceModSummary> {
    let html = http_get_text(&format!("https://www.nexusmods.com/payday3/mods/{}", summary.source_id)).ok()?;
    let title = extract_meta_content(&html, "og:title")
        .or_else(|| extract_title_from_html(&html))
        .map(|text| clean_mod_name(&text));

    let thumbnail = extract_meta_content(&html, "og:image")
        .and_then(|url| absolutize_source_url("nexus", Some(url)));

    let description = extract_meta_content(&html, "og:description")
        .or_else(|| extract_meta_content(&html, "description"))
        .map(|text| clean_mod_name(&clean_html_text(&text)));

    Some(SourceModSummary {
        source: summary.source.clone(),
        source_id: summary.source_id.clone(),
        uid: None,
        game_id: None,
        name: title
            .filter(|name| !name.is_empty() && !name.starts_with("Nexus Mod "))
            .unwrap_or_else(|| summary.name.clone()),
        author: summary.author.clone(),
        version: summary.version.clone(),
        thumbnail_url: thumbnail.clone().or_else(|| summary.thumbnail_url.clone()),
        banner_url: thumbnail.or_else(|| summary.banner_url.clone()),
        page_url: summary.page_url.clone(),
        updated_at: summary.updated_at.clone(),
        downloads: summary.downloads,
        likes: summary.likes,
        short_description: description.or_else(|| summary.short_description.clone()),
        tags: summary.tags.clone(),
    })
}

fn extract_nexus_ids_from_html(html: &str) -> Vec<String> {
    let mut ids = Vec::new();
    let needles = ["/payday3/mods/", "nexusmods.com/payday3/mods/"];

    for needle in needles {
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

fn scrape_nexus_summary_from_listing(html: &str, id: &str) -> SourceModSummary {
    let marker = format!("/payday3/mods/{}", id);
    let center = html.find(&marker).unwrap_or_else(|| html.find(id).unwrap_or(0));

    let name = extract_anchor_text_near(html, center)
        .unwrap_or_else(|| format!("Nexus Mod {}", id));

    let thumbnail = extract_first_img_near_for_source(html, center, "nexus");

    SourceModSummary {
        source: "nexus".to_string(),
        source_id: id.to_string(),
        uid: None,
        game_id: None,
        name,
        author: None,
        version: None,
        thumbnail_url: thumbnail.clone(),
        banner_url: thumbnail,
        page_url: Some(format!("https://www.nexusmods.com/payday3/mods/{}", id)),
        updated_at: None,
        downloads: None,
        likes: None,
        short_description: Some("Loaded from Nexus Mods PAYDAY 3 browse pages.".to_string()),
        tags: vec!["Nexus".to_string(), "PAYDAY 3".to_string()],
    }
}

fn nexus_browse_urls(page: u32, sort: &str, include_age_restricted: bool) -> Vec<String> {
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
        format!("https://www.nexusmods.com/payday3/mods/?BH=0&page={}&sort={}{adult_fragment}", page, sort_fragment),
        format!("https://www.nexusmods.com/payday3/mods/?BH=0&page={}&tab={}{adult_fragment}", page, sort_fragment),
        format!("https://www.nexusmods.com/payday3/mods/?BH=0&page={}{adult_fragment}", page),
    ]
}

fn fetch_nexus_website_mods_page(page: u32, sort: &str, include_age_restricted: bool) -> Result<Vec<SourceModSummary>, String> {
    let mut errors = Vec::new();

    for url in nexus_browse_urls(page, sort, include_age_restricted) {
        match http_get_text(&url) {
            Ok(html) => {
                let ids = extract_nexus_ids_from_html(&html);
                let mut mods = Vec::new();

                for id in ids.into_iter().take(40) {
                    let mut summary = scrape_nexus_summary_from_listing(&html, &id);

                    if summary.name.starts_with("Nexus Mod ") || summary.thumbnail_url.is_none() {
                        if let Some(enriched) = nexus_detail_from_website(&summary) {
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


fn nexus_enrich_summary(summary: SourceModSummary, api_key: &str) -> SourceModSummary {
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
        &format!("https://api.nexusmods.com/v1/games/payday3/mods/{}.json", best.source_id),
        Some(api_key),
    ) {
        let enriched = nexus_summary_from_value(&value);

        best = SourceModSummary {
            source: best.source,
            source_id: best.source_id,
        uid: None,
        game_id: None,
            name: if enriched.name.starts_with("Nexus Mod ") { best.name } else { enriched.name },
            author: enriched.author.or(best.author),
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
        if let Some(web) = nexus_detail_from_website(&best) {
            return web;
        }
    }

    best
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

    Command::new("cmd")
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
) -> Result<String, String> {
    let source_lower = source.to_lowercase();

    if source_lower == "nexus" {
        let settings = load_settings_internal();
        let api_key = settings
            .nexus_api_key
            .as_deref()
            .ok_or_else(|| "Nexus API key is not saved. Paste it in Settings first.".to_string())?;

        let url = format!(
            "https://api.nexusmods.com/v1/games/payday3/mods/{}/files/{}/download_link.json",
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
        comments: vec!["Comments tab is ready. Nexus V1 and current ModWorkshop GET responses may not expose comments through the same mod metadata endpoint.".to_string()],
        bugs: vec!["Bugs tab is ready. Nexus V1 does not expose the full website Bugs tab through the basic mod metadata endpoint.".to_string()],
        logs: vec!["No source logs loaded yet.".to_string()],
        changelog: None,
        description,
        files,
        images,
        source: summary.source,
        source_id: summary.source_id,
        uid: None,
        game_id: None,
        name: summary.name,
        author: summary.author,
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
fn fetch_nexus_mod_detail(mod_id: String) -> Result<SourceModDetail, String> {
    let settings = load_settings_internal();
    let api_key = settings
        .nexus_api_key
        .as_deref()
        .ok_or_else(|| "Nexus API key is not saved. Paste it in Settings first.".to_string())?;

    // GraphQL detail is metadata-only for now. The live schema path works, but
    // files are still more reliable through Nexus REST V1, so never return a
    // GraphQL-only detail page with 0 downloads.
    let graphql_detail = lookup_nexus_game_id_for_mod_id(&mod_id)
        .and_then(|game_id| fetch_nexus_graphql_mod_detail(&game_id, &mod_id, api_key).ok());

    let mod_value = http_get_json(
        &format!("https://api.nexusmods.com/v1/games/payday3/mods/{}.json", mod_id),
        Some(api_key),
    )?;

    let summary = nexus_summary_from_value(&mod_value);
    let description = json_string(&mod_value, &["description", "summary"])
        .map(|text| html_to_text(&text))
        .unwrap_or_else(|| "No description exposed by this API response.".to_string());

    let files_value = http_get_json(
        &format!("https://api.nexusmods.com/v1/games/payday3/mods/{}/files.json", mod_id),
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
                        "https://www.nexusmods.com/payday3/mods/{}?tab=files&file_id={}",
                        mod_id,
                        id
                    ))
                }),
                file_type: None,
                download_count: None,
            }
        })
        .filter(|file| normalize_nexus_id_string(&file.id).is_some())
        .collect::<Vec<_>>();

    sort_source_files_newest_first(&mut file_items);
    file_items = filter_source_download_files(file_items);

    let images_value = http_get_json(
        &format!("https://api.nexusmods.com/v1/games/payday3/mods/{}/images.json", mod_id),
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
fn fetch_modworkshop_mod_detail(mod_id: String) -> Result<SourceModDetail, String> {
    let id = mod_id.trim().to_string();
    let page_url = format!("https://modworkshop.net/mod/{}", id);
    let modworkshop_api_key = load_settings_internal().modworkshop_api_key;

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

            detail.description = choose_better_description(
                detail.description,
                extract_modworkshop_api_description(&data),
            );

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

    let summary = SourceModSummary {
        source: "modworkshop".to_string(),
        source_id: id.clone(),
        uid: None,
        game_id: None,
        name,
        author: json_string(&data, &["author", "created_by", "createdBy", "user_name", "userName"]),
        version: json_string(&data, &["version"]),
        thumbnail_url: thumbnail.clone(),
        banner_url: thumbnail,
        page_url: Some(page_url),
        updated_at: json_string(&data, &["updated_at", "updatedAt", "last_updated", "lastUpdated"]),
        downloads: json_u64(&data, &["downloads", "download_count", "downloadCount"]),
        likes: json_u64(&data, &["likes", "like_count", "likeCount"]),
        short_description: safe_short_description(json_string(&data, &["short_description", "shortDescription", "summary", "description"])),
        tags: vec!["ModWorkshop".to_string(), "PAYDAY 3".to_string()],
    };

    let files = modworkshop_file_items_from_api(&id, &data);

    let detail = source_detail_from_summary(summary, description, files, Vec::new());
    upsert_source_index_detail(&detail);
    Ok(detail)
}



fn payday_content_root(paths: &PaydayPaths) -> PathBuf {
    paths.game_root.join("PAYDAY3").join("Content")
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

    let status = Command::new(&tar)
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

    sevenz_rust::decompress_file(archive_path, &output_dir)
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
        if matches!(lower.as_str(), "payday3" | "content" | "binaries" | "win64" | "mods" | "scripts") {
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

    if matches!(extension, "txt" | "md" | "rtf" | "pdf" | "url" | "lnk" | "xml" | "yaml" | "yml" | "log") {
        return Some("Readme/documentation/metadata file skipped. Tsuki only installs runtime mod files.".to_string());
    }

    if matches!(extension, "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "ico" | "bmp" | "avif") {
        return Some("Image/preview asset skipped. Tsuki only installs runtime mod files.".to_string());
    }

    None
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
        let relative = if let Some(found) = strip_after_any_marker_case_insensitive(
            &normalized,
            &["PAYDAY3/Binaries/Win64/", "Binaries/Win64/"],
        ) {
            found
        } else if lower.starts_with("mods/") || lower.contains("/mods/") {
            {
                let tail = relative_after_path_markers(&normalized, &["Mods/"], &normalized);
                format!("Mods/{}", tail.trim_start_matches("Mods/").trim_start_matches('/'))
            }
        } else if lower.starts_with("scripts/") || lower.contains("/scripts/") {
            if lower.starts_with("scripts/") {
                normalized.clone()
            } else {
                format!("Mods/{}", normalized)
            }
        } else if matches!(extension.as_str(), "lua" | "ini" | "json" | "toml")
            && (lower.contains("/scripts/") || lower.contains("/enabled") || lower.contains("/config"))
        {
            format!("Mods/{}", normalized)
        } else if matches!(extension.as_str(), "lua" | "json" | "toml")
            || (extension == "ini" && !file_name.to_lowercase().contains("ue4ss"))
        {
            format!("Mods/{}", file_name)
        } else {
            file_name.clone()
        };

        route_kind = "win64".to_string();
        destination = safe_join_under(&paths.win64, &relative);
        confidence = "high".to_string();
        reason = "UE4SS/Mods folder/.ini/.dll/Lua/native route detected; routed under PAYDAY3/Binaries/Win64.".to_string();
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
    let stem = archive_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("archive");

    Ok(downloads_cache_dir()?
        .join("external_extract")
        .join(format!(
            "{}_{}_{}",
            sanitize_file_component(label),
            sanitize_file_component(stem),
            current_timestamp()
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
        Command::new(&tool)
            .arg("x")
            .arg("-ibck")
            .arg("-y")
            .arg(archive_path)
            .arg(&output_dir)
            .status()
            .map_err(|err| format!("Failed to run {}: {}", tool.display(), err))?
    } else {
        Command::new(&tool)
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

fn resolve_source_file_download_url(source: &str, mod_id: &str, file_id: &str, download_url: Option<String>) -> Result<String, String> {
    if source.eq_ignore_ascii_case("nexus") {
        let settings = load_settings_internal();
        let api_key = settings
            .nexus_api_key
            .as_deref()
            .ok_or_else(|| "Nexus API key is not saved. Paste it in Settings first.".to_string())?;

        let url = format!(
            "https://api.nexusmods.com/v1/games/payday3/mods/{}/files/{}/download_link.json",
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
) -> Vec<String> {
    let mut urls = Vec::new();
    let caller_url_allowed = !source.eq_ignore_ascii_case("nexus") && !source.eq_ignore_ascii_case("modworkshop");
    let trusted_download_url = if caller_url_allowed { download_url.clone() } else { None };

    if let Ok(primary) = resolve_source_file_download_url(source, mod_id, file_id, trusted_download_url.clone()) {
        push_unique_url(&mut urls, primary);
    }

    if source.eq_ignore_ascii_case("nexus") {
        let clean_mod_id = mod_id.trim();
        let clean_file_id = file_id.trim();

        if !clean_mod_id.is_empty() && !clean_file_id.is_empty() && clean_file_id != "unknown" {
            if let Some(api_key) = load_settings_internal().nexus_api_key {
                let endpoint = format!(
                    "https://api.nexusmods.com/v1/games/payday3/mods/{}/files/{}/download_link.json",
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
                    "https://www.nexusmods.com/payday3/mods/{}?tab=files&file_id={}",
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

    let bytes = io::copy(&mut response, &mut output)
        .map_err(|err| format!("Failed to save download: {}", err))?;

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
        files: files.iter().map(|file| {
            let destination_path = PathBuf::from(&file.destination);
            let sha256 = sha256_file(&destination_path).ok();

            InstallReceiptFile {
                relative_path: file.destination.clone(),
                size_bytes: Some(file.size_bytes),
                sha256,
            }
        }).collect(),
    };

    let receipt_path = receipt_root.join(format!("{}.json", receipt_id));
    let contents = serde_json::to_string_pretty(&receipt)
        .map_err(|err| format!("Failed to serialize install receipt: {}", err))?;

    fs::write(&receipt_path, contents)
        .map_err(|err| format!("Failed to write install receipt: {}", err))?;

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
) -> Result<InstallApplyResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
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
) -> Result<StagedDownloadResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
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

        let paths = detect_payday3_paths_internal()
            .ok_or_else(|| "Payday 3 was not detected. Set the game path in Settings first.".to_string())?;

        let download_candidates = source_file_download_candidates(&source, &mod_id, &file_id, download_url.clone());

        if download_candidates.is_empty() {
            return Err("This source did not expose a download URL.".to_string());
        }

        let direct_url = download_candidates
            .first()
            .cloned()
            .unwrap_or_else(|| "download.zip".to_string());

        let stage_root = downloads_cache_dir()?
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

        for candidate in download_candidates {
            if is_image_or_page_asset_name(&candidate) {
                last_download_error = format!("Skipped page image/thumbnail URL instead of downloading it: {}", candidate);
                continue;
            }

            match download_url_to_file_with_diagnostic(&candidate, &staged_file) {
                Ok(diagnostic) => {
                    size_bytes = Some(diagnostic.size_bytes);
                    download_http = Some(diagnostic);
                    break;
                }
                Err(error) => {
                    last_download_error = format!("{} -> {}", candidate, error);
                    let _ = fs::remove_file(&staged_file);
                }
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

        let (archive_kind, entries, mut warnings) = match inspect_staged_file(&paths, &staged_file, &description) {
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

        warnings.push("Downloaded to Tsuki staging and inspected. Install can now copy safe routes into detected PAYDAY 3 paths.".to_string());

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
            can_install_later: entries.iter().any(|entry| entry.route_kind != "folder" && !entry.blocked),
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

    let matches = match_installed_source_mods(modworkshop_sources.clone())?;
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
fn match_installed_source_mods(source_mods: Vec<SourceModSummary>) -> Result<Vec<InstalledSourceMatch>, String> {
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

        let installed = if match_kind == "receipt" || match_kind == "receipt-hash" {
            best_receipt_live
        } else {
            matches!(match_kind.as_str(), "source-id" | "proof-filename")
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
async fn fetch_modworkshop_browse_live_page(page: u32, sort: Option<String>) -> Result<Vec<SourceModSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let sort_mode = sort.unwrap_or_else(|| "recent".to_string());
        let mods = fetch_modworkshop_mods_page(page, &sort_mode)?;

        if mods.is_empty() {
            return Err("ModWorkshop direct live returned zero cards.".to_string());
        }

        upsert_source_index_summaries(&mods);
        Ok(mods)
    })
    .await
    .map_err(|err| format!("ModWorkshop direct live task failed: {:?}", err))?
}

#[tauri::command]
async fn diagnose_modworkshop_browse_live() -> Result<String, String> {
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
) -> Result<Vec<SourceModSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_source_mods_page_sync(source, page, sort))
        .await
        .map_err(|err| format!("Source loader task failed: {:?}", err))?
}

fn fetch_source_mods_page_sync(
    source: String,
    page: u32,
    sort: Option<String>,
) -> Result<Vec<SourceModSummary>, String> {
    let sort_mode = sort.unwrap_or_else(|| "recent".to_string());

    let result = match source.as_str() {
        "nexus" => fetch_nexus_mods_page(page, &sort_mode),
        "modworkshop" => fetch_modworkshop_mods_page(page, &sort_mode),
        other => Err(format!("Unknown source: {}", other)),
    };

    match result {
        Ok(mods) if !mods.is_empty() => {
            upsert_source_index_summaries(&mods);
            Ok(mods)
        }
        Ok(_) => Ok(Vec::new()),
        Err(error) => {
            if source.eq_ignore_ascii_case("modworkshop") {
                return Err(error);
            }

            let page_size = 24usize;
            let start = page.saturating_sub(1) as usize * page_size;
            let cached = read_source_index_database()
                .records
                .into_values()
                .filter(|record| record.source.eq_ignore_ascii_case(&source))
                .map(|record| record.summary)
                .collect::<Vec<_>>();

            let mut sorted = nexus_sort_browser_summaries(cached, &sort_mode);

            if start < sorted.len() {
                Ok(sorted.drain(start..sorted.len().min(start + page_size)).collect())
            } else if page == 1 {
                Ok(sorted.into_iter().take(page_size).collect())
            } else {
                Ok(Vec::new())
            }
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

fn source_date_score(summary: &SourceModSummary) -> i64 {
    summary
        .updated_at
        .as_ref()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0)
}

fn nexus_sort_browser_summaries(mut summaries: Vec<SourceModSummary>, sort: &str) -> Vec<SourceModSummary> {
    match sort {
        "downloads" => summaries.sort_by(|a, b| b.downloads.unwrap_or(0).cmp(&a.downloads.unwrap_or(0))),
        "liked" | "popular" => summaries.sort_by(|a, b| b.likes.unwrap_or(0).cmp(&a.likes.unwrap_or(0))),
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

    let mut summaries = nexus_sort_browser_summaries(nexus_dedupe_summaries(combined), "updated");

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
        if summary.source_id != "unknown" && is_clean_nexus_summary_for_browser(&summary) && source_summary_is_payday3_safe(&summary) {
            map.entry(summary.source_id.clone())
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
    match sort {
        "added" => vec![
            "latest_added.json",
            "updated.json?period=1w",
            "updated.json?period=1m",
            "trending.json",
        ],
        "popular" | "downloads" => vec![
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

fn nexus_rest_collect(api_key: &str, sort: &str, enrich_limit: usize) -> Vec<SourceModSummary> {
    let mut summaries = Vec::<SourceModSummary>::new();

    for endpoint in nexus_rest_endpoint_order(sort) {
        let url = format!("https://api.nexusmods.com/v1/games/payday3/mods/{}", endpoint);

        let Ok(value) = http_get_json(&url, Some(api_key)) else {
            continue;
        };

        let Some(array) = value.as_array() else {
            continue;
        };

        for item in array.iter().take(100) {
            let summary = nexus_summary_from_value(item);
            if is_clean_nexus_summary_for_browser(&summary) && source_summary_is_payday3_safe(&summary) {
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
                    nexus_enrich_summary(summary, api_key)
                } else {
                    summary
                }
            })
            .collect::<Vec<_>>();
    }

    nexus_sort_browser_summaries(nexus_dedupe_summaries(summaries), sort)
}

fn nexus_cached_index_page(page: u32, sort: &str, page_size: usize) -> Vec<SourceModSummary> {
    let start = page.saturating_sub(1) as usize * page_size;

    let cached = read_source_index_database()
        .records
        .into_values()
        .filter(|record| record.source.eq_ignore_ascii_case("nexus"))
        .map(|record| record.summary)
        .filter(source_summary_is_payday3_safe)
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

fn nexus_website_collect(sort: &str, allow_adult: bool, max_pages: u32) -> Vec<SourceModSummary> {
    let mut combined = Vec::new();

    for page in 1..=max_pages {
        if let Ok(mut web) = fetch_nexus_website_mods_page(page, sort, allow_adult) {
            combined.append(&mut web);
        }
    }

    nexus_sort_browser_summaries(nexus_dedupe_summaries(combined), sort)
}


fn fetch_nexus_mods_page(page: u32, sort: &str) -> Result<Vec<SourceModSummary>, String> {
    let page = page.max(1);
    let settings = load_settings_internal();
    let api_key = settings
        .nexus_api_key
        .as_deref()
        .ok_or_else(|| "Nexus API key is not saved. Paste it in Settings first.".to_string())?;

    let page_size = 24usize;

    // v1.0.5: GraphQL Browse is now allowed to drive live Nexus cards because
    // diagnostics proved the minimal PAYDAY 3 query returns nodes. REST/cache remain
    // fallback and GraphQL errors must never blank Browse.
    if let Ok(graphql_mods) = fetch_nexus_graphql_mods_page_paged(sort, api_key, page, page_size) {
        let visible = nexus_sort_browser_summaries(nexus_dedupe_summaries(graphql_mods), sort)
            .into_iter()
            .take(page_size)
            .collect::<Vec<_>>();

        if !visible.is_empty() {
            upsert_source_index_summaries(&visible);
            return Ok(visible);
        }
    }

    if page == 1 {
        let mut combined = nexus_rest_collect(api_key, sort, 24);
        let mut website = nexus_website_collect(sort, settings.show_age_restricted_nexus, 2);
        combined.append(&mut website);

        let mut clean = nexus_sort_browser_summaries(nexus_dedupe_summaries(combined), sort);

        if clean.is_empty() {
            clean = nexus_cached_index_page(page, sort, page_size);
        }

        if !clean.is_empty() {
            let visible = clean.into_iter().take(page_size).collect::<Vec<_>>();
            upsert_source_index_summaries(&visible);
            return Ok(visible);
        }

        return Err("Nexus Browse rebuilt loader found no REST, website, or indexed PAYDAY 3 cards.".to_string());
    }

    let mut indexed = nexus_cached_index_page(page, sort, page_size);

    if indexed.is_empty() {
        let mut website = fetch_nexus_website_mods_page(page, sort, settings.show_age_restricted_nexus)
            .unwrap_or_default();
        website.retain(source_summary_is_payday3_safe);
        indexed = nexus_sort_browser_summaries(nexus_dedupe_summaries(website), sort)
            .into_iter()
            .take(page_size)
            .collect();
    }

    Ok(indexed)
}

fn parse_modworkshop_list(value: serde_json::Value) -> Vec<SourceModSummary> {
    let data = unwrap_data(value);
    let mut candidates: Vec<&serde_json::Value> = Vec::new();

    if let Some(array) = data.as_array() {
        candidates = array.iter().collect();
    } else {
        for key in ["mods", "results", "items", "data"] {
            if let Some(array) = data.get(key).and_then(|v| v.as_array()) {
                candidates = array.iter().collect();
                break;
            }
        }
    }

    candidates
        .into_iter()
        .filter_map(modworkshop_summary_from_api_value)
        .filter(source_summary_is_payday3_safe)
        .take(40)
        .collect()
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


fn modworkshop_summary_from_api_value(item: &serde_json::Value) -> Option<SourceModSummary> {
    let id = json_modworkshop_id_string(item, &["id", "mod_id", "modId"])?;

    let name = json_string(item, &["name", "title"])
        .map(|value| clean_mod_name(&value))
        .unwrap_or_else(|| format!("ModWorkshop Mod {}", id));

    let game_id = modworkshop_game_id_from_value(item)
        .or_else(|| Some(MODWORKSHOP_PAYDAY3_GAME_ID.to_string()));

    let mut tags = vec!["ModWorkshop".to_string()];
    if game_id
        .as_deref()
        .map(is_modworkshop_payday3_game_id)
        .unwrap_or(true)
    {
        tags.push("PAYDAY 3".to_string());
    }

    for tag in json_array(item, &["tags", "categories", "game", "games"]) {
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

    Some(SourceModSummary {
        source: "modworkshop".to_string(),
        source_id: id.clone(),
        uid: None,
        game_id,
        name,
        author: json_string(item, &["author", "user", "username", "submitter"])
            .or_else(|| json_nested_string(
                item,
                &[
                    &["author", "name"],
                    &["author", "username"],
                    &["user", "name"],
                    &["user", "username"],
                    &["submitter", "name"],
                    &["submitter", "username"],
                ],
            )),
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

    let Ok(detail) = fetch_modworkshop_mod_detail(summary.source_id.clone()) else {
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
async fn fetch_modworkshop_filter_page(filter: String, page: Option<u32>, sort: Option<String>) -> Result<Vec<SourceModSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_modworkshop_filter_page_sync(filter, page, sort))
        .await
        .map_err(|err| format!("ModWorkshop filter task failed: {:?}", err))?
}

#[tauri::command]
async fn search_modworkshop_mods_for_query(query: String, page: Option<u32>) -> Result<Vec<SourceModSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || search_modworkshop_mods_for_query_sync(query, page))
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
        return Err(format!("{} returned HTTP {}", url, status));
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
        .get_webview_window("main")
        .ok_or_else(|| "Main window was not found.".to_string())?;

    window.minimize().map_err(|err| format!("Failed to minimize window: {}", err))?;
    Ok("Window minimized.".to_string())
}

#[tauri::command]
fn window_toggle_maximize(app: tauri::AppHandle) -> Result<String, String> {
    let window = app
        .get_webview_window("main")
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
        .get_webview_window("main")
        .ok_or_else(|| "Main window was not found.".to_string())?;

    window.close().map_err(|err| format!("Failed to close window: {}", err))?;
    Ok("Window closed.".to_string())
}

#[tauri::command]
fn window_start_dragging(app: tauri::AppHandle) -> Result<String, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window was not found.".to_string())?;

    window.start_dragging().map_err(|err| format!("Failed to start dragging window: {}", err))?;
    Ok("Window dragging started.".to_string())
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(BackupState {
            progress: Mutex::new(BackupProgress::default()),
        })
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
        // v1.8.2: restore any crashed vanilla temp session when Tsuki starts and PAYDAY 3 is not running.
            if read_vanilla_launch_session().is_some() && !payday_process_running() {
                let _ = restore_mods_after_vanilla_launch();
            }

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }

            if should_auto_relaunch_as_admin() {
                if relaunch_current_exe_as_admin_internal().is_ok() {
                    std::process::exit(0);
                }
            }

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_decorations(false);
                let _ = window.set_resizable(true);
                let _ = window.set_min_size(Some(tauri::Size::Logical(tauri::LogicalSize {
                    width: 960.0,
                    height: 640.0,
                })));
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            window_minimize,
            window_toggle_maximize,
            window_close,
            window_start_dragging,
            get_app_settings,
            save_game_path,
            clear_game_path,
            save_theme,
            save_source_api_keys,
            clear_source_api_keys,
            save_app_update_settings,
            check_app_update,
            download_and_launch_app_update,
            open_external_url,
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
            fetch_source_mods_page,
            fetch_modworkshop_browse_live_page,
            fetch_modworkshop_filter_page,
            diagnose_modworkshop_browse_live,
            match_installed_source_mods,
            diagnose_modworkshop_pairing,
            remove_raid_ww2_bad_install,
            list_source_index,
            get_source_index_status,
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
            scan_pak_mods,
            set_pak_mod_files_enabled,
            uninstall_pak_mod_files,
            open_pak_mods_folder,
            open_backups_folder,
            open_mod_profiles_folder,
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
