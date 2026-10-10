use super::*;
use std::collections::BTreeMap;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCache {
    fingerprint: String,
    checked: u64,
    results: Vec<SourceUpdateStatus>,
}

fn category(file: &SourceFileItem, main: Option<&str>, source: &str) -> &'static str {
    match file
        .file_type
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "main" => "main",
        "optional" => "optional",
        "old_version" | "old version" | "archived" => "old",
        _ if source == "modworkshop" => "main",
        _ => source_file_category_for_update(file, main, source),
    }
}

fn engine_variant(name: &str) -> Option<&'static str> {
    let name = name.to_ascii_lowercase();
    if name.contains("ue4ss") && !name.contains("ue4.27") && !name.contains("ue427") {
        return None;
    }
    if name.contains("ue4") {
        Some("ue4")
    } else if name.contains("ue5") {
        Some("ue5")
    } else {
        None
    }
}

fn candidate<'a>(
    record: &InstalledStateRecord,
    detail: &'a SourceModDetail,
    profile: &str,
) -> Option<&'a SourceFileItem> {
    let installed_id = record.source_file_id.as_ref().or(record.file_id.as_ref())?;
    let original = detail.files.iter().find(|file| &file.id == installed_id);
    let main = main_source_file_for_update(&detail.files, &record.source);
    let main_id = main.as_ref().map(|f| f.id.as_str());
    let saved_bucket = record
        .source_file_category
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let bucket = match saved_bucket.as_str() {
        "main" => "main",
        "optional" => "optional",
        _ => original
            .map(|file| category(file, main_id, &record.source))
            .unwrap_or("main"),
    };
    let family = original
        .map(|file| file.name.as_str())
        .or(record.source_file_name.as_deref())
        .unwrap_or(&record.filename);
    let uploaded = original
        .and_then(source_file_uploaded_unix)
        .or_else(|| parse_source_timestamp_to_unix(record.source_file_uploaded_at.as_deref()));
    let mut candidates = detail.files.iter().filter(|file| file.id != *installed_id && file.id != "unknown" && !file.id.is_empty())
        .filter(|file| category(file, main_id, &record.source) == bucket && bucket != "old")
        .filter(|file| source_file_family_similarity_name(family, &file.name) >= 70)
        .filter(|file| match (engine_variant(family), engine_variant(&file.name)) { (Some(a), Some(b)) => a == b, _ => true })
        .filter(|file| !is_builtin_payday3_profile(Some(profile)) || engine_variant(&file.name).is_none_or(|engine| engine == if load_profile_settings_internal(profile).game_version.as_deref() == Some("UE4.27") { "ue4" } else { "ue5" }))
        .filter(|file| matches!((source_file_uploaded_unix(file), uploaded), (Some(new), Some(old)) if new > old)).collect::<Vec<_>>();
    candidates.sort_by_key(|file| source_file_uploaded_unix(file));
    if candidates.len() > 1
        && source_file_uploaded_unix(candidates[candidates.len() - 1])
            == source_file_uploaded_unix(candidates[candidates.len() - 2])
    {
        return None;
    }
    candidates.pop()
}

fn check_record(record: InstalledStateRecord, profile: &str) -> SourceUpdateStatus {
    let mut status = SourceUpdateStatus {
        uid: persistent_uid_for_state(&record),
        source: record.source.clone(),
        mod_id: record
            .source_mod_id
            .clone()
            .unwrap_or_else(|| record.id.clone()),
        installed_file_id: record.source_file_id.clone().or(record.file_id.clone()),
        latest_file_id: None,
        latest_file_name: None,
        installed_version: record
            .source_file_version
            .clone()
            .or(record.version.clone()),
        latest_version: None,
        update_available: false,
        can_update: false,
        reason: "No compatible newer source file was proven".into(),
        page_url: record.page_url.clone(),
        checked_at_unix: now_unix_seconds(),
        health: "unverified".into(),
    };
    status.uid = record
        .receipt_id
        .clone()
        .unwrap_or_else(|| record.uid.clone());
    if status
        .installed_file_id
        .as_deref()
        .is_none_or(|id| id.is_empty())
    {
        status.reason =
            "Unknown installed file ID; confirm the source file before checking updates".into();
        return status;
    }
    let detail = if record.source == "nexus" {
        let domain = record
            .page_url
            .as_deref()
            .map(dependency_identity_from_url)
            .and_then(|(kind, domain, _)| {
                (kind.as_deref() == Some("nexus"))
                    .then_some(domain)
                    .flatten()
            });
        fetch_nexus_mod_detail(status.mod_id.clone(), domain, Some(profile.into()))
    } else {
        fetch_modworkshop_mod_detail(status.mod_id.clone(), Some(profile.into()))
    };
    let detail = match detail {
        Ok(detail) => detail,
        Err(error) => {
            status.reason = format!("Source lookup failed: {error}");
            return status;
        }
    };
    if let Some(latest) = candidate(&record, &detail, profile) {
        status.latest_file_id = Some(latest.id.clone());
        status.latest_file_name = Some(latest.name.clone());
        status.latest_version = latest.version.clone();
        status.update_available = true;
        status.can_update = true;
        status.reason = "Newer compatible file ID in the same source file family/category".into();
    }
    if record.receipt_id.is_none() && status.update_available {
        status.can_update = false;
        status
            .reason
            .push_str("; manually installed files require review/import before replacement");
    }
    status
}

pub(super) fn check_profile(profile: &str, force: bool) -> Result<Vec<SourceUpdateStatus>, String> {
    clean_profile_id(profile)?;
    let mut records = if is_builtin_payday3_profile(Some(profile)) {
        sync_installed_state_database()?
    } else {
        profile_installs::sync_profile_installed_state(profile)?
    };
    let receipts = profile_installs::list_profile_receipts_internal(profile)?;
    let mut health = BTreeMap::new();
    let mut fingerprint = format!(
        "{profile}:{:?}",
        load_profile_settings_internal(profile).game_version
    );
    let mut hashes = read_hash_cache();
    for receipt in &receipts {
        let mut state = "verified";
        for (path, expected) in profile_installs::receipt_file_locations(profile, receipt) {
            if force {
                hashes.remove(&path.display().to_string());
            }
            let meta = fs::metadata(&path).ok();
            let stamp = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .and_then(|t| u64::try_from(t.as_nanos()).ok());
            fingerprint.push_str(&format!(
                "{}:{:?}:{:?}:{:?}",
                path.display(),
                meta.as_ref().map(|m| m.len()),
                stamp,
                expected
            ));
            let actual = meta
                .as_ref()
                .and_then(|meta| cached_sha256_for_file(&path, meta.len(), stamp, &mut hashes))
                .or_else(|| {
                    let meta = meta.as_ref()?;
                    let hash = sha256_file(&path).ok()?;
                    let key = path.display().to_string();
                    hashes.insert(
                        key.clone(),
                        FileHashCacheRecord {
                            path: key,
                            size_bytes: meta.len(),
                            modified_unix: stamp,
                            sha256: hash.clone(),
                        },
                    );
                    Some(hash)
                });
            if meta.is_none() {
                state = "missing";
            } else if expected.is_none() && state == "verified" {
                state = "unverified";
            } else if actual != expected && state != "missing" {
                state = "modified";
            }
        }
        fingerprint.push_str(&format!(
            "{}:{:?}:{:?}:{:?}",
            receipt.id,
            receipt.source_file_id,
            receipt.source_file_uploaded_at,
            receipt.source_file_name
        ));
        health.insert(receipt.id.clone(), state.to_string());
    }
    write_hash_cache(&hashes);
    for record in source_catalog::verified_update_records(profile)? {
        if records.iter().any(|r| {
            r.source == record.source
                && r.source_mod_id == record.source_mod_id
                && r.source_file_id == record.source_file_id
        }) {
            continue;
        }
        fingerprint.push_str(&format!("{}:{:?}", record.uid, record.source_file_id));
        health.insert(record.uid.clone(), "verified".into());
        records.push(record);
    }
    let path = ensure_profile_data_dirs(profile)?.join("cache/source-updates-v2.json");
    let fingerprint = format!("{:x}", Sha256::digest(fingerprint.as_bytes()));
    if !force {
        if let Some(cache) = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<UpdateCache>(&bytes).ok())
        {
            if cache.fingerprint == fingerprint
                && now_unix_seconds().saturating_sub(cache.checked) < 3600
            {
                return Ok(cache.results);
            }
        }
    }
    let records = records
        .into_iter()
        .filter(|r| {
            ["nexus", "modworkshop"].contains(&r.source.as_str())
                && (r.receipt_id.is_some() || health.contains_key(&r.uid))
        })
        .collect::<Vec<_>>();
    let mut results = Vec::new();
    for batch in records.chunks(2) {
        std::thread::scope(|scope| {
            let workers = batch
                .iter()
                .map(|r| scope.spawn(move || check_record(r.clone(), profile)))
                .collect::<Vec<_>>();
            for worker in workers {
                if let Ok(mut status) = worker.join() {
                    status.health = health
                        .get(&status.uid)
                        .cloned()
                        .unwrap_or_else(|| "unverified".into());
                    if status.health != "verified" {
                        status.can_update = false;
                        status.reason = format!(
                            "{}; local files {}. Review/repair before replacing",
                            status.reason, status.health
                        );
                    }
                    results.push(status);
                }
            }
        });
    }
    let cache = UpdateCache {
        fingerprint,
        checked: now_unix_seconds(),
        results: results.clone(),
    };
    write_json_file(
        &path,
        &serde_json::to_value(cache).map_err(|e| e.to_string())?,
        "update cache",
    )?;
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record() -> InstalledStateRecord {
        serde_json::from_value(serde_json::json!({"uid":"r","id":"1","name":"Fixture","source":"nexus","filename":"Fixture","fileType":"mod","folderId":"f","location":"game","enabled":true,"files":[],"sourceFileId":"10","sourceFileName":"Fixture Main UE5.zip","sourceFileCategory":"main","sourceFileUploadedAt":"2026-01-01T00:00:00Z"})).unwrap()
    }
    fn file(id: &str, name: &str, kind: &str, uploaded: &str) -> SourceFileItem {
        SourceFileItem {
            id: id.into(),
            name: name.into(),
            version: Some("1.0".into()),
            size_label: None,
            uploaded_at: Some(uploaded.into()),
            download_url: None,
            file_type: Some(kind.into()),
            download_count: None,
        }
    }
    #[test]
    fn update_selection_uses_file_ids_dates_categories_and_engine_not_version_text() {
        let source: SourceModSummary = serde_json::from_value(
            serde_json::json!({"source":"nexus","sourceId":"1","name":"Fixture","tags":[]}),
        )
        .unwrap();
        let detail = source_detail_from_summary(
            source,
            "".into(),
            vec![
                file(
                    "10",
                    "Fixture Main UE5.zip",
                    "OLD_VERSION",
                    "2026-01-01T00:00:00Z",
                ),
                file("11", "Fixture Main UE5.zip", "MAIN", "2026-02-01T00:00:00Z"),
                file("12", "Fixture Main UE4.zip", "MAIN", "2026-03-01T00:00:00Z"),
                file(
                    "13",
                    "Fixture Main UE5.zip",
                    "OPTIONAL",
                    "2026-04-01T00:00:00Z",
                ),
            ],
            vec![],
        );
        assert_eq!(
            candidate(&record(), &detail, "user.fixture").unwrap().id,
            "11"
        );
        let mut record = record();
        record.source_file_id = None;
        assert!(candidate(&record, &detail, "user.fixture").is_none());
    }
    #[test]
    fn ue4ss_is_not_an_engine_four_marker() {
        assert_eq!(engine_variant("Super UE4SS"), None);
        assert_eq!(engine_variant("UE4.27"), Some("ue4"));
    }
    #[test]
    fn timestamps_support_numeric_milliseconds_and_iso_offsets() {
        assert_eq!(
            parse_source_timestamp_to_unix(Some("1767225600")),
            Some(1767225600)
        );
        assert_eq!(
            parse_source_timestamp_to_unix(Some("1767225600000")),
            Some(1767225600)
        );
        assert_eq!(
            parse_source_timestamp_to_unix(Some("2026-01-01T00:00:00Z")),
            Some(1767225600)
        );
        assert_eq!(
            parse_source_timestamp_to_unix(Some("2025-12-31T16:00:00-08:00")),
            Some(1767225600)
        );
        assert_eq!(parse_source_timestamp_to_unix(Some("not a date")), None);
    }
    #[test]
    fn workshop_main_revisions_remain_in_one_family_and_ties_need_review() {
        let source: SourceModSummary = serde_json::from_value(
            serde_json::json!({"source":"modworkshop","sourceId":"1","name":"Fixture","tags":[]}),
        )
        .unwrap();
        let mut detail = source_detail_from_summary(
            source,
            "".into(),
            vec![
                file("10", "Fixture Main UE5.zip", "", "2026-01-01T00:00:00Z"),
                file("11", "Fixture Main UE5.zip", "", "2026-02-01T00:00:00Z"),
            ],
            vec![],
        );
        let mut record = record();
        record.source = "modworkshop".into();
        assert_eq!(
            candidate(&record, &detail, "user.fixture").unwrap().id,
            "11"
        );
        detail.files.push(file(
            "12",
            "Fixture Main UE5.zip",
            "",
            "2026-02-01T00:00:00Z",
        ));
        assert!(candidate(&record, &detail, "user.fixture").is_none());
    }
}
