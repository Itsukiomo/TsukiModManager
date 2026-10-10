use super::*;

fn numeric_id(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 20 || !value.bytes().all(|c| c.is_ascii_digit()) {
        return Err("Invalid mod identity".into());
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn fetch_dependency_metadata(source: String, mod_id: String, game_domain: Option<String>, profile_id: String) -> Result<SourceModSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        numeric_id(&mod_id)?;
        clean_profile_id(&profile_id)?;
        match source.as_str() {
            "modworkshop" => {
                let value = unwrap_data(http_get_json_fast(&format!("https://api.modworkshop.net/mods/{mod_id}"), 12)?);
                modworkshop_summary_from_api_value_for_game(&value, None).ok_or("Dependency metadata is unavailable".into())
            }
            "nexus" => {
                let domain = nexus_domain_for_request(game_domain.as_deref(), &source_config_for_profile_id(Some(&profile_id)))?;
                let settings = load_settings_internal();
                let key = settings.nexus_api_key.as_deref().ok_or("Nexus account is not connected")?;
                let value = http_get_json_fast_with_api_key(&format!("https://api.nexusmods.com/v1/games/{domain}/mods/{mod_id}.json"), 12, Some(key))?;
                let mut summary = nexus_summary_from_value(&value);
                summary.game_id = Some(domain.clone());
                summary.page_url = Some(format!("https://www.nexusmods.com/{domain}/mods/{mod_id}"));
                Ok(summary)
            }
            _ => Err("This dependency has no source mod metadata".into()),
        }
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn fetch_mod_requirements(source: String, mod_id: String, game_domain: Option<String>, profile_id: String) -> Result<Vec<SourceDependencyItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        numeric_id(&mod_id)?;
        clean_profile_id(&profile_id)?;
        if source == "modworkshop" {
            let value = unwrap_data(http_get_json_fast(&format!("https://api.modworkshop.net/mods/{mod_id}"), 12)?);
            return Ok(source_dependencies_from_value(&value, Some("modworkshop"), None, json_id_string(&value, &["game_id"]).as_deref()));
        }
        if source != "nexus" { return Err("Requirements are not available for this source".into()); }
        let domain = nexus_domain_for_request(game_domain.as_deref(), &source_config_for_profile_id(Some(&profile_id)))?;
        let settings = load_settings_internal();
        let key = settings.nexus_api_key.as_deref().ok_or("Nexus account is not connected")?;
        let metadata = http_get_json_fast_with_api_key(&format!("https://api.nexusmods.com/v1/games/{domain}/mods/{mod_id}.json"), 12, Some(key))?;
        let game_id = json_id_string(&metadata, &["game_id"]).ok_or("Nexus did not return the game's numeric identity")?;
        let client = reqwest::blocking::Client::builder().timeout(std::time::Duration::from_secs(15)).build().map_err(|e| e.to_string())?;
        let mut result = Vec::new();
        let mut game_domains = std::collections::HashMap::from([(game_id.clone(), domain.clone())]);
        let mut games_loaded = false;
        // Page the forward requirements only; reverse dependants are never installation requirements.
        for offset in (0..500).step_by(100) {
            let response: serde_json::Value = client.post("https://api.nexusmods.com/v2/graphql").header("apikey", key)
                .json(&serde_json::json!({"query": "query TsukiRequirements($game:ID!,$mod:ID!,$offset:Int!){mod(gameId:$game,modId:$mod){modRequirements{dlcRequirements{notes gameExpansion{name}} nexusRequirements(offset:$offset,count:100){totalCount nodes{modId gameId modName notes url externalRequirement}}}}}", "variables":{"game":game_id,"mod":mod_id,"offset":offset}}))
                .send().and_then(|r| r.error_for_status()).map_err(|e| e.without_url().to_string())?.json().map_err(|e| e.to_string())?;
            if response.get("errors").and_then(|e| e.as_array()).is_some_and(|e| !e.is_empty()) { return Err("Nexus requirements lookup failed; use the author's Requirements page or retry".into()); }
            let page = response.pointer("/data/mod/modRequirements/nexusRequirements").ok_or("Nexus requirements response was incomplete")?;
            if offset == 0 {
                for dlc in response.pointer("/data/mod/modRequirements/dlcRequirements").and_then(|v| v.as_array()).into_iter().flatten() {
                    let value = serde_json::json!({"name":dlc["gameExpansion"]["name"], "source":"official", "notes":dlc["notes"].as_str().unwrap_or("Official DLC; manage through your game client")});
                    if let Some(dependency) = source_dependency_from_value(&value, result.len(), None, None, None) { result.push(dependency); }
                }
            }
            let nodes = page["nodes"].as_array().ok_or("Nexus requirements were not returned")?;
            for node in nodes {
                if let Some(mut dependency) = source_dependency_from_value(node, result.len(), Some("nexus"), None, None) {
                    // Off-site entries must not inherit the current game's Nexus identity.
                    if node["externalRequirement"].as_bool() == Some(true) {
                        let (source, domain, id) = dependency.url.as_deref().map(dependency_identity_from_url).unwrap_or((None,None,None));
                        dependency.source_kind = source;
                        dependency.game_domain = domain;
                        dependency.mod_id = id;
                    } else {
                        let requirement_game = dependency.numeric_game_id.as_deref().unwrap_or(&game_id);
                        if !game_domains.contains_key(requirement_game) && !games_loaded {
                            let games = http_get_json_fast_with_api_key("https://api.nexusmods.com/v1/games.json", 12, Some(key))?;
                            for game in games.as_array().into_iter().flatten() {
                                if let (Some(id), Some(slug)) = (json_id_string(game, &["id"]), json_string(game, &["domain_name"])) { game_domains.insert(id, slug); }
                            }
                            games_loaded = true;
                        }
                        let slug = game_domains.get(requirement_game).ok_or("Nexus requirement game could not be resolved")?;
                        dependency.game_domain = Some(slug.clone());
                        dependency.source_kind = Some("nexus".into());
                        dependency.url = dependency.mod_id.as_ref().map(|id| format!("https://www.nexusmods.com/{slug}/mods/{id}"));
                    }
                    result.push(dependency);
                }
            }
            let total = page["totalCount"].as_u64().unwrap_or(nodes.len() as u64);
            if offset as u64 + nodes.len() as u64 >= total { return Ok(result); }
            if nodes.is_empty() { return Err("Nexus returned an incomplete requirements page".into()); }
        }
        Err("This mod lists more than 500 requirements; review the source page".into())
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn workshop_templates_keep_linked_mod_names_images_and_identity() {
        let value = serde_json::json!({"instructs_template":{"dependencies":[{"id":5933,"name":null,"mod_id":58342,"optional":false,"mod":{"id":58342,"name":"SuperBLT 64-bit Beta","game_id":1,"thumbnail":{"file":"loader.webp"}}}]}});
        let result = source_dependencies_from_value(&value, Some("modworkshop"), None, Some("1"));
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "SuperBLT 64-bit Beta");
        assert_eq!(result[0].mod_id.as_deref(), Some("58342"));
        assert!(result[0].thumbnail_url.as_deref().is_some_and(|u| u.contains("loader.webp")));
    }
    #[test]
    fn dependency_row_id_is_not_a_mod_id() {
        let result = source_dependency_from_value(&serde_json::json!({"id":42,"name":"External tool","url":"https://example.com"}),0,Some("nexus"),None,None).unwrap();
        assert!(result.mod_id.is_none());
        assert!(numeric_id("../../1").is_err());
    }
    #[test]
    fn requirement_links_preserve_game_identity_and_reject_impostor_hosts() {
        assert_eq!(dependency_identity_from_url("https://www.nexusmods.com/games/payday2/mods/896?tab=requirements"), (Some("nexus".into()), Some("payday2".into()), Some("896".into())));
        assert_eq!(dependency_identity_from_url("https://modworkshop.net/mod/58342"), (Some("modworkshop".into()), None, Some("58342".into())));
        assert_eq!(dependency_identity_from_url("https://evil.example/nexusmods.com/payday2/mods/896").0.as_deref(), Some("external"));
        assert_eq!(dependency_identity_from_url("https://nexusmods.com.evil.example/payday2/mods/896").0.as_deref(), Some("external"));
    }
    #[test]
    #[ignore = "Uses live source APIs and the locally connected Nexus account"]
    fn live_source_requirements() {
        tauri::async_runtime::block_on(async {
            let workshop = fetch_mod_requirements("modworkshop".into(), "14924".into(), None, "builtin.payday2".into()).await.unwrap();
            assert!(workshop.iter().any(|d| d.mod_id.as_deref() == Some("58342") && d.thumbnail_url.is_some()));
            let nexus = fetch_mod_requirements("nexus".into(), "6945".into(), Some("cyberpunk2077".into()), "builtin.cyberpunk2077".into()).await.unwrap();
            assert!(!nexus.is_empty(), "Equipment-EX requirements must be available");
            for dependency in nexus.iter().filter(|d| d.source_kind.as_deref() == Some("nexus")) {
                assert_eq!(dependency.game_domain.as_deref(), Some("cyberpunk2077"));
                let details = fetch_dependency_metadata("nexus".into(), dependency.mod_id.clone().unwrap(), dependency.game_domain.clone(), "builtin.cyberpunk2077".into()).await.unwrap();
                assert!(!details.name.is_empty());
                assert!(details.thumbnail_url.is_some());
            }
            println!("Live requirements passed: ModWorkshop {} entries, Nexus {} entries with named thumbnail metadata", workshop.len(), nexus.len());
        });
    }
}
