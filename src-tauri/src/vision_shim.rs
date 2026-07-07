//! 视觉协议 shim：对内暴露 OpenAI Chat Completions 端点（CodeWhale 的 image_analyze
//! 工具只会调 `{base_url}/chat/completions`），对外翻译成 tabcode 的 Responses API。
//!
//! 数据流：engine image_analyze → POST http://127.0.0.1:8788/chat/completions
//!   → 本 shim 翻译 messages→input、image_url→input_image → POST tabcode /openai/responses
//!   → 把 responses 的 output_text 包回 chat/completions 的 choices[0].message.content。
//!
//! key 不落在本进程：engine 把 [vision_model].api_key 作为 Bearer 传进来，shim 原样转发。

use axum::{
    extract::{DefaultBodyLimit, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde_json::{json, Value};
use std::net::SocketAddr;

pub const SHIM_PORT: u16 = 8788;
const TABCODE_RESPONSES_URL: &str = "https://api2.tabcode.cc/openai/responses";

#[derive(Clone)]
struct ShimState {
    client: reqwest::Client,
}

pub fn router() -> Router {
    let state = ShimState {
        client: reqwest::Client::new(),
    };
    Router::new()
        .route("/chat/completions", post(handle))
        // 真实照片 base64 常达数 MB，放宽到 20MB（默认 2MB 会拦）
        .layer(DefaultBodyLimit::max(20 * 1024 * 1024))
        .with_state(state)
}

pub fn spawn() {
    tauri::async_runtime::spawn(async {
        let addr = SocketAddr::from(([127, 0, 0, 1], SHIM_PORT));
        match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => {
                let _ = axum::serve(listener, router()).await;
            }
            Err(e) => eprintln!("vision shim 无法绑定 {SHIM_PORT}: {e}"),
        }
    });
}

/// chat/completions.messages → responses.input
fn messages_to_input(messages: &Value) -> Value {
    let mut input = Vec::new();
    for m in messages.as_array().into_iter().flatten() {
        let role = m.get("role").and_then(Value::as_str).unwrap_or("user");
        let content = m.get("content");
        let parts = match content {
            // 字符串内容 → 单个 input_text
            Some(Value::String(s)) => vec![json!({"type": "input_text", "text": s})],
            // 数组内容 → 逐个映射
            Some(Value::Array(arr)) => arr
                .iter()
                .filter_map(|p| match p.get("type").and_then(Value::as_str) {
                    Some("text") => Some(json!({
                        "type": "input_text",
                        "text": p.get("text").and_then(Value::as_str).unwrap_or("")
                    })),
                    Some("image_url") => {
                        let url = p
                            .get("image_url")
                            .and_then(|iu| iu.get("url"))
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        Some(json!({"type": "input_image", "image_url": url}))
                    }
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        };
        input.push(json!({"role": role, "content": parts}));
    }
    Value::Array(input)
}

/// responses.output[].content[].output_text → 合并文本
fn extract_output_text(resp: &Value) -> String {
    if let Some(s) = resp.get("output_text").and_then(Value::as_str) {
        if !s.is_empty() {
            return s.to_string();
        }
    }
    let mut out = String::new();
    for item in resp.get("output").and_then(Value::as_array).into_iter().flatten() {
        if item.get("type").and_then(Value::as_str) == Some("message") {
            for c in item.get("content").and_then(Value::as_array).into_iter().flatten() {
                if let Some(t) = c.get("text").and_then(Value::as_str) {
                    out.push_str(t);
                }
            }
        }
    }
    out
}

async fn handle(
    State(state): State<ShimState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let model = body.get("model").and_then(Value::as_str).unwrap_or("gpt-5.4");
    let max_tokens = body
        .get("max_tokens")
        .or_else(|| body.get("max_completion_tokens"))
        .and_then(Value::as_u64);

    let mut req = json!({
        "model": model,
        "input": messages_to_input(body.get("messages").unwrap_or(&Value::Null)),
    });
    if let Some(mt) = max_tokens {
        req["max_output_tokens"] = json!(mt);
    }

    // engine 传进来的 Bearer（= [vision_model].api_key，即 tabcode key）原样转发
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let body_bytes = match serde_json::to_vec(&req) {
        Ok(b) => b,
        Err(e) => {
            return Json(json!({"error": {"message": format!("shim encode error: {e}")}}))
                .into_response()
        }
    };
    let upstream = state
        .client
        .post(TABCODE_RESPONSES_URL)
        .header("Authorization", auth)
        .header("Content-Type", "application/json")
        .body(body_bytes)
        .send()
        .await;

    let resp = match upstream {
        Ok(r) => r,
        Err(e) => {
            return Json(json!({"error": {"message": format!("shim upstream error: {e}")}}))
                .into_response()
        }
    };
    let text = match resp.text().await {
        Ok(t) => t,
        Err(e) => {
            return Json(json!({"error": {"message": format!("shim read error: {e}")}}))
                .into_response()
        }
    };
    let resp_json: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            return Json(json!({"error": {"message": format!("shim parse error: {e}: {text}")}}))
                .into_response()
        }
    };

    let analysis = extract_output_text(&resp_json);
    // 包回 chat/completions 形状，供 image_analyze 解析
    Json(json!({
        "model": model,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": analysis},
            "finish_reason": "stop"
        }]
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_chat_content_to_responses_input() {
        let messages = json!([{
            "role": "user",
            "content": [
                {"type": "text", "text": "什么图"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAA"}}
            ]
        }]);
        let input = messages_to_input(&messages);
        let parts = input[0]["content"].as_array().unwrap();
        assert_eq!(parts[0]["type"], "input_text");
        assert_eq!(parts[1]["type"], "input_image");
        assert_eq!(parts[1]["image_url"], "data:image/png;base64,AAA");
    }

    #[test]
    fn extracts_output_text_from_responses() {
        let resp = json!({
            "output": [{"type": "message", "content": [{"type": "output_text", "text": "一只猫"}]}]
        });
        assert_eq!(extract_output_text(&resp), "一只猫");
    }

    // 打真 tabcode 的端到端测试：cargo test --ignored real_round_trip
    #[tokio::test]
    #[ignore]
    async fn real_round_trip() {
        use std::net::SocketAddr;
        let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, router()).await.unwrap();
        });
        let key = std::env::var("TABCODE_KEY").expect("set TABCODE_KEY");
        let img = std::env::var("TEST_IMG_B64").expect("set TEST_IMG_B64");
        let body = json!({
            "model": "gpt-5.4",
            "messages": [{"role":"user","content":[
                {"type":"text","text":"一句话中文，这是什么"},
                {"type":"image_url","image_url":{"url": format!("data:image/png;base64,{img}")}}
            ]}],
            "max_tokens": 200
        });
        let raw = reqwest::Client::new()
            .post(format!("http://{addr}/chat/completions"))
            .header("Authorization", format!("Bearer {key}"))
            .header("Content-Type", "application/json")
            .body(serde_json::to_vec(&body).unwrap())
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        let resp: Value = serde_json::from_str(&raw).unwrap();
        let content = resp["choices"][0]["message"]["content"].as_str().unwrap();
        println!("SHIM RESULT: {content}");
        assert!(!content.is_empty(), "shim 返回空内容");
    }
}
