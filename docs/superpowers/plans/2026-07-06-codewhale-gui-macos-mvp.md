# CodeWhale GUI macOS MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 CodeWhale 引擎打包成 macOS (arm64) 一键安装的 Tauri 桌面工作台：安装 DMG → 首次向导配 key → 建会话对话/审批。

**Architecture:** 独立 Tauri 2 项目。Rust 侧只做 sidecar 进程管理（随机 token + 空闲端口起 `codewhale app-server --http`、健康等待、崩溃通知、退出清理）+ 3 个辅助 command（runtime info / doctor / 设 key）。前端 React+TS 直连 `127.0.0.1:N` 的 `/v1/*` REST + SSE（官方 CORS 白名单含 `tauri://localhost` 与 `:1420`）。

**Tech Stack:** Tauri 2.x、React 18 + TypeScript + Vite、pnpm、vitest；Rust 依赖 tauri-plugin-shell / tauri-plugin-dialog / reqwest / uuid / tokio；前端依赖 @tauri-apps/api、@tauri-apps/plugin-dialog、react-markdown。

## Global Constraints

- 平台仅 macOS arm64（target triple `aarch64-apple-darwin`），bundle 目标仅 `dmg`
- sidecar 版本 pin 死 `v0.8.66`，二进制放 `src-tauri/binaries/codewhale-aarch64-apple-darwin`，**不进 git**（.gitignore 已有 `src-tauri/binaries/`）
- 首次向导写 provider key 时**绝不触碰 `base_url`**（二期网关的切换点，见 spec）
- API 契约以 `docs/RUNTIME_API.md`（上游 repo，副本在 scratchpad）为准；已核实的 body：`POST /v1/threads` = `{workspace, model?, mode?, ...}`（全可选，server 有默认）、`POST /v1/threads/{id}/turns` = `{prompt: string}`、steer = `{prompt}`、approval = `{decision: "allow"|"deny", remember: false}`
- app identifier `com.melodylu.codewhale-gui`，productName `CodeWhale GUI`
- 国内网络：GitHub 下载走 `HTTPS_PROXY`；npm 用默认 npmmirror；crates.io 慢时用本机已有 cargo 镜像配置，不在项目里硬编码
- API key 值任何时候不得写入日志/console
- 每个 Task 结束必须 commit；commit message 风格：`feat:`/`fix:`/`docs:`/`chore:` 前缀

---

### Task 1: 清理 Python 骨架 + Tauri 2 脚手架

**Files:**
- Delete: `pyproject.toml`、`.venv/`
- Create: Tauri 模板全套（`package.json`、`vite.config.ts`、`src/`、`src-tauri/`）
- Modify: `package.json`（name）、`src-tauri/tauri.conf.json`（productName/identifier/targets）

**Interfaces:**
- Produces: 可构建的空壳 app；`pnpm build` 与 `cargo check` 两条静态门后续每个 task 都要过

- [x] **Step 1: 删除 PyCharm 残留**

```bash
cd /Users/melodylu/PycharmProjects/CodeWhale_GUI
rm -rf .venv pyproject.toml
```

- [x] **Step 2: 脚手架（先出到临时目录再并入，create-tauri-app 拒绝非空目录）**

```bash
cd /Users/melodylu/PycharmProjects/CodeWhale_GUI
pnpm create tauri-app@latest scaffold-tmp --template react-ts --manager pnpm --yes
rsync -a scaffold-tmp/ ./
rm -rf scaffold-tmp
pnpm install
```

- [x] **Step 3: 项目命名与 bundle 配置**

`package.json`：`"name": "codewhale-gui"`。

`src-tauri/tauri.conf.json` 关键字段改为：

```json
{
  "productName": "CodeWhale GUI",
  "identifier": "com.melodylu.codewhale-gui",
  "app": {
    "windows": [{ "title": "CodeWhale GUI", "width": 1200, "height": 800 }]
  },
  "bundle": {
    "active": true,
    "targets": ["dmg"]
  }
}
```

（其余脚手架生成字段保留；`build.devUrl` 保持默认 `http://localhost:1420`，该端口在引擎 CORS 白名单内。）

- [x] **Step 4: 验证两条静态门**

```bash
pnpm build                      # 预期: tsc + vite build 成功
cd src-tauri && cargo check     # 预期: Finished（首次要拉 crates，耐心）
```

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold Tauri 2 + React/TS app, drop python skeleton"
```

---

### Task 2: sidecar 获取脚本 + externalBin 注册

**Files:**
- Create: `scripts/fetch-sidecar.sh`
- Modify: `src-tauri/tauri.conf.json`（bundle.externalBin）

**Interfaces:**
- Produces: `src-tauri/binaries/codewhale-aarch64-apple-darwin`（可执行，v0.8.66）；tauri.conf 注册名 `binaries/codewhale`（Rust 侧 `.sidecar("codewhale")` 引用）

- [x] **Step 1: 写下载脚本**

`scripts/fetch-sidecar.sh`：

```bash
#!/usr/bin/env bash
# 下载 pinned 版本 CodeWhale sidecar 二进制并校验。升级引擎 = 改 VERSION 重跑。
set -euo pipefail

VERSION="v0.8.66"
ASSET="codewhale-macos-arm64"
TRIPLE="aarch64-apple-darwin"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/src-tauri/binaries/codewhale-$TRIPLE"
BASE="https://github.com/Hmbown/CodeWhale/releases/download/$VERSION"

mkdir -p "$ROOT/src-tauri/binaries"

if [[ -x "$DEST" ]] && "$DEST" --version 2>/dev/null | grep -q "${VERSION#v}"; then
  echo "sidecar $VERSION 已就位: $DEST"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "下载 ${ASSET} ${VERSION} (国内网络请先 export HTTPS_PROXY=...)"  # 注意: bash 3.2 + set -u 下 $VAR 紧跟全角字符会误并入变量名, 必须 ${} 且用 ASCII 括号
curl -fL --retry 3 -o "$TMP/$ASSET" "$BASE/$ASSET"
curl -fL --retry 3 -o "$TMP/sha.txt" "$BASE/codewhale-artifacts-sha256.txt"

EXPECTED="$(awk -v a="$ASSET" '$NF == a {print $1}' "$TMP/sha.txt")"
if [[ -z "$EXPECTED" ]]; then
  echo "ERROR: sha256 清单里找不到 $ASSET" >&2
  exit 1
fi
ACTUAL="$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')"
if [[ "$EXPECTED" != "$ACTUAL" ]]; then
  echo "ERROR: sha256 校验失败 expected=$EXPECTED actual=$ACTUAL" >&2
  exit 1
fi

install -m 755 "$TMP/$ASSET" "$DEST"
echo -n "OK: "
"$DEST" --version
```

```bash
chmod +x scripts/fetch-sidecar.sh
```

- [x] **Step 2: 跑脚本验证**

```bash
./scripts/fetch-sidecar.sh
# 预期输出以 "OK: " 开头且含 0.8.66
./src-tauri/binaries/codewhale-aarch64-apple-darwin --version
# 预期: 版本串含 0.8.66
```

- [x] **Step 3: 注册 externalBin**

`src-tauri/tauri.conf.json` 的 `bundle` 加：

```json
"externalBin": ["binaries/codewhale"]
```

（Tauri 按 `binaries/codewhale-<target-triple>` 自动解析到刚下载的文件。）

- [x] **Step 4: 验证配置合法**

```bash
cd src-tauri && cargo check
# 预期: 通过。externalBin 缺文件会在 tauri build 时报错，本步先保证 conf 解析不炸
```

- [x] **Step 5: Commit**

```bash
git add scripts/fetch-sidecar.sh src-tauri/tauri.conf.json
git commit -m "feat: pinned sidecar fetch script with sha256 verify + externalBin"
```

---

### Task 3: Rust sidecar 生命周期（端口/token/spawn/健康/崩溃/清理）

**Files:**
- Create: `src-tauri/src/sidecar.rs`
- Modify: `src-tauri/src/lib.rs`、`src-tauri/Cargo.toml`
- Test: `sidecar.rs` 内 `#[cfg(test)]`

**Interfaces:**
- Produces（后续 task 依赖，签名精确）:
  - command `get_runtime_info() -> Option<RuntimeInfo>`，`RuntimeInfo { base_url: String, token: String, port: u16 }`（serde 序列化为 snake_case 同名字段）
  - command `restart_sidecar() -> Result<RuntimeInfo, String>`
  - Tauri 事件 `"sidecar-crashed"`（payload 为 String 描述）
  - `sidecar::start(app: AppHandle) -> Result<RuntimeInfo, String>`、`sidecar::shutdown(app: &AppHandle)`

- [ ] **Step 1: 加依赖**

`src-tauri/Cargo.toml` `[dependencies]` 增加：

```toml
tauri-plugin-shell = "2"
uuid = { version = "1", features = ["v4"] }
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls"] }
tokio = { version = "1", features = ["time"] }
```

- [ ] **Step 2: 先写端口探测的失败测试**

`src-tauri/src/sidecar.rs` 底部：

```rust
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
```

- [ ] **Step 3: 跑测试确认编译失败（pick_port 未定义）**

```bash
cd src-tauri && cargo test pick_port
# 预期: 编译错误 cannot find function `pick_port`
```

- [ ] **Step 4: 实现 sidecar.rs**

```rust
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
    if let Some(child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
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
```

- [ ] **Step 5: 接线 lib.rs**

`src-tauri/src/lib.rs` 整体替换为：

```rust
mod sidecar;

use sidecar::SidecarState;
use tauri::Emitter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(SidecarState::default())
        .invoke_handler(tauri::generate_handler![
            sidecar::get_runtime_info,
            sidecar::restart_sidecar,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = sidecar::start(handle.clone()).await {
                    eprintln!("sidecar start failed: {e}");
                    let _ = handle.emit("sidecar-crashed", e);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                sidecar::shutdown(app);
            }
        });
}
```

（模板若把逻辑放在 `main.rs`，保持 `main.rs` 只调 `codewhale_gui_lib::run()` 的脚手架原样。）

- [ ] **Step 6: 跑测试与静态门**

```bash
cd src-tauri && cargo test pick_port
# 预期: 2 passed
cargo check
# 预期: 通过
```

- [ ] **Step 7: 冒烟——dev 起 app，确认 sidecar 被拉起**

```bash
pnpm tauri dev &
sleep 25
ps aux | grep -v grep | grep "app-server --http"
# 预期: 能看到 codewhale app-server 进程，--port 7878（或随机口）--auth-token <uuid>
# 然后关掉窗口/kill dev，再次 ps 确认 app-server 进程已消失（退出清理生效）
```

- [ ] **Step 8: Commit**

```bash
git add src-tauri/
git commit -m "feat: sidecar lifecycle - port/token/spawn/health-wait/crash-event/cleanup"
```

---

### Task 4: Rust doctor + 设 key 命令

**Files:**
- Modify: `src-tauri/src/sidecar.rs`（追加两个 command）、`src-tauri/src/lib.rs`（注册）

**Interfaces:**
- Consumes: Task 3 的 `ShellExt::sidecar("codewhale")`
- Produces:
  - command `run_doctor() -> Result<serde_json::Value, String>`（doctor --json 原样 JSON；前端读 `api_key.source`，取值 `"env" | "config" | "missing"`）
  - command `set_api_key(api_key: String) -> Result<(), String>`（写 provider key，不触碰 base_url）

- [ ] **Step 1: 核实 auth 子命令真实旗标（不许臆造 CLI 参数）**

```bash
./src-tauri/binaries/codewhale-aarch64-apple-darwin auth set --help
# 预期: 显示 --provider 与传 key 的方式（--api-key 或 stdin）
# 若 `auth set` 不存在或不接受 --api-key，按 CONFIGURATION.md 已确认的
# legacy 别名改用: codewhale login --api-key <KEY>
# 【按实际输出决定 Step 3 的 args 数组，本 task 后续代码默认 auth set 路径】
```

- [ ] **Step 2: 追加 doctor 命令到 sidecar.rs**

```rust
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
    serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("doctor 输出解析失败: {e}"))
}
```

（`serde_json` 已是 tauri 模板依赖；若 Cargo.toml 没有则加 `serde_json = "1"`。）

- [ ] **Step 3: 追加 set_api_key 命令**

```rust
#[tauri::command]
pub async fn set_api_key(app: AppHandle, api_key: String) -> Result<(), String> {
    // 注意: 本函数任何分支都不得把 api_key 打进日志
    let output = app
        .shell()
        .sidecar("codewhale")
        .map_err(|e| e.to_string())?
        .args(["auth", "set", "--provider", "deepseek", "--api-key", &api_key])
        .output()
        .await
        .map_err(|e| format!("auth set 执行失败: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}
```

（若 Step 1 核实结果是 legacy 路径，args 改 `["login", "--api-key", &api_key]`，其余不变。）

- [ ] **Step 4: lib.rs 注册**

`generate_handler!` 列表加 `sidecar::run_doctor, sidecar::set_api_key`。

- [ ] **Step 5: 静态门 + 真机验证 doctor**

```bash
cd src-tauri && cargo check   # 预期: 通过
./binaries/codewhale-aarch64-apple-darwin doctor --json | python3 -m json.tool | head -20
# 预期: 合法 JSON，含 "api_key": {"source": ...} 字段
```

- [ ] **Step 6: Commit**

```bash
git add src-tauri/
git commit -m "feat: run_doctor and set_api_key commands via sidecar CLI"
```

---

### Task 5: 前端 API 客户端 + SSE 订阅 + 事件 reducer（vitest）

**Files:**
- Create: `src/lib/api.ts`、`src/lib/events.ts`、`src/state/threadReducer.ts`
- Test: `src/state/threadReducer.test.ts`
- Modify: `package.json`（vitest）

**Interfaces:**
- Consumes: Task 3 的 `RuntimeInfo { base_url, token, port }`
- Produces（Task 6-9 依赖，签名精确）:
  - `class ApiClient(baseUrl: string, token: string)`：`listThreadSummaries(limit?): Promise<ThreadSummary[]>`、`createThread(workspace: string): Promise<{id: string}>`、`startTurn(threadId, prompt): Promise<unknown>`、`steerTurn(threadId, turnId, prompt)`、`interruptTurn(threadId, turnId)`、`decideApproval(approvalId, decision: 'allow'|'deny')`
  - `subscribeThreadEvents(opts): () => void`（返回取消函数；自动退避重连并带 `since_seq` 续传）
  - `threadReducer(state: ThreadViewState, ev: ThreadEvent): ThreadViewState` 与 `initialThreadView`
  - 类型 `ThreadEvent`、`ThreadSummary`、`ConversationItem`、`PendingApproval`、`ThreadViewState`

- [ ] **Step 1: 装 vitest 与 react-markdown**

```bash
pnpm add -D vitest
pnpm add react-markdown
```

`package.json` scripts 加 `"test": "vitest run"`。

- [ ] **Step 2: 写 api.ts**

```typescript
export interface RuntimeInfo {
  base_url: string;
  token: string;
  port: number;
}

export interface ThreadSummary {
  id: string;
  title: string | null;
  preview: string | null;
  model: string;
  mode: string;
  branch: string | null;
  head: string | null;
  dirty: boolean;
  workspace: string;
  archived: boolean;
  updated_at: string;
  latest_turn_id: string | null;
  latest_turn_status: string | null;
}

export class ApiClient {
  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status}: ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }

  listThreadSummaries(limit = 50): Promise<ThreadSummary[]> {
    return this.req(`/v1/threads/summary?limit=${limit}`);
  }

  createThread(workspace: string): Promise<{ id: string }> {
    return this.req(`/v1/threads`, {
      method: 'POST',
      body: JSON.stringify({ workspace }),
    });
  }

  startTurn(threadId: string, prompt: string): Promise<unknown> {
    return this.req(`/v1/threads/${threadId}/turns`, {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    });
  }

  steerTurn(threadId: string, turnId: string, prompt: string): Promise<unknown> {
    return this.req(`/v1/threads/${threadId}/turns/${turnId}/steer`, {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    });
  }

  interruptTurn(threadId: string, turnId: string): Promise<unknown> {
    return this.req(`/v1/threads/${threadId}/turns/${turnId}/interrupt`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  decideApproval(approvalId: string, decision: 'allow' | 'deny'): Promise<unknown> {
    return this.req(`/v1/approvals/${approvalId}`, {
      method: 'POST',
      body: JSON.stringify({ decision, remember: false }),
    });
  }
}
```

- [ ] **Step 3: 写 events.ts（SSE 用命名事件，必须逐名 addEventListener）**

```typescript
export interface ThreadEvent {
  schema_version: number;
  seq: number;
  event: string;
  kind: string;
  thread_id: string;
  turn_id?: string;
  item_id?: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

// RUNTIME_API.md 列出的事件名全集；SSE 以命名事件下发，
// EventSource 的 onmessage 收不到命名事件，必须逐名监听。
const EVENT_NAMES = [
  'thread.started', 'thread.forked',
  'turn.started', 'turn.lifecycle', 'turn.steered',
  'turn.interrupt_requested', 'turn.completed',
  'item.started', 'item.delta', 'item.completed',
  'item.failed', 'item.interrupted',
  'approval.required', 'approval.decided', 'approval.timeout',
  'sandbox.denied',
];

export interface SubscribeOptions {
  baseUrl: string;
  token: string;
  threadId: string;
  sinceSeq: number;
  onEvent: (ev: ThreadEvent) => void;
  onStatus?: (status: 'open' | 'reconnecting') => void;
}

export function subscribeThreadEvents(opts: SubscribeOptions): () => void {
  let es: EventSource | null = null;
  let lastSeq = opts.sinceSeq;
  let closed = false;
  let retryMs = 500;

  const connect = () => {
    if (closed) return;
    const url =
      `${opts.baseUrl}/v1/threads/${opts.threadId}/events` +
      `?since_seq=${lastSeq}&token=${encodeURIComponent(opts.token)}`;
    es = new EventSource(url);
    const handle = (e: MessageEvent) => {
      const ev = JSON.parse(e.data) as ThreadEvent;
      if (ev.seq > lastSeq) {
        lastSeq = ev.seq;
        retryMs = 500;
        opts.onEvent(ev);
      }
    };
    for (const name of EVENT_NAMES) es!.addEventListener(name, handle);
    es.onmessage = handle; // 兜底未命名事件
    es.onopen = () => opts.onStatus?.('open');
    es.onerror = () => {
      es?.close();
      opts.onStatus?.('reconnecting');
      if (!closed) {
        setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 10_000);
      }
    };
  };

  connect();
  return () => {
    closed = true;
    es?.close();
  };
}
```

- [ ] **Step 4: 先写 reducer 的失败测试**

`src/state/threadReducer.test.ts`：

```typescript
import { describe, expect, it } from 'vitest';
import type { ThreadEvent } from '../lib/events';
import { initialThreadView, threadReducer } from './threadReducer';

const ev = (partial: Partial<ThreadEvent>): ThreadEvent => ({
  schema_version: 1,
  seq: 1,
  event: 'item.delta',
  kind: 'item.delta',
  thread_id: 'thr_1',
  timestamp: '2026-07-06T00:00:00Z',
  payload: {},
  ...partial,
});

describe('threadReducer', () => {
  it('回放序列组装出流式 agent 消息', () => {
    let s = initialThreadView;
    s = threadReducer(s, ev({ seq: 1, kind: 'turn.started', turn_id: 't1' }));
    s = threadReducer(s, ev({ seq: 2, kind: 'item.started', turn_id: 't1', item_id: 'i1', payload: { kind: 'agent_message' } }));
    s = threadReducer(s, ev({ seq: 3, kind: 'item.delta', turn_id: 't1', item_id: 'i1', payload: { delta: 'Hello ', kind: 'agent_message' } }));
    s = threadReducer(s, ev({ seq: 4, kind: 'item.delta', turn_id: 't1', item_id: 'i1', payload: { delta: 'world', kind: 'agent_message' } }));
    s = threadReducer(s, ev({ seq: 5, kind: 'item.completed', turn_id: 't1', item_id: 'i1', payload: {} }));
    s = threadReducer(s, ev({ seq: 6, kind: 'turn.completed', turn_id: 't1' }));

    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ id: 'i1', kind: 'agent_message', text: 'Hello world', status: 'completed' });
    expect(s.activeTurnId).toBeNull();
    expect(s.lastSeq).toBe(6);
  });

  it('重复/乱序 seq 被丢弃', () => {
    let s = initialThreadView;
    s = threadReducer(s, ev({ seq: 5, kind: 'item.started', item_id: 'i1', payload: { kind: 'agent_message' } }));
    const again = threadReducer(s, ev({ seq: 5, kind: 'item.delta', item_id: 'i1', payload: { delta: 'dup' } }));
    expect(again).toBe(s);
    const older = threadReducer(s, ev({ seq: 3, kind: 'item.delta', item_id: 'i1', payload: { delta: 'old' } }));
    expect(older).toBe(s);
  });

  it('审批出现与决议', () => {
    let s = initialThreadView;
    s = threadReducer(s, ev({ seq: 1, kind: 'approval.required', payload: { approval_id: 'ap1', summary: 'rm -rf /tmp/x', matched_rule: 'shell' } }));
    expect(s.approvals).toHaveLength(1);
    expect(s.approvals[0].approvalId).toBe('ap1');
    s = threadReducer(s, ev({ seq: 2, kind: 'approval.decided', payload: { approval_id: 'ap1' } }));
    expect(s.approvals).toHaveLength(0);
  });

  it('turn 活跃状态跟随 started/completed', () => {
    let s = initialThreadView;
    s = threadReducer(s, ev({ seq: 1, kind: 'turn.started', turn_id: 't9' }));
    expect(s.activeTurnId).toBe('t9');
    s = threadReducer(s, ev({ seq: 2, kind: 'turn.completed', turn_id: 't9' }));
    expect(s.activeTurnId).toBeNull();
  });
});
```

- [ ] **Step 5: 跑测试确认失败**

```bash
pnpm test
# 预期: FAIL - Cannot find module './threadReducer'
```

- [ ] **Step 6: 实现 threadReducer.ts**

```typescript
import type { ThreadEvent } from '../lib/events';

export type ItemKind =
  | 'user_message' | 'agent_message' | 'tool_call' | 'file_change'
  | 'command_execution' | 'context_compaction' | 'status' | 'error';

export interface ConversationItem {
  id: string;
  turnId: string | null;
  kind: ItemKind;
  text: string;
  status: 'started' | 'completed' | 'failed' | 'interrupted';
  metadata: Record<string, unknown>;
}

export interface PendingApproval {
  approvalId: string;
  summary: string;
  matchedRule: string | null;
}

export interface ThreadViewState {
  items: ConversationItem[];
  activeTurnId: string | null;
  approvals: PendingApproval[];
  lastSeq: number;
}

export const initialThreadView: ThreadViewState = {
  items: [],
  activeTurnId: null,
  approvals: [],
  lastSeq: 0,
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function patchItem(
  items: ConversationItem[],
  itemId: string,
  patch: (item: ConversationItem) => ConversationItem,
): ConversationItem[] {
  return items.map((it) => (it.id === itemId ? patch(it) : it));
}

export function threadReducer(state: ThreadViewState, ev: ThreadEvent): ThreadViewState {
  if (ev.seq <= state.lastSeq) return state;
  const s = { ...state, lastSeq: ev.seq };
  const p = ev.payload ?? {};

  switch (ev.kind) {
    case 'turn.started':
      return { ...s, activeTurnId: ev.turn_id ?? null };
    case 'turn.completed':
      return { ...s, activeTurnId: null };
    case 'item.started':
      return {
        ...s,
        items: [
          ...s.items,
          {
            id: ev.item_id ?? `seq-${ev.seq}`,
            turnId: ev.turn_id ?? null,
            kind: (str(p.kind) || 'status') as ItemKind,
            text: str(p.text),
            status: 'started',
            metadata: p,
          },
        ],
      };
    case 'item.delta':
      return {
        ...s,
        items: patchItem(s.items, ev.item_id ?? '', (it) => ({
          ...it,
          text: it.text + str(p.delta),
        })),
      };
    case 'item.completed':
      return {
        ...s,
        items: patchItem(s.items, ev.item_id ?? '', (it) => ({
          ...it,
          status: 'completed',
          text: str(p.text) || it.text,
        })),
      };
    case 'item.failed':
    case 'item.interrupted':
      return {
        ...s,
        items: patchItem(s.items, ev.item_id ?? '', (it) => ({
          ...it,
          status: ev.kind === 'item.failed' ? 'failed' : 'interrupted',
        })),
      };
    case 'approval.required': {
      const approvalId = str(p.approval_id) || str(p.id);
      if (!approvalId) return s;
      return {
        ...s,
        approvals: [
          ...s.approvals,
          {
            approvalId,
            summary: str(p.summary) || JSON.stringify(p),
            matchedRule: str(p.matched_rule) || null,
          },
        ],
      };
    }
    case 'approval.decided':
    case 'approval.timeout': {
      const decidedId = str(p.approval_id) || str(p.id);
      return { ...s, approvals: s.approvals.filter((a) => a.approvalId !== decidedId) };
    }
    default:
      return s;
  }
}
```

- [ ] **Step 7: 跑测试确认通过 + 构建门**

```bash
pnpm test    # 预期: 4 passed
pnpm build   # 预期: 通过
```

- [ ] **Step 8: Commit**

```bash
git add src/ package.json pnpm-lock.yaml
git commit -m "feat: api client, sse subscription with resume, thread event reducer + tests"
```

**实施提醒（不是占位符，是核对动作）**：`approval.required` 的 payload 字段名（`approval_id`/`summary`）来自文档推断，reducer 已做容错取值。Task 9 联调时若真实字段不同，以 `console.debug` 打出的原始事件为准修 reducer 的取值行（测试同步改）。

---

### Task 6: App 壳——启动屏 / 首次向导 / 崩溃屏三态机

**Files:**
- Create: `src/components/Wizard.tsx`、`src/components/CrashScreen.tsx`、`src/components/MainScreen.tsx`（本 task 先占坑渲染选中线程 id）
- Modify: `src/App.tsx`（整体替换模板内容）、`src/App.css`

**Interfaces:**
- Consumes: command `get_runtime_info` / `run_doctor` / `set_api_key` / `restart_sidecar`；事件 `sidecar-crashed`；`ApiClient`
- Produces: `MainScreen` 的 props 约定 `{ info: RuntimeInfo }`（Task 7/8 在其内部扩展，不改 App.tsx）

- [ ] **Step 1: App.tsx 三态机**

```tsx
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { RuntimeInfo } from './lib/api';
import Wizard from './components/Wizard';
import CrashScreen from './components/CrashScreen';
import MainScreen from './components/MainScreen';
import './App.css';

type Phase =
  | { name: 'booting'; note: string }
  | { name: 'wizard'; info: RuntimeInfo }
  | { name: 'main'; info: RuntimeInfo }
  | { name: 'crashed'; message: string };

async function waitRuntimeInfo(): Promise<RuntimeInfo> {
  for (let i = 0; i < 60; i++) {
    const info = await invoke<RuntimeInfo | null>('get_runtime_info');
    if (info) return info;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('engine 启动超时（30s）');
}

async function keyMissing(): Promise<boolean> {
  const doctor = await invoke<{ api_key?: { source?: string } }>('run_doctor');
  return (doctor.api_key?.source ?? 'missing') === 'missing';
}

export default function App() {
  const [phase, setPhase] = useState<Phase>({ name: 'booting', note: '正在启动引擎…' });

  useEffect(() => {
    const unlisten = listen<string>('sidecar-crashed', (e) => {
      setPhase({ name: 'crashed', message: e.payload });
    });
    (async () => {
      try {
        const info = await waitRuntimeInfo();
        setPhase((await keyMissing()) ? { name: 'wizard', info } : { name: 'main', info });
      } catch (err) {
        setPhase({ name: 'crashed', message: String(err) });
      }
    })();
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  switch (phase.name) {
    case 'booting':
      return <div className="center-screen">{phase.note}</div>;
    case 'wizard':
      return <Wizard onDone={() => setPhase({ name: 'main', info: phase.info })} />;
    case 'crashed':
      return (
        <CrashScreen
          message={phase.message}
          onRestarted={async (info) => {
            setPhase((await keyMissing()) ? { name: 'wizard', info } : { name: 'main', info });
          }}
        />
      );
    case 'main':
      return <MainScreen info={phase.info} />;
  }
}
```

- [ ] **Step 2: Wizard.tsx**

```tsx
import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

export default function Wizard({ onDone }: { onDone: () => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await invoke('set_api_key', { apiKey: key.trim() });
      const doctor = await invoke<{ api_key?: { source?: string } }>('run_doctor');
      if ((doctor.api_key?.source ?? 'missing') === 'missing') {
        throw new Error('key 已提交但 doctor 仍报 missing，请检查 key 是否有效');
      }
      onDone();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-screen">
      <div className="wizard-card">
        <h2>首次配置</h2>
        <p>粘贴 DeepSeek API Key（仅写入本机 ~/.codewhale/config.toml）</p>
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="sk-..."
          autoFocus
        />
        <button disabled={busy || key.trim() === ''} onClick={submit}>
          {busy ? '验证中…' : '保存并继续'}
        </button>
        {error && <p className="error-text">{error}</p>}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: CrashScreen.tsx**

```tsx
import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { RuntimeInfo } from '../lib/api';

export default function CrashScreen({
  message,
  onRestarted,
}: {
  message: string;
  onRestarted: (info: RuntimeInfo) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const restart = async () => {
    setBusy(true);
    setError(null);
    try {
      onRestarted(await invoke<RuntimeInfo>('restart_sidecar'));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-screen">
      <div className="wizard-card">
        <h2>引擎已停止</h2>
        <pre className="error-text">{message}</pre>
        {error && <pre className="error-text">{error}</pre>}
        <button disabled={busy} onClick={restart}>
          {busy ? '重启中…' : '重启引擎'}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: MainScreen.tsx 占坑（Task 7/8 充实）**

```tsx
import type { RuntimeInfo } from '../lib/api';

export default function MainScreen({ info }: { info: RuntimeInfo }) {
  return <div className="center-screen">engine ready @ {info.base_url}</div>;
}
```

- [ ] **Step 5: App.css 追加基础布局类**

```css
.center-screen {
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
}
.wizard-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 420px;
  padding: 24px;
  border: 1px solid #8884;
  border-radius: 12px;
}
.error-text {
  color: #d33;
  white-space: pre-wrap;
  word-break: break-all;
}
.app-layout { display: flex; height: 100vh; }
.sidebar { width: 280px; border-right: 1px solid #8884; overflow-y: auto; display: flex; flex-direction: column; }
.conversation { flex: 1; display: flex; flex-direction: column; min-width: 0; }
```

（模板自带的 demo 样式/组件——`Greet` 之类——一并删掉。）

- [ ] **Step 6: 静态门 + 手动验证向导两分支**

```bash
pnpm build && pnpm test   # 预期: 全过
pnpm tauri dev
# 手动: 若 ~/.codewhale 无 key → 出现向导; 贴一个真 key → 进 main 占坑页
# 已有 key 的情况 → 直接 main。验证后关闭。
```

- [ ] **Step 7: Commit**

```bash
git add src/
git commit -m "feat: app shell - boot/wizard/crash phase machine"
```

---

### Task 7: 线程列表 + 新建会话（目录选择）

**Files:**
- Create: `src/components/ThreadList.tsx`
- Modify: `src/components/MainScreen.tsx`、`src-tauri/Cargo.toml`、`src-tauri/src/lib.rs`、`src-tauri/capabilities/default.json`、`package.json`

**Interfaces:**
- Consumes: `ApiClient.listThreadSummaries` / `createThread`；`@tauri-apps/plugin-dialog` 的 `open`
- Produces: `MainScreen` 内部状态 `selectedThreadId: string | null`；`<ConversationView key={threadId} api info threadId />` 挂载点（Task 8 实现该组件，本 task 先渲染占位 div）

- [ ] **Step 1: 装 dialog 插件（三处）**

```bash
pnpm add @tauri-apps/plugin-dialog
cd src-tauri && cargo add tauri-plugin-dialog
```

`src-tauri/src/lib.rs` builder 链加 `.plugin(tauri_plugin_dialog::init())`。

`src-tauri/capabilities/default.json` 的 `permissions` 数组加 `"dialog:default"`。

- [ ] **Step 2: ThreadList.tsx**

```tsx
import { useCallback, useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import type { ApiClient, ThreadSummary } from '../lib/api';

export default function ThreadList({
  api,
  selectedId,
  onSelect,
}: {
  api: ApiClient;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setThreads(await api.listThreadSummaries());
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [api]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const createSession = async () => {
    const dir = await open({ directory: true, title: '选择工作目录' });
    if (typeof dir !== 'string') return;
    const { id } = await api.createThread(dir);
    await refresh();
    onSelect(id);
  };

  return (
    <div className="sidebar">
      <button onClick={createSession}>＋ 新建会话</button>
      {error && <p className="error-text">{error}</p>}
      {threads.map((t) => (
        <div
          key={t.id}
          className={`thread-row${t.id === selectedId ? ' selected' : ''}`}
          onClick={() => onSelect(t.id)}
        >
          <div className="thread-title">{t.title || t.preview || t.id}</div>
          <div className="thread-meta">
            {t.workspace.split('/').pop()}
            {t.branch ? ` · ${t.branch}` : ''}
            {t.dirty ? ' · ●' : ''}
            {t.latest_turn_status ? ` · ${t.latest_turn_status}` : ''}
          </div>
        </div>
      ))}
    </div>
  );
}
```

`App.css` 追加：

```css
.thread-row { padding: 10px 12px; cursor: pointer; border-bottom: 1px solid #8882; }
.thread-row.selected { background: #4a90d922; }
.thread-title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.thread-meta { font-size: 12px; opacity: 0.7; }
```

- [ ] **Step 3: MainScreen 接线**

```tsx
import { useMemo, useState } from 'react';
import { ApiClient, type RuntimeInfo } from '../lib/api';
import ThreadList from './ThreadList';

export default function MainScreen({ info }: { info: RuntimeInfo }) {
  const api = useMemo(() => new ApiClient(info.base_url, info.token), [info]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <div className="app-layout">
      <ThreadList api={api} selectedId={selectedId} onSelect={setSelectedId} />
      <div className="conversation">
        {selectedId ? (
          <div className="center-screen">对话视图（Task 8）: {selectedId}</div>
        ) : (
          <div className="center-screen">选择或新建一个会话</div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 静态门 + 手动验证**

```bash
pnpm build && pnpm test && (cd src-tauri && cargo check)   # 预期: 全过
pnpm tauri dev
# 手动: 点新建会话 → 系统目录选择器弹出 → 选一个项目目录 →
# 左栏出现新线程且被选中; 5 秒轮询不报错
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: thread list with 5s refresh + create session via directory picker"
```

---

### Task 8: 对话视图（回放 + 实时流 + 发送/打断/steer）

**Files:**
- Create: `src/components/ConversationView.tsx`、`src/components/ItemView.tsx`
- Modify: `src/components/MainScreen.tsx`（把占位 div 换成 `<ConversationView key={selectedId} ...>`）、`src/App.css`

**Interfaces:**
- Consumes: `subscribeThreadEvents`、`threadReducer`/`initialThreadView`、`ApiClient.startTurn/steerTurn/interruptTurn`
- Produces: `ConversationView` props `{ api: ApiClient; info: RuntimeInfo; threadId: string }`；内部把 `state.approvals` 传给 Task 9 的 `ApprovalModal`（本 task 先不渲染审批）

- [ ] **Step 1: ItemView.tsx（按 kind 分渲染）**

```tsx
import ReactMarkdown from 'react-markdown';
import type { ConversationItem } from '../state/threadReducer';

export default function ItemView({ item }: { item: ConversationItem }) {
  switch (item.kind) {
    case 'user_message':
      return <div className="item user">{item.text}</div>;
    case 'agent_message':
      return (
        <div className="item agent">
          <ReactMarkdown>{item.text}</ReactMarkdown>
          {item.status === 'started' && <span className="cursor">▌</span>}
        </div>
      );
    case 'tool_call':
    case 'command_execution':
      return (
        <details className="item tool">
          <summary>
            {item.kind === 'tool_call' ? '🔧 工具调用' : '💻 命令执行'}
            {item.status !== 'completed' ? `（${item.status}）` : ''}
          </summary>
          <pre>{item.text || JSON.stringify(item.metadata, null, 2)}</pre>
        </details>
      );
    case 'file_change':
      return <div className="item file">📝 文件变更: {item.text || JSON.stringify(item.metadata)}</div>;
    case 'error':
      return <div className="item error-text">{item.text || JSON.stringify(item.metadata)}</div>;
    default:
      return <div className="item system">{item.kind}: {item.text}</div>;
  }
}
```

- [ ] **Step 2: ConversationView.tsx**

```tsx
import { useEffect, useReducer, useRef, useState } from 'react';
import type { ApiClient, RuntimeInfo } from '../lib/api';
import { subscribeThreadEvents } from '../lib/events';
import { initialThreadView, threadReducer } from '../state/threadReducer';
import ItemView from './ItemView';

export default function ConversationView({
  api,
  info,
  threadId,
}: {
  api: ApiClient;
  info: RuntimeInfo;
  threadId: string;
}) {
  const [state, dispatch] = useReducer(threadReducer, initialThreadView);
  const [draft, setDraft] = useState('');
  const [steering, setSteering] = useState(false);
  const [connState, setConnState] = useState<'open' | 'reconnecting'>('open');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return subscribeThreadEvents({
      baseUrl: info.base_url,
      token: info.token,
      threadId,
      sinceSeq: 0,
      onEvent: dispatch,
      onStatus: setConnState,
    });
  }, [info, threadId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [state.items]);

  const send = async () => {
    const prompt = draft.trim();
    if (!prompt) return;
    setDraft('');
    if (steering && state.activeTurnId) {
      await api.steerTurn(threadId, state.activeTurnId, prompt);
      setSteering(false);
    } else {
      await api.startTurn(threadId, prompt);
    }
  };

  return (
    <div className="conversation">
      {connState === 'reconnecting' && <div className="banner">连接中断，重连中…</div>}
      <div className="items">
        {state.items.map((item) => (
          <ItemView key={item.id} item={item} />
        ))}
        <div ref={bottomRef} />
      </div>
      <div className="composer">
        {state.activeTurnId && (
          <div className="turn-controls">
            <span>agent 运行中…</span>
            <button onClick={() => api.interruptTurn(threadId, state.activeTurnId!)}>打断</button>
            <label>
              <input type="checkbox" checked={steering} onChange={(e) => setSteering(e.target.checked)} />
              追加指令（steer）
            </label>
          </div>
        )}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
          }}
          placeholder="输入消息，⌘+Enter 发送"
          rows={3}
        />
        <button onClick={send} disabled={!draft.trim()}>发送</button>
      </div>
    </div>
  );
}
```

`App.css` 追加：

```css
.items { flex: 1; overflow-y: auto; padding: 16px; }
.item { margin-bottom: 12px; max-width: 100%; overflow-wrap: break-word; }
.item.user { text-align: right; background: #4a90d922; border-radius: 8px; padding: 8px 12px; margin-left: 15%; }
.item.tool pre { overflow-x: auto; font-size: 12px; }
.item.system { font-size: 12px; opacity: 0.6; }
.composer { border-top: 1px solid #8884; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.composer textarea { resize: vertical; }
.turn-controls { display: flex; gap: 12px; align-items: center; font-size: 13px; }
.banner { background: #d9822b33; padding: 6px 12px; font-size: 13px; }
.cursor { animation: blink 1s step-start infinite; }
@keyframes blink { 50% { opacity: 0; } }
```

- [ ] **Step 3: MainScreen 换占位**

```tsx
{selectedId ? (
  <ConversationView key={selectedId} api={api} info={info} threadId={selectedId} />
) : (
  <div className="center-screen">选择或新建一个会话</div>
)}
```

（对应 import 加上；`key={selectedId}` 保证切线程时 reducer 状态整体重置。）

- [ ] **Step 4: 静态门 + 真机联调**

```bash
pnpm build && pnpm test   # 预期: 全过
pnpm tauri dev
# 手动: 选中会话 → 发 "列出这个目录的文件" → 看到 agent_message 逐字流出、
# tool_call/command_execution 折叠块出现; 活动 turn 时打断按钮可用且生效;
# 关掉 wifi 再开 → banner 出现又消失（重连续传）
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: conversation view - replay + live sse, send/interrupt/steer"
```

---

### Task 9: 工具审批弹窗

**Files:**
- Create: `src/components/ApprovalModal.tsx`
- Modify: `src/components/ConversationView.tsx`（渲染 modal）、`src/App.css`

**Interfaces:**
- Consumes: `state.approvals`（`PendingApproval[]`）、`ApiClient.decideApproval`
- Produces: 无下游依赖，MVP 功能闭环

- [ ] **Step 1: ApprovalModal.tsx**

```tsx
import { useState } from 'react';
import type { ApiClient } from '../lib/api';
import type { PendingApproval } from '../state/threadReducer';

export default function ApprovalModal({
  approval,
  api,
}: {
  approval: PendingApproval;
  api: ApiClient;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: 'allow' | 'deny') => {
    setBusy(true);
    setError(null);
    try {
      await api.decideApproval(approval.approvalId, decision);
      // 弹窗移除交给 approval.decided 事件驱动 reducer，不本地乐观删除
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="wizard-card">
        <h3>⚠️ 工具审批</h3>
        <pre className="approval-summary">{approval.summary}</pre>
        {approval.matchedRule && <p className="thread-meta">规则: {approval.matchedRule}</p>}
        {error && <p className="error-text">{error}</p>}
        <div className="approval-actions">
          <button disabled={busy} onClick={() => decide('deny')}>拒绝</button>
          <button disabled={busy} className="primary" onClick={() => decide('allow')}>允许</button>
        </div>
      </div>
    </div>
  );
}
```

`App.css` 追加：

```css
.modal-backdrop { position: fixed; inset: 0; background: #0008; display: flex; align-items: center; justify-content: center; z-index: 10; }
.approval-summary { max-height: 200px; overflow-y: auto; font-size: 12px; }
.approval-actions { display: flex; gap: 12px; justify-content: flex-end; }
button.primary { background: #4a90d9; color: white; }
```

- [ ] **Step 2: ConversationView 渲染（items 区域后面加）**

```tsx
{state.approvals.length > 0 && (
  <ApprovalModal approval={state.approvals[0]} api={api} />
)}
```

- [ ] **Step 3: 真机触发一次审批验证 payload 字段**

```bash
pnpm tauri dev
# 手动: 发一条会触发受审工具的消息（如 "删除 /tmp/test-approval 这个文件"）
# 预期: 弹窗出现，允许后弹窗消失、命令执行
# 若弹窗不出现: 在 events.ts 的 onEvent 前临时加 console.debug(ev)，
# 对照真实 approval.required payload 修 reducer 取值行 + 同步改测试
```

- [ ] **Step 4: 静态门 + Commit**

```bash
pnpm build && pnpm test
git add -A
git commit -m "feat: tool approval modal driven by approval events"
```

---

### Task 10: 崩溃恢复联调验证

**Files:**
- Modify: 仅当验证暴露 bug 时修（预期不改文件）

**Interfaces:**
- Consumes: Task 3 崩溃事件 + Task 6 CrashScreen

- [ ] **Step 1: 强杀引擎验证崩溃屏**

```bash
pnpm tauri dev
# 另一终端:
pkill -9 -f "app-server --http"
# 预期: GUI 立即切到"引擎已停止"屏（不是白屏/无响应）
```

- [ ] **Step 2: 重启按钮闭环**

```
点"重启引擎" → 预期: 回到主界面，线程列表还在（runtime 持久化），
之前 in_progress 的 turn 显示 interrupted（上游文档定义的重启语义，正常）
```

- [ ] **Step 3: 退出清理复验**

```bash
# 完全退出 app（⌘Q）后:
ps aux | grep -v grep | grep "app-server --http"
# 预期: 无输出（无孤儿进程）
```

- [ ] **Step 4: Commit（若有修补）**

```bash
git add -A && git commit -m "fix: crash recovery issues found in integration testing"
# 无修补则跳过
```

---

### Task 11: DMG 打包 + 验收 + tag

**Files:**
- Create: `README.md`（安装/开发说明）

**Interfaces:**
- Consumes: 全部前序 task
- Produces: `src-tauri/target/release/bundle/dmg/CodeWhale GUI_0.1.0_aarch64.dmg`

- [ ] **Step 1: 版本号与打包**

`src-tauri/tauri.conf.json` 确认 `"version": "0.1.0"`（脚手架默认 0.1.0 即可）。

```bash
./scripts/fetch-sidecar.sh    # 确保 sidecar 就位
pnpm tauri build
# 预期: 产出 src-tauri/target/release/bundle/dmg/*.dmg（未签名警告属预期）
ls -lh "src-tauri/target/release/bundle/dmg/"
```

- [ ] **Step 2: 安装验收（完整 E2E 清单，逐条过）**

```
1. 双击 DMG → 拖 app 到 Applications
2. 右键 → 打开（绕过 Gatekeeper，未签名的预期路径）
3. mv ~/.codewhale/config.toml ~/.codewhale/config.toml.bak（模拟新用户）
4. 启动 app → 首次向导出现 → 贴 DeepSeek key → 进主界面
5. 新建会话选一个测试目录 → 发消息 → 实时流渲染正常
6. 触发一次工具审批 → 允许 → 执行
7. 打断一个运行中的 turn → 状态变 interrupted
8. ⌘Q 退出 → ps 确认无 app-server 残留
9. 恢复: 若 bak 里有你自己的配置，合并回去（key 已被向导写入新 config）
```

- [ ] **Step 3: README.md（简短：一段简介 + 安装两步 + 开发三命令 + 引擎升级一行）**

```markdown
# CodeWhale GUI

CodeWhale 引擎的 macOS 桌面工作台（Tauri）。安装即用：DMG 内嵌引擎二进制，
首次启动向导配好 API key 即可创建会话、对话、审批工具调用。

## 安装
1. 打开 DMG，拖入 Applications
2. 首次启动：右键 → 打开（未签名）

## 开发
pnpm install && ./scripts/fetch-sidecar.sh   # 初始化
pnpm tauri dev                                # 开发
pnpm tauri build                              # 打 DMG

## 引擎升级
改 scripts/fetch-sidecar.sh 顶部 VERSION 后重跑脚本再打包。
GUI 只依赖 /v1/* API 契约（上游 docs/RUNTIME_API.md，drift test 锁定）。
```

- [ ] **Step 4: Commit + tag**

```bash
git add -A
git commit -m "docs: readme + v0.1.0 release build"
git tag v0.1.0
```

---

## Self-Review 结果

- **Spec 覆盖**：sidecar 获取（T2）、Rust 四职责（T3/T4）、向导（T6）、线程列表/新建（T7）、对话/流式/打断/steer（T8）、审批（T9）、崩溃恢复+SSE 重连（T3/T5/T10）、DMG+验收（T11）、"不触碰 base_url"（全局约束+T4）——无缺口
- **占位符**：无 TBD/TODO；T4 Step 1 与 T9 Step 3 是"对真实二进制/事件核对后二选一"的显式核对动作，两条路径的代码都已给出
- **类型一致性**：`RuntimeInfo`（rust Serialize ↔ ts interface 字段名 snake_case 对齐）、`ApiClient` 方法签名在 T5 定义并被 T6-T9 一致引用、`threadReducer/initialThreadView`、事件名 `sidecar-crashed`、组件 props 均前后一致


