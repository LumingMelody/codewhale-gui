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
        // Windows WebView2 的页面 origin 是 http(s)://tauri.localhost, 不在引擎
        // 内置 CORS 白名单里(macOS 的 tauri://localhost 在); 此变量叠加不替换
        .env(
            "DEEPSEEK_CORS_ORIGINS",
            "http://tauri.localhost,https://tauri.localhost",
        )
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
        // Windows: taskkill /T 按进程树连孙进程一起杀, 必须在 kill 之前跑
        // (dispatcher 死后树关系就断了, /T 找不到 codewhale-tui 孙进程)
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("taskkill")
                .args(["/F", "/T", "/PID", &child.pid().to_string()])
                .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
                .status();
        }
        let _ = child.kill();
    }
    // codewhale 是 dispatcher, 会再 spawn codewhale-tui 孙进程; child.kill 只杀
    // dispatcher。Unix 用本次运行唯一的 auth-token 作选择器兜底清掉整棵树。
    let token = state.token.lock().unwrap().take();
    #[cfg(unix)]
    if let Some(token) = &token {
        let _ = std::process::Command::new("pkill")
            .args(["-f", token])
            .status();
    }
    #[cfg(not(unix))]
    drop(token);
}

#[tauri::command]
pub fn get_runtime_info(state: State<'_, SidecarState>) -> Option<RuntimeInfo> {
    state.info.lock().unwrap().clone()
}

/// Chat 模式的固定 scratch 工作区 ~/EverPretty（首次调用时创建）。
/// 引擎每个 thread 都要一个 cwd；chat 用这个统一目录，不打扰用户选目录。
#[tauri::command]
pub fn ensure_chat_workspace(app: AppHandle) -> Result<String, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let dir = home.join("EverPretty");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 chat 工作区失败: {e}"))?;
    dir.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "chat 工作区路径非 UTF-8".to_string())
}

/// 把粘贴/拖入的图片字节写进 <workspace>/.everpretty-attachments/，返回**工作区内相对
/// 路径**——引擎的 image_analyze 工具只接受工作区内相对路径（禁止逃逸）。
#[tauri::command]
pub fn save_attachment(workspace: String, filename: String, bytes: Vec<u8>) -> Result<String, String> {
    // 防目录穿越：只取纯文件名
    let name = std::path::Path::new(&filename)
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "非法文件名".to_string())?;
    let rel_dir = ".everpretty-attachments";
    let dir = std::path::Path::new(&workspace).join(rel_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建附件目录失败: {e}"))?;
    std::fs::write(dir.join(name), &bytes).map_err(|e| format!("写入附件失败: {e}"))?;
    Ok(format!("{rel_dir}/{name}"))
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
