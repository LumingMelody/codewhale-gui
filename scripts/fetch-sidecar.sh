#!/usr/bin/env bash
# 下载 pinned 版本 CodeWhale sidecar 二进制并校验。升级引擎 = 改 VERSION 重跑。
# 注意: codewhale 是 dispatcher, 启动时要求同目录存在伴生 codewhale-tui, 必须两个都下。
set -euo pipefail

VERSION="v0.8.66"
TRIPLE="aarch64-apple-darwin"
# 格式: <release asset 名>:<本地名>
ASSETS=("codewhale-macos-arm64:codewhale" "codewhale-tui-macos-arm64:codewhale-tui")

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/src-tauri/binaries"
BASE="https://github.com/Hmbown/CodeWhale/releases/download/$VERSION"

mkdir -p "$BIN"

if [[ -x "$BIN/codewhale-$TRIPLE" && -x "$BIN/codewhale-tui-$TRIPLE" ]] \
  && "$BIN/codewhale-$TRIPLE" --version 2>/dev/null | grep -q "${VERSION#v}"; then
  echo "sidecar ${VERSION} 已就位"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "下载 sidecar ${VERSION} (国内网络请先 export HTTPS_PROXY=...)"  # bash 3.2 + set -u 下 $VAR 紧跟全角字符会误并入变量名, 必须 ${} 且用 ASCII 括号
curl -fL --retry 3 -o "$TMP/sha.txt" "$BASE/codewhale-artifacts-sha256.txt"

for pair in "${ASSETS[@]}"; do
  asset="${pair%%:*}"
  name="${pair##*:}"
  dest="$BIN/$name-$TRIPLE"

  curl -fL --retry 3 -o "$TMP/$asset" "$BASE/$asset"

  expected="$(awk -v a="$asset" '$NF == a {print $1}' "$TMP/sha.txt")"
  if [[ -z "$expected" ]]; then
    echo "ERROR: sha256 清单里找不到 $asset" >&2
    exit 1
  fi
  actual="$(shasum -a 256 "$TMP/$asset" | awk '{print $1}')"
  if [[ "$expected" != "$actual" ]]; then
    echo "ERROR: $asset sha256 校验失败 expected=$expected actual=$actual" >&2
    exit 1
  fi

  install -m 755 "$TMP/$asset" "$dest"
done

# dev 模式下 dispatcher 按无后缀名找 sibling; 打包时 Tauri 会自动剥掉 triple 后缀
ln -sf "codewhale-tui-$TRIPLE" "$BIN/codewhale-tui"

echo -n "OK: "
"$BIN/codewhale-$TRIPLE" --version
