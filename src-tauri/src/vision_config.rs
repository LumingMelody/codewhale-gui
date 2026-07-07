//! 把视觉模型配置合并进 ~/.codewhale/config.toml，指向本机 shim。
//! 用 toml_edit 增量修改，保留用户已有的 deepseek 等配置不动。

use crate::sidecar::RuntimeInfo;
use crate::vision_shim::SHIM_PORT;
use tauri::{AppHandle, Manager};
use toml_edit::{value, DocumentMut, Item, Table};

fn config_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    // 尊重 CODEWHALE_HOME，否则 ~/.codewhale
    if let Ok(home) = std::env::var("CODEWHALE_HOME") {
        return Ok(std::path::PathBuf::from(home).join("config.toml"));
    }
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    Ok(home.join(".codewhale").join("config.toml"))
}

fn load_doc(path: &std::path::Path) -> Result<DocumentMut, String> {
    if path.exists() {
        std::fs::read_to_string(path)
            .map_err(|e| e.to_string())?
            .parse::<DocumentMut>()
            .map_err(|e| format!("config.toml 解析失败: {e}"))
    } else {
        Ok(DocumentMut::new())
    }
}

/// 视觉模型是否已配置（api_key 非空）。
#[tauri::command]
pub fn vision_status(app: AppHandle) -> Result<bool, String> {
    let path = config_path(&app)?;
    if !path.exists() {
        return Ok(false);
    }
    let doc = load_doc(&path)?;
    let has_key = doc
        .get("vision_model")
        .and_then(|v| v.get("api_key"))
        .and_then(|k| k.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    Ok(has_key)
}

/// 写入/更新视觉模型配置并重启引擎使其生效。空 key 视为清除。
/// 返回重启后的新 RuntimeInfo（port/token 会变，前端必须更新）。
#[tauri::command]
pub async fn set_vision_key(app: AppHandle, key: String) -> Result<RuntimeInfo, String> {
    let path = config_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut doc = load_doc(&path)?;
    let key = key.trim().to_string();

    // [features] vision_model = <bool>
    if !doc.contains_key("features") {
        doc["features"] = Item::Table(Table::new());
    }
    doc["features"]["vision_model"] = value(!key.is_empty());

    // [vision_model] model/api_key/base_url —— base_url 指向本机 shim
    if !doc.contains_key("vision_model") {
        doc["vision_model"] = Item::Table(Table::new());
    }
    doc["vision_model"]["model"] = value("gpt-5.4");
    doc["vision_model"]["api_key"] = value(key);
    doc["vision_model"]["base_url"] = value(format!("http://127.0.0.1:{SHIM_PORT}"));

    std::fs::write(&path, doc.to_string()).map_err(|e| format!("写入 config.toml 失败: {e}"))?;

    // 引擎在启动时读取 vision 配置，必须重启才生效
    crate::sidecar::shutdown(&app);
    crate::sidecar::start(app.clone()).await
}
