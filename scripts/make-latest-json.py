#!/usr/bin/env python3
"""生成 tauri-plugin-updater 的 latest.json 清单。

用法: python3 scripts/make-latest-json.py <tag> [notes]
前提: 已用签名 env 跑完两个平台的 tauri build（createUpdaterArtifacts=true）。
注意: GitHub 会把 release 资产文件名里的空格替换成点（"Ever Pretty_..." →
"Ever.Pretty_..."），下载 URL 必须按替换后的名字拼。
"""
import json
import pathlib
import subprocess
import sys

REPO = "LumingMelody/codewhale-gui"
ROOT = pathlib.Path(__file__).resolve().parent.parent

def main() -> None:
    tag = sys.argv[1]
    notes = sys.argv[2] if len(sys.argv) > 2 else ""
    conf = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text())
    version = conf["version"]
    name = conf["productName"]

    artifacts = {
        "darwin-aarch64": ROOT
        / f"src-tauri/target/release/bundle/macos/{name}.app.tar.gz",
        "windows-x86_64": ROOT
        / f"src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/{name}_{version}_x64-setup.exe",
    }

    platforms = {}
    for key, path in artifacts.items():
        sig = path.with_name(path.name + ".sig")
        if not path.exists() or not sig.exists():
            sys.exit(f"缺少产物或签名: {path} / {sig}")
        gh_asset_name = path.name.replace(" ", ".")
        platforms[key] = {
            "signature": sig.read_text().strip(),
            "url": f"https://github.com/{REPO}/releases/download/{tag}/{gh_asset_name}",
        }

    pub_date = subprocess.run(
        ["date", "-u", "+%Y-%m-%dT%H:%M:%SZ"], capture_output=True, text=True
    ).stdout.strip()

    out = ROOT / "latest.json"
    out.write_text(
        json.dumps(
            {
                "version": version,
                "notes": notes,
                "pub_date": pub_date,
                "platforms": platforms,
            },
            indent=2,
        )
        + "\n"
    )
    print(f"OK: {out} (version={version}, tag={tag})")


if __name__ == "__main__":
    main()
