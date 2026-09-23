#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""成贤课程资料库 — 本地下载与浏览.

用法（任选其一）:
    双击 start.bat
    python server.py

启动后会自动打开浏览器。资料保存在本目录 课程资源/，结构与线上资料库一致。
仅依赖 Python 标准库。
"""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import socket
import sys
import threading
import time
import traceback
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

HOST = "127.0.0.1"
PORT = int(os.environ.get("PORT", "8765"))
BASE_DIR = Path(__file__).resolve().parent
RESOURCE_ROOT = BASE_DIR / "课程资源"
API_BASE = "https://openlist.truraly.fun"
REMOTE_ROOT = "/成贤学院课程攻略共享计划/资料库"

JOBS: dict[str, dict[str, Any]] = {}
JOBS_LOCK = threading.Lock()
_JOB_SEQ = 0


def _api(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        API_BASE + path,
        data=data,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        body = resp.read().decode("utf-8", errors="replace")
    json_body = json.loads(body)
    if json_body.get("code") != 200:
        raise RuntimeError(json_body.get("message") or "远程接口失败")
    return json_body.get("data") or {}


def remote_list(path: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    page = 1
    while True:
        data = _api("/api/fs/list", {"path": path, "page": page, "per_page": 100})
        content = data.get("content") or []
        items.extend(content)
        total = data.get("total") or len(items)
        if len(items) >= total or not content:
            break
        page += 1
    return items


def remote_raw_url(path: str) -> tuple[str, int]:
    data = _api("/api/fs/get", {"path": path})
    raw = data.get("raw_url") or ""
    if not raw:
        raise RuntimeError("无下载链接")
    return raw, int(data.get("size") or 0)


def download_raw_to(raw_url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    req = urllib.request.Request(raw_url, headers={"User-Agent": "chengxian-course-tool/1.0"})
    with urllib.request.urlopen(req, timeout=300) as resp, open(tmp, "wb") as f:
        while True:
            chunk = resp.read(1024 * 256)
            if not chunk:
                break
            f.write(chunk)
    tmp.replace(dest)


def safe_rel_parts(rel: str) -> list[str]:
    rel = rel.replace("\\", "/").strip("/")
    return [p for p in rel.split("/") if p and p not in (".", "..")]


def local_path_for(rel: str) -> Path:
    parts = safe_rel_parts(rel)
    return RESOURCE_ROOT.joinpath(*parts) if parts else RESOURCE_ROOT


def walk_remote(rel: str, on_progress=None) -> list[dict[str, Any]]:
    remote_dir = f"{REMOTE_ROOT}/{rel}" if rel else REMOTE_ROOT
    out: list[dict[str, Any]] = []

    def walk(dir_remote: str, dir_rel: str) -> None:
        for item in remote_list(dir_remote):
            name = item.get("name") or ""
            child_rel = f"{dir_rel}/{name}" if dir_rel else name
            child_remote = f"{dir_remote}/{name}"
            if item.get("is_dir"):
                if on_progress:
                    on_progress(f"扫描 {child_rel}")
                walk(child_remote, child_rel)
            else:
                if on_progress:
                    on_progress(f"扫描 {child_rel}")
                out.append(
                    {
                        "rel": child_rel,
                        "remote": child_remote,
                        "name": name,
                        "size": int(item.get("size") or 0),
                    }
                )

    walk(remote_dir, rel)
    return out


def new_job(kind: str, label: str) -> str:
    global _JOB_SEQ
    with JOBS_LOCK:
        _JOB_SEQ += 1
        job_id = f"job{_JOB_SEQ}"
        JOBS[job_id] = {
            "id": job_id,
            "kind": kind,
            "label": label,
            "state": "running",
            "message": "准备中…",
            "done": 0,
            "total": 0,
            "bytes": 0,
            "errors": [],
            "saved_to": "",
            "finished_at": None,
        }
        return job_id


def update_job(job_id: str, **kwargs: Any) -> None:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job:
            job.update(kwargs)


def append_job_error(job_id: str, message: str) -> None:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job:
            job["errors"].append(message)


def job_snapshot(job_id: str) -> dict[str, Any] | None:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        return dict(job) if job else None


def run_download_job(job_id: str, rel: str, mode: str) -> None:
    try:
        if mode == "file":
            name = rel.rsplit("/", 1)[-1]
            update_job(job_id, total=1, message=f"下载 {name}", saved_to=str(local_path_for(rel)))
            try:
                raw, size = remote_raw_url(f"{REMOTE_ROOT}/{rel}")
                dest = local_path_for(rel)
                download_raw_to(raw, dest)
                update_job(
                    job_id,
                    done=1,
                    bytes=size,
                    state="done",
                    message=f"完成：{name}",
                    finished_at=time.time(),
                )
            except Exception as exc:  # noqa: BLE001
                append_job_error(job_id, f"{rel}: {exc}")
                update_job(job_id, state="error", message=str(exc), finished_at=time.time())
            return

        files = walk_remote(rel, lambda m: update_job(job_id, message=m))
        only_missing = mode in ("update", "only_missing")
        if only_missing:
            existing = local_file_set(rel)
            existing_names = {p.rsplit("/", 1)[-1] for p in existing}
            files = [f for f in files if f["rel"] not in existing and f["name"] not in existing_names]
            update_job(
                job_id,
                total=len(files),
                message=f"新增 {len(files)} 个文件（本地已有跳过）…",
            )
        else:
            update_job(job_id, total=len(files), message=f"共 {len(files)} 个文件，开始写入…")
        if not files:
            update_job(
                job_id,
                state="done",
                message="没有新增文件" if only_missing else "没有文件",
                finished_at=time.time(),
            )
            return

        dest_root = local_path_for(rel)
        update_job(job_id, saved_to=str(dest_root))
        done = 0
        byte_acc = 0
        for f in files:
            try:
                raw, _ = remote_raw_url(f["remote"])
                dest = local_path_for(f["rel"])
                download_raw_to(raw, dest)
                done += 1
                byte_acc += f["size"]
                update_job(
                    job_id,
                    done=done,
                    bytes=byte_acc,
                    message=f"下载 {done}/{len(files)} · {f['name']}",
                )
            except Exception as exc:  # noqa: BLE001
                append_job_error(job_id, f"{f['rel']}: {exc}")
                done += 1
                update_job(job_id, done=done, message=f"失败 {f['name']}")

        dest_root.mkdir(parents=True, exist_ok=True)
        manifest = {
            "source": rel,
            "mode": mode,
            "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "files": [{"rel": f["rel"], "size": f["size"]} for f in files],
        }
        (dest_root / ".manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
        )

        errors = (job_snapshot(job_id) or {}).get("errors") or []
        state = "done" if not errors else "done_with_errors"
        update_job(
            job_id,
            state=state,
            message=f"完成：{done} 个文件 → {dest_root.name}",
            finished_at=time.time(),
        )
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        update_job(job_id, state="error", message=str(exc), finished_at=time.time())


def list_local(rel: str = "") -> dict[str, Any]:
    root = local_path_for(rel)
    if not root.exists():
        return {"path": rel, "exists": False, "entries": []}
    entries = []
    for child in sorted(root.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
        if child.name.startswith("."):
            continue
        child_rel = f"{rel}/{child.name}" if rel else child.name
        entries.append(
            {
                "name": child.name,
                "rel": child_rel.replace("\\", "/"),
                "is_dir": child.is_dir(),
                "size": child.stat().st_size if child.is_file() else 0,
            }
        )
    return {"path": rel, "exists": True, "entries": entries}


def local_file_set(rel: str) -> set[str]:
    """本地已存在文件路径集合，键与 walk_remote 的 f['rel'] 一致。"""
    root = local_path_for(rel)
    out: set[str] = set()
    if not root.exists():
        return out
    for p in root.rglob("*"):
        if not p.is_file() or p.name.startswith(".") or p.name == ".manifest.json":
            continue
        inner = str(p.relative_to(root)).replace("\\", "/")
        out.add(f"{rel}/{inner}" if rel else inner)
    return out


def sync_check(rel: str) -> dict[str, Any]:
    """对比资料库与本地：只找新增，不标记删除。"""
    remote_files = walk_remote(rel)
    remote_names = [f["rel"] for f in remote_files]
    local_names = sorted(local_file_set(rel))
    remote_set = set(remote_names)
    local_set = set(local_names)
    new_files = sorted(remote_set - local_set)
    # 用户要求：文件名相同即可视为已有
    local_basenames = {n.rsplit("/", 1)[-1] for n in local_names}
    new_by_name = sorted(
        {n for n in remote_names if n.rsplit("/", 1)[-1] not in local_basenames}
    )
    # 更新判定以「文件名」为准（同名已有则跳过）
    if local_names:
        actionable = new_by_name
    else:
        actionable = new_files
    complete = not actionable
    has_local = bool(local_names) or local_path_for(rel).exists()
    return {
        "rel": rel,
        "remote_count": len(remote_files),
        "local_count": len(local_names),
        "new_files": actionable,
        "new_count": len(actionable),
        "new_by_name_count": len(new_by_name),
        "complete": complete,
        "has_local": has_local,
    }


# ---------- 预览 / 文档转换 ----------

PREVIEW_CACHE = RESOURCE_ROOT / ".preview"
OFFICE_EXT = {".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".odt", ".odp", ".ods"}
ZIP_OFFICE_EXT = {".docx", ".pptx", ".xlsx", ".odt", ".odp", ".ods"}
LEGACY_OFFICE_EXT = {".doc", ".ppt", ".xls"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico"}
VIDEO_EXT = {".mp4", ".webm", ".mov", ".m4v", ".ogv", ".mkv"}
AUDIO_EXT = {".mp3", ".wav", ".ogg", ".m4a", ".flac"}
TEXT_EXT = {".txt", ".md", ".markdown", ".csv", ".json", ".log", ".yml", ".yaml", ".xml", ".html", ".htm", ".css", ".js", ".py", ".java", ".c", ".cpp", ".h"}


def ensure_local_copy(rel: str) -> Path:
    dest = local_path_for(rel)
    if dest.exists() and dest.is_file():
        return dest
    raw, _ = remote_raw_url(f"{REMOTE_ROOT}/{rel}")
    download_raw_to(raw, dest)
    return dest


def hashlib_md5(s: str) -> str:
    return hashlib.md5(s.encode("utf-8", errors="replace")).hexdigest()[:16]


def html_escape(s: str) -> str:
    return (
        str(s)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def guess_inline_type(name: str) -> str:
    return mimetypes.guess_type(name)[0] or "application/octet-stream"


class Handler(BaseHTTPRequestHandler):
    server_version = "ChengXianCourse/2.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, code: int, body: bytes, content_type: str, extra: dict[str, str] | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj: Any, code: int = 200) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self._send(code, body, "application/json; charset=utf-8")

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def _serve_file(self, fp: Path, download_name: str | None = None) -> None:
        if not fp.exists() or not fp.is_file():
            self._json({"error": "not found"}, 404)
            return
        ctype = mimetypes.guess_type(fp.name)[0] or "application/octet-stream"
        data = fp.read_bytes()
        name = download_name or fp.name
        self._send(
            200,
            data,
            ctype,
            {"Content-Disposition": f"inline; filename*=UTF-8''{urllib.parse.quote(name)}"},
        )

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(parsed.path)
        query = urllib.parse.parse_qs(parsed.query)

        try:
            if path in ("/", "/index.html"):
                self._serve_file(BASE_DIR / "index.html")
                return
            if path == "/viewer.html":
                self._serve_file(BASE_DIR / "viewer.html")
                return
            if path == "/viewer.js":
                self._serve_file(BASE_DIR / "viewer.js")
                return
            if path == "/styles.css":
                self._serve_file(BASE_DIR / "styles.css")
                return
            if path == "/app.js":
                self._serve_file(BASE_DIR / "app.js")
                return
            if path.startswith("/vendor/"):
                rel = path[len("/vendor/") :]
                fp = (BASE_DIR / "vendor" / rel).resolve()
                vendor_root = (BASE_DIR / "vendor").resolve()
                if not str(fp).startswith(str(vendor_root)):
                    self._json({"error": "bad path"}, 400)
                    return
                self._serve_file(fp)
                return

            if path == "/api/ping":
                self._json(
                    {
                        "ok": True,
                        "resource_root": str(RESOURCE_ROOT),
                        "remote_root": REMOTE_ROOT,
                        "api_base": API_BASE,
                    }
                )
                return

            if path == "/api/download/status":
                job_id = (query.get("id") or [""])[0]
                job = job_snapshot(job_id)
                if not job:
                    self._json({"error": "job not found"}, 404)
                else:
                    self._json(job)
                return

            if path == "/api/local/list":
                rel = (query.get("path") or [""])[0]
                self._json(list_local(rel))
                return

            if path.startswith("/local/"):
                rel = path[len("/local/") :]
                fp = local_path_for(rel)
                self._serve_file(fp)
                return

            if path == "/api/file":
                rel = (query.get("rel") or [""])[0]
                force = (query.get("src") or ["auto"])[0]  # auto|local|remote
                fp = local_path_for(rel)
                if force != "remote" and fp.exists() and fp.is_file():
                    self._serve_file(fp)
                    return
                if force == "local":
                    self._json({"error": "本地不存在"}, 404)
                    return
                raw, _ = remote_raw_url(f"{REMOTE_ROOT}/{rel}")
                req = urllib.request.Request(
                    raw, headers={"User-Agent": "chengxian-course-tool/1.0"}
                )
                with urllib.request.urlopen(req, timeout=300) as resp:
                    data = resp.read()
                self._send(200, data, guess_inline_type(rel))
                return

            if path == "/api/preview":
                """浏览器可直接看的类型内联返回；Office 不在网页转换。"""
                rel = (query.get("rel") or [""])[0]
                name = rel.rsplit("/", 1)[-1]
                ext = Path(name).suffix.lower()
                if ext in OFFICE_EXT:
                    self._json(
                        {"error": "请使用本机程序打开该文档", "rel": rel},
                        200,
                    )
                    return
                # 其他类型直接给原始字节（内联）
                fp = local_path_for(rel)
                if not fp.exists():
                    raw, _ = remote_raw_url(f"{REMOTE_ROOT}/{rel}")
                    req = urllib.request.Request(
                        raw, headers={"User-Agent": "chengxian-course-tool/1.0"}
                    )
                    with urllib.request.urlopen(req, timeout=300) as resp:
                        data = resp.read()
                    self._send(200, data, guess_inline_type(name))
                    return
                self._serve_file(fp)
                return

            self._json({"error": "not found"}, 404)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            self._json({"error": str(exc)}, 500)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        try:
            body = self._read_json()

            if path == "/api/sync/check":
                rel = (body.get("rel") or "").replace("\\", "/").strip("/")
                self._json(sync_check(rel))
                return

            if path == "/api/remote/list":
                remote_path = body.get("path") or REMOTE_ROOT
                # 允许相对路径（课程名），自动补全资料库根
                if remote_path and not remote_path.startswith("/"):
                    remote_path = f"{REMOTE_ROOT}/{remote_path}"
                items = remote_list(remote_path)
                slim = [
                    {
                        "name": it.get("name"),
                        "is_dir": bool(it.get("is_dir")),
                        "size": int(it.get("size") or 0),
                    }
                    for it in items
                ]
                slim.sort(key=lambda x: (not x["is_dir"], x["name"].lower()))
                self._json({"items": slim})
                return

            if path == "/api/open-folder":
                rel = (body.get("rel") or "").replace("\\", "/").strip("/")
                folder = local_path_for(rel)
                if not folder.exists():
                    folder.mkdir(parents=True, exist_ok=True)
                if sys.platform.startswith("win"):
                    os.startfile(str(folder))  # noqa: S606
                elif sys.platform == "darwin":
                    import subprocess

                    subprocess.Popen(["open", str(folder)])
                else:
                    import subprocess

                    subprocess.Popen(["xdg-open", str(folder)])
                self._json({"ok": True, "path": str(folder)})
                return

            if path == "/api/open":
                """取到本地后用系统默认程序打开。"""
                rel = (body.get("rel") or "").replace("\\", "/").strip("/")
                try:
                    fp = local_path_for(rel)
                    if not fp.exists() or not fp.is_file():
                        fp = ensure_local_copy(rel)
                except Exception as exc:  # noqa: BLE001
                    self._json({"error": f"获取文件失败：{exc}"}, 500)
                    return
                opened = False
                if sys.platform.startswith("win"):
                    try:
                        os.startfile(str(fp))  # noqa: S606
                        opened = True
                    except Exception as exc:  # noqa: BLE001
                        self._json({"error": f"无法打开：{exc}"}, 500)
                        return
                elif sys.platform == "darwin":
                    import subprocess

                    subprocess.Popen(["open", str(fp)])
                    opened = True
                else:
                    import subprocess

                    subprocess.Popen(["xdg-open", str(fp)])
                    opened = True
                self._json({"ok": True, "path": str(fp), "opened": opened})
                return

            if path == "/api/download/start":
                rel = (body.get("rel") or "").replace("\\", "/").strip("/")
                mode = body.get("mode") or "tree"
                if body.get("only_missing"):
                    mode = "update"
                label = body.get("label") or (rel or "资料库")
                job_id = new_job(mode, label)
                update_job(job_id, saved_to=str(local_path_for(rel)))
                threading.Thread(
                    target=run_download_job, args=(job_id, rel, mode), daemon=True
                ).start()
                self._json({"id": job_id})
                return

            self._json({"error": "not found"}, 404)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            self._json({"error": str(exc)}, 500)


def port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((HOST, port))
            return True
        except OSError:
            return False


def find_port(start: int, tries: int = 10) -> int:
    for p in range(start, start + tries):
        if port_free(p):
            return p
    raise RuntimeError(f"端口 {start}~{start + tries - 1} 都被占用，请关闭占用程序后重试")


def main() -> None:
    # 支持从任意工作目录启动
    os.chdir(BASE_DIR)
    RESOURCE_ROOT.mkdir(parents=True, exist_ok=True)

    global PORT
    PORT = find_port(PORT)
    url = f"http://{HOST}:{PORT}"

    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    print("=" * 48)
    print("  成贤课程资料库 2.x（本地服务版）")
    print("=" * 48)
    print(f"  界面地址:  {url}")
    print(f"  资料目录:  {RESOURCE_ROOT}")
    print("  关闭本窗口或 Ctrl+C 退出")
    print("=" * 48)

    # 自动打开浏览器（失败不影响使用）
    try:
        webbrowser.open(url)
    except Exception:
        pass

    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        print("\n已退出")
    finally:
        httpd.shutdown()


if __name__ == "__main__":
    main()
