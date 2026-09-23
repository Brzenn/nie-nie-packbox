# 成贤课程资料库 — PyInstaller 打包脚本
# 用法:  在已安装 pyinstaller 的环境里运行:  python build_app.py
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
APP_NAME = "成贤课程资料库"

ASSETS = [
    "index.html",
    "app.js",
    "styles.css",
    "viewer.html",
    "viewer.js",
]


def main() -> None:
    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        print("请先安装 PyInstaller:  python -m pip install pyinstaller")
        sys.exit(1)

    args = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--windowed",
        "--name",
        APP_NAME,
        "--distpath",
        str(DIST / APP_NAME),
        "--workpath",
        str(ROOT / "build" / "work"),
        "--specpath",
        str(ROOT / "build"),
    ]
    for name in ASSETS:
        args += ["--add-data", f"{ROOT / name};."]
    vendor = ROOT / "vendor"
    if vendor.exists():
        args += ["--add-data", f"{vendor};vendor"]
    args.append(str(ROOT / "server.py"))
    print("run:", " ".join(args))
    subprocess.check_call(args)
    out = DIST / APP_NAME
    print("\n打包完成:", out)
    print("双击其中的 成贤课程资料库.exe 即可使用")


if __name__ == "__main__":
    main()
