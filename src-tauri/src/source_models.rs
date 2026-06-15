#![allow(dead_code)]

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFileItem {
    pub id: String,
    pub name: String,
    pub version: Option<String>,
    pub size_label: Option<String>,
    pub download_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceImageItem {
    pub id: String,
    pub title: Option<String>,
    pub image_url: String,
    pub thumbnail_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatItem {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceModSummary {
    pub source: String,
    pub source_id: String,
    pub name: String,
    pub author: Option<String>,
    pub version: Option<String>,
    pub thumbnail_url: Option<String>,
    pub banner_url: Option<String>,
    pub page_url: Option<String>,
    pub updated_at: Option<String>,
    pub downloads: Option<u64>,
    pub likes: Option<u64>,
    pub short_description: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceModDetail {
    pub source: String,
    pub source_id: String,
    pub name: String,
    pub author: Option<String>,
    pub version: Option<String>,
    pub thumbnail_url: Option<String>,
    pub banner_url: Option<String>,
    pub page_url: Option<String>,
    pub updated_at: Option<String>,
    pub downloads: Option<u64>,
    pub likes: Option<u64>,
    pub short_description: Option<String>,
    pub tags: Vec<String>,
    pub description: String,
    pub changelog: Option<String>,
    pub files: Vec<SourceFileItem>,
    pub images: Vec<SourceImageItem>,
    pub comments: Vec<String>,
    pub bugs: Vec<String>,
    pub logs: Vec<String>,
    pub stats: Vec<SourceStatItem>,
}
