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

import json
import mimetypes
import re
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
DEFAULT_RESOURCE_ROOT = BASE_DIR / "课程资源"
CONFIG_FILE = BASE_DIR / "config.json"
LOG_FILE = BASE_DIR / "server.log"
API_BASE = "https://openlist.truraly.fun"
REMOTE_ROOT = "/成贤学院课程攻略共享计划/资料库"
# 页面心跳丢失后无任务则退出；页面主动「离开」时用更短的 LEAVE_EXIT_SEC
IDLE_EXIT_SEC = 30
LEAVE_EXIT_SEC = 5

JOBS: dict[str, dict[str, Any]] = {}
JOBS_LOCK = threading.Lock()
_JOB_SEQ = 0
LAST_HEARTBEAT = 0.0
HEARTBEAT_SEEN = False
LEAVE_AT = 0.0  # >0 表示页面发过离开信号
_SHUTDOWN = threading.Event()


def load_config() -> dict[str, Any]:
    try:
        if CONFIG_FILE.exists():
            return json.loads(CONFIG_FILE.read_text(encoding="utf-8") or "{}")
    except Exception:
        pass
    return {}


def save_config(cfg: dict[str, Any]) -> None:
    CONFIG_FILE.write_text(
        json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _resource_root_from_config() -> Path:
    cfg = load_config()
    raw = (cfg.get("resource_root") or "").strip()
    if raw:
        p = Path(raw).expanduser()
        try:
            return p.resolve()
        except Exception:
            return DEFAULT_RESOURCE_ROOT.resolve()
    return DEFAULT_RESOURCE_ROOT.resolve()


RESOURCE_ROOT = _resource_root_from_config()


def set_resource_root(new_root: Path) -> None:
    global RESOURCE_ROOT
    RESOURCE_ROOT = new_root.resolve()
    cfg = load_config()
    cfg["resource_root"] = str(RESOURCE_ROOT)
    save_config(cfg)


def migrate_to_new_root(new_root: Path) -> dict[str, Any]:
    """把现有资源整体搬到新目录（移动文件），并切换索引。程序自身不迁移。"""
    import shutil

    global RESOURCE_ROOT
    old = RESOURCE_ROOT.resolve()
    new = new_root.resolve()
    if old == new:
        return {"migrated": 0, "bytes": 0, "resource_root": str(new), "changed": False}
    # 防止嵌套迁移导致自毁
    if new in old.parents or old in new.parents:
        raise ValueError("新旧目录不能互相包含")

    new.mkdir(parents=True, exist_ok=True)
    moved = 0
    total = 0
    for src in list(old.rglob("*")):
        if not src.is_file():
            continue
        rel = src.relative_to(old)
        dest = new / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dest))
        moved += 1
        try:
            total += dest.stat().st_size
        except OSError:
            pass
    # 清理旧目录（只删空的残留文件夹；根目录若变空也删掉）
    for dirpath, dirnames, filenames in os.walk(old, topdown=False):
        p = Path(dirpath)
        try:
            if not any(p.iterdir()):
                p.rmdir()
        except OSError:
            pass
    set_resource_root(new)
    return {"migrated": moved, "bytes": total, "resource_root": str(new), "changed": True}


def pick_folder_dialog(initial: str | None = None) -> str | None:
    """弹出系统文件夹选择框（Windows），返回路径或 None。"""
    if sys.platform.startswith("win"):
        script = r"""
Add-Type -AssemblyName System.Windows.Forms
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = '选择课程资源保存位置'
$dlg.ShowNewFolderButton = $true
if ($args.Count -gt 0 -and $args[0]) { $dlg.SelectedPath = $args[0] }
if ($dlg.ShowDialog() -eq 'OK') { [Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output $dlg.SelectedPath }
"""
        try:
            import subprocess

            r = subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-Command", script, initial or ""],
                capture_output=True,
                text=True,
                timeout=120,
                encoding="utf-8",
                errors="replace",
            )
            out = (r.stdout or "").strip()
            return out or None
        except Exception:
            traceback.print_exc()
            return None
    return None


def log(msg: str) -> None:
    line = f"{time.strftime('%H:%M:%S')} {msg}"
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass
    try:
        sys.stderr.write(line + "\n")
    except Exception:
        pass


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
    try:
        req = urllib.request.Request(
            raw_url, headers={"User-Agent": "chengxian-course-tool/1.0"}
        )
        with urllib.request.urlopen(req, timeout=300) as resp, open(tmp, "wb") as f:
            while True:
                chunk = resp.read(1024 * 256)
                if not chunk:
                    break
                f.write(chunk)
        tmp.replace(dest)
    except Exception:
        try:
            tmp.unlink(missing_ok=True)
        except Exception:
            pass
        raise


def safe_rel_parts(rel: str) -> list[str]:
    rel = (rel or "").replace("\\", "/").strip("/")
    out = []
    for p in rel.split("/"):
        if not p or p in (".", ".."):
            continue
        # 去掉 Windows 盘符式段，防止 joinpath 逃出资源目录
        if ":" in p:
            p = p.replace(":", "_")
        out.append(p)
    return out


def local_path_for(rel: str) -> Path:
    parts = safe_rel_parts(rel)
    base = RESOURCE_ROOT.resolve()
    target = base.joinpath(*parts) if parts else base
    resolved = target.resolve()
    if resolved != base and base not in resolved.parents:
        raise ValueError(f"非法路径: {rel}")
    return resolved


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
            # 按相对路径跳过已有文件；同名不同路径仍会下载，保留目录结构
            existing = local_file_set(rel)
            files = [f for f in files if f["rel"] not in existing]
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


SYNC_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
SYNC_CACHE_TTL = 8.0


def sync_check(rel: str) -> dict[str, Any]:
    """对比资料库与本地：只找新增，不标记删除。带短缓存，避免反复扫远端。"""
    now = time.time()
    hit = SYNC_CACHE.get(rel)
    if hit and now - hit[0] < SYNC_CACHE_TTL:
        return hit[1]
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
    result = {
        "rel": rel,
        "remote_count": len(remote_files),
        "local_count": len(local_names),
        "new_files": actionable,
        "new_count": len(actionable),
        "new_by_name_count": len(new_by_name),
        "complete": complete,
        "has_local": has_local,
    }
    SYNC_CACHE[rel] = (time.time(), result)
    # 简单上限，避免长期运行膨胀
    if len(SYNC_CACHE) > 64:
        oldest = min(SYNC_CACHE, key=lambda k: SYNC_CACHE[k][0])
        SYNC_CACHE.pop(oldest, None)
    return result


OFFICE_EXT = {".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".odt", ".odp", ".ods"}


def ensure_local_copy(rel: str) -> Path:
    dest = local_path_for(rel)
    if dest.exists() and dest.is_file():
        return dest
    raw, _ = remote_raw_url(f"{REMOTE_ROOT}/{rel}")
    download_raw_to(raw, dest)
    return dest


def guess_inline_type(name: str) -> str:
    return mimetypes.guess_type(name)[0] or "application/octet-stream"


class Handler(BaseHTTPRequestHandler):
    server_version = "ChengXianCourse/2.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        log(f"{self.address_string()} {fmt % args}")

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
        ctype = guess_inline_type(fp.name)
        name = download_name or fp.name
        size = fp.stat().st_size
        # 支持 Range，便于视频拖动进度
        range_header = self.headers.get("Range")
        start, end = 0, size - 1
        status = 200
        if range_header:
            m = re.match(r"bytes=(\d*)-(\d*)", range_header)
            if m:
                if m.group(1):
                    start = int(m.group(1))
                if m.group(2):
                    end = min(int(m.group(2)), size - 1)
                if start <= end and start < size:
                    status = 206
                else:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.end_headers()
                    return
        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header(
            "Content-Disposition",
            f"inline; filename*=UTF-8''{urllib.parse.quote(name)}",
        )
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        try:
            with open(fp, "rb") as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(1024 * 256, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            # 客户端取消下载/关页
            pass

    def do_HEAD(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(parsed.path)
        query = urllib.parse.parse_qs(parsed.query)
        try:
            if path in ("/api/preview", "/api/file", "/local/") or path.startswith("/local/"):
                rel = (query.get("rel") or [""])[0]
                if path.startswith("/local/"):
                    rel = path[len("/local/") :]
                fp = local_path_for(rel)
                if fp.exists() and fp.is_file():
                    self.send_response(200)
                    self.send_header("Content-Type", guess_inline_type(fp.name))
                    self.send_header("Content-Length", str(fp.stat().st_size))
                    self.send_header("Accept-Ranges", "bytes")
                    self.end_headers()
                    return
            self.send_response(404)
            self.end_headers()
        except Exception:
            self.send_response(500)
            self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        global LAST_HEARTBEAT, HEARTBEAT_SEEN, LEAVE_AT
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
                        "idle_exit_sec": IDLE_EXIT_SEC,
                    }
                )
                return

            if path in ("/api/goodbye", "/api/heartbeat"):
                LAST_HEARTBEAT = time.time()
                HEARTBEAT_SEEN = True
                if path.endswith("goodbye"):
                    if not LEAVE_AT:
                        LEAVE_AT = time.time()
                else:
                    LEAVE_AT = 0.0
                self._json({"ok": True, "leave_at": LEAVE_AT})
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
                # 流式转发，避免大文件占满内存
                with urllib.request.urlopen(req, timeout=300) as resp:
                    ctype = guess_inline_type(rel)
                    self.send_response(200)
                    self.send_header("Content-Type", ctype)
                    self.send_header("Accept-Ranges", "bytes")
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    try:
                        while True:
                            chunk = resp.read(1024 * 256)
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                    except (BrokenPipeError, ConnectionResetError):
                        pass
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
                fp = local_path_for(rel)
                if fp.exists() and fp.is_file():
                    self._serve_file(fp)
                    return
                raw, _ = remote_raw_url(f"{REMOTE_ROOT}/{rel}")
                req = urllib.request.Request(
                    raw, headers={"User-Agent": "chengxian-course-tool/1.0"}
                )
                with urllib.request.urlopen(req, timeout=300) as resp:
                    self.send_response(200)
                    self.send_header("Content-Type", guess_inline_type(name))
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    try:
                        while True:
                            chunk = resp.read(1024 * 256)
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                    except (BrokenPipeError, ConnectionResetError):
                        pass
                return

            self._json({"error": "not found"}, 404)
        except Exception as exc:  # noqa: BLE001
            if isinstance(exc, ValueError) and "非法路径" in str(exc):
                self._json({"error": "非法路径"}, 400)
                return
            traceback.print_exc()
            try:
                self._json({"error": str(exc)}, 500)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def do_POST(self) -> None:  # noqa: N802
        global LAST_HEARTBEAT, HEARTBEAT_SEEN, LEAVE_AT
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        try:
            if path in ("/api/goodbye", "/api/heartbeat"):
                LAST_HEARTBEAT = time.time()
                HEARTBEAT_SEEN = True
                if path.endswith("goodbye"):
                    if not LEAVE_AT:
                        LEAVE_AT = time.time()
                else:
                    LEAVE_AT = 0.0
                self._json({"ok": True, "leave_at": LEAVE_AT})
                return
            body = self._read_json()

            if path == "/api/sync/check":
                rel = (body.get("rel") or "").replace("\\", "/").strip("/")
                if body.get("force"):
                    SYNC_CACHE.pop(rel, None)
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

            if path == "/api/pick-folder":
                picked = pick_folder_dialog(str(RESOURCE_ROOT))
                self._json({"ok": bool(picked), "path": picked or ""})
                return

            if path == "/api/settings/resource-root":
                raw = (body.get("path") or "").strip()
                if not raw:
                    self._json({"error": "缺少路径"}, 400)
                    return
                try:
                    new_root = Path(raw).expanduser()
                    # 若目标是父目录下的「课程资源」子目录名相同，允许直接使用
                    result = migrate_to_new_root(new_root)
                except ValueError as exc:
                    self._json({"error": str(exc)}, 400)
                    return
                except Exception as exc:  # noqa: BLE001
                    traceback.print_exc()
                    self._json({"error": f"迁移失败：{exc}"}, 500)
                    return
                log(f"resource root -> {result['resource_root']} moved={result['migrated']}")
                self._json(result)
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
            if isinstance(exc, ValueError) and "非法路径" in str(exc):
                self._json({"error": "非法路径"}, 400)
                return
            traceback.print_exc()
            try:
                self._json({"error": str(exc)}, 500)
            except (BrokenPipeError, ConnectionResetError):
                pass


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


def _job_running() -> bool:
    with JOBS_LOCK:
        return any(j.get("state") == "running" for j in JOBS.values())


def _try_existing(url: str) -> bool:
    """若已有实例在跑，只打开浏览器并退出，避免残留双开。"""
    try:
        with urllib.request.urlopen(url + "/api/ping", timeout=1) as r:
            if json.loads(r.read().decode("utf-8", errors="replace")).get("ok"):
                return True
    except Exception:
        return False
    return False


def open_url(u: str) -> None:
    if sys.platform.startswith("win"):
        try:
            os.startfile(u)  # noqa: S606
            return
        except Exception:
            pass
    try:
        webbrowser.open(u)
    except Exception:
        pass


def main() -> None:
    global PORT, LAST_HEARTBEAT, HEARTBEAT_SEEN, LEAVE_AT
    os.chdir(BASE_DIR)
    RESOURCE_ROOT.mkdir(parents=True, exist_ok=True)
    log(f"resource_root={RESOURCE_ROOT}")

    # 单实例：若已有服务在 8765 段上，则复用并退出本进程
    for p in range(8765, 8775):
        if _try_existing(f"http://{HOST}:{p}"):
            log(f"reuse existing :{p}")
            open_url(f"http://{HOST}:{p}")
            return
    PORT = find_port(PORT)
    url = f"http://{HOST}:{PORT}"

    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    log(f"started {url} root={RESOURCE_ROOT}")

    if os.environ.get("NO_BROWSER") != "1":
        threading.Thread(target=open_url, args=(url,), daemon=True).start()

    started = time.time()
    try:
        while True:
            time.sleep(1)
            now = time.time()
            if _job_running():
                continue
            if not HEARTBEAT_SEEN:
                if now - started >= 120:
                    log("no client, exit")
                    break
                continue
            if LEAVE_AT and (now - LEAVE_AT) >= LEAVE_EXIT_SEC:
                log(f"page left {int(now - LEAVE_AT)}s, exit")
                break
            if (now - LAST_HEARTBEAT) >= IDLE_EXIT_SEC:
                log(f"idle {int(now - LAST_HEARTBEAT)}s, exit")
                break
    except KeyboardInterrupt:
        log("keyboard interrupt")
    finally:
        _SHUTDOWN.set()
        try:
            httpd.shutdown()
        except Exception:
            pass
        log("stopped")
        # 桌面小工具：确保进程退出，不残留
        os._exit(0)


if __name__ == "__main__":
    main()
