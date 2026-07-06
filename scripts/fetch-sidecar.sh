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

echo "下载 ${ASSET} ${VERSION} (国内网络请先 export HTTPS_PROXY=...)"
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
