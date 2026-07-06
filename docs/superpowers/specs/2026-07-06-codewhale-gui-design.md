# CodeWhale GUI — macOS 桌面工作台设计

日期：2026-07-06
状态：已与用户确认

## 目标

把 CodeWhale（github.com/Hmbown/CodeWhale，Rust agent harness）打包成一键安装、开箱即用的 macOS 桌面 GUI。用户双击 DMG 安装后，无需终端操作即可创建会话、与 agent 对话、审批工具调用。

**MVP 范围**：macOS arm64（Apple Silicon）自用；核心工作台功能；内置首次运行向导；DMG 分发不签名（右键打开绕 Gatekeeper）。

## 已验证的事实（2026-07-06 核查）

- `Hmbown/CodeWhale` 真实存在：Rust，39.5k stars，持续更新
- npm `codewhale@0.8.66`：从 GitHub release 拉二进制的安装器
- `docs/RUNTIME_API.md` 是稳定集成契约：`codewhale app-server --http` 在 `127.0.0.1:7878` 提供 `/v1/*` HTTP/SSE API；方法集有 drift test 锁定
- CORS 白名单内置 `tauri://localhost` 与 `http://localhost:1420`——官方预期 Tauri GUI
- Release 产物含 `codewhale-macos-arm64` 等独立二进制，匹配 Tauri sidecar 打包
- 第三方 "DeepSeek-GUI" 不存在（Claude Desktop 幻觉）；现存 codewhale-desktop 项目均为 ≤6 星 Electron 玩具，无 fork 价值

## 架构决策

**独立 Tauri 项目 + sidecar 内嵌引擎二进制，前端直连 runtime API。**不 fork CodeWhale 源码；上游 repo 仅作只读参考（event schema、方法定义）。引擎升级 = 换 sidecar 二进制重新打包，GUI 只依赖 API 契约。

已评估并否决的替代方案：
- Rust 全代理（每端点包 Tauri command，SSE 转 Tauri 事件）：token 不出 Rust 更"正统"，但 MVP 阶段样板翻倍，且 loopback 场景 token 暴露给前端无实际风险 → 否决
- fork 现有 Electron 项目：玩具级、不符合 Rust 诉求 → 否决

## 技术栈

- Tauri 2.x（Rust 侧 `src-tauri/`）
- React 18 + TypeScript + Vite（前端）
- 包管理：pnpm（Node via nvm，国内镜像）
- sidecar：pinned 版本的 CodeWhale 二进制（初始 v0.8.66）

## 组件设计

### 1. Sidecar 获取（构建期）

`scripts/fetch-sidecar.sh`：
- 从 GitHub release 下载 pinned 版本 `codewhale-macos-arm64`（网络走代理，失败时提示设 `HTTPS_PROXY`）
- 对照 `codewhale-artifacts-sha256.txt` 校验
- 放入 `src-tauri/binaries/codewhale-aarch64-apple-darwin`（Tauri externalBin 的 target-triple 命名）
- 版本号 pin 在脚本顶部常量，升级引擎 = 改一行重跑

### 2. Rust 侧（薄进程管理层）

职责仅四项：

1. **启动 sidecar**：生成随机 auth token（UUID v4）；探测空闲端口（优先 7878，被占则 OS 随机分配）；spawn `codewhale app-server --http --host 127.0.0.1 --port N --auth-token T`
2. **就绪等待**：轮询 `GET /health`（无需 token），200 即 ready；15 秒超时报错
3. **Tauri commands**：
   - `get_runtime_info() -> {base_url, token, status}` — 前端启动时调用
   - `run_doctor() -> JSON` — 执行 sidecar 二进制 `doctor --json`，首次向导用
   - `write_provider_config(api_key: String) -> Result` — 写 `~/.codewhale/config.toml`（存在则合并，不覆盖用户已有配置）。**config.toml 的确切字段名/结构不得臆造，实施时以上游 `docs/CONFIGURATION.md` 为准核实**
4. **生命周期**：窗口关闭 → kill 子进程（含 SIGTERM 后超时 SIGKILL）；子进程意外退出 → emit `sidecar-crashed` 事件给前端

### 3. 前端

**路由/视图**：

- **启动屏**：调 `get_runtime_info()`，等 sidecar ready
- **首次向导**：`run_doctor()` 检测 `api_key.source == "missing"` → 表单粘贴 DeepSeek API key → `write_provider_config()` → 重跑 doctor 确认 → 进主界面。key 已配置则跳过
- **主界面**：
  - 左栏：线程列表（`GET /v1/threads/summary`），显示 title/preview/model/workspace/branch/dirty 徽标/latest_turn_status；顶部"新建会话"按钮
  - 右侧：对话视图
- **对话视图**：
  - 打开线程：`GET /v1/threads/{id}/events?since_seq=0` 回放历史 + 同一连接转 live SSE（EventSource，token 走 `?token=` query，官方支持）
  - 按 `item kind` 渲染：`user_message` / `agent_message`（流式 markdown，`item.delta` 增量）/ `tool_call`、`command_execution`（折叠块）/ `file_change`（摘要）/ `error`（红块）/ `context_compaction`、`status`（灰色系统行）
  - 输入框：`POST /v1/threads/{id}/turns`
  - 活动 turn（`in_progress`）：显示"打断"（`POST .../interrupt`）与"追加指令"（`POST .../steer`）
- **审批弹窗**：SSE `approval.required` 事件 → 模态框展示工具/命令详情（含 `matched_rule`）→ allow/deny → `POST /v1/approvals/{approval_id}`，body `{decision, remember: false}`
- **新建会话**：Tauri dialog 选工作目录 → `POST /v1/threads`（带 workspace）→ 跳转对话视图

**状态管理**：SSE 事件 → 纯函数 reducer → UI 状态。reducer 独立成模块，vitest 可测。

## 数据流

```
[Tauri Rust] spawn sidecar(app-server --http --port N --auth-token T)
     │ get_runtime_info()
     ▼
[前端] ──REST──> http://127.0.0.1:N/v1/*   (Authorization: Bearer T)
       ──SSE───> /v1/threads/{id}/events?since_seq=K&token=T
```

## 错误处理

| 场景 | 处理 |
|---|---|
| sidecar 启动失败 / 15s 未 ready | 全屏错误页，显示 stderr 尾部日志 + 重试按钮 |
| sidecar 运行中崩溃 | `sidecar-crashed` 事件 → 错误页 + 一键重启（重启后线程数据不丢，runtime 持久化，`queued/in_progress` turn 被标 interrupted 属预期） |
| SSE 断线 | 记住最后 `seq`，指数退避重连 `?since_seq=<last>`，事件流原生支持续传 |
| turn `failed` / `interrupted` | 状态徽标入流渲染，不弹窗 |
| 端口 7878 被占 | 自动换随机空闲端口（前端从 `get_runtime_info` 拿实际端口，不硬编码） |

## 测试

- **Rust 单测**：空闲端口探测；config.toml 合并写入（不破坏已有字段）；子进程 kill 逻辑
- **前端 vitest**：SSE 事件 reducer（回放序列 → 期望 UI 状态；乱序/重复 seq 容错）
- **E2E 手动验收**：`pnpm tauri build` 出 DMG → 本机安装 → 首次向导配 key → 新建会话 → 发消息看实时流 → 触发一次工具审批 → 打断一个 turn → 退出确认无残留 codewhale 进程

## 明确不做（MVP 边界）

Windows/Linux 打包、代码签名与公证、usage 面板、tasks/automations/fleet/snapshots 管理、多引擎版本管理、自动更新。

## 风险与应对

- **国内网络下载 release 二进制慢/断**：fetch 脚本支持 `HTTPS_PROXY`；二进制下载一次后缓存，不进 git
- **上游 API 演进**：只依赖 drift-test 锁定的 `/v1/*` 契约；sidecar 版本 pin，升级是显式动作
- **DeepSeek API key 计费**：MVP 自用，key 由用户自备
