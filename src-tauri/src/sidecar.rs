use serde::Serialize;
use std::net::TcpListener;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[derive(Clone, Serialize)]
pub struct RuntimeInfo {
    pub base_url: String,
    pub token: String,
    pub port: u16,
}

#[derive(Default)]
pub struct SidecarState {
    pub info: Mutex<Option<RuntimeInfo>>,
    pub child: Mutex<Option<CommandChild>>,
    pub shutting_down: Mutex<bool>,
    /// spawn 后立即记录（info 要等健康检查后才有），shutdown 兜底清树用
    pub token: Mutex<Option<String>>,
}

/// 优先 preferred，被占则取 OS 随机空闲端口。
pub fn pick_port(preferred: u16) -> u16 {
    if let Ok(l) = TcpListener::bind(("127.0.0.1", preferred)) {
        drop(l);
        return preferred;
    }
    TcpListener::bind(("127.0.0.1", 0))
        .expect("bind ephemeral port")
        .local_addr()
        .expect("read local addr")
        .port()
}

pub async fn start(app: AppHandle) -> Result<RuntimeInfo, String> {
    let port = pick_port(7878);
    let token = uuid::Uuid::new_v4().to_string();
    let base_url = format!("http://127.0.0.1:{port}");

    let (mut rx, child) = app
        .shell()
        .sidecar("codewhale")
        .map_err(|e| format!("sidecar 解析失败: {e}"))?
        .args([
            "app-server",
            "--http",
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "--auth-token",
            &token,
        ])
        .spawn()
        .map_err(|e| format!("sidecar 启动失败: {e}"))?;

    {
        let state = app.state::<SidecarState>();
        *state.shutting_down.lock().unwrap() = false;
        *state.child.lock().unwrap() = Some(child);
        *state.token.lock().unwrap() = Some(token.clone());
    }

    // 崩溃监视：sidecar 进程退出且非主动关闭时通知前端
    let watcher = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            if let CommandEvent::Terminated(payload) = event {
                let state = watcher.state::<SidecarState>();
                let intentional = *state.shutting_down.lock().unwrap();
                state.info.lock().unwrap().take();
                if !intentional {
                    let _ = watcher.emit(
                        "sidecar-crashed",
                        format!("engine 进程退出, code={:?}", payload.code),
                    );
                }
                break;
            }
        }
    });

    wait_healthy(&base_url).await?;

    let info = RuntimeInfo { base_url, token, port };
    let state = app.state::<SidecarState>();
    *state.info.lock().unwrap() = Some(info.clone());
    Ok(info)
}

async fn wait_healthy(base_url: &str) -> Result<(), String> {
    let client = reqwest::Client::new();
    for _ in 0..30 {
        if let Ok(resp) = client.get(format!("{base_url}/health")).send().await {
            if resp.status().is_success() {
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err("engine 未在 15 秒内就绪".to_string())
}

pub fn shutdown(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    *state.shutting_down.lock().unwrap() = true;
    let child = state.child.lock().unwrap().take();
    if let Some(child) = child {
        let _ = child.kill();
    }
    // codewhale 是 dispatcher, 会再 spawn codewhale-tui 孙进程; child.kill 只杀
    // dispatcher。用本次运行唯一的 auth-token 作选择器兜底清掉整棵树 (macOS)。
    let token = state.token.lock().unwrap().take();
    if let Some(token) = token {
        let _ = std::process::Command::new("pkill")
            .args(["-f", &token])
            .status();
    }
}

#[tauri::command]
pub fn get_runtime_info(state: State<'_, SidecarState>) -> Option<RuntimeInfo> {
    state.info.lock().unwrap().clone()
}

#[tauri::command]
pub async fn restart_sidecar(app: AppHandle) -> Result<RuntimeInfo, String> {
    shutdown(&app);
    start(app.clone()).await
}

#[tauri::command]
pub async fn run_doctor(app: AppHandle) -> Result<serde_json::Value, String> {
    let output = app
        .shell()
        .sidecar("codewhale")
        .map_err(|e| e.to_string())?
        .args(["doctor", "--json"])
        .output()
        .await
        .map_err(|e| format!("doctor 执行失败: {e}"))?;
    serde_json::from_slice(&output.stdout).map_err(|e| format!("doctor 输出解析失败: {e}"))
}

/// dev 下 Tauri 把 sidecar 复制到主程序同目录（无 triple 后缀），bundle 下在
/// Contents/MacOS/ 同目录 —— 两种情况都是 current_exe 的兄弟文件。
fn engine_cli_path() -> Result<std::path::PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("exe 无父目录")?;
    Ok(dir.join("codewhale"))
}

#[tauri::command]
pub async fn set_api_key(api_key: String) -> Result<(), String> {
    // key 经 stdin 传递（--api-key-stdin），不进程序参数也不进日志
    let path = engine_cli_path()?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let mut child = Command::new(&path)
            .args(["auth", "set", "--provider", "deepseek", "--api-key-stdin"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("auth set 启动失败: {e}"))?;
        child
            .stdin
            .take()
            .ok_or("stdin 不可用")?
            .write_all(api_key.as_bytes())
            .map_err(|e| format!("写入 key 失败: {e}"))?;
        // stdin 句柄随语句结束 drop → EOF
        let out = child
            .wait_with_output()
            .map_err(|e| format!("auth set 等待失败: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn pick_port_prefers_free_preferred() {
        // 找一个当前空闲的端口作为 preferred
        let probe = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let free = probe.local_addr().unwrap().port();
        drop(probe);
        assert_eq!(pick_port(free), free);
    }

    #[test]
    fn pick_port_falls_back_when_occupied() {
        let holder = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let occupied = holder.local_addr().unwrap().port();
        let picked = pick_port(occupied); // holder 仍持有
        assert_ne!(picked, occupied);
        assert_ne!(picked, 0);
    }
}
