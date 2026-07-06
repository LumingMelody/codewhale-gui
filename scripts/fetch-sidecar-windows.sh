#!/usr/bin/env bash
# 下载 Windows x64 sidecar 二进制并校验, 供 macOS 上 cargo-xwin 交叉打包 NSIS 安装器用。
# 与 fetch-sidecar.sh 同源同版本; 升级引擎 = 改 VERSION 重跑。
set -euo pipefail

VERSION="v0.8.66"
TRIPLE="x86_64-pc-windows-msvc"
# 格式: <release asset 名>:<本地名>
ASSETS=("codewhale-windows-x64.exe:codewhale" "codewhale-tui-windows-x64.exe:codewhale-tui")

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/src-tauri/binaries"
BASE="https://github.com/Hmbown/CodeWhale/releases/download/$VERSION"

mkdir -p "$BIN"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "下载 Windows sidecar ${VERSION} (国内网络请先 export HTTPS_PROXY=...)"
curl -fL --retry 3 -o "$TMP/sha.txt" "$BASE/codewhale-artifacts-sha256.txt"

for pair in "${ASSETS[@]}"; do
  asset="${pair%%:*}"
  name="${pair##*:}"
  dest="$BIN/$name-$TRIPLE.exe"

  expected="$(awk -v a="$asset" '$NF == a {print $1}' "$TMP/sha.txt")"
  if [[ -z "$expected" ]]; then
    echo "ERROR: sha256 清单里找不到 $asset" >&2
    exit 1
  fi

  if [[ -f "$dest" ]]; then
    actual="$(shasum -a 256 "$dest" | awk '{print $1}')"
    if [[ "$expected" == "$actual" ]]; then
      echo "$dest 已就位 (sha256 匹配)"
      continue
    fi
  fi

  curl -fL --retry 3 -o "$TMP/$asset" "$BASE/$asset"
  actual="$(shasum -a 256 "$TMP/$asset" | awk '{print $1}')"
  if [[ "$expected" != "$actual" ]]; then
    echo "ERROR: $asset sha256 校验失败 expected=$expected actual=$actual" >&2
    exit 1
  fi
  install -m 755 "$TMP/$asset" "$dest"
  echo "OK: $dest"
done
