use super::*;
use std::collections::{BTreeMap, BTreeSet};

pub(super) fn read_catalog(profile_id: Option<&str>) -> Result<SourceIndexDatabase, String> {
    let profile = profile_id.unwrap_or(BUILTIN_PAYDAY3_PROFILE_ID);
    let file = profile_data_dir_for(profile)?.join("source-index/source-index.json");
    let mut database = if file.is_file() {
        serde_json::from_slice::<SourceIndexDatabase>(&fs::read(&file).map_err(|e| e.to_string())?)
            .map_err(|e| format!("Invalid profile source index {}: {}", file.display(), e))?
    } else { SourceIndexDatabase::default() };
    let downloads = profile_data_dir_for(profile)?.join("source-index/in-app-download-index.json");
    if let Ok(bytes) = fs::read(downloads) {
        if let Ok(downloads) = serde_json::from_slice::<SourceIndexDatabase>(&bytes) {
            let replaced = downloads.records.values().map(|record| (record.source.clone(), record.source_id.clone(), record.summary.page_url.clone())).collect::<BTreeSet<_>>();
            database.records.retain(|_, existing| !replaced.contains(&(existing.source.clone(), existing.source_id.clone(), existing.summary.page_url.clone())));
            for (key, record) in downloads.records {
                database.records.insert(key, record);
            }
        }
    }
    if is_builtin_payday3_profile(Some(profile)) && !file.is_file() {
        for (key, record) in read_source_index_database().records {
            if !database.records.values().any(|existing| existing.source == record.source && existing.source_id == record.source_id) {
                database.records.insert(key, record);
            }
        }
        database.records.retain(|_, record| !record.summary.tags.iter().any(|tag| tag.eq_ignore_ascii_case("UE4.27")));
    }
    if profile == "builtin.borderlands" {
        if let Ok(root) = profile_installs::indexed_game_root(profile) {
            let domain = if root.join("Binaries/Win64/BorderlandsGOTY.exe").is_file() { "borderlandsgotyenhanced" } else { "borderlands" };
            database.records.retain(|_, record| record.source != "nexus" || record.summary.page_url.as_deref().is_some_and(|url| url.contains(&format!("/{}/mods/", domain))));
        }
    }
    Ok(database)
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct IndexedFile { file_name: String, file_size: u64, sha256: String }

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct IndexedArchive {
    source: String, game: String, mod_id: String, file_id: String,
    version: Option<String>, file_name: String, status: String,
    file_entries: Vec<IndexedFile>,
}

#[derive(Debug, Deserialize, Default)]
struct FileIndex { #[serde(default)] archives: BTreeMap<String, IndexedArchive> }

fn file_index(profile_id: &str) -> FileIndex {
    let mut index: FileIndex = profile_data_dir_for(profile_id).ok()
        .and_then(|root| fs::read(root.join("source-index/file-hashes.json")).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
    if let Some(journal) = profile_data_dir_for(profile_id).ok().and_then(|root| fs::read_to_string(root.join("source-index/archive-results.ndjson")).ok()) {
        for line in journal.lines() {
            if let Ok(row) = serde_json::from_str::<serde_json::Value>(line) {
                if let (Some(key), Ok(archive)) = (row["key"].as_str(), serde_json::from_value::<IndexedArchive>(row["archive"].clone())) { index.archives.insert(key.into(), archive); }
            }
        }
    }
    if is_builtin_payday3_profile(Some(profile_id)) {
        let root = profile_data_dir_for(profile_id).ok();
        let state = root.as_ref().and_then(|root| fs::read(root.join("source-index/bulk-index-progress.json")).ok())
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok()).unwrap_or_default();
        let catalog = root.and_then(|root| fs::read(root.join("source-index/source-index.json")).ok())
            .and_then(|bytes| serde_json::from_slice::<SourceIndexDatabase>(&bytes).ok()).unwrap_or_default();
        let verified_mods = state["sources"].as_object().into_iter().flat_map(|sources| sources.values())
            .filter_map(|source| source["mods"].as_object()).flat_map(|mods| mods.iter())
            .filter(|(_, value)| value["engineFilePolicy"].as_u64() == Some(2))
            .map(|(id, _)| id.clone()).collect::<BTreeSet<_>>();
        let allowed_files = catalog.records.values().flat_map(|record| record.file_ids.iter()
            .map(move |id| (record.source.clone(), record.source_id.clone(), id.clone()))).collect::<BTreeSet<_>>();
        index.archives.retain(|_, archive| archive.source != "modworkshop" || {
            verified_mods.contains(&archive.mod_id) && allowed_files.contains(&(archive.source.clone(), archive.mod_id.clone(), archive.file_id.clone()))
        });
    }
    if let Some(downloads) = profile_data_dir_for(profile_id).ok()
        .and_then(|root| fs::read(root.join("source-index/in-app-download-index.json")).ok())
        .and_then(|bytes| serde_json::from_slice::<FileIndex>(&bytes).ok()) { index.archives.extend(downloads.archives); }
    index
}

pub(super) fn index_receipt(profile: &str, receipt: &InstallReceipt) -> Result<(), String> {
    if !["nexus", "modworkshop"].contains(&receipt.source.as_str()) { return Ok(()); }
    if is_builtin_payday3_profile(Some(profile)) && modworkshop_profile_game_version(Some(profile), "payday-3").as_deref() != Some("UE5.5") { return Ok(()); }
    let Some(id) = receipt.source_mod_id.as_deref() else { return Ok(()); };
    let root = ensure_profile_data_dirs(profile)?.join("source-index");
    let path = root.join("in-app-download-index.json");
    let mut index = fs::read(&path).ok().and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .unwrap_or_else(|| serde_json::json!({"version": 1, "records": {}, "archives": {}}));
    let key = source_index_key(&receipt.source, id);
    let summary = serde_json::json!({"source":receipt.source,"sourceId":id,"name":receipt.display_name,
        "version":receipt.version,"author":receipt.author,"thumbnailUrl":receipt.thumbnail_url,"pageUrl":receipt.page_url,
        "tags":[receipt.source]});
    index["records"][&key] = serde_json::json!({"source":receipt.source,"sourceId":id,"indexedAtUnix":now_unix_seconds(),
        "summary":summary,"fileNames":receipt.files.iter().map(|file| file.relative_path.clone()).collect::<Vec<_>>(),
        "fileIds":receipt.source_file_id.iter().collect::<Vec<_>>(),"archiveFingerprint":null});
    let game = if receipt.source == "nexus" {
        receipt.page_url.as_deref().and_then(|url| reqwest::Url::parse(url).ok()).and_then(|url| url.path_segments().and_then(|mut parts| parts.next().map(str::to_string))).unwrap_or_else(|| profile.to_string())
    } else { profile.to_string() };
    index["archives"][format!("{}-{}",key,receipt.source_file_id.as_deref().unwrap_or("installed"))] = serde_json::json!({
        "source":receipt.source,"game":game,"modId":id,"fileId":receipt.source_file_id.clone().unwrap_or_default(),
        "version":receipt.version,"fileName":receipt.source_file_name.clone().unwrap_or_default(),"status":"hashed",
        "fileEntries":receipt.files.iter().filter_map(|file| file.sha256.as_ref().map(|hash| serde_json::json!({
            "fileName":Path::new(&file.relative_path).file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default(),
            "fileSize":file.size_bytes.unwrap_or(0),"sha256":hash}))).collect::<Vec<_>>()});
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec(&index).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(tmp, path).map_err(|e| e.to_string())
}

fn payload_file(name: &str) -> bool {
    !matches!(Path::new(name).extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase().as_str(),
        "txt" | "md" | "html" | "url" | "pdf" | "jpg" | "jpeg" | "webp" | "exe")
}

pub(super) fn index_file_statistics(profile: &str) -> (usize, usize, usize) {
    let index = file_index(profile);
    let mut hashes = BTreeMap::<String, usize>::new();
    let mut archives = 0;
    let mut files = 0;
    for archive in index.archives.values().filter(|archive| archive.status == "hashed") {
        archives += 1;
        for file in &archive.file_entries {
            if file.sha256.len() == 64 && file.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                files += 1;
                *hashes.entry(file.sha256.clone()).or_default() += 1;
            }
        }
    }
    (archives, files, hashes.values().filter(|count| **count > 1).count())
}

fn unique_payloads(index: &FileIndex) -> BTreeMap<String, IndexedArchive> {
    let mut identities = BTreeMap::<String, BTreeSet<(String, String, String)>>::new();
    let mut proofs = BTreeMap::new();
    for archive in index.archives.values().filter(|a| a.status == "hashed") {
        for file in archive.file_entries.iter().filter(|file| payload_file(&file.file_name) && file.file_size > 0 && file.sha256.len() == 64) {
            identities.entry(file.sha256.clone()).or_default().insert((archive.source.clone(), if archive.source == "nexus" { archive.game.clone() } else { String::new() }, archive.mod_id.clone()));
            proofs.insert(file.sha256.clone(), archive.clone());
        }
    }
    proofs.retain(|hash, _| identities.get(hash).is_some_and(|ids| ids.len() == 1));
    proofs
}

pub(super) fn match_profile_sources(sources: &[SourceModSummary], profile: &str) -> Result<Vec<InstalledSourceMatch>, String> {
    match_profile_sources_with_hashing(sources, profile, false)
}

fn match_profile_sources_with_hashing(sources: &[SourceModSummary], profile: &str, hash_large: bool) -> Result<Vec<InstalledSourceMatch>, String> {
    let records = if is_builtin_payday3_profile(Some(profile)) {
        list_installed_state_records_internal().unwrap_or_default()
    } else { profile_installs::sync_profile_installed_state(profile).unwrap_or_default() };
    let index = file_index(profile);
    let proofs = unique_payloads(&index);
    let mut existing = BTreeMap::<String, Vec<String>>::new();
    let names = index.archives.values().flat_map(|a| a.file_entries.iter())
        .filter(|file| payload_file(&file.file_name))
        .filter_map(|file| Path::new(&file.file_name).file_name().and_then(|n| n.to_str()).map(|n| n.to_ascii_lowercase()))
        .collect::<BTreeSet<_>>();
    let root = if is_builtin_payday3_profile(Some(profile)) {
        detect_payday3_paths_internal().map(|paths| paths.game_root)
    } else { profile_installs::indexed_game_root(profile).ok() };
    let mut cache = read_hash_cache();
    fn scan(root: &Path, names: &BTreeSet<String>, proofs: &BTreeMap<String, IndexedArchive>, existing: &mut BTreeMap<String, Vec<String>>, cache: &mut BTreeMap<String, FileHashCacheRecord>, hash_large: bool) {
        let Ok(items) = fs::read_dir(root) else { return; };
        for item in items.flatten() {
            let Ok(kind) = item.file_type() else { continue; };
            if kind.is_symlink() { continue; }
            let name = item.file_name().to_string_lossy().to_ascii_lowercase();
            if kind.is_dir() {
                if !["tsuki_backups", "backups", "uninstalled", ".git", "saved"].contains(&name.as_str()) { scan(&item.path(), names, proofs, existing, cache, hash_large); }
            } else if names.contains(&name) {
                let Ok(meta) = item.metadata() else { continue; };
                let modified = meta.modified().ok().and_then(|v| v.duration_since(UNIX_EPOCH).ok()).map(|v| v.as_secs());
                let hash = cached_sha256_for_file(&item.path(), meta.len(), modified, cache).or_else(|| {
                    if !hash_large { return None; }
                    let sha256 = sha256_file(&item.path()).ok()?;
                    let key = item.path().display().to_string();
                    cache.insert(key.clone(), FileHashCacheRecord { path: key, size_bytes: meta.len(), modified_unix: modified, sha256: sha256.clone() });
                    Some(sha256)
                });
                if let Some(hash) = hash {
                    if proofs.contains_key(&hash) { existing.entry(hash).or_default().push(item.path().display().to_string()); }
                }
            }
        }
    }
    if !names.is_empty() { if let Some(root) = root { scan(&root, &names, &proofs, &mut existing, &mut cache, hash_large); } }
    write_hash_cache(&cache);
    let mut receipt_lookup = BTreeMap::<(String, String), Vec<&InstalledStateRecord>>::new();
    for record in records.iter().filter(|record| record.files.iter().any(|file| file.live)) {
        if let Some(id) = &record.source_mod_id {
            receipt_lookup.entry((record.source.to_ascii_lowercase(), id.clone())).or_default().push(record);
        }
    }
    let payload_lookup = matched_payload_lookup(&proofs, &existing);
    Ok(sources.iter().map(|source| {
        let receipt = receipt_lookup.get(&(source.source.to_ascii_lowercase(), source.source_id.clone()))
            .and_then(|records| records.iter().copied().find(|r| r.page_url.is_none() || source.page_url.is_none() || r.page_url == source.page_url));
        let mut result = InstalledSourceMatch {
            source: source.source.clone(), source_id: source.source_id.clone(), installed: receipt.is_some(), enabled: receipt.is_some_and(|r| r.enabled),
            update_available: false, confidence: if receipt.is_some() { 100 } else { 0 }, reason: if receipt.is_some() { "Exact live profile receipt" } else { "No unique indexed payload hash matched" }.into(),
            matched_files: receipt.map(|r| r.files.iter().filter(|f| f.live).map(|f| f.relative_path.clone()).collect()).unwrap_or_default(),
            source_file_id: receipt.and_then(|r| r.source_file_id.clone()), source_file_name: receipt.and_then(|r| r.source_file_name.clone()),
            source_file_category: receipt.and_then(|r| r.source_file_category.clone()), source_file_uploaded_at: receipt.and_then(|r| r.source_file_uploaded_at.clone()),
            source_file_version: receipt.and_then(|r| r.source_file_version.clone()), installed_modified_unix: receipt.and_then(|r| r.installed_at_unix),
            source_updated_at: source.updated_at.clone(), source_updated_unix: parse_source_timestamp_to_unix(source.updated_at.as_deref()), match_kind: if receipt.is_some() { "receipt" } else { "none" }.into(),
        };
        if receipt.is_none() {
            for (proof, files) in payload_lookup.get(&(source.source.clone(), source.source_id.clone())).into_iter().flatten() {
                if proof.source == "nexus" && !source.page_url.as_deref().is_some_and(|url| url.contains(&format!("/{}/mods/", proof.game))) { continue; }
                result.installed = true; result.enabled = true; result.confidence = 100;
                result.reason = "Exact SHA-256 match to a unique payload in this game's source index".into();
                result.match_kind = "sha256".into(); result.matched_files.extend(files.iter().cloned());
                result.source_file_id = Some(proof.file_id.clone()); result.source_file_name = Some(proof.file_name.clone()); result.source_file_version = proof.version.clone();
            }
        }
        result
    }).collect())
}

fn matched_payload_lookup<'a>(proofs: &'a BTreeMap<String, IndexedArchive>, existing: &'a BTreeMap<String, Vec<String>>)
    -> BTreeMap<(String, String), Vec<(&'a IndexedArchive, &'a Vec<String>)>> {
    let mut lookup = BTreeMap::<_, Vec<_>>::new();
    for (hash, files) in existing {
        if let Some(proof) = proofs.get(hash) {
            lookup.entry((proof.source.clone(), proof.mod_id.clone())).or_default().push((proof, files));
        }
    }
    lookup
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstalledSourceIndexIdentity { source_mod: SourceModSummary, match_info: InstalledSourceMatch }

#[tauri::command]
pub(crate) async fn match_installed_source_index_v2(profile_id: Option<String>) -> Result<Vec<InstalledSourceIndexIdentity>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let profile = profile_id.as_deref().unwrap_or(BUILTIN_PAYDAY3_PROFILE_ID);
        let sources = read_catalog(Some(profile))?.records.into_values().map(|record| record.summary).collect::<Vec<_>>();
        let matches = match_profile_sources_with_hashing(&sources, profile, true)?;
        Ok(sources.into_iter().zip(matches).filter(|(_, matched)| matched.installed)
            .map(|(source_mod, match_info)| InstalledSourceIndexIdentity { source_mod, match_info }).collect())
    }).await.map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keyed_payload_lookup_preserves_exact_matches_and_order() {
        let mut proofs = BTreeMap::new();
        let mut existing = BTreeMap::new();
        for (hash, source, id, game) in [("a", "nexus", "1", "payday2"), ("b", "nexus", "1", "borderlands"), ("c", "modworkshop", "1", ""), ("d", "nexus", "2", "payday2")] {
            proofs.insert(hash.into(), IndexedArchive { source: source.into(), mod_id: id.into(), game: game.into(), ..Default::default() });
            existing.insert(hash.into(), vec![format!("{}.lua", hash)]);
        }
        existing.insert("not-proven".into(), vec!["unrelated.lua".into()]);
        let lookup = matched_payload_lookup(&proofs, &existing);
        for (source, id, game) in [("nexus", "1", "payday2"), ("nexus", "1", "borderlands"), ("modworkshop", "1", ""), ("nexus", "2", "payday2"), ("nexus", "missing", "payday2")] {
            let expected = existing.iter().filter_map(|(hash, files)| proofs.get(hash)
                .filter(|proof| proof.source == source && proof.mod_id == id && (source != "nexus" || proof.game == game)).map(|_| files.clone())).flatten().collect::<Vec<_>>();
            let actual = lookup.get(&(source.into(), id.into())).into_iter().flatten()
                .filter(|(proof, _)| source != "nexus" || proof.game == game).flat_map(|(_, files)| files.iter().cloned()).collect::<Vec<_>>();
            assert_eq!(actual, expected);
        }
    }
    #[test]
    fn shared_payloads_are_not_source_identity_proof() {
        let archive = |id: &str, name: &str| IndexedArchive { source: "nexus".into(), game: "payday3".into(), mod_id: id.into(), status: "hashed".into(), file_entries: vec![IndexedFile { file_name: name.into(), file_size: 4, sha256: "a".repeat(64) }], ..Default::default() };
        let mut index = FileIndex::default();
        index.archives.insert("one".into(), archive("1", "main.lua"));
        assert_eq!(unique_payloads(&index).len(), 1);
        index.archives.insert("two".into(), archive("2", "main.lua"));
        assert!(unique_payloads(&index).is_empty());
        index.archives.clear(); index.archives.insert("docs".into(), archive("1", "readme.txt"));
        assert!(unique_payloads(&index).is_empty());
    }

    #[test]
    #[ignore = "Requires isolated APPDATA under target/profile-smoke"]
    fn source_index_identification_sandbox() {
        let appdata = PathBuf::from(env::var("APPDATA").unwrap()).canonicalize().unwrap();
        let approved = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/profile-smoke").canonicalize().unwrap();
        assert!(appdata.starts_with(&approved) && appdata != approved);
        let profile = "builtin.payday2";
        let game = appdata.join("game");
        fs::create_dir_all(game.join("mods/Fixture/Scripts")).unwrap();
        fs::write(game.join("PAYDAY2.exe"), b"SIMULATED GAME - NOT EXECUTABLE").unwrap();
        save_profile_settings_internal(profile, &ProfileSettings { game_root_override: Some(game.display().to_string()), ..Default::default() }).unwrap();
        let payload = game.join("mods/Fixture/Scripts/main.lua");
        fs::write(&payload, b"-- unique index fixture\n").unwrap();
        let digest = sha256_file(&payload).unwrap();
        let source: SourceModSummary = serde_json::from_value(serde_json::json!({"source":"nexus","sourceId":"99","name":"Fixture","tags":[],"pageUrl":"https://www.nexusmods.com/payday2/mods/99"})).unwrap();
        let root = ensure_profile_data_dirs(profile).unwrap().join("source-index");
        let database = serde_json::json!({"version":1,"records":{"nexus-payday2-99":{"source":"nexus","sourceId":"99","indexedAtUnix":1,"summary":source,"fileNames":["main.lua"],"fileIds":["123"],"archiveFingerprint":null}}});
        fs::write(root.join("source-index.json"), serde_json::to_vec(&database).unwrap()).unwrap();
        fs::write(root.join("file-hashes.json"), serde_json::to_vec(&serde_json::json!({"version":1,"archives":{"fixture":{"source":"nexus","game":"payday2","modId":"99","fileId":"123","fileName":"fixture.zip","status":"hashed","fileEntries":[{"fileName":"Scripts/main.lua","fileSize":23,"sha256":digest}]}}})).unwrap()).unwrap();
        assert_eq!(read_catalog(Some(profile)).unwrap().records.len(), 1);
        let first = match_profile_sources_with_hashing(&[source.clone()], profile, true).unwrap();
        assert!(first[0].installed);
        assert_eq!(first[0].match_kind, "sha256");
        let mut wrong_game = source.clone(); wrong_game.page_url = Some("https://www.nexusmods.com/borderlands/mods/99".into());
        assert!(!match_profile_sources(&[wrong_game], profile).unwrap()[0].installed);
        fs::remove_file(payload).unwrap();
        assert!(!match_profile_sources(&[source], profile).unwrap()[0].installed);
        assert!(read_catalog(Some("builtin.cyberpunk2077")).unwrap().records.is_empty());
        let receipt: InstallReceipt = serde_json::from_value(serde_json::json!({"id":"download","displayName":"Cyberpunk Download","source":"nexus","modType":"source-install","sourceModId":"5","sourceFileId":"7","pageUrl":"https://www.nexusmods.com/cyberpunk2077/mods/5","files":[{"relativePath":"fixture.archive","sizeBytes":4,"sha256":"a".repeat(64)}]})).unwrap();
        index_receipt("builtin.cyberpunk2077", &receipt).unwrap();
        assert_eq!(read_catalog(Some("builtin.cyberpunk2077")).unwrap().records.len(), 1);
        assert_eq!(file_index("builtin.cyberpunk2077").archives.len(), 1);
    }
}
