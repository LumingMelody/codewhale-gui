# CodeWhale GUI

CodeWhale 引擎的 macOS 桌面工作台（Tauri）。安装即用：DMG 内嵌引擎双二进制
（`codewhale` dispatcher + `codewhale-tui`），首次启动向导配好 API key 即可
创建会话、对话、审批工具调用。

## 安装

1. 打开 DMG，把 `CodeWhale GUI.app` 拖入 Applications
2. 首次启动：右键 → 打开（未签名，绕过 Gatekeeper）
3. 按向导粘贴 DeepSeek API Key（写入 `~/.codewhale/config.toml`，不出本机）

## 开发

```bash
pnpm install && ./scripts/fetch-sidecar.sh   # 初始化（国内网络先 export HTTPS_PROXY）
pnpm tauri dev                                # 开发
pnpm test && pnpm build                       # 前端测试 + 静态门
(cd src-tauri && cargo test)                  # Rust 测试
pnpm tauri build                              # 打 DMG
```

## 架构

独立 Tauri 2 项目，不 fork CodeWhale 源码。Rust 侧只管 sidecar 生命周期
（随机 token + 空闲端口起 `codewhale app-server --http`、健康等待、崩溃通知、
按 token 清进程树）；前端 React/TS 直连 `127.0.0.1:N` 的 `/v1/*` REST + SSE。
契约见上游 `docs/RUNTIME_API.md`（drift test 锁定）。

设计文档：`docs/superpowers/specs/2026-07-06-codewhale-gui-design.md`

## 引擎升级

改 `scripts/fetch-sidecar.sh` 顶部 `VERSION` 后重跑脚本再打包。

## 二期：智能网关

CodeWhale 官方支持 OpenAI 兼容网关：`~/.codewhale/config.toml` 设
`provider = "openai"` + `[providers.openai].base_url = "https://你的网关/v1"`，
GUI 零改动。首次向导刻意不触碰 `base_url`，为此保留干净切换点。
