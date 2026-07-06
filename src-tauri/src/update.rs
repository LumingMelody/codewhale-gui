use serde::Serialize;
use std::time::Duration;

#[derive(Clone, Serialize)]
pub struct LatestRelease {
    pub tag: String,
    pub url: String,
}

/// 查 GitHub 最新 Release。版本比较在前端做（可单测）；
/// 网络失败/限流由前端静默处理，不打扰用户。
#[tauri::command]
pub async fn check_latest_release() -> Result<LatestRelease, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get("https://api.github.com/repos/LumingMelody/codewhale-gui/releases/latest")
        // GitHub API 无 UA 会 403
        .header("User-Agent", "codewhale-gui")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("github api {}", resp.status()));
    }
    // reqwest 未开 json feature（default-features=false），走 text + serde_json
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let body: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let tag = body["tag_name"]
        .as_str()
        .ok_or("tag_name missing")?
        .to_string();
    let url = body["html_url"]
        .as_str()
        .ok_or("html_url missing")?
        .to_string();
    Ok(LatestRelease { tag, url })
}
