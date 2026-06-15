#![allow(dead_code)]

//! Nexus integration module.
//!
//! v0.16 starts moving source code out of `lib.rs` so future updates do not keep
//! duplicating commands. The current public Tauri command wrappers still live in
//! `lib.rs` for compatibility. New Nexus parsing/downloading code should be added here.

pub const PAYDAY3_DOMAIN: &str = "payday3";

pub fn updated_mods_url(period: &str) -> String {
    format!(
        "https://api.nexusmods.com/v1/games/{}/mods/updated.json?period={}",
        PAYDAY3_DOMAIN, period
    )
}

pub fn mod_detail_url(mod_id: &str) -> String {
    format!(
        "https://api.nexusmods.com/v1/games/{}/mods/{}.json",
        PAYDAY3_DOMAIN, mod_id
    )
}

pub fn mod_files_url(mod_id: &str) -> String {
    format!(
        "https://api.nexusmods.com/v1/games/{}/mods/{}/files.json",
        PAYDAY3_DOMAIN, mod_id
    )
}
