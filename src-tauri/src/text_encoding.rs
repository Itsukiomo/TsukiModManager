use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const MIGRATION_MARKER_DIR: &str = "migration-state";
const MIGRATION_BACKUP_DIR: &str = "migration-backups";
const TEXT_ENCODING_MIGRATION_ID: &str = "text-encoding-v1";
const MAX_TEXT_FILE_BYTES: u64 = 25 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TextEncodingMigrationReport {
    pub scanned_files: usize,
    pub repaired_files: usize,
    pub backups_created: usize,
    pub skipped_files: usize,
    pub repaired_strings: usize,
    pub backup_root: Option<String>,
    pub marker_path: Option<String>,
}

pub fn has_mojibake_evidence(text: &str) -> bool {
    if text.is_empty() {
        return false;
    }

    text.contains('\u{00c3}')
        || text.contains('\u{00c2}')
        || text.contains('\u{00e2}')
        || text.contains('\u{fffd}')
        || text.contains("\u{00f0}\u{0178}")
        || text.contains("\u{00e3}\u{0192}")
        || text.contains("\u{00e3}\u{201a}")
        || text.chars().any(|ch| {
            let code_point = ch as u32;
            (0x80..=0x9f).contains(&code_point)
        })
}

fn mojibake_score(text: &str) -> usize {
    let mut score = 0;
    for ch in text.chars() {
        score += match ch {
            '\u{00c3}' | '\u{00c2}' | '\u{00e2}' => 1,
            '\u{fffd}' => 3,
            _ => {
                let code_point = ch as u32;
                if (0x80..=0x9f).contains(&code_point) { 2 } else { 0 }
            }
        };
    }

    score += text.matches("\u{00f0}\u{0178}").count() * 2;
    score += text.matches("\u{00e3}\u{0192}").count() * 2;
    score += text.matches("\u{00e3}\u{201a}").count() * 2;
    score
}

fn windows_1252_byte_for(ch: char) -> Option<u8> {
    let code_point = ch as u32;
    if code_point <= 0xff {
        return Some(code_point as u8);
    }

    match code_point {
        0x20ac => Some(0x80),
        0x201a => Some(0x82),
        0x0192 => Some(0x83),
        0x201e => Some(0x84),
        0x2026 => Some(0x85),
        0x2020 => Some(0x86),
        0x2021 => Some(0x87),
        0x02c6 => Some(0x88),
        0x2030 => Some(0x89),
        0x0160 => Some(0x8a),
        0x2039 => Some(0x8b),
        0x0152 => Some(0x8c),
        0x017d => Some(0x8e),
        0x2018 => Some(0x91),
        0x2019 => Some(0x92),
        0x201c => Some(0x93),
        0x201d => Some(0x94),
        0x2022 => Some(0x95),
        0x2013 => Some(0x96),
        0x2014 => Some(0x97),
        0x02dc => Some(0x98),
        0x2122 => Some(0x99),
        0x0161 => Some(0x9a),
        0x203a => Some(0x9b),
        0x0153 => Some(0x9c),
        0x017e => Some(0x9e),
        0x0178 => Some(0x9f),
        _ => None,
    }
}

fn starts_mojibake_run(chars: &[char], index: usize) -> bool {
    let current = chars[index];
    let next = chars.get(index + 1).copied();

    matches!(current, '\u{00c3}' | '\u{00c2}' | '\u{00e2}' | '\u{fffd}')
        || (current == '\u{00f0}' && next == Some('\u{0178}'))
        || (current == '\u{00e3}' && matches!(next, Some('\u{0192}' | '\u{201a}')))
        || {
            let code_point = current as u32;
            (0x80..=0x9f).contains(&code_point)
        }
}

fn best_repair_at(chars: &[char], start: usize) -> Option<(usize, String)> {
    let mut bytes = Vec::new();
    let mut best: Option<(usize, String, usize)> = None;
    let max_length = (chars.len() - start).min(96);

    for length in 1..=max_length {
        let Some(byte) = windows_1252_byte_for(chars[start + length - 1]) else {
            break;
        };
        bytes.push(byte);
        if length < 2 {
            continue;
        }

        let candidate = chars[start..start + length].iter().collect::<String>();
        if !has_mojibake_evidence(&candidate) {
            continue;
        }

        let Ok(decoded) = String::from_utf8(bytes.clone()) else {
            continue;
        };
        if decoded == candidate || decoded.contains('\u{fffd}') {
            continue;
        }

        let improvement = mojibake_score(&candidate).saturating_sub(mojibake_score(&decoded));
        if improvement == 0 {
            continue;
        }

        match best.as_ref() {
            Some((best_length, _, best_improvement)) if *best_improvement > improvement || (*best_improvement == improvement && *best_length >= length) => {}
            _ => best = Some((length, decoded, improvement)),
        }
    }

    best.map(|(length, decoded, _)| (length, decoded))
}

fn repair_mojibake_pass(input: &str) -> String {
    let chars = input.chars().collect::<Vec<_>>();
    let mut output = String::with_capacity(input.len());
    let mut index = 0;

    while index < chars.len() {
        if starts_mojibake_run(&chars, index) {
            if let Some((consumed, replacement)) = best_repair_at(&chars, index) {
                output.push_str(&replacement);
                index += consumed;
                continue;
            }
        }

        output.push(chars[index]);
        index += 1;
    }

    output
}

pub fn repair_mojibake_text(input: &str) -> String {
    if !has_mojibake_evidence(input) {
        return input.to_string();
    }

    let mut current = input.to_string();
    let mut current_score = mojibake_score(&current);
    for _ in 0..3 {
        if current_score == 0 {
            break;
        }

        let next = repair_mojibake_pass(&current);
        if next == current {
            break;
        }

        let next_score = mojibake_score(&next);
        if next_score > current_score {
            break;
        }

        current = next;
        current_score = next_score;
    }

    current
}

pub fn repair_json_value(value: &mut Value) -> usize {
    match value {
        Value::String(text) => {
            let repaired = repair_mojibake_text(text);
            if repaired == *text {
                0
            } else {
                *text = repaired;
                1
            }
        }
        Value::Array(items) => items.iter_mut().map(repair_json_value).sum(),
        Value::Object(map) => map.values_mut().map(repair_json_value).sum(),
        _ => 0,
    }
}

pub fn run_persisted_text_encoding_migration(app_data_root: &Path) -> Result<TextEncodingMigrationReport, String> {
    let marker_dir = app_data_root.join(MIGRATION_MARKER_DIR);
    let marker_path = marker_dir.join(format!("{}.json", TEXT_ENCODING_MIGRATION_ID));
    let marker_path_text = marker_path.display().to_string();

    if marker_path.exists() {
        return Ok(TextEncodingMigrationReport {
            marker_path: Some(marker_path_text),
            ..TextEncodingMigrationReport::default()
        });
    }

    fs::create_dir_all(&marker_dir)
        .map_err(|err| format!("Failed to create text encoding migration marker folder: {}", err))?;

    let mut report = TextEncodingMigrationReport {
        marker_path: Some(marker_path_text),
        ..TextEncodingMigrationReport::default()
    };
    let mut files = Vec::new();
    collect_candidate_files(app_data_root, &mut files, &mut report.skipped_files)?;

    let backup_stamp = unix_timestamp();
    let mut backup_root: Option<PathBuf> = None;

    for path in files {
        report.scanned_files += 1;
        let Ok(raw) = fs::read_to_string(&path) else {
            report.skipped_files += 1;
            continue;
        };
        if !has_mojibake_evidence(&raw) {
            continue;
        }

        let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
        let (next_raw, repaired_strings) = if extension == "json" {
            let Ok(mut value) = serde_json::from_str::<Value>(&raw) else {
                report.skipped_files += 1;
                continue;
            };
            let repaired_strings = repair_json_value(&mut value);
            if repaired_strings == 0 {
                continue;
            }
            let serialized = serde_json::to_string_pretty(&value)
                .map_err(|err| format!("Failed to serialize repaired JSON {}: {}", path.display(), err))?;
            (format!("{}\n", serialized), repaired_strings)
        } else {
            let repaired = repair_mojibake_text(&raw);
            if repaired == raw {
                continue;
            }
            (repaired, 1)
        };

        if backup_root.is_none() {
            let root = app_data_root.join(MIGRATION_BACKUP_DIR).join(format!("{}-{}", TEXT_ENCODING_MIGRATION_ID, backup_stamp));
            fs::create_dir_all(&root)
                .map_err(|err| format!("Failed to create text encoding backup folder: {}", err))?;
            report.backup_root = Some(root.display().to_string());
            backup_root = Some(root);
        }

        let root = backup_root.as_ref().expect("backup root is initialized before repair writes");
        backup_original_file(app_data_root, root, &path)?;
        fs::write(&path, next_raw)
            .map_err(|err| format!("Failed to write repaired text file {}: {}", path.display(), err))?;
        report.backups_created += 1;
        report.repaired_files += 1;
        report.repaired_strings += repaired_strings;
    }

    let marker_contents = serde_json::to_string_pretty(&report)
        .map_err(|err| format!("Failed to serialize text encoding migration marker: {}", err))?;
    fs::write(&marker_path, format!("{}\n", marker_contents))
        .map_err(|err| format!("Failed to write text encoding migration marker {}: {}", marker_path.display(), err))?;

    Ok(report)
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn collect_candidate_files(root: &Path, files: &mut Vec<PathBuf>, skipped: &mut usize) -> Result<(), String> {
    if should_skip_dir(root) {
        return Ok(());
    }

    let entries = fs::read_dir(root)
        .map_err(|err| format!("Failed to read text encoding migration folder {}: {}", root.display(), err))?;

    for entry in entries {
        let Ok(entry) = entry else {
            *skipped += 1;
            continue;
        };
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            *skipped += 1;
            continue;
        };

        if metadata.is_dir() {
            if should_skip_dir(&path) {
                continue;
            }
            collect_candidate_files(&path, files, skipped)?;
        } else if metadata.is_file() {
            if metadata.len() > MAX_TEXT_FILE_BYTES {
                *skipped += 1;
                continue;
            }
            if is_candidate_text_file(&path) {
                files.push(path);
            }
        }
    }

    Ok(())
}

fn should_skip_dir(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    matches!(name, MIGRATION_BACKUP_DIR | "encoding-backups" | "node_modules" | "target")
}

fn is_candidate_text_file(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|value| value.to_str()).map(|value| value.to_ascii_lowercase()).as_deref(),
        Some("json" | "txt" | "log" | "md" | "html" | "cache")
    )
}

fn backup_original_file(app_data_root: &Path, backup_root: &Path, path: &Path) -> Result<(), String> {
    let relative = path.strip_prefix(app_data_root)
        .map_err(|err| format!("Failed to build backup path for {}: {}", path.display(), err))?;
    let backup_path = backup_root.join(relative);
    if let Some(parent) = backup_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create text encoding backup folder {}: {}", parent.display(), err))?;
    }
    fs::copy(path, &backup_path)
        .map_err(|err| format!("Failed to back up {} to {}: {}", path.display(), backup_path.display(), err))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::env;

    #[test]
    fn repairs_common_mojibake_sequences() {
        assert_eq!(repair_mojibake_text("Tsuki\u{00e2}\u{20ac}\u{2122}s"), "Tsuki\u{2019}s");
        assert_eq!(repair_mojibake_text("PAYDAY 2 \u{00e2}\u{20ac}\u{201c} Mods"), "PAYDAY 2 \u{2013} Mods");
        assert_eq!(repair_mojibake_text("Pok\u{00c3}\u{00a9}mon"), "Pok\u{00e9}mon");
        assert_eq!(repair_mojibake_text("\u{00e3}\u{0192}\u{201e}\u{00e3}\u{201a}\u{00ad}"), "\u{30c4}\u{30ad}");
        assert_eq!(repair_mojibake_text("\u{00f0}\u{0178}\u{2018}\u{0081}"), "\u{1f441}");
    }

    #[test]
    fn repairs_double_encoded_text_in_multiple_passes() {
        assert_eq!(repair_mojibake_text("Pok\u{00c3}\u{0192}\u{00c2}\u{00a9}mon"), "Pok\u{00e9}mon");
    }

    #[test]
    fn preserves_valid_unicode_and_entities() {
        let healthy = "\u{d55c}\u{ad6d}\u{c5b4} \u{30c4}\u{30ad} \u{1f600} Fish &amp; Chips \u{00c2}ngela";
        assert_eq!(repair_mojibake_text(healthy), healthy);
    }

    #[test]
    fn repairs_json_strings_recursively() {
        let mut value = json!({
            "name": "Tsuki\u{00e2}\u{20ac}\u{2122}s Mod",
            "tags": ["PAYDAY 2 \u{00e2}\u{20ac}\u{201c} Mods", "\u{30c4}\u{30ad}"],
            "html": "Fish &amp; Chips"
        });
        assert_eq!(repair_json_value(&mut value), 2);
        assert_eq!(value["name"], "Tsuki\u{2019}s Mod");
        assert_eq!(value["tags"][0], "PAYDAY 2 \u{2013} Mods");
        assert_eq!(value["tags"][1], "\u{30c4}\u{30ad}");
        assert_eq!(value["html"], "Fish &amp; Chips");
    }

    #[test]
    fn migration_backs_up_repairs_and_marks_once() {
        let root = env::temp_dir().join(format!("tsuki-text-encoding-test-{}", unix_timestamp()));
        fs::create_dir_all(root.join("receipts")).unwrap();
        let receipt = root.join("receipts").join("one.json");
        let original = json!({ "title": "Tsuki\u{00e2}\u{20ac}\u{2122}s Mod" });
        fs::write(&receipt, serde_json::to_string_pretty(&original).unwrap()).unwrap();

        let report = run_persisted_text_encoding_migration(&root).unwrap();
        assert_eq!(report.scanned_files, 1);
        assert_eq!(report.repaired_files, 1);
        assert_eq!(report.backups_created, 1);
        assert_eq!(report.repaired_strings, 1);
        assert!(report.backup_root.as_deref().is_some_and(|path| Path::new(path).exists()));
        assert!(root.join(MIGRATION_MARKER_DIR).join(format!("{}.json", TEXT_ENCODING_MIGRATION_ID)).exists());

        let repaired = fs::read_to_string(&receipt).unwrap();
        assert!(repaired.contains("Tsuki\\u2019s") || repaired.contains("Tsuki\u{2019}s"));

        let second_report = run_persisted_text_encoding_migration(&root).unwrap();
        assert_eq!(second_report.scanned_files, 0);
        assert_eq!(second_report.repaired_files, 0);

        let _ = fs::remove_dir_all(root);
    }
}