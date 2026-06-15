#![allow(dead_code)]

use serde_json::Value;

pub fn get_json(url: &str, api_key: Option<&str>) -> Result<Value, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("TsukiModManager/0.16")
        .build()
        .map_err(|err| format!("Failed to create HTTP client: {}", err))?;

    let mut request = client.get(url);

    if let Some(key) = api_key {
        request = request.header("apikey", key);
    }

    let response = request
        .send()
        .map_err(|err| format!("Request failed for {}: {}", url, err))?;

    let status = response.status();
    let text = response
        .text()
        .map_err(|err| format!("Failed to read response body: {}", err))?;

    if !status.is_success() {
        return Err(format!(
            "{} returned HTTP {}: {}",
            url,
            status,
            text.chars().take(240).collect::<String>()
        ));
    }

    serde_json::from_str(&text)
        .map_err(|err| format!("Failed to parse JSON from {}: {}", url, err))
}

pub fn get_text(url: &str) -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("TsukiModManager/0.16")
        .build()
        .map_err(|err| format!("Failed to create HTTP client: {}", err))?;

    let response = client
        .get(url)
        .send()
        .map_err(|err| format!("Request failed for {}: {}", url, err))?;

    let status = response.status();
    let text = response
        .text()
        .map_err(|err| format!("Failed to read response body: {}", err))?;

    if !status.is_success() {
        return Err(format!("{} returned HTTP {}", url, status));
    }

    Ok(text)
}

pub fn html_to_text(input: &str) -> String {
    let mut output = String::new();
    let mut in_tag = false;

    for ch in input.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                output.push(' ');
            }
            _ if !in_tag => output.push(ch),
            _ => {}
        }
    }

    output
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
