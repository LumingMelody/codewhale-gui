use serde::Serialize;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const ATTACHMENTS_DIR: &str = ".everpretty-attachments";
const IMPORT_ATTACHMENT_LIMIT: u64 = 256 * 1024 * 1024;
const SAVE_ATTACHMENT_LIMIT: usize = 25 * 1024 * 1024;
const PREVIEW_ATTACHMENT_LIMIT: u64 = 10 * 1024 * 1024;
const WORKSPACE_SCAN_FILE_LIMIT: usize = 20_000;
const WORKSPACE_SCAN_ENTRY_LIMIT: usize = 100_000;

#[derive(Clone, Serialize)]
pub struct RuntimeInfo {
    pub base_url: String,
    pub token: String,
    pub port: u16,
}

#[derive(Clone, Debug, Serialize)]
pub struct AttachmentInfo {
    pub rel: String,
    pub name: String,
    pub size: u64,
    pub kind: String,
    pub mime: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AttachmentPreview {
    pub bytes: Vec<u8>,
    pub mime: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct WorkspaceFileInfo {
    pub rel: String,
    pub name: String,
    pub path: String,
    pub directory: String,
    pub size: u64,
    pub modified_ms: u128,
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

    let info = RuntimeInfo {
        base_url,
        token,
        port,
    };
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

/// 把 picker/原生拖放拿到的文件复制进 <workspace>/.everpretty-attachments/，
/// 返回**工作区内相对路径**和元数据（禁止目标路径逃逸）。
#[tauri::command]
pub async fn import_attachment(workspace: String, path: String) -> Result<AttachmentInfo, String> {
    tauri::async_runtime::spawn_blocking(move || import_attachment_sync(&workspace, &path))
        .await
        .map_err(|e| e.to_string())?
}

/// 把剪贴板图片/小文件字节写进 <workspace>/.everpretty-attachments/。
/// 路径导入优先；bytes 通道只承载小附件，避免 IPC 内存峰值过高。
#[tauri::command]
pub async fn save_attachment(
    workspace: String,
    filename: String,
    bytes: Vec<u8>,
) -> Result<AttachmentInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_attachment_bytes_sync(&workspace, &filename, &bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 受限读取附件缩略图：只允许读取附件目录下的小图片，不开放通用文件读取。
#[tauri::command]
pub async fn read_attachment_preview(
    workspace: String,
    rel: String,
) -> Result<AttachmentPreview, String> {
    tauri::async_runtime::spawn_blocking(move || read_attachment_preview_sync(&workspace, &rel))
        .await
        .map_err(|e| e.to_string())?
}

/// 返回工作区内可用于产物 diff 的普通文件快照。跳过依赖、VCS、构建缓存、隐藏目录和符号链接，
/// 防止扫描逃逸工作区或在大型仓库中无限遍历。
#[tauri::command]
pub async fn list_workspace_files(workspace: String) -> Result<Vec<WorkspaceFileInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || list_workspace_files_sync(&workspace))
        .await
        .map_err(|e| e.to_string())?
}

fn list_workspace_files_sync(workspace: &str) -> Result<Vec<WorkspaceFileInfo>, String> {
    use std::time::UNIX_EPOCH;

    let root = Path::new(workspace)
        .canonicalize()
        .map_err(|e| format!("工作区路径无效: {e}"))?;
    if !root.is_dir() {
        return Err("工作区不是目录".to_string());
    }

    let mut pending = vec![root.clone()];
    let mut files = Vec::new();
    let mut visited_entries = 0usize;
    'walk: while let Some(dir) = pending.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            visited_entries += 1;
            if files.len() >= WORKSPACE_SCAN_FILE_LIMIT
                || visited_entries >= WORKSPACE_SCAN_ENTRY_LIMIT
            {
                break 'walk;
            }
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };
            if file_type.is_symlink() {
                continue;
            }
            let name = entry.file_name();
            let name_lossy = name.to_string_lossy();
            if file_type.is_dir() {
                if should_skip_workspace_dir(&name_lossy) {
                    continue;
                }
                pending.push(entry.path());
                continue;
            }
            if !file_type.is_file() || name_lossy.starts_with('.') {
                continue;
            }
            let path = entry.path();
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            let rel = match path.strip_prefix(&root).ok().and_then(Path::to_str) {
                Some(rel) => rel.to_string(),
                None => continue,
            };
            let directory = path
                .parent()
                .and_then(Path::to_str)
                .unwrap_or(workspace)
                .to_string();
            let modified_ms = metadata
                .modified()
                .ok()
                .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis())
                .unwrap_or(0);
            files.push(WorkspaceFileInfo {
                rel,
                name: name_lossy.into_owned(),
                path: path.to_string_lossy().into_owned(),
                directory,
                size: metadata.len(),
                modified_ms,
            });
        }
    }
    Ok(files)
}

fn should_skip_workspace_dir(name: &str) -> bool {
    name.starts_with('.')
        || matches!(
            name,
            "node_modules"
                | "target"
                | "dist"
                | "build"
                | "out"
                | "coverage"
                | "__pycache__"
                | "venv"
        )
}

fn import_attachment_sync(workspace: &str, source: &str) -> Result<AttachmentInfo, String> {
    let source_path = PathBuf::from(source);
    let metadata = source_path
        .metadata()
        .map_err(|e| format!("读取附件信息失败: {e}"))?;
    if !metadata.is_file() {
        return Err("只能添加普通文件，目录或特殊文件暂不支持".to_string());
    }
    if metadata.len() > IMPORT_ATTACHMENT_LIMIT {
        return Err("单个附件不能超过 256 MiB".to_string());
    }
    let raw_name = source_path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "非法文件名".to_string())?;
    let name = sanitize_filename(raw_name);
    let dir = attachment_dir(workspace)?;
    let (mut dst, final_name) = create_unique_file(&dir, &name)?;
    let copy_result = File::open(&source_path)
        .and_then(|mut src| std::io::copy(&mut src, &mut dst))
        .and_then(|_| dst.flush());
    if let Err(e) = copy_result {
        let _ = fs::remove_file(dir.join(&final_name));
        return Err(format!("复制附件失败: {e}"));
    }
    Ok(attachment_info(final_name, metadata.len()))
}

fn save_attachment_bytes_sync(
    workspace: &str,
    filename: &str,
    bytes: &[u8],
) -> Result<AttachmentInfo, String> {
    if bytes.len() > SAVE_ATTACHMENT_LIMIT {
        return Err("剪贴板附件不能超过 25 MiB，请改用附件按钮或拖入文件".to_string());
    }
    ensure_plain_filename(filename)?;
    let name = sanitize_filename(filename);
    let dir = attachment_dir(workspace)?;
    let (mut file, final_name) = create_unique_file(&dir, &name)?;
    if let Err(e) = file.write_all(bytes).and_then(|_| file.flush()) {
        let _ = fs::remove_file(dir.join(&final_name));
        return Err(format!("写入附件失败: {e}"));
    }
    Ok(attachment_info(final_name, bytes.len() as u64))
}

fn read_attachment_preview_sync(workspace: &str, rel: &str) -> Result<AttachmentPreview, String> {
    let path = resolve_attachment_rel(workspace, rel)?;
    let metadata = path
        .metadata()
        .map_err(|e| format!("读取附件信息失败: {e}"))?;
    if !metadata.is_file() {
        return Err("只能预览普通文件".to_string());
    }
    if metadata.len() > PREVIEW_ATTACHMENT_LIMIT {
        return Err("图片超过 10 MiB，已改用文件图标显示".to_string());
    }
    if !is_image_name(&path.to_string_lossy()) {
        return Err("该附件不是可预览图片".to_string());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(&path)
        .and_then(|mut f| f.read_to_end(&mut bytes))
        .map_err(|e| format!("读取预览失败: {e}"))?;
    Ok(AttachmentPreview {
        bytes,
        mime: mime_for_name(&path.to_string_lossy())
            .unwrap_or("application/octet-stream")
            .to_string(),
    })
}

fn attachment_dir(workspace: &str) -> Result<PathBuf, String> {
    let workspace = Path::new(workspace)
        .canonicalize()
        .map_err(|e| format!("工作区路径无效: {e}"))?;
    let dir = workspace.join(ATTACHMENTS_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("创建附件目录失败: {e}"))?;
    let dir = dir
        .canonicalize()
        .map_err(|e| format!("附件目录路径无效: {e}"))?;
    if !dir.starts_with(&workspace) {
        return Err("附件目录不能位于工作区外".to_string());
    }
    Ok(dir)
}

fn resolve_attachment_rel(workspace: &str, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    let mut components = rel_path.components();
    match components.next() {
        Some(Component::Normal(part)) if part == ATTACHMENTS_DIR => {}
        _ => return Err("预览路径必须位于附件目录下".to_string()),
    }
    for component in components {
        match component {
            Component::Normal(_) => {}
            _ => return Err("附件路径不能包含目录穿越".to_string()),
        }
    }

    let workspace = Path::new(workspace)
        .canonicalize()
        .map_err(|e| format!("工作区路径无效: {e}"))?;
    let dir = attachment_dir(workspace.to_string_lossy().as_ref())?;
    let path = workspace.join(rel_path);
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("附件路径无效: {e}"))?;
    if !canonical.starts_with(&dir) {
        return Err("附件路径不能逃逸附件目录".to_string());
    }
    Ok(canonical)
}

fn ensure_plain_filename(filename: &str) -> Result<(), String> {
    if filename.trim().is_empty() {
        return Err("非法文件名".to_string());
    }
    if filename.contains('/') || filename.contains('\\') {
        return Err("文件名不能包含路径分隔符".to_string());
    }
    let path = Path::new(filename);
    let mut components = path.components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(_)), None) => Ok(()),
        _ => Err("文件名不能包含目录穿越".to_string()),
    }
}

fn sanitize_filename(filename: &str) -> String {
    let mut cleaned = String::with_capacity(filename.len());
    for ch in filename.chars() {
        if ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
            cleaned.push('_');
        } else {
            cleaned.push(ch);
        }
    }
    let cleaned = cleaned.trim().trim_end_matches(['.', ' ']).to_string();
    let cleaned = if cleaned.is_empty() {
        "attachment".to_string()
    } else {
        cleaned
    };
    let (stem, ext) = split_name_ext(&cleaned);
    let stem = stem.trim_end_matches(['.', ' ']);
    let stem = if stem.trim_matches(['.', ' ', '_']).is_empty() {
        "attachment"
    } else {
        stem
    };
    let ext = if ext
        .strip_prefix('.')
        .is_some_and(|s| s.chars().any(char::is_alphanumeric))
    {
        ext
    } else {
        ""
    };
    let reserved = is_windows_reserved_name(stem);
    let stem = if reserved {
        format!("_{stem}")
    } else {
        stem.to_string()
    };
    format!("{stem}{ext}")
}

fn create_unique_file(dir: &Path, name: &str) -> Result<(File, String), String> {
    let (stem, ext) = split_name_ext(name);
    for index in 0..10_000 {
        let candidate = if index == 0 {
            name.to_string()
        } else {
            format!("{stem}-{index}{ext}")
        };
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(dir.join(&candidate))
        {
            Ok(file) => return Ok((file, candidate)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("创建附件失败: {e}")),
        }
    }
    Err("附件重名过多，无法创建唯一文件名".to_string())
}

fn attachment_info(name: String, size: u64) -> AttachmentInfo {
    let kind = if is_image_name(&name) {
        "image"
    } else {
        "file"
    };
    AttachmentInfo {
        rel: format!("{ATTACHMENTS_DIR}/{name}"),
        mime: mime_for_name(&name).map(str::to_string),
        name,
        size,
        kind: kind.to_string(),
    }
}

fn split_name_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(0) | None => (name, ""),
        Some(i) if i + 1 == name.len() => (&name[..i], ""),
        Some(i) => (&name[..i], &name[i..]),
    }
}

fn is_windows_reserved_name(stem: &str) -> bool {
    let upper = stem.trim_end_matches(['.', ' ']).to_ascii_uppercase();
    matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || upper
            .strip_prefix("COM")
            .and_then(|s| s.parse::<u8>().ok())
            .is_some_and(|n| (1..=9).contains(&n))
        || upper
            .strip_prefix("LPT")
            .and_then(|s| s.parse::<u8>().ok())
            .is_some_and(|n| (1..=9).contains(&n))
}

fn is_image_name(name: &str) -> bool {
    matches!(
        Path::new(name)
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase())
            .as_deref(),
        Some("png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "tiff")
    )
}

fn mime_for_name(name: &str) -> Option<&'static str> {
    match Path::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => Some("image/png"),
        Some("jpg" | "jpeg") => Some("image/jpeg"),
        Some("webp") => Some("image/webp"),
        Some("gif") => Some("image/gif"),
        Some("bmp") => Some("image/bmp"),
        Some("tiff") => Some("image/tiff"),
        Some("txt") => Some("text/plain"),
        Some("json") => Some("application/json"),
        Some("pdf") => Some("application/pdf"),
        Some("csv") => Some("text/csv"),
        Some("md") => Some("text/markdown"),
        _ => None,
    }
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
    use std::time::{SystemTime, UNIX_EPOCH};

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

    #[test]
    fn attachment_filename_sanitizes_windows_rules_and_keeps_chinese() {
        assert_eq!(sanitize_filename("报 告<1>.txt"), "报 告_1_.txt");
        assert_eq!(sanitize_filename("CON.txt"), "_CON.txt");
        assert_eq!(sanitize_filename("LPT9"), "_LPT9");
        assert_eq!(sanitize_filename("...\u{0001}"), "attachment");
    }

    #[test]
    fn attachment_same_name_gets_incrementing_suffix() {
        let workspace = temp_workspace("same-name");

        let first =
            save_attachment_bytes_sync(workspace.to_str().unwrap(), "报告.txt", b"first").unwrap();
        let second =
            save_attachment_bytes_sync(workspace.to_str().unwrap(), "报告.txt", b"second").unwrap();

        assert_eq!(first.rel, ".everpretty-attachments/报告.txt");
        assert_eq!(second.rel, ".everpretty-attachments/报告-1.txt");
        assert_eq!(
            fs::read_to_string(workspace.join(&second.rel)).unwrap(),
            "second"
        );

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn attachment_import_rejects_directory() {
        let workspace = temp_workspace("reject-dir");
        let dir = workspace.join("folder");
        fs::create_dir_all(&dir).unwrap();

        let err =
            import_attachment_sync(workspace.to_str().unwrap(), dir.to_str().unwrap()).unwrap_err();

        assert!(err.contains("普通文件"));
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn attachment_rejects_traversal_paths() {
        let workspace = temp_workspace("reject-traversal");

        let err = save_attachment_bytes_sync(workspace.to_str().unwrap(), "../evil.txt", b"x")
            .unwrap_err();
        assert!(err.contains("路径分隔符") || err.contains("目录穿越"));

        let err = read_attachment_preview_sync(
            workspace.to_str().unwrap(),
            ".everpretty-attachments/../evil.png",
        )
        .unwrap_err();
        assert!(err.contains("目录穿越"));

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn workspace_snapshot_lists_outputs_and_skips_heavy_or_hidden_dirs() {
        let workspace = temp_workspace("workspace-snapshot");
        fs::write(workspace.join("供应链培训.pptx"), b"ppt").unwrap();
        fs::create_dir_all(workspace.join("reports")).unwrap();
        fs::write(workspace.join("reports/result.pdf"), b"pdf").unwrap();
        fs::create_dir_all(workspace.join("node_modules/pkg")).unwrap();
        fs::write(workspace.join("node_modules/pkg/ignored.pdf"), b"ignored").unwrap();
        fs::create_dir_all(workspace.join(".everpretty-attachments")).unwrap();
        fs::write(
            workspace.join(".everpretty-attachments/input.png"),
            b"input",
        )
        .unwrap();

        let files = list_workspace_files_sync(workspace.to_str().unwrap()).unwrap();
        let rels: Vec<_> = files.iter().map(|file| file.rel.as_str()).collect();

        assert!(rels.contains(&"供应链培训.pptx"));
        assert!(rels.contains(&"reports/result.pdf"));
        assert!(!rels.iter().any(|rel| rel.contains("node_modules")));
        assert!(!rels
            .iter()
            .any(|rel| rel.contains(".everpretty-attachments")));
        let ppt = files
            .iter()
            .find(|file| file.name == "供应链培训.pptx")
            .unwrap();
        assert_eq!(
            ppt.directory,
            workspace.canonicalize().unwrap().to_string_lossy()
        );

        let _ = fs::remove_dir_all(workspace);
    }

    fn temp_workspace(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("codewhale-{name}-{stamp}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }
}
