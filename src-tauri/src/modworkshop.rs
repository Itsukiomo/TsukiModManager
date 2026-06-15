#![allow(dead_code)]

//! ModWorkshop integration module.
//!
//! v0.16 starts moving source code out of `lib.rs` so future updates do not keep
//! duplicating commands. The current public Tauri command wrappers still live in
//! `lib.rs` for compatibility. New ModWorkshop parsing/downloading code should be
//! added here.

pub const PAYDAY3_GAME_SLUG: &str = "payday-3";

pub fn payday3_mods_page(page: u32) -> String {
    format!(
        "https://modworkshop.net/g/{}/mods?page={}",
        PAYDAY3_GAME_SLUG,
        page.max(1)
    )
}

pub fn mod_page(mod_id: &str) -> String {
    format!("https://modworkshop.net/mod/{}", mod_id)
}
