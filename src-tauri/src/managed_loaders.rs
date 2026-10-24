//! Signed external runtimes. No proprietary loader source or payload is bundled.
use super::*;
use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use fs2::FileExt;
use std::{collections::HashSet, io::Cursor, time::Duration};

pub(crate) const PROFILE: &str = "builtin.outlast-trials";
const LIMIT: u64 = 256 * 1024 * 1024;
const RUNTIME: &str = "NativePakLoader/ManagedRuntime";

#[derive(Deserialize)]
struct ReleaseSource { repository: String, public_key: String }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    loader_id: String, version: String, protocol: u32, release_tag: String,
    archive_url: String, archive_sha256: String, archive_size: u64,
    entry_point: String, files: Vec<PayloadFile>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PayloadFile { path: String, size: u64, sha256: String }
#[derive(Serialize, Deserialize)]
struct Installed { manifest: Vec<u8>, signature: String, game_root: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status { state: String, message: String, version: Option<String>, authorized: bool }

fn source() -> Result<ReleaseSource, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Config { repository: String, public_key: String }
    let config: Config = serde_json::from_str(include_str!("../managed-loader-release.json")).map_err(|e| e.to_string())?;
    let parts: Vec<_> = config.repository.split('/').collect();
    if parts.len() != 2 || parts.iter().any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))) || config.public_key.is_empty() {
        return Err("Native PAK support is awaiting its dedicated release repository and pinned signing key.".into());
    }
    Ok(ReleaseSource { repository: config.repository, public_key: config.public_key })
}
fn data() -> Result<PathBuf, String> {
    let path = ensure_profile_data_dirs(PROFILE)?.join("dependencies/native-pak-loader");
    fs::create_dir_all(&path).map_err(|e| e.to_string())?; Ok(path)
}
fn authorized(dir: &Path) -> bool { dir.join("consent-v1").is_file() }
fn root() -> Result<PathBuf, String> {
    let root = PathBuf::from(profile_launch_mapping_internal(PROFILE)?.game_root);
    profile_installs::validate_builtin_profile_root(PROFILE, &root)?;
    ordinary_tree(&root)?; Ok(root)
}
fn hash(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn file_hash(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new(); let mut buffer = [0; 65536];
    loop { let count = file.read(&mut buffer).map_err(|e| e.to_string())?; if count == 0 { break; } digest.update(&buffer[..count]); }
    Ok(format!("{:x}", digest.finalize()))
}
fn safe_path(value: &str) -> Result<(), String> {
    if value.is_empty() || !value.is_ascii() || value.len() > 180 || value.contains('\\') || value.split('/').any(|p| p.is_empty() || p == "." || p == ".." || p.ends_with('.') || p.ends_with(' ') || p.bytes().any(|b| b < 32 || b":<>\"|?*".contains(&b)) || {
        let name = p.split('.').next().unwrap_or("").to_ascii_uppercase();
        ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"].contains(&name.as_str())
    }) { return Err("Unsafe release path.".into()); }
    Ok(())
}
fn ordinary_tree(path: &Path) -> Result<(), String> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        #[cfg(windows)] {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 { return Err("Loader path contains a reparse point.".into()); }
        }
        if metadata.file_type().is_symlink() { return Err("Loader path contains a link.".into()); }
    }
    if let Some(parent) = path.parent() { ordinary_tree(parent)?; } Ok(())
}
fn verify(raw: &[u8], signature: &str, config: &ReleaseSource) -> Result<Manifest, String> {
    if raw.len() > 65536 { return Err("Release manifest is too large.".into()); }
    let key: [u8; 32] = base64::engine::general_purpose::STANDARD.decode(&config.public_key).map_err(|_| "Invalid pinned key.")?.try_into().map_err(|_| "Invalid pinned key size.")?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(signature.trim()).map_err(|_| "Invalid manifest signature.")?;
    VerifyingKey::from_bytes(&key).map_err(|_| "Invalid pinned key.")?.verify_strict(raw, &Signature::from_slice(&bytes).map_err(|_| "Invalid signature size.")?).map_err(|_| "Release signature verification failed.")?;
    let manifest: Manifest = serde_json::from_slice(raw).map_err(|e| format!("Invalid manifest: {e}"))?;
    if manifest.loader_id != "outlast-native-pak" || manifest.protocol != 1 || manifest.version.is_empty() || manifest.archive_size == 0 || manifest.archive_size > LIMIT || manifest.files.is_empty() || manifest.files.len() > 2048 { return Err("Unsupported loader release.".into()); }
    safe_path(&manifest.entry_point)?; safe_path(&manifest.release_tag)?;
    let expected = format!("/{}/releases/download/{}/", config.repository, manifest.release_tag);
    let url = reqwest::Url::parse(&manifest.archive_url).map_err(|_| "Invalid archive URL.")?;
    if url.host_str() != Some("github.com") || !url.path().starts_with(&expected) || url.query().is_some() || url.fragment().is_some() || !trusted_url(&manifest.archive_url) { return Err("Archive does not belong to the configured release repository.".into()); }
    let mut paths = HashSet::new(); let mut total = 0u64;
    for file in &manifest.files {
        safe_path(&file.path)?;
        if ["installed.json", "tsuki-managed-receipt.json"].contains(&file.path.to_ascii_lowercase().as_str()) { return Err("Release uses reserved metadata paths.".into()); }
        let extension = Path::new(&file.path).extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase();
        if !["exe", "dll", "pyd", "dat", "txt", "json", "bin"].contains(&extension.as_str()) || !paths.insert(file.path.to_ascii_lowercase()) || file.sha256.len() != 64 || !file.sha256.bytes().all(|b| b.is_ascii_hexdigit()) { return Err("Release contains unsafe or duplicate payload files.".into()); }
        total = total.checked_add(file.size).ok_or("Release size overflow.")?;
    }
    if total > LIMIT * 3 || !manifest.files.iter().any(|f| f.path == manifest.entry_point && f.path.ends_with(".exe")) { return Err("Invalid runtime entry point or expanded size.".into()); }
    Ok(manifest)
}
fn trusted_url(value: &str) -> bool {
    reqwest::Url::parse(value).is_ok_and(|url| url.scheme() == "https" && url.username().is_empty() && url.password().is_none() && url.port_or_known_default() == Some(443) && matches!(url.host_str(), Some("github.com" | "release-assets.githubusercontent.com" | "objects.githubusercontent.com")))
}
fn fetch(url: &str, limit: u64) -> Result<Vec<u8>, String> {
    if !trusted_url(url) { return Err("Untrusted release URL.".into()); }
    let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(180)).connect_timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::custom(|attempt| if attempt.previous().len() >= 5 || !trusted_url(attempt.url().as_str()) { attempt.error("Untrusted release redirect") } else { attempt.follow() }))
        .build().map_err(|e| e.to_string())?;
    let response = client.get(url).header("User-Agent", "Tsuki-Managed-Loader/1").send().and_then(|r| r.error_for_status()).map_err(|_| "Loader download unavailable. Your profile remains accessible; retry when online.")?;
    if response.content_length().is_some_and(|size| size > limit) { return Err("Release download exceeds its size limit.".into()); }
    let mut result = Vec::new(); response.take(limit + 1).read_to_end(&mut result).map_err(|_| "Loader download interrupted.")?;
    if result.len() as u64 > limit { return Err("Release download exceeds its size limit.".into()); } Ok(result)
}
fn lock(dir: &Path) -> Result<File, String> {
    let file = fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).open(dir.join("operation.lock")).map_err(|e| e.to_string())?;
    file.try_lock_exclusive().map_err(|_| "Another loader operation is in progress. Retry shortly.")?; Ok(file)
}
fn intact(runtime: &Path, manifest: &Manifest) -> bool {
    manifest.files.iter().all(|file| {
        let path = runtime.join(&file.path);
        ordinary_tree(&path).is_ok() && fs::metadata(&path).is_ok_and(|m| m.is_file() && m.len() == file.size) && file_hash(&path).is_ok_and(|sha| sha.eq_ignore_ascii_case(&file.sha256))
    })
}
fn cached_intact(runtime: &Path, manifest: &Manifest) -> bool {
    type Stamp = Vec<(u64, Option<std::time::SystemTime>)>;
    static CACHE: std::sync::OnceLock<Mutex<std::collections::HashMap<PathBuf, (Stamp, bool)>>> = std::sync::OnceLock::new();
    let stamps = manifest.files.iter().map(|f| {
        let path = runtime.join(&f.path); ordinary_tree(&path).ok()?;
        let metadata = fs::metadata(path).ok()?;
        Some((metadata.len(), metadata.modified().ok()))
    }).collect::<Option<Stamp>>();
    let Some(stamps) = stamps else { return false; };
    let cache = CACHE.get_or_init(|| Mutex::new(std::collections::HashMap::new()));
    if let Ok(cache) = cache.lock() { if let Some((old, result)) = cache.get(runtime) { if *old == stamps { return *result; } } }
    let result = intact(runtime, manifest);
    if let Ok(mut cache) = cache.lock() { cache.insert(runtime.into(), (stamps, result)); } result
}
fn owned_tree(runtime: &Path, manifest: &Manifest) -> Result<(), String> {
    let mut expected: HashSet<String> = manifest.files.iter().map(|f| f.path.to_ascii_lowercase()).collect();
    expected.extend(["installed.json".into(), "tsuki-managed-receipt.json".into()]);
    fn visit(root: &Path, current: &Path, expected: &HashSet<String>) -> Result<(), String> {
        ordinary_tree(current)?;
        for entry in fs::read_dir(current).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path(); ordinary_tree(&path)?;
            if path.is_dir() { visit(root, &path, expected)?; }
            else {
                let name = path.strip_prefix(root).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/").to_ascii_lowercase();
                if !expected.contains(&name) { return Err("Loader runtime contains unrelated files; preserving the folder. Move those files before repair or removal.".into()); }
            }
        } Ok(())
    }
    visit(runtime, runtime, &expected)
}
fn installed(dir: &Path, config: &ReleaseSource) -> Result<(Installed, Manifest), String> {
    let record: Installed = serde_json::from_slice(&fs::read(dir.join("installed.json")).map_err(|_| "Loader is not installed.")?).map_err(|_| "Loader receipt is damaged.")?;
    let manifest = verify_installed(&record.manifest, &record.signature, config)?; Ok((record, manifest))
}
fn verify_installed(raw: &[u8], signature: &str, config: &ReleaseSource) -> Result<Manifest, String> {
    verify(raw, signature, config).or_else(|error| {
        // Only existing local receipts may migrate from the former channel.
        // Remote releases still require the new repository and the pinned key.
        if config.repository != "Itsukiomo/runtime-channel-7f3a" { return Err(error); }
        let legacy = ReleaseSource {
            repository: "Itsukiomo/OutlastTrialsNativePakLoader".into(),
            public_key: config.public_key.clone(),
        };
        verify(raw, signature, &legacy).map_err(|_| error)
    })
}
// The runtime and its receipt share one directory swap; a durable marker keeps rollback deterministic.
fn recover(game: &Path) -> Result<(), String> {
    let home = game.join("NativePakLoader"); let runtime = game.join(RUNTIME);
    let backup = home.join(".tsuki-runtime-backup"); let staging = home.join(".tsuki-runtime-staging"); let journal = home.join(".tsuki-runtime-pending");
    ordinary_tree(&home)?; ordinary_tree(&runtime)?; ordinary_tree(&backup)?; ordinary_tree(&staging)?;
    if journal.exists() {
        let marker = fs::read(&journal).map_err(|e| e.to_string())?;
        if marker != b"fresh" && marker != b"replace" { return Err("Loader recovery marker is invalid; files were preserved.".into()); }
        let fresh = marker == b"fresh";
        if backup.exists() || fresh {
            if runtime.exists() { fs::remove_dir_all(&runtime).map_err(|e| e.to_string())?; }
            if backup.exists() { fs::rename(&backup, &runtime).map_err(|e| e.to_string())?; }
        }
        fs::remove_file(&journal).map_err(|e| e.to_string())?;
    }
    if staging.exists() {
        if fs::read(staging.join(".tsuki-staging-owned")).ok().as_deref() != Some(b"Tsuki verified-runtime staging") && fs::read_dir(&staging).map_err(|e| e.to_string())?.next().is_some() { return Err("Staging folder contains unowned files; preserving it.".into()); }
        fs::remove_dir_all(staging).map_err(|e| e.to_string())?;
    }
    if backup.exists() {
        let record: Installed = serde_json::from_slice(&fs::read(backup.join("installed.json")).map_err(|_| "Runtime backup ownership is missing.")?).map_err(|_| "Runtime backup record is damaged.")?;
        let manifest: Manifest = serde_json::from_slice(&record.manifest).map_err(|_| "Runtime backup manifest is damaged.")?;
        owned_tree(&backup, &manifest)?;
        fs::remove_dir_all(backup).map_err(|e| e.to_string())?;
    } Ok(())
}
#[cfg(test)]
fn install_bundle(game: &Path, raw: &[u8], signature: &str, manifest: &Manifest, bytes: &[u8]) -> Result<(), String> {
    install_bundle_owned(game, raw, signature, manifest, bytes, manifest)
}
fn install_bundle_owned(game: &Path, raw: &[u8], signature: &str, manifest: &Manifest, bytes: &[u8], prior: &Manifest) -> Result<(), String> {
    if bytes.len() as u64 != manifest.archive_size || !hash(bytes).eq_ignore_ascii_case(&manifest.archive_sha256) { return Err("Release archive hash or length mismatch.".into()); }
    let home = game.join("NativePakLoader"); fs::create_dir_all(&home).map_err(|e| e.to_string())?; recover(game)?;
    let runtime = game.join(RUNTIME); let staging = home.join(".tsuki-runtime-staging"); let backup = home.join(".tsuki-runtime-backup"); let journal = home.join(".tsuki-runtime-pending");
    if runtime.exists() && !runtime.join("tsuki-managed-receipt.json").is_file() { return Err("Runtime folder is not owned by Tsuki; no user files were replaced.".into()); }
    if runtime.exists() { owned_tree(&runtime, prior)?; }
    fs::create_dir(&staging).map_err(|e| e.to_string())?;
    fs::write(staging.join(".tsuki-staging-owned"), b"Tsuki verified-runtime staging").map_err(|e| e.to_string())?;
    let prepared = (|| {
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| e.to_string())?;
        if archive.len() != manifest.files.len() { return Err("Archive contains undeclared files.".into()); }
        let mut seen = HashSet::new();
        for index in 0..archive.len() {
            let mut member = archive.by_index(index).map_err(|e| e.to_string())?;
            let file = manifest.files.iter().find(|f| f.path == member.name()).ok_or("Archive contains undeclared files.")?;
            if !seen.insert(file.path.clone()) || member.size() != file.size || member.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000) { return Err("Invalid archive member.".into()); }
            let mut contents = Vec::new(); (&mut member).take(file.size + 1).read_to_end(&mut contents).map_err(|e| e.to_string())?;
            if contents.len() as u64 != file.size || !hash(&contents).eq_ignore_ascii_case(&file.sha256) { return Err("Runtime file failed verification.".into()); }
            let target = staging.join(&file.path); fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
            let mut output = File::create(target).map_err(|e| e.to_string())?; output.write_all(&contents).and_then(|_| output.sync_all()).map_err(|e| e.to_string())?;
        }
        let receipt = InstallReceipt { id: "native-pak-loader".into(), display_name: "Native PAK Loader".into(), source: "tsuki-managed-loader".into(), mod_type: "loader".into(), source_mod_id: None, source_file_id: None, source_file_name: None, source_file_category: None, source_file_uploaded_at: None, source_file_version: None, version: Some(manifest.version.clone()), author: None, thumbnail_url: None, banner_url: None, page_url: None, installed_at_unix: None, enabled: Some(true), profile_id: Some(PROFILE.into()), notes: Some("Deployment integrity only; runtime compatibility is not guaranteed.".into()), files: manifest.files.iter().map(|f| InstallReceiptFile { relative_path: runtime.join(&f.path).display().to_string(), size_bytes: Some(f.size), sha256: Some(f.sha256.clone()), original_path: None, backup_path: None }).collect() };
        fs::write(staging.join("tsuki-managed-receipt.json"), serde_json::to_vec_pretty(&receipt).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        fs::write(staging.join("installed.json"), serde_json::to_vec(&Installed { manifest: raw.to_vec(), signature: signature.into(), game_root: game.display().to_string() }).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    })();
    if let Err(error) = prepared { let _ = fs::remove_dir_all(&staging); return Err(error); }
    let mut marker = File::create(&journal).map_err(|e| e.to_string())?; marker.write_all(if runtime.exists() { b"replace" } else { b"fresh" }).and_then(|_| marker.sync_all()).map_err(|e| e.to_string())?;
    if runtime.exists() { fs::rename(&runtime, &backup).map_err(|e| e.to_string())?; }
    if let Err(error) = fs::rename(&staging, &runtime) { recover(game)?; return Err(error.to_string()); }
    fs::remove_file(runtime.join(".tsuki-staging-owned")).map_err(|e| e.to_string())?;
    fs::remove_file(&journal).map_err(|e| e.to_string())?;
    if backup.exists() { fs::remove_dir_all(backup).map_err(|e| e.to_string())?; } Ok(())
}
fn status() -> Result<Status, String> {
    let dir = data()?; let consent = authorized(&dir);
    let config = match source() { Ok(value) => value, Err(message) => return Ok(Status { state: "unconfigured".into(), message, version: None, authorized: consent }) };
    if !consent { return Ok(Status { state: "disclosure".into(), message: "Native PAK support downloads an independently released compiled backend from GitHub. It modifies the game's PAK before launch and keeps recovery records. Online use and future game compatibility are not guaranteed.".into(), version: None, authorized: false }); }
    let game = root()?; let _lock = lock(&dir)?; recover(&game)?;
    let runtime = game.join(RUNTIME);
    match installed(&runtime, &config) {
        Ok((_, manifest)) if cached_intact(&runtime, &manifest) => Ok(Status { state: "ready".into(), message: "Native PAK backend verified. Game compatibility remains unverified.".into(), version: Some(manifest.version), authorized: true }),
        _ => Ok(Status { state: "missing".into(), message: "Native PAK support needs installation or repair.".into(), version: None, authorized: true }),
    }
}
fn ensure(repair: bool, update: bool) -> Result<Status, String> {
    let dir = data()?; if !authorized(&dir) { return status(); }
    let config = source()?; let game = root()?; let _lock = lock(&dir)?; recover(&game)?;
    let runtime = game.join(RUNTIME);
    if !repair && !update && installed(&runtime, &config).is_ok_and(|(_, m)| cached_intact(&runtime, &m)) { drop(_lock); return status(); }
    let previous = installed(&runtime, &config).ok();
    let cached = if update { None } else { installed(&runtime, &config).ok().or_else(|| {
        let record: Installed = serde_json::from_slice(&fs::read(dir.join("release-cache.json")).ok()?).ok()?;
        let manifest = verify(&record.manifest, &record.signature, &config).ok()?; Some((record, manifest))
    }) };
    let (raw, sig) = if let Some((record, _)) = cached { (record.manifest, record.signature) } else {
        let base = format!("https://github.com/{}/releases/latest/download", config.repository);
        (fetch(&format!("{base}/manifest.json"), 65536)?, String::from_utf8(fetch(&format!("{base}/manifest.sig"), 1024)?).map_err(|_| "Invalid signature encoding.")?)
    };
    let manifest = verify(&raw, &sig, &config)?;
    if let Some((_, prior)) = &previous {
        if runtime_release_is_older(&prior.version, &manifest.version)? {
            if intact(&runtime, prior) {
                drop(_lock);
                return status();
            }
            return Err("The available signed backend is older than the installed version. Repair the installed version; no runtime files were changed.".into());
        }
    }
    fs::write(dir.join("release-cache.json"), serde_json::to_vec(&Installed { manifest: raw.clone(), signature: sig.clone(), game_root: game.display().to_string() }).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let bytes = fetch(&manifest.archive_url, manifest.archive_size)?;
    install_bundle_owned(&game, &raw, &sig, &manifest, &bytes, previous.as_ref().map(|(_, m)| m).unwrap_or(&manifest))?; drop(_lock); status()
}
fn runtime_release_is_older(installed: &str, incoming: &str) -> Result<bool, String> {
    let installed = semver::Version::parse(installed).map_err(|_| "Installed loader version cannot be compared safely.")?;
    let incoming = semver::Version::parse(incoming).map_err(|_| "Signed loader version is not a semantic version.")?;
    Ok(incoming.cmp_precedence(&installed).is_lt())
}
pub(crate) fn prepare_launch(game: &Path, vanilla: bool) -> Result<(), String> {
    profile_dependencies::game_closed(PROFILE)?;
    let dir = data()?; let _lock = lock(&dir)?; recover(game)?;
    let runtime = game.join(RUNTIME);
    if vanilla && !runtime.exists() {
        if game.join("NativePakLoader/append-backup/state.json").exists() || game.join("NativePakLoader/movie-backup/state.json").exists() { return Err("Existing native PAK recovery data was found. Install or repair the verified backend before requesting a vanilla launch.".into()); }
        return Ok(());
    }
    if !authorized(&dir) { return Err("Authorize Native PAK support in the Outlast profile before launching modded.".into()); }
    let (_, manifest) = installed(&runtime, &source()?)?;
    if !intact(&runtime, &manifest) { return Err("Native PAK runtime is damaged. Repair it before launch.".into()); }
    let mut command = Command::new(runtime.join(&manifest.entry_point)); hide_command_window(&mut command);
    let mut has_managed_movies = false;
    if !vanilla {
        for receipt in profile_installs::list_profile_receipts_internal(PROFILE)? {
            if receipt.enabled == Some(false) { continue; }
            for file in receipt.files {
                let path = PathBuf::from(file.relative_path);
                if path.is_file() && path.extension().is_some_and(|v| v.eq_ignore_ascii_case("pak")) && path.starts_with(game.join("OPP/Content/Paks")) {
                    command.arg("--managed-pak").arg(path);
                } else if path.is_file() && path.starts_with(game.join("NativePakLoader/Mods"))
                    && path.extension().is_some_and(|v| v.eq_ignore_ascii_case("bk2") || v.eq_ignore_ascii_case("srt")) {
                    command.arg("--managed-movie").arg(path);
                    has_managed_movies = true;
                }
            }
        }
    }
    if has_managed_movies {
        let mut probe = Command::new(runtime.join(&manifest.entry_point)); hide_command_window(&mut probe);
        let result = probe.args(["--game-root"]).arg(game).arg("status").current_dir(&runtime).output().map_err(|e| e.to_string())?;
        let capabilities: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap_or_default();
        if !result.status.success() || !capabilities.get("capabilities").and_then(|v| v.as_array())
            .is_some_and(|items| items.iter().any(|v| v.as_str() == Some("managed-movies"))) {
            return Err("This native backend does not support Tsuki-managed movies. Update the signed Outlast backend before launching; no game movie was changed.".into());
        }
    }
    let result = command.arg("--game-root").arg(game).arg(if vanilla { "restore" } else { "apply" }).current_dir(&runtime).output().map_err(|_| "Native PAK backend could not start.")?;
    validate_backend_result(result.status.success(), &result.stdout, &result.stderr, vanilla)
}
fn validate_backend_result(success: bool, stdout: &[u8], stderr: &[u8], vanilla: bool) -> Result<(), String> {
    let protocol: serde_json::Value = serde_json::from_slice(stdout).unwrap_or_default();
    if success && protocol.get("protocol").and_then(|v| v.as_u64()) == Some(1)
        && protocol.get("state").and_then(|v| v.as_str()) == Some(if vanilla { "restored" } else { "applied" }) { return Ok(()); }
    let detail = protocol.get("message").and_then(|v| v.as_str()).filter(|s| !s.is_empty())
        .map(str::to_owned).unwrap_or_else(|| String::from_utf8_lossy(stderr).chars().take(1200).collect());
    Err(format!("Native PAK operation failed: {}. The game was not launched; recovery records and user mods were retained.", if detail.trim().is_empty() { "the backend returned an invalid response" } else { detail.trim() }))
}
fn launch_lock(dir: &Path) -> Result<File, String> {
    let guard = fs::OpenOptions::new().read(true).write(true).create(true).truncate(false)
        .open(dir.join("launch.lock")).map_err(|e| e.to_string())?;
    guard.try_lock_exclusive().map_err(|_| "Outlast Trials is already launching or running. Wait for it to exit before launching again.")?;
    Ok(guard)
}
pub(crate) fn launch_via_steam(mapping: ProfileLaunchMapping, vanilla: bool) -> Result<String, String> {
    let dir = data()?;
    // Keep a separate cross-process launch lock through preparation and the actual game lifetime.
    let guard = launch_lock(&dir)?;
    profile_dependencies::game_closed(PROFILE).map_err(|error| if error.starts_with("Close the game") {
        "Outlast Trials is already running. Close the game before launching again.".to_owned()
    } else { error })?;
    let steam = common_steam_roots().into_iter().map(|root| root.join("steam.exe"))
        .find(|path| path.is_file()).ok_or("Steam was not found. Start Steam before launching Outlast Trials.")?;
    prepare_launch(Path::new(&mapping.game_root), vanilla)?;
    let enabled = if vanilla {
        let ids = profile_installs::enabled_profile_receipt_ids(PROFILE)?;
        profile_installs::apply_profile_receipt_selection(PROFILE, &[])?;
        ids
    } else { Vec::new() };
    let mut command = Command::new(steam);
    hide_command_window(&mut command);
    command.args(["-applaunch", "1304930"]).args(&mapping.arguments);
    for entry in load_profile_settings_internal(PROFILE).launch_environment {
        if let Some((key, value)) = entry.split_once('=') { if !key.trim().is_empty() { command.env(key.trim(), value.trim()); } }
    }
    if let Err(error) = command.spawn() {
        if vanilla { profile_installs::apply_profile_receipt_selection(PROFILE, &enabled)?; }
        return Err(format!("Steam could not launch Outlast Trials: {error}"));
    }
    std::thread::spawn(move || {
        let _guard = guard;
        let mut observed = false;
        let mut absent = 0;
        for _ in 0..120 {
            match profile_dependencies::game_closed(PROFILE) {
                Ok(()) => { absent += 1; if observed && absent >= 5 { break; } }
                Err(message) if message.starts_with("Close the game") => { observed = true; absent = 0; }
                Err(_) => return, // Never restore files when process detection fails.
            }
            std::thread::sleep(Duration::from_secs(1));
        }
        while profile_dependencies::game_closed(PROFILE).is_err() { std::thread::sleep(Duration::from_secs(2)); }
        if vanilla { let _ = profile_installs::apply_profile_receipt_selection(PROFILE, &enabled); }
    });
    Ok("Requested Outlast Trials through Steam. Waiting for the game is not proof of a successful launch.".into())
}
pub(crate) fn dependency_item() -> DependencyStatusItem {
    let current = status().unwrap_or_else(|message| Status { state: "error".into(), message, version: None, authorized: false });
    DependencyStatusItem { id: "outlast-native-pak".into(), label: "Native PAK Loader".into(), found: current.state == "ready", status: current.state, path: root().ok().map(|game| game.join(RUNTIME).display().to_string()), details: current.message, recommendation: "Manage the independently distributed backend in the Outlast profile. Mod changes apply before launch; loader integrity is not game compatibility proof.".into() }
}
pub(crate) fn ensure_archive_dependency() -> Result<String, String> {
    profile_dependencies::game_closed(PROFILE)?;
    let dir = data()?;
    if !authorized(&dir) { return Err("Authorize Native PAK support in the Outlast profile first. Automatic dependency setup cannot bypass its protection disclosure.".into()); }
    let checked = dir.join("dependency-update-check");
    let last = fs::read_to_string(&checked).ok().and_then(|v| v.parse::<u128>().ok()).unwrap_or(0);
    let update = now_unix_millis().saturating_sub(last) >= 24 * 60 * 60 * 1000;
    let current = ensure(false, update)?;
    if current.state != "ready" { return Err(current.message); }
    if update { fs::write(checked, now_unix_millis().to_string()).map_err(|e| e.to_string())?; }
    Ok(current.message)
}
#[tauri::command]
pub(crate) async fn managed_loader_status() -> Result<Status, String> { tauri::async_runtime::spawn_blocking(status).await.map_err(|e| e.to_string())? }
#[tauri::command]
pub(crate) async fn managed_loader_action(action: String) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || match action.as_str() {
        "authorize" => { let dir = data()?; fs::write(dir.join("consent-v1"), b"external compiled GitHub runtime authorized").map_err(|e| e.to_string())?; ensure(false, false) },
        "ensure" => ensure(false, false), "repair" => ensure(true, false), "update" => ensure(true, true),
        "uninstall" => { let game = root()?; prepare_launch(&game, true)?; let dir = data()?; let _lock = lock(&dir)?; let runtime = game.join(RUNTIME); ordinary_tree(&runtime)?; if runtime.exists() { let (_, manifest) = installed(&runtime, &source()?)?; owned_tree(&runtime, &manifest)?; fs::remove_dir_all(runtime).map_err(|e| e.to_string())?; } if dir.join("consent-v1").exists() { fs::remove_file(dir.join("consent-v1")).map_err(|e| e.to_string())?; } drop(_lock); status() },
        _ => Err("Unknown loader operation.".into()),
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Owner-only local signed runtime deployment; requires explicit game, release and backup paths"]
    fn local_owner_runtime_deployment() {
        let game = PathBuf::from(env::var("TSUKI_LOADER_GAME_ROOT").expect("explicit game root"));
        let release = PathBuf::from(env::var("TSUKI_LOADER_RELEASE").expect("signed release folder"));
        let backup = PathBuf::from(env::var("TSUKI_LOADER_BACKUP_ROOT").expect("explicit fresh backup folder"));
        profile_installs::validate_builtin_profile_root(PROFILE, &game).unwrap();
        profile_dependencies::game_closed(PROFILE).unwrap();
        ordinary_tree(&game).unwrap();
        let raw = fs::read(release.join("manifest.json")).unwrap();
        let signature = fs::read_to_string(release.join("manifest.sig")).unwrap();
        let config = source().unwrap();
        let manifest = verify(&raw, &signature, &config).unwrap();
        let archive = fs::read(release.join("outlast-native-pak-win64.zip")).unwrap();
        let dir = data().unwrap();
        let _guard = lock(&dir).unwrap();
        let runtime = game.join(RUNTIME);
        let (_, prior) = installed(&runtime, &config).unwrap();
        owned_tree(&runtime, &prior).unwrap();
        assert!(intact(&runtime, &prior));
        assert!(!backup.exists(), "Use a fresh backup folder");
        assert!(!backup.starts_with(&runtime));
        fs::create_dir_all(&backup).unwrap();
        for path in prior.files.iter().map(|file| file.path.as_str()).chain(["installed.json", "tsuki-managed-receipt.json"]) {
            let target = backup.join(path);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::copy(runtime.join(path), &target).unwrap();
            assert_eq!(file_hash(&runtime.join(path)).unwrap(), file_hash(&target).unwrap());
        }
        install_bundle_owned(&game, &raw, &signature, &manifest, &archive, &prior).unwrap();
        assert!(intact(&runtime, &manifest));
        println!("Installed signed local runtime {}. Previous runtime: {}. No publication performed.", manifest.version, backup.display());
    }
    #[test]
    fn launch_guard_blocks_duplicates_until_game_exit() {
        let sandbox = Sandbox::new();
        let guard = launch_lock(&sandbox.0).unwrap();
        assert!(launch_lock(&sandbox.0).unwrap_err().contains("already launching"));
        drop(guard);
        assert!(launch_lock(&sandbox.0).is_ok());
    }
    #[test]
    fn backend_response_reports_failure_and_validates_action() {
        assert!(validate_backend_result(true, br#"{"protocol":1,"state":"applied"}"#, b"", false).is_ok());
        assert!(validate_backend_result(true, br#"{"protocol":1,"state":"applied"}"#, b"", true).is_err());
        let error = validate_backend_result(false, br#"{"protocol":1,"state":"failed","message":"Close the game"}"#, b"", false).unwrap_err();
        assert!(error.contains("Close the game"));
        assert!(validate_backend_result(false, b"", b"Archive is locked", false).unwrap_err().contains("Archive is locked"));
    }
    #[test]
    fn runtime_updates_never_downgrade_a_local_fix() {
        assert!(runtime_release_is_older("1.0.2", "1.0.0").unwrap());
        assert!(runtime_release_is_older("1.0.2", "1.0.2-rc.1").unwrap());
        assert!(!runtime_release_is_older("1.0.2", "1.0.2").unwrap());
        assert!(!runtime_release_is_older("1.0.2", "1.0.3").unwrap());
        assert!(!runtime_release_is_older("1.0.2+local", "1.0.2+public").unwrap());
        assert!(runtime_release_is_older("unknown", "1.0.2").is_err());
        assert!(runtime_release_is_older("1.0.2", "unknown").is_err());
    }
    #[test]
    #[ignore = "Set TSUKI_LOADER_RELEASE to the prepared release asset folder"]
    fn prepared_release_bundle() {
        let folder = PathBuf::from(env::var("TSUKI_LOADER_RELEASE").expect("release folder"));
        let raw = fs::read(folder.join("manifest.json")).unwrap();
        let signature = fs::read_to_string(folder.join("manifest.sig")).unwrap();
        let manifest = verify(&raw, &signature, &source().unwrap()).unwrap();
        let zip = fs::read(folder.join("outlast-native-pak-win64.zip")).unwrap();
        let sandbox = Sandbox::new();
        install_bundle(&sandbox.0, &raw, &signature, &manifest, &zip).unwrap();
        assert!(intact(&sandbox.0.join(RUNTIME), &manifest));
        owned_tree(&sandbox.0.join(RUNTIME), &manifest).unwrap();
    }
    struct Sandbox(PathBuf);
    impl Sandbox {
        fn new() -> Self { let path = env::temp_dir().join(format!("tsuki-loader-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos())); fs::create_dir_all(&path).unwrap(); Self(path) }
    }
    impl Drop for Sandbox { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    fn release() -> (Vec<u8>, String, Manifest, Vec<u8>) {
        use ed25519_dalek::{Signer, SigningKey};
        let content = b"compiled-backend-fixture";
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer.start_file("backend.exe", zip::write::SimpleFileOptions::default()).unwrap(); writer.write_all(content).unwrap();
        let zip = writer.finish().unwrap().into_inner();
        let manifest = Manifest { loader_id: "outlast-native-pak".into(), version: "1.2.3".into(), protocol: 1, release_tag: "v1.2.3".into(), archive_url: "https://github.com/test/releases/releases/download/v1.2.3/runtime.zip".into(), archive_sha256: hash(&zip), archive_size: zip.len() as u64, entry_point: "backend.exe".into(), files: vec![PayloadFile { path: "backend.exe".into(), size: content.len() as u64, sha256: hash(content) }] };
        let signing = SigningKey::from_bytes(&[42; 32]); let raw = serde_json::to_vec(&manifest).unwrap();
        let signature = base64::engine::general_purpose::STANDARD.encode(signing.sign(&raw).to_bytes());
        let config = ReleaseSource { repository: "test/releases".into(), public_key: base64::engine::general_purpose::STANDARD.encode(signing.verifying_key().as_bytes()) };
        verify(&raw, &signature, &config).unwrap(); (raw, signature, manifest, zip)
    }
    #[test] fn fresh_install_and_repair_preserve_user_mods() {
        let sandbox = Sandbox::new(); let game = &sandbox.0;
        fs::create_dir_all(game.join("NativePakLoader/Mods/example")).unwrap();
        let user_mod = game.join("NativePakLoader/Mods/example/user.pak"); fs::write(&user_mod, b"user-data").unwrap();
        let (raw, signature, manifest, zip) = release(); install_bundle(game, &raw, &signature, &manifest, &zip).unwrap();
        let runtime = game.join(RUNTIME); assert!(intact(&runtime, &manifest)); assert!(cached_intact(&runtime, &manifest));
        fs::write(runtime.join("backend.exe"), b"corrupted").unwrap(); assert!(!cached_intact(&runtime, &manifest));
        install_bundle(game, &raw, &signature, &manifest, &zip).unwrap(); assert!(intact(&runtime, &manifest));
        owned_tree(&runtime, &manifest).unwrap(); fs::remove_dir_all(runtime).unwrap();
        assert_eq!(fs::read(user_mod).unwrap(), b"user-data");
    }
    #[test] fn corruption_never_replaces_existing_runtime() {
        let sandbox = Sandbox::new(); let (raw, signature, manifest, zip) = release();
        install_bundle(&sandbox.0, &raw, &signature, &manifest, &zip).unwrap();
        let mut damaged = zip; damaged[0] ^= 1;
        assert!(install_bundle(&sandbox.0, &raw, &signature, &manifest, &damaged).is_err());
        assert!(intact(&sandbox.0.join(RUNTIME), &manifest));
    }
    #[test] fn unrelated_runtime_files_block_repair() {
        let sandbox = Sandbox::new(); let (raw, signature, manifest, zip) = release();
        install_bundle(&sandbox.0, &raw, &signature, &manifest, &zip).unwrap();
        let unrelated = sandbox.0.join(RUNTIME).join("my-file.txt"); fs::write(&unrelated, b"preserve").unwrap();
        assert!(install_bundle(&sandbox.0, &raw, &signature, &manifest, &zip).is_err());
        assert_eq!(fs::read(unrelated).unwrap(), b"preserve");
    }
    #[test] fn interrupted_replacement_restores_previous_runtime() {
        let sandbox = Sandbox::new(); let (raw, signature, manifest, zip) = release();
        install_bundle(&sandbox.0, &raw, &signature, &manifest, &zip).unwrap();
        let home = sandbox.0.join("NativePakLoader"); let runtime = sandbox.0.join(RUNTIME);
        fs::write(home.join(".tsuki-runtime-pending"), b"replace").unwrap();
        recover(&sandbox.0).unwrap(); assert!(intact(&runtime, &manifest));
        fs::write(home.join(".tsuki-runtime-pending"), b"replace").unwrap();
        fs::rename(&runtime, home.join(".tsuki-runtime-backup")).unwrap();
        fs::create_dir(&runtime).unwrap(); fs::write(runtime.join("incomplete.exe"), b"partial").unwrap();
        recover(&sandbox.0).unwrap(); assert!(intact(&runtime, &manifest));
    }
    #[test] fn interrupted_first_install_removes_partial_runtime() {
        let sandbox = Sandbox::new(); let home = sandbox.0.join("NativePakLoader");
        fs::create_dir_all(sandbox.0.join(RUNTIME)).unwrap(); fs::write(home.join(".tsuki-runtime-pending"), b"fresh").unwrap();
        recover(&sandbox.0).unwrap(); assert!(!sandbox.0.join(RUNTIME).exists());
    }
    #[test] fn concurrent_profile_operations_are_exclusive() {
        let sandbox = Sandbox::new(); let first = lock(&sandbox.0).unwrap(); assert!(lock(&sandbox.0).is_err());
        drop(first); assert!(lock(&sandbox.0).is_ok());
    }
    #[test] fn game_build_change_does_not_invalidate_loader() {
        let sandbox = Sandbox::new(); let (raw, signature, manifest, zip) = release();
        install_bundle(&sandbox.0, &raw, &signature, &manifest, &zip).unwrap();
        fs::write(sandbox.0.join("game-build.txt"), b"new-steam-version").unwrap(); assert!(intact(&sandbox.0.join(RUNTIME), &manifest));
    }
    #[test] fn rejects_windows_path_escapes() { for path in ["../x.exe", "/x.exe", "C:/x.exe", "x\\y.exe", "NUL.exe", "a./x.exe", "a:b.exe"] { assert!(safe_path(path).is_err(), "{path}"); } assert!(safe_path("runtime/backend.exe").is_ok()); }
    #[test] fn rejects_untrusted_transport() { for url in ["http://github.com/x", "https://github.com.evil.test/x", "https://user@github.com/x", "https://github.com:444/x", "https://example.com/x"] { assert!(!trusted_url(url)); } assert!(trusted_url("https://release-assets.githubusercontent.com/x")); }
    #[test] fn signature_rejects_modified_manifest() {
        use ed25519_dalek::{Signer, SigningKey};
        let signing = SigningKey::from_bytes(&[42; 32]); let raw = b"{}";
        let config = ReleaseSource { repository: "test/releases".into(), public_key: base64::engine::general_purpose::STANDARD.encode(signing.verifying_key().as_bytes()) };
        let sig = base64::engine::general_purpose::STANDARD.encode(signing.sign(raw).to_bytes());
        assert!(verify(b"{ }", &sig, &config).unwrap_err().contains("signature"));
    }
    #[test] fn channel_migration_trusts_only_old_signed_local_receipts() {
        use ed25519_dalek::{Signer, SigningKey};
        let (_, _, mut manifest, _) = release();
        manifest.archive_url = "https://github.com/Itsukiomo/OutlastTrialsNativePakLoader/releases/download/v1.2.3/runtime.zip".into();
        let signing = SigningKey::from_bytes(&[42; 32]);
        let config = ReleaseSource { repository: "Itsukiomo/runtime-channel-7f3a".into(), public_key: base64::engine::general_purpose::STANDARD.encode(signing.verifying_key().as_bytes()) };
        let raw = serde_json::to_vec(&manifest).unwrap();
        let signature = base64::engine::general_purpose::STANDARD.encode(signing.sign(&raw).to_bytes());
        assert!(verify(&raw, &signature, &config).is_err());
        assert!(verify_installed(&raw, &signature, &config).is_ok());
        assert!(verify_installed(b"{}", &signature, &config).is_err());
        manifest.archive_url = "https://github.com/untrusted/repository/releases/download/v1.2.3/runtime.zip".into();
        let raw = serde_json::to_vec(&manifest).unwrap();
        let signature = base64::engine::general_purpose::STANDARD.encode(signing.sign(&raw).to_bytes());
        assert!(verify_installed(&raw, &signature, &config).is_err());
    }
}
