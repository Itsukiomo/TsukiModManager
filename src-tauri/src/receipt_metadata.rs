use super::*;

fn receipt_path(profile: &str, id: &str) -> Result<PathBuf, String> {
    clean_profile_id(profile)?;
    let path = if is_builtin_payday3_profile(Some(profile)) {
        receipt_file_path(id)?
    } else {
        profile_installs::profile_receipt_path(profile, id)?
    };
    if !path.is_file() {
        return Err("Receipt does not exist in this profile".into());
    }
    Ok(path)
}

fn image_kind(bytes: &[u8]) -> Result<(&'static str, &'static str), String> {
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("Thumbnail exceeds 8 MiB".into());
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Ok(("png", "image/png"))
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Ok(("jpg", "image/jpeg"))
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Ok(("gif", "image/gif"))
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Ok(("webp", "image/webp"))
    } else {
        Err("Select a PNG, JPEG, GIF or WebP image".into())
    }
}

#[tauri::command]
pub(crate) fn load_managed_thumbnail_data_url(path: String) -> Result<String, String> {
    let path = PathBuf::from(path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let root = ensure_app_data_dirs()?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !path.starts_with(root) {
        return Err("Thumbnail is outside managed app storage".into());
    }
    if path.metadata().map_err(|e| e.to_string())?.len() > 8 * 1024 * 1024 {
        return Err("Thumbnail exceeds 8 MiB".into());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let (_, mime) = image_kind(&bytes)?;
    Ok(format!(
        "data:{mime};base64,{}",
        general_purpose::STANDARD.encode(bytes)
    ))
}

#[tauri::command]
pub(crate) fn save_custom_receipt_thumbnail(
    receipt_id: String,
    profile_id: String,
    file_name: String,
    bytes: Vec<u8>,
) -> Result<serde_json::Value, String> {
    receipt_path(&profile_id, &receipt_id)?;
    let (extension, _) = image_kind(&bytes)?;
    let root = ensure_profile_data_dirs(&profile_id)?.join("thumbnails");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let path = root.join(format!(
        "{}-{}.{}",
        sanitize_file_component(&receipt_id),
        now_unix_seconds(),
        extension
    ));
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(
        serde_json::json!({"path":path.display().to_string(),"fileName":Path::new(&file_name).file_name().unwrap_or_default().to_string_lossy()}),
    )
}

#[tauri::command]
pub(crate) fn update_install_receipt_metadata(
    profile_id: String,
    update: serde_json::Value,
) -> Result<String, String> {
    let id = json_string(&update, "receiptId").ok_or("Receipt ID is required")?;
    let path = receipt_path(&profile_id, &id)?;
    let mut receipt = read_json_file(&path).ok_or("Receipt could not be read")?;
    let object = receipt.as_object_mut().ok_or("Receipt is malformed")?;
    for key in [
        "displayName",
        "version",
        "thumbnailUrl",
        "pageUrl",
        "author",
        "notes",
        "tags",
    ] {
        if let Some(value) = update.get(key) {
            object.insert(key.into(), value.clone());
        }
    }
    if let Some(matched) = update.get("sourceMatch").filter(|m| m.is_object()) {
        let url = json_string(matched, "pageUrl").ok_or("Confirmed source URL is required")?;
        let (source, domain, mod_id) = dependency_identity_from_url(&url);
        let source = source.ok_or("Unsupported source URL")?;
        if mod_id.as_deref() != json_string(matched, "sourceId").as_deref() {
            return Err("Source URL/mod ID disagree".into());
        }
        if source == "nexus" {
            let config = source_config_for_profile_id(Some(&profile_id));
            let expected = json_string(&config, "nexusDomain");
            if expected.is_some() && domain != expected {
                return Err("Source belongs to a different game".into());
            }
        }
        for (from, to) in [
            ("source", "source"),
            ("sourceId", "sourceModId"),
            ("fileId", "sourceFileId"),
            ("fileName", "sourceFileName"),
            ("pageUrl", "pageUrl"),
            ("thumbnailUrl", "thumbnailUrl"),
        ] {
            if let Some(value) = matched.get(from) {
                object.insert(to.into(), value.clone());
            }
        }
        object.insert("sourceMatch".into(), matched.clone());
    } else if update["clearSourceMatch"] == true {
        object.insert("source".into(), "local".into());
        for key in ["sourceModId", "sourceFileId", "sourceMatch"] {
            object.remove(key);
        }
    }
    let backups = ensure_profile_data_dirs(&profile_id)?.join("backups/receipt-metadata");
    fs::create_dir_all(&backups).map_err(|e| e.to_string())?;
    fs::copy(
        &path,
        backups.join(format!(
            "{}-{}.json",
            sanitize_file_component(&id),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        )),
    )
    .map_err(|e| e.to_string())?;
    write_json_file(&path, &receipt, "receipt metadata")?;
    Ok("Receipt metadata saved; tracked file paths are unchanged".into())
}

fn taxonomy_path(profile: &str) -> Result<PathBuf, String> {
    Ok(ensure_profile_data_dirs(profile)?.join("cache/taxonomy.json"))
}

#[tauri::command]
pub(crate) fn get_source_taxonomy_for_game(
    game_id: String,
    profile_id: String,
) -> Result<serde_json::Value, String> {
    clean_profile_id(&profile_id)?;
    read_json_file(&taxonomy_path(&profile_id)?)
        .ok_or_else(|| format!("No cached official taxonomy for {game_id}; refresh to fetch it"))
}

#[tauri::command]
pub(crate) async fn refresh_current_game_taxonomy(
    game_id: String,
    profile_id: String,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        clean_profile_id(&profile_id)?;
        let config = source_config_for_profile_id(Some(&profile_id));
        let route = json_string(&config, "modworkshopGameId").ok_or("This profile has no ModWorkshop category API")?;
        let route = normalize_modworkshop_game_route(&route)?;
        let categories = parse_modworkshop_categories(http_get_json_fast(&format!("https://api.modworkshop.net/games/{route}/categories"), 10)?);
        if categories.is_empty() { return Err("Source returned no official categories".into()); }
        let entries = categories.into_iter().map(|c| serde_json::json!({"source":"modworkshop","sourceGameId":route,"tsukiGameKey":game_id,"taxonomyType":"category","sourceTaxonomyId":c.id,"label":c.label,"canonicalKey":format!("modworkshop:{route}:{}", c.id)})).collect::<Vec<_>>();
        let database = serde_json::json!({"schemaVersion":1,"generatedAt":now_unix_seconds(),"sources":{"modworkshop":{"games":[{"source":"modworkshop","sourceGameId":route,"displayName":game_id,"categories":entries,"descriptiveTags":[]}]},"nexus":{"games":[]}}});
        write_json_file(&taxonomy_path(&profile_id)?, &database, "official taxonomy")?;
        Ok(database)
    }).await.map_err(|e| e.to_string())?
}
