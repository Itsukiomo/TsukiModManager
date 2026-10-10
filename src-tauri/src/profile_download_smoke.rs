//! Opt-in validation with isolated receipts. Real-game writes require the separate explicit deployment test.
use super::*;

#[test]
#[ignore = "Read-only real game inventory; writes only the sandbox report"]
fn real_profile_installation_inventory() {
    let root = PathBuf::from(env::var("TSUKI_PROFILE_TEST_ROOT").unwrap()).canonicalize().unwrap();
    let approved = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/profile-smoke").canonicalize().unwrap();
    assert!(root.starts_with(&approved) && root != approved);
    let profiles: serde_json::Value = serde_json::from_slice(&fs::read(root.join("profiles.json")).unwrap()).unwrap();
    let probes = profiles.as_array().unwrap().iter().map(|profile| {
        let profile_id = profile["profileId"].as_str().unwrap().to_string();
        let steam_app_ids = builtin_profile_steam_app_ids(&profile_id).iter().map(|id| id.to_string()).collect();
        GameProfileInstallationProbe { profile_id, steam_app_ids }
    }).collect();
    let inventory = detect_game_profile_installations(probes).unwrap();
    fs::write(root.join("real-game-inventory.json"), serde_json::to_vec_pretty(&inventory).unwrap()).unwrap();
}

#[test]
#[ignore = "Explicitly authorized reversible real-game sample deployment; isolated APPDATA required"]
fn real_game_sample_deployment() {
    let root = PathBuf::from(env::var("TSUKI_PROFILE_TEST_ROOT").unwrap()).canonicalize().unwrap();
    let approved = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/profile-smoke").canonicalize().unwrap();
    assert!(root.starts_with(&approved) && root != approved);
    let isolated = root.join("real-appdata").canonicalize().unwrap();
    assert_eq!(PathBuf::from(env::var("APPDATA").unwrap()).canonicalize().unwrap(), isolated);
    let profile = env::var("TSUKI_REAL_TEST_PROFILE").unwrap();
    assert!(matches!(profile.as_str(), "builtin.payday2" | BUILTIN_PAYDAY3_PROFILE_ID));
    let deployment = root.join(format!("real-deployment-{}.json", sanitize_file_component(&profile)));
    if env::var("TSUKI_REAL_TEST_PHASE").unwrap() == "restore" {
        let manifest: serde_json::Value = serde_json::from_slice(&fs::read(&deployment).unwrap()).unwrap();
        let receipt: InstallReceipt = serde_json::from_slice(&fs::read(manifest["receiptPath"].as_str().unwrap()).unwrap()).unwrap();
        for owned in &receipt.files { assert_eq!(sha256_file(Path::new(&owned.relative_path)).unwrap(), owned.sha256.clone().unwrap(), "Refuse to remove a sample file changed by somebody else"); }
        if profile == BUILTIN_PAYDAY3_PROFILE_ID { uninstall_receipt_internal(&receipt).unwrap(); }
        else { uninstall_profile_receipt_internal(&profile, &receipt.id).unwrap(); }
        assert!(receipt.files.iter().all(|owned| !Path::new(&owned.relative_path).exists()));
        for original in manifest["originals"].as_array().unwrap() {
            let destination = Path::new(original["path"].as_str().unwrap());
            if let Some(backup) = original["backup"].as_str() {
                fs::copy(backup, destination).unwrap();
                assert_eq!(sha256_file(destination).unwrap(), original["sha256"].as_str().unwrap());
            } else if destination.is_file() { fs::remove_file(destination).unwrap(); }
        }
        let mut restored = manifest;
        restored["restorationVerified"] = serde_json::json!(true);
        fs::write(&deployment, serde_json::to_vec_pretty(&restored).unwrap()).unwrap();
        return;
    }
    assert!(!deployment.exists(), "Never overwrite an active deployment manifest");
    let inventory: Vec<serde_json::Value> = serde_json::from_slice(&fs::read(root.join("real-game-inventory.json")).unwrap()).unwrap();
    let detected = inventory.iter().find(|item| item["profileId"] == profile && item["installed"] == true).unwrap();
    let game = PathBuf::from(detected["gameRoot"].as_str().unwrap()).canonicalize().unwrap();
    validate_builtin_profile_root(&profile, &game).unwrap();
    let mod_id = if profile == BUILTIN_PAYDAY3_PROFILE_ID { "59445" } else { "58117" };
    let report: Vec<serde_json::Value> = serde_json::from_slice(&fs::read(root.join("report.json")).unwrap()).unwrap();
    let row = report.iter().find(|item| item["profileId"] == profile && item["provider"] == "modworkshop").unwrap();
    let sample = row["result"]["attempts"].as_array().unwrap().iter().find(|item| item["modId"] == mod_id).unwrap();
    let file = PathBuf::from(sample["file"].as_str().unwrap()).canonicalize().unwrap();
    assert!(file.starts_with(root.join("downloads")));
    assert_eq!(sha256_file(&file).unwrap(), sample["downloadSha256"].as_str().unwrap());
    save_settings_internal(&AppSettings { game_path:Some(game.display().to_string()), keep_downloaded_archives:true, ..Default::default() }).unwrap();
    save_profile_settings_internal(&profile, &ProfileSettings { game_root_override:Some(game.display().to_string()), game_version:if profile == BUILTIN_PAYDAY3_PROFILE_ID { Some("UE5.5".into()) } else { None }, ..Default::default() }).unwrap();
    let entries = if profile == BUILTIN_PAYDAY3_PROFILE_ID { inspect_staged_file(&detect_payday3_paths_internal().unwrap(), &file, "UE5 cosmetic").unwrap().1 }
        else { let item = analyze_custom_profile_path(&load_profile_context(&profile).unwrap(), &file).unwrap(); assert!(!item.blocked); item.entries };
    let destinations = entries.iter().filter(|entry| entry.route_kind != "folder").map(|entry| {
        assert!(!entry.blocked);
        let path = PathBuf::from(&entry.destination);
        assert!(path.starts_with(&game));
        assert!(!path.exists(), "This runtime test refuses to overwrite existing mods");
        assert!(if profile == BUILTIN_PAYDAY3_PROFILE_ID { ["pak", "utoc", "ucas"].contains(&path.extension().unwrap().to_str().unwrap()) } else { path.starts_with(game.join("mods/PD_Rebalance")) });
        path
    }).collect::<Vec<_>>();
    let mut originals = Vec::new();
    if profile == BUILTIN_PAYDAY3_PROFILE_ID {
        for (index, relative) in ["PAYDAY3/Binaries/Win64/ue4ss/Mods/mods.txt", "PAYDAY3/Binaries/Win64/Mods/mods.txt"].iter().enumerate() {
            let path = game.join(relative);
            let backup = root.join(format!("real-pd3-mods-{index}.bak"));
            if path.is_file() { fs::copy(&path, &backup).unwrap(); originals.push(serde_json::json!({"path":path,"backup":backup,"sha256":sha256_file(&path).unwrap()})); }
            else { originals.push(serde_json::json!({"path":path,"backup":null})); }
        }
    }
    fs::write(&deployment, serde_json::to_vec_pretty(&serde_json::json!({"profileId":profile,"gameRoot":game,"modId":mod_id,"archiveSha256":sha256_file(&file).unwrap(),"plannedDestinations":destinations,"originals":originals,"restorationVerified":false,"runtimeVerified":false})).unwrap()).unwrap();
    let applied = if profile == BUILTIN_PAYDAY3_PROFILE_ID {
        install_staged_file_to_game_internal(file.to_str().unwrap(), "Temporary cosmetic verification sample", "modworkshop", mod_id, sample["fileId"].as_str().unwrap(), None, None, None, None, None, None, None, None, None, "UE5 cosmetic", vec![]).unwrap()
    } else { install_profile_source_file(&profile, &file, "modworkshop", mod_id, sample["fileId"].as_str().unwrap(), "Temporary verification sample", None, None, None, None).unwrap() };
    let receipt: InstallReceipt = serde_json::from_slice(&fs::read(&applied.receipt_path).unwrap()).unwrap();
    assert!(receipt.files.iter().all(|owned| destinations.contains(&PathBuf::from(&owned.relative_path))));
    for owned in &receipt.files { assert_eq!(sha256_file(Path::new(&owned.relative_path)).unwrap(), owned.sha256.clone().unwrap()); }
    let mut manifest: serde_json::Value = serde_json::from_slice(&fs::read(&deployment).unwrap()).unwrap();
    manifest["receiptPath"] = serde_json::json!(applied.receipt_path);
    manifest["deploymentHashVerified"] = serde_json::json!(true);
    fs::write(&deployment, serde_json::to_vec_pretty(&manifest).unwrap()).unwrap();
}

#[test]
#[ignore = "Requires isolated APPDATA under target/profile-smoke"]
fn profile_workflow_persistence_sandbox() {
    let root = PathBuf::from(env::var("TSUKI_PROFILE_TEST_ROOT").unwrap()).canonicalize().unwrap();
    let approved = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/profile-smoke").canonicalize().unwrap();
    assert!(root.starts_with(&approved) && root != approved);
    let isolated = root.join("isolated-appdata").canonicalize().unwrap();
    assert_eq!(PathBuf::from(env::var("APPDATA").unwrap()).canonicalize().unwrap(), isolated);
    let assets = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/assets");
    for name in ["payday3-profile-cover.png", "payday2-profile-cover.jpg", "lunar-startup-v2.webp"] {
        let source = assets.join(name);
        let imported = import_profile_artwork_image("user.artwork-regression".into(), source.display().to_string()).unwrap();
        let managed = PathBuf::from(imported.managed_path);
        assert!(managed.canonicalize().unwrap().starts_with(&isolated));
        assert!(imported.managed_exists && imported.source_exists);
        assert_eq!(sha256_file(&source).unwrap(), sha256_file(&managed).unwrap());
    }
    let image_bytes = fs::read(assets.join("lunar-startup-v2.webp")).unwrap();
    let pasted = save_profile_artwork_data_url("user.artwork-regression".into(), format!("data:image/webp;base64,{}", general_purpose::STANDARD.encode(&image_bytes))).unwrap();
    assert_eq!(fs::read(&pasted.managed_path).unwrap(), image_bytes);
    let game = root.join("workflow-game");
    let paths = sandbox_paths(&game);
    fs::create_dir_all(&paths.win64).unwrap();
    fs::create_dir_all(&paths.pak_mods).unwrap();
    fs::write(paths.win64.join("PAYDAY3Client-Win64-Shipping.exe"), b"SIMULATED GAME - NOT EXECUTABLE").unwrap();
    save_settings_internal(&AppSettings { game_path: Some(game.display().to_string()), ..Default::default() }).unwrap();
    assert_eq!(detect_payday3_paths_internal().unwrap().game_root.canonicalize().unwrap(), game.canonicalize().unwrap());
    let profiles = [BUILTIN_PAYDAY3_PROFILE_ID, "test.readyornot", "builtin.payday2", "builtin.monster-hunter-wilds"];
    for id in profiles {
        let first = save_current_mod_profile("Default".into(), id.into()).unwrap();
        let second = save_current_mod_profile("Testing".into(), id.into()).unwrap();
        let loaded = list_mod_profiles(id.into()).unwrap();
        assert_eq!(loaded.len(), 2);
        assert!(loaded.iter().all(|profile| profile.game_profile_id == id));
        assert_eq!(load_settings_internal().active_mod_profile_by_game_profile_id.get(id), Some(&second.id));
        delete_mod_profile(first.id, id.into()).unwrap();
        assert_eq!(list_mod_profiles(id.into()).unwrap().len(), 1);
        assert_eq!(load_settings_internal().active_mod_profile_by_game_profile_id.get(id), Some(&second.id));
    }
    let draft_id = "user.sandbox-payday2";
    let cover = ensure_profile_data_dirs(draft_id).unwrap().join("artwork/cover.webp");
    fs::create_dir_all(cover.parent().unwrap()).unwrap();
    fs::copy(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/assets/lunar-startup-v2.webp"), &cover).unwrap();
    let image = serde_json::json!({"kind":"managed_local","value":cover});
    let draft = serde_json::json!({"profileId":draft_id,"status":"draft","overview":{"profileTitle":"PAYDAY 2 Sandbox","gameName":"PAYDAY 2","gameKey":"payday-2"},"artwork":{"imageReference":image},"sections":{}});
    save_game_profile_draft_value(draft_id, draft).unwrap();
    let mut restored = read_game_profile_draft(draft_id).unwrap();
    assert_eq!(restored["overview"]["gameName"], "PAYDAY 2");
    assert_eq!(restored["artwork"]["imageReference"], image);
    restored["overview"]["profileTitle"] = serde_json::json!("PAYDAY 2 Edited");
    save_game_profile_draft_value(draft_id, restored).unwrap();
    assert!(game_profile_draft_path(draft_id).unwrap().with_extension("json.bak").is_file());
    let malformed = game_profile_draft_path("user.sandbox-malformed").unwrap();
    fs::write(&malformed, b"{broken legacy draft").unwrap();
    let drafts = list_game_profile_drafts().unwrap();
    assert_eq!(drafts.iter().filter(|draft| draft["profileId"] == draft_id).count(), 1);
    assert_eq!(fs::read(&malformed).unwrap(), b"{broken legacy draft");
    save_game_profile_draft_value("user.sandbox-other", serde_json::json!({"profileId":"user.sandbox-other","overview":{"profileTitle":"Other Game"},"sections":{}})).unwrap();
    delete_game_profile_draft("user.sandbox-other".into()).unwrap();
    assert_eq!(read_game_profile_draft(draft_id).unwrap()["artwork"]["imageReference"], image);
    fs::write(root.join("workflow-persistence-report.json"), serde_json::to_vec_pretty(&serde_json::json!({"profiles":profiles,"modProfileIsolation":"passed","selectedModProfilePersistence":"passed","draftImagePersistence":"passed","localPngJpegWebpImports":"hash-verified","clipboardDataUrlImport":"byte-verified","draftOverwriteBackup":"passed","malformedDraftPreserved":true,"unrelatedDraftDeletion":"passed"})).unwrap()).unwrap();
}

#[test]
#[ignore = "Requires downloaded UE5 loader and isolated APPDATA under target/profile-smoke"]
fn payday_ue5_loader_receipt_lifecycle() {
    let root = PathBuf::from(env::var("TSUKI_PROFILE_TEST_ROOT").unwrap()).canonicalize().unwrap();
    let approved = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/profile-smoke").canonicalize().unwrap();
    assert!(root.starts_with(&approved) && root != approved);
    let isolated = root.join("isolated-appdata").canonicalize().unwrap();
    assert_eq!(PathBuf::from(env::var("APPDATA").unwrap()).canonicalize().unwrap(), isolated);
    let game = root.join(format!("game-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    fs::create_dir_all(game.join("PAYDAY3/Content/Paks/~mods")).unwrap();
    fs::create_dir_all(game.join("PAYDAY3/Binaries/Win64")).unwrap();
    fs::write(game.join("PAYDAY3/Binaries/Win64/PAYDAY3Client-Win64-Shipping.exe"), b"SIMULATED GAME - DO NOT EXECUTE").unwrap();
    save_settings_internal(&AppSettings { game_path: Some(game.display().to_string()), ..Default::default() }).unwrap();
    save_profile_settings_internal(BUILTIN_PAYDAY3_PROFILE_ID, &ProfileSettings { game_version: Some("UE5.5".to_string()), ..Default::default() }).unwrap();
    let paths = detect_payday3_paths_internal().unwrap();
    assert_eq!(paths.game_root.canonicalize().unwrap(), game.canonicalize().unwrap());
    assert!(!payday_ue5_loader_ready(&paths, true));
    let install = |file: &Path, name: &str, mod_id: &str, description: &str| install_staged_file_to_game_internal(
        file.to_str().unwrap(), name, "modworkshop", mod_id, "sandbox", None, None, None, None, None, None, None, None, None, description, vec![]).unwrap();
    let loader = install(&root.join("PD3-UE5-UE4SS-exp.zip"), "PD3 UE5 Loader", "47771", "UE4SS UE5 package");
    assert!(payday_ue5_loader_ready(&paths, true));
    let loader_receipt: InstallReceipt = serde_json::from_slice(&fs::read(&loader.receipt_path).unwrap()).unwrap();
    assert!(loader_receipt.files.iter().all(|file| Path::new(&file.relative_path).starts_with(&game)));
    assert!(loader_receipt.files.iter().any(|file| Path::new(&file.relative_path) == paths.ue4ss_mods.join("mods.txt")));
    set_receipt_mod_enabled_internal(&loader_receipt.id, false).unwrap();
    assert!(!payday_ue5_loader_ready(&paths, true));
    assert!(installed_state_record_from_receipt(&paths, &loader_receipt).files.iter().any(|file| file.live));
    set_receipt_mod_enabled_internal(&loader_receipt.id, true).unwrap();
    for file in &loader_receipt.files { assert_eq!(sha256_file(Path::new(&file.relative_path)).unwrap(), file.sha256.clone().unwrap()); }
    assert!(payday_ue5_loader_ready(&paths, true));
    let script = root.join("Sandbox.lua"); fs::write(&script, b"-- Sandbox fixture; never executed").unwrap();
    let lua = install(&script, "Sandbox Lua", "sandbox-lua", "Lua UE4SS");
    assert!(paths.ue4ss_mods.join("Sandbox/Scripts/main.lua").is_file());
    let pak = root.join("Sandbox_P.pak"); fs::write(&pak, b"Sandbox routing fixture; not a real Unreal package").unwrap();
    let applied = install(&pak, "Sandbox PAK", "sandbox-pak", "");
    assert!(paths.pak_mods.join("Sandbox_P.pak").is_file());
    for applied in [&lua, &applied] {
        let receipt: InstallReceipt = serde_json::from_slice(&fs::read(&applied.receipt_path).unwrap()).unwrap();
        set_receipt_mod_enabled_internal(&receipt.id, false).unwrap();
        set_receipt_mod_enabled_internal(&receipt.id, true).unwrap();
        uninstall_receipt_internal(&receipt).unwrap();
        assert!(!list_installed_state_records_internal().unwrap().iter().any(|record| record.receipt_id.as_deref() == Some(receipt.id.as_str())));
    }
    uninstall_receipt_internal(&loader_receipt).unwrap();
    assert!(!payday_ue5_loader_ready(&paths, true));
    fs::write(root.join("ue5-receipt-report.json"), serde_json::to_vec_pretty(&serde_json::json!({
        "gameRoot": game, "loaderOwnedFiles": loader_receipt.files.len(), "loaderLifecycle": "passed", "luaLifecycle": "passed", "pakLifecycle": "passed", "runtimeVerified": false
    })).unwrap()).unwrap();
}

#[test]
#[ignore = "Use profile-sandbox-recheck.mjs with isolated APPDATA"]
fn recheck_profile_sandbox_receipts() {
    let root = PathBuf::from(env::var("TSUKI_PROFILE_TEST_ROOT").unwrap()).canonicalize().unwrap();
    let approved = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/profile-smoke").canonicalize().unwrap();
    assert!(root.starts_with(&approved) && root != approved);
    let isolated = root.join("isolated-appdata").canonicalize().unwrap();
    assert_eq!(PathBuf::from(env::var("APPDATA").unwrap()).canonicalize().unwrap(), isolated, "Receipt tests require isolated app data");
    let report: Vec<serde_json::Value> = serde_json::from_slice(&fs::read(root.join("report.json")).unwrap()).unwrap();
    let recheck_root = root.join("recheck-games").join(SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos().to_string());
    let mut results = Vec::new();
    for row in report {
        let profile = row["profileId"].as_str().unwrap();
        for sample in row["result"]["attempts"].as_array().unwrap_or(&Vec::new()) {
            let Some(file) = sample["file"].as_str() else { continue; };
            let file = PathBuf::from(file).canonicalize().unwrap();
            assert!(file.starts_with(root.join("downloads")));
            assert_eq!(sha256_file(&file).unwrap(), sample["downloadSha256"].as_str().unwrap());
            let game = recheck_root.join(row["sourceId"].as_str().unwrap()).join(sample["modId"].as_str().unwrap());
            fs::create_dir_all(&game).unwrap();
            if profile == BUILTIN_PAYDAY3_PROFILE_ID {
                let paths = sandbox_paths(&game);
                fs::create_dir_all(&paths.win64).unwrap();
                fs::create_dir_all(&paths.pak_mods).unwrap();
                fs::write(paths.win64.join("PAYDAY3Client-Win64-Shipping.exe"), b"SIMULATED GAME - NOT EXECUTABLE").unwrap();
                save_settings_internal(&AppSettings { game_path: Some(game.display().to_string()), ..Default::default() }).unwrap();
                save_profile_settings_internal(profile, &ProfileSettings { game_version:Some("UE5.5".into()), ..Default::default() }).unwrap();
                let loader_file = approved.join("ue5-loader-verification/PD3-UE5-UE4SS-exp.zip");
                let loader = install_staged_file_to_game_internal(loader_file.to_str().unwrap(), "Sandbox UE5 loader", "modworkshop", "47771", "102150", None, None, None, None, None, None, None, None, None, "UE4SS UE5 package", vec![]).unwrap();
                let applied = install_staged_file_to_game_internal(file.to_str().unwrap(), "Sandbox downloaded mod", row["provider"].as_str().unwrap(), sample["modId"].as_str().unwrap(), sample["fileId"].as_str().unwrap(), None, None, None, None, None, None, None, None, None, "UE5 mod", vec![]).unwrap();
                let receipt: InstallReceipt = serde_json::from_slice(&fs::read(&applied.receipt_path).unwrap()).unwrap();
                assert!(Path::new(&applied.receipt_path).canonicalize().unwrap().starts_with(&isolated));
                assert!(receipt.files.iter().all(|owned| Path::new(&owned.relative_path).starts_with(&game)));
                set_receipt_mod_enabled_internal(&receipt.id, false).unwrap();
                set_receipt_mod_enabled_internal(&receipt.id, true).unwrap();
                for owned in &receipt.files { assert_eq!(sha256_file(Path::new(&owned.relative_path)).unwrap(), owned.sha256.clone().unwrap()); }
                uninstall_receipt_internal(&receipt).unwrap();
                assert!(receipt.files.iter().all(|owned| !Path::new(&owned.relative_path).exists()));
                let loader_receipt: InstallReceipt = serde_json::from_slice(&fs::read(&loader.receipt_path).unwrap()).unwrap();
                uninstall_receipt_internal(&loader_receipt).unwrap();
                results.push(serde_json::json!({"profileId":profile,"modId":sample["modId"],"status":"install-disable-enable-uninstall-passed","receiptLifecycleVerified":true,"runtimeVerified":false,"ownedFiles":receipt.files.len(),"engine":"UE5.5"}));
                continue;
            }
            let _ = sandbox_context(profile, &game);
            save_profile_settings_internal(profile, &ProfileSettings { game_root_override:Some(game.display().to_string()), ..Default::default() }).unwrap();
            let item = analyze_custom_profile_path(&load_profile_context(profile).unwrap(), &file).unwrap();
            if item.blocked {
                if external_manager_for_package(profile, &file).is_some() {
                    let staged = downloads_cache_dir().unwrap().join(sanitize_file_component(profile)).join(sample["modId"].as_str().unwrap()).join(file.file_name().unwrap());
                    fs::create_dir_all(staged.parent().unwrap()).unwrap();
                    fs::copy(&file, &staged).unwrap();
                    let handoff = prepare_external_handoff_internal(profile, &staged).unwrap();
                    let manifest: serde_json::Value = serde_json::from_slice(&fs::read(handoff.join("handoff.json")).unwrap()).unwrap();
                    assert_eq!(manifest["profileId"], profile);
                    assert_eq!(manifest["installed"], false);
                    assert_eq!(sha256_file(Path::new(manifest["package"].as_str().unwrap())).unwrap(), sha256_file(&file).unwrap());
                    assert!(prepare_external_handoff_internal("builtin.payday2", &staged).is_err());
                    assert!(prepare_external_handoff_internal(profile, &file).is_err(), "Foreign profile paths must not be accepted");
                    results.push(serde_json::json!({"profileId":profile,"modId":sample["modId"],"status":"external-manager-handoff-verified","manager":manifest["manager"],"hashVerified":true,"installed":false,"runtimeVerified":false}));
                } else {
                    results.push(serde_json::json!({"profileId":profile,"modId":sample["modId"],"status":"unsupported-package","blocked":item.entries}));
                }
                continue;
            }
            let applied = install_profile_source_file(profile, &file, row["provider"].as_str().unwrap(), sample["modId"].as_str().unwrap(), sample["fileId"].as_str().unwrap(), "Sandbox downloaded mod", None, None, None, None).unwrap();
            let receipt: InstallReceipt = serde_json::from_slice(&fs::read(&applied.receipt_path).unwrap()).unwrap();
            assert!(Path::new(&applied.receipt_path).canonicalize().unwrap().starts_with(&isolated));
            for owned in &receipt.files { assert!(Path::new(&owned.relative_path).starts_with(&game)); }
            set_source_install_enabled(receipt.source.clone(), receipt.source_mod_id.clone().unwrap(), false, Some(profile.into()), Some(receipt.id.clone())).unwrap();
            assert!(receipt.files.iter().all(|owned| !Path::new(&owned.relative_path).exists()));
            set_local_win64_matched_files_enabled(receipt.files.iter().map(|f| f.relative_path.clone()).collect(), true, Some(profile.into())).unwrap();
            for owned in &receipt.files { assert_eq!(sha256_file(Path::new(&owned.relative_path)).unwrap(),owned.sha256.clone().unwrap()); }
            uninstall_profile_receipt_internal(profile, &receipt.id).unwrap();
            assert!(receipt.files.iter().all(|owned| !Path::new(&owned.relative_path).exists()));
            assert!(!Path::new(&applied.receipt_path).exists());
            results.push(serde_json::json!({"profileId":profile,"modId":sample["modId"],"status":"install-disable-enable-uninstall-passed","receiptLifecycleVerified":true,"runtimeVerified":false,"ownedFiles":receipt.files.len()}));
        }
    }
    fs::write(root.join("recheck-report.json"),serde_json::to_vec_pretty(&results).unwrap()).unwrap();
    println!("Rechecked {} downloaded packages against current routing; supported generic packages also passed real receipt lifecycle commands.",results.len());
}

fn sandbox_paths(root: &Path) -> PaydayPaths {
    let win64 = root.join("PAYDAY3/Binaries/Win64");
    PaydayPaths { game_root: root.to_path_buf(), pak_mods: root.join("PAYDAY3/Content/Paks/~mods"), ue4ss_mods: win64.join("ue4ss/Mods"), win64 }
}

#[test]
#[ignore = "Requires isolated APPDATA under target/profile-smoke; no real game writes"]
fn all_profile_toggle_command_round_trips() {
    let appdata = PathBuf::from(env::var("APPDATA").unwrap()).canonicalize().unwrap();
    let approved = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/profile-smoke").canonicalize().unwrap();
    assert!(appdata.starts_with(&approved) && appdata != approved);
    let profiles = ["builtin.payday3", "builtin.cyberpunk2077", "builtin.outlast-trials", "builtin.payday-the-heist", "builtin.payday2", "builtin.resident-evil-7", "builtin.resident-evil-village", "builtin.resident-evil-requiem", "builtin.borderlands", "builtin.borderlands2", "builtin.borderlands3", "builtin.borderlands4", "builtin.tiny-tinas-wonderlands", "builtin.spider-man-remastered", "builtin.spider-man-2", "builtin.monster-hunter-wilds", "user.creator-fixture"];
    let mut report = Vec::new();
    for profile in profiles {
        let game = appdata.join("toggle-games").join(profile);
        fs::create_dir_all(&game).unwrap();
        if profile == BUILTIN_PAYDAY3_PROFILE_ID {
            let paths = sandbox_paths(&game);
            fs::create_dir_all(&paths.win64).unwrap(); fs::create_dir_all(&paths.pak_mods).unwrap();
            fs::write(paths.win64.join("PAYDAY3Client-Win64-Shipping.exe"), b"SIMULATED GAME").unwrap();
            save_settings_internal(&AppSettings { game_path:Some(game.display().to_string()), ..Default::default() }).unwrap();
        } else if profile.starts_with("builtin.") { sandbox_context(profile, &game).unwrap(); }
        else {
            let rules = get_profile_creator_install_rules("reframework".into()).unwrap();
            save_game_profile_draft(profile.into(), serde_json::json!({"profileId":profile,"overview":{"profileTitle":"Creator fixture","gameId":"creator-fixture"},"customTest":{"sampleGameRoot":game.display().to_string()},"customFileTypes":rules})).unwrap();
        }
        save_profile_settings_internal(profile, &ProfileSettings { game_root_override:Some(game.display().to_string()), game_version:Some("UE5.5".into()), ..Default::default() }).unwrap();
        let directory = if profile == BUILTIN_PAYDAY3_PROFILE_ID { sandbox_paths(&game).pak_mods } else { game.join("mods") };
        fs::create_dir_all(&directory).unwrap();
        let mut receipts = Vec::new();
        for variant in ["first", "second"] {
            let file = directory.join(format!("{variant}_P.pak"));
            fs::write(&file, variant.as_bytes()).unwrap();
            let id = format!("toggle-{}-{variant}", sanitize_file_component(profile));
            let receipt:InstallReceipt = serde_json::from_value(serde_json::json!({"id":id,"profileId":profile,"displayName":variant,"source":"nexus","sourceModId":"99","sourceFileId":variant,"modType":"pak","enabled":true,"files":[{"relativePath":file.display().to_string(),"sha256":sha256_file(&file).unwrap(),"sizeBytes":variant.len()}]})).unwrap();
            let path = if profile == BUILTIN_PAYDAY3_PROFILE_ID { receipt_file_path(&id).unwrap() } else { profile_receipt_path(profile, &id).unwrap() };
            write_json_file(&path, &serde_json::to_value(&receipt).unwrap(), "fixture").unwrap();
            receipts.push(receipt);
        }
        let first = &receipts[0]; let second = &receipts[1];
        set_source_install_enabled("nexus".into(), "99".into(), false, Some(profile.into()), Some(second.id.clone())).unwrap();
        assert!(Path::new(&first.files[0].relative_path).is_file());
        assert!(!Path::new(&second.files[0].relative_path).exists(), "Exact receipt ID must select the second variant");
        assert_eq!(list_profile_receipts_internal(profile).unwrap().iter().find(|r| r.id == second.id).unwrap().enabled, Some(false));
        set_local_win64_matched_files_enabled(vec![second.files[0].relative_path.clone()], true, Some(profile.into())).unwrap();
        set_pak_mod_files_enabled(vec![if profile == BUILTIN_PAYDAY3_PROFILE_ID { "first_P.pak".into() } else { first.files[0].relative_path.clone() }], false, Some(profile.into())).unwrap();
        set_local_win64_matched_files_enabled(vec![first.files[0].relative_path.clone()], true, Some(profile.into())).unwrap();
        for receipt in &receipts { assert_eq!(sha256_file(Path::new(&receipt.files[0].relative_path)).unwrap(), receipt.files[0].sha256.clone().unwrap()); }
        assert!(set_source_install_enabled("nexus".into(), "wrong".into(), false, Some(profile.into()), Some(first.id.clone())).is_err());
        if profile != BUILTIN_PAYDAY3_PROFILE_ID {
            assert!(replace_profile_source_install(profile, &first.id, "nexus", "99", || Err("Simulated install failure".into())).is_err());
            assert_eq!(sha256_file(Path::new(&first.files[0].relative_path)).unwrap(), first.files[0].sha256.clone().unwrap());
            assert_eq!(list_profile_receipts_internal(profile).unwrap().iter().find(|r| r.id == first.id).unwrap().enabled, Some(true));
        }
        report.push(serde_json::json!({"profileId":profile,"exactReceiptVariant":true,"disableRestore":true,"hashVerified":true,"runtimeVerified":false}));
    }
    fs::write(appdata.join("toggle-report.json"), serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    println!("All 16 built-in profiles and a saved Creator profile passed registered toggle command round trips.");
}

fn sandbox_context(profile_id: &str, root: &Path) -> Option<profile_installs::ProfileInstallContext> {
    for marker in profile_installs::builtin_profile_executable_markers(profile_id).iter().take(1) {
        let path = root.join(marker);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"SIMULATED GAME - NOT EXECUTABLE").unwrap();
    }
    let draft = profile_installs::builtin_install_definition(profile_id, Some(root))?;
    for dependency in profile_installs::draft_section_items(&draft, "dependencies") {
        for marker in profile_installs::split_list(&profile_installs::item_field_value(dependency, "Marker Filenames").unwrap_or_default()) {
            let path = root.join(profile_installs::safe_relative_path(&marker).unwrap());
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"SIMULATED LOADER - NOT EXECUTABLE").unwrap();
        }
    }
    let rules = serde_json::from_value(draft["customFileTypes"].clone()).unwrap();
    Some(profile_installs::ProfileInstallContext { profile_id: format!("test.smoke-{}", sanitize_file_component(profile_id)), game_id: profile_id.to_string(), game_root: root.to_path_buf(), executable_dir: root.to_path_buf(), draft, rules })
}

fn apply_sandbox_archive(profile: &str, game: &Path, file: &Path, description: &str) -> Result<serde_json::Value, String> {
    let (entries, item) = if profile == BUILTIN_PAYDAY3_PROFILE_ID {
        let (_, entries, _) = inspect_staged_file(&sandbox_paths(game), file, description)?;
        (entries, None)
    } else {
        let context = sandbox_context(profile, game).ok_or("No install policy")?;
        let item = profile_installs::analyze_custom_profile_path(&context, file)?;
        if item.blocked {
            return Ok(serde_json::json!({"status":"unsupported-package","installed":[],"blocked":item.entries,"runtimeVerified":false,"receiptLifecycleVerified":false}));
        }
        (item.entries.clone(), Some(item))
    };
    let mut installed = Vec::new();
    let mut blocked = Vec::new();
    for entry in entries {
        if entry.blocked { blocked.push(entry); continue; }
        if entry.route_kind == "folder" { continue; }
        let destination = PathBuf::from(&entry.destination);
        if !destination.starts_with(game) { return Err("Sandbox destination escaped simulated game".into()); }
        if destination.exists() { return Err("Sandbox refuses to overwrite an earlier sample".into()); }
        let bytes = if let Some(item) = item.as_ref() {
            profile_installs::read_entry_bytes(item, &entry)?
        } else if file_has_zip_magic(file) {
            let mut archive = ZipArchive::new(File::open(file).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            let mut found = None;
            for index in 0..archive.len() {
                let mut member = archive.by_index(index).map_err(|e| e.to_string())?;
                let name = normalize_archive_path(member.name());
                if name == entry.archive_path || name.ends_with(&format!("/{}", entry.archive_path)) {
                    let mut bytes = Vec::new();
                    member.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
                    found = Some(bytes);
                    break;
                }
            }
            found.ok_or("Archive member not found")?
        } else { fs::read(file).map_err(|e| e.to_string())? };
        fs::create_dir_all(destination.parent().unwrap()).map_err(|e| e.to_string())?;
        fs::write(&destination, &bytes).map_err(|e| e.to_string())?;
        if fs::read(&destination).map_err(|e| e.to_string())? != bytes { return Err("Extracted-byte verification failed".into()); }
        installed.push(serde_json::json!({"archivePath": entry.archive_path, "destination": destination, "sha256": sha256_file(&destination)?, "bytes": bytes.len()}));
    }
    Ok(serde_json::json!({"status": if installed.is_empty() { "unsupported-package" } else if blocked.is_empty() { "sandbox-extracted-and-routed" } else { "partial-package-blocked" }, "installed": installed, "blocked": blocked, "runtimeVerified": false, "receiptLifecycleVerified": false}))
}

#[test]
#[ignore = "Downloads real third-party mods; run node scripts/profile-download-smoke.mjs"]
fn live_profile_download_sandbox() {
    let root = PathBuf::from(env::var("TSUKI_PROFILE_TEST_ROOT").expect("Use the smoke script"));
    let approved = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/profile-smoke").canonicalize().unwrap();
    let root = root.canonicalize().unwrap();
    assert!(root.starts_with(&approved) && root != approved);
    let profiles: Vec<serde_json::Value> = serde_json::from_slice(&fs::read(root.join("profiles.json")).unwrap()).unwrap();
    let settings = load_settings_internal();
    let expected_profiles = profiles.len();
    let mut report = Vec::new();
    for profile in profiles {
        let profile_id = profile["profileId"].as_str().unwrap();
        let game = root.join("games").join(sanitize_file_component(profile_id));
        fs::create_dir_all(&game).unwrap();
        let _ = sandbox_context(profile_id, &game);
        for source in profile["sources"].as_array().unwrap() {
            let provider = source["provider"].as_str().unwrap();
            let slug = source["providerSlug"].as_str().unwrap();
            let source_id = source["id"].as_str().unwrap();
            let engine = source["gameVersion"].as_str().unwrap_or("UE5.5");
            println!("Probing {profile_id} / {provider} / {slug}");
            let run = (|| -> Result<serde_json::Value, String> {
                let listing = if let Some(ids) = source["candidateModIds"].as_array() {
                    let mut mods = Vec::new();
                    for id in ids.iter().take(20) {
                        mods.push(http_get_json_fast_with_api_key(&format!("https://api.nexusmods.com/v1/games/{slug}/mods/{}.json", id.as_str().unwrap()), 18, settings.nexus_api_key.as_deref())?);
                    }
                    serde_json::Value::Array(mods)
                } else if provider == "nexus" {
                    let key = settings.nexus_api_key.as_deref().ok_or("Nexus API key missing")?;
                    http_get_json_fast_with_api_key(&format!("https://api.nexusmods.com/v1/games/{slug}/mods/latest_added.json"), 18, Some(key))?
                } else {
                    http_get_json_fast(&format!("https://api.modworkshop.net/games/{slug}/mods?limit=8{}", if slug != "payday-3" { "" } else if engine == "UE4.27" { "&tags%5B%5D=97" } else { "&block_tags%5B%5D=97" }), 18)?
                };
                let listing = unwrap_data(listing);
                let mods = listing.as_array().ok_or("No mod listing array")?;
                let mut attempts = Vec::new();
                for candidate in mods.iter().take(20) {
                    let mod_id = json_id_string(candidate, &["mod_id", "id"]).ok_or("No mod identity")?;
                    if slug == "payday3" {
                        let detail = http_get_json_fast_with_api_key(&format!("https://api.nexusmods.com/v1/games/{slug}/mods/{mod_id}.json"), 18, settings.nexus_api_key.as_deref())?;
                        let text = format!("{} {} {}", json_string(&detail, &["name"]).unwrap_or_default(), json_string(&detail, &["summary"]).unwrap_or_default(), json_string(&detail, &["description"]).unwrap_or_default()).to_lowercase();
                        if !text.contains("ue5") && !text.contains("unreal engine 5") { continue; }
                    }
                    if provider == "modworkshop" {
                        let summary = modworkshop_summary_from_api_value_for_game(candidate, None).ok_or("No verified game identity")?;
                        if !modworkshop_summary_matches_game(&summary, slug) { continue; }
                        if slug == "payday-3" && !modworkshop_version_matches(&summary.tags, engine) { continue; }
                    }
                    let files_value = if provider == "nexus" {
                        http_get_json_fast_with_api_key(&format!("https://api.nexusmods.com/v1/games/{slug}/mods/{mod_id}/files.json"), 18, settings.nexus_api_key.as_deref())
                    } else { http_get_json_fast(&format!("https://api.modworkshop.net/mods/{mod_id}/files"), 18) };
                    let files_value = match files_value {
                        Ok(value) => value,
                        Err(error) => { attempts.push(serde_json::json!({"modId":mod_id,"status":"file-list-unavailable","error":error})); continue; }
                    };
                    let files_value = unwrap_data(files_value);
                    let mut files = if provider == "nexus" {
                        json_array(&files_value, &["files"]).into_iter().filter(|file| {
                            !matches!(json_string(file, &["category_name"]).unwrap_or_default().to_lowercase().as_str(), "old_version" | "archived" | "deleted")
                        }).cloned().collect::<Vec<_>>()
                    } else {
                        files_value.as_array().unwrap_or(&Vec::new()).iter().cloned().collect::<Vec<_>>()
                    };
                    files.sort_by(|a, b| json_timestamp_string(b, &["uploaded_timestamp", "created_at"]).cmp(&json_timestamp_string(a, &["uploaded_timestamp", "created_at"])));
                    if profile_id == BUILTIN_PAYDAY3_PROFILE_ID {
                        files.retain(|file| {
                            let text = format!("{} {} {}", json_string(file, &["file_name", "file", "name"]).unwrap_or_default(), json_string(file, &["description", "desc"]).unwrap_or_default(), json_string(file, &["name"]).unwrap_or_default()).to_lowercase();
                            !text.contains("ue4.27") && !text.contains("unreal engine 4") && (provider != "nexus" || text.contains("ue5") || text.contains("unreal engine 5"))
                        });
                    }
                    let Some(file) = files.first() else { continue; };
                    if json_u64(file, &["size_in_bytes", "size"]).unwrap_or(u64::MAX) >= 64 * 1024 * 1024 { continue; }
                    let file_id = json_id_string(file, &["file_id", "id"]).ok_or("No file identity")?;
                    let url = match resolve_source_file_download_url(provider, &mod_id, &file_id, json_string(file, &["download_url"]), Some(slug)) {
                        Ok(url) => url,
                        Err(error) => { attempts.push(serde_json::json!({"modId":mod_id,"fileId":file_id,"error":error})); continue; }
                    };
                    let name = json_string(file, &["file_name", "file", "name"]).unwrap_or_else(|| "sample.zip".into());
                    let folder = root.join("downloads").join(source_id).join(&mod_id);
                    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
                    let mut path = folder.join(sanitize_file_component(&name));
                    download_url_to_file_with_diagnostic(&url, &path)?;
                    validate_staged_download_payload(&path, provider, &mod_id, &file_id)?;
                    path = rename_staged_download_if_fake_zip(&path, provider, &mod_id, &file_id, &name)?;
                    let sample_game = game.join(source_id).join(&mod_id);
                    fs::create_dir_all(&sample_game).map_err(|e| e.to_string())?;
                    let analysis = apply_sandbox_archive(profile_id, &sample_game, &path, &json_string(candidate, &["desc", "description"]).unwrap_or_default())?;
                    let success = analysis["status"] == "sandbox-extracted-and-routed";
                    attempts.push(serde_json::json!({"modId":mod_id,"fileId":file_id,"file":path,"downloadSha256":sha256_file(&path)?,"routing":analysis}));
                    if success || attempts.iter().filter(|sample|sample.get("downloadSha256").is_some()).count() >= 3 { break; }
                }
                Ok(serde_json::json!({"attempts":attempts,"status":if attempts.is_empty(){"no-small-downloadable-file"}else{"probed"}}))
            })();
            let result = match run { Ok(value) => value, Err(error) => serde_json::json!({"status":"provider-error","error":error}) };
            report.push(serde_json::json!({"profileId":profile_id,"sourceId":source_id,"provider":provider,"mapping":slug,"gameVersion":source["gameVersion"],"result":result}));
            fs::write(root.join("report.json"), serde_json::to_vec_pretty(&report).unwrap()).unwrap();
        }
    }
    assert_eq!(report.iter().map(|row|row["profileId"].as_str().unwrap()).collect::<std::collections::BTreeSet<_>>().len(), expected_profiles);
    println!("All configured sources probed; inspect report.json for passes, unsupported formats and provider errors.");
}
