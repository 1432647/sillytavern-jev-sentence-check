"""模型注册表与下载引擎。

设计要点：

* **下载由后端执行**，不在浏览器里做。理由：没有 CORS 限制、能断点续传、
  能上报进度、落盘位置就是后端要用的位置。而且它天然满足「必须先装好后端」这个前提。
* **默认走魔搭**。实测这台机器上抱脸直接连不通（fetch failed），
  所以备用通道只是「给用户一个选项」，绝不自动切换。
* 只依赖标准库（`urllib`），不引入 requests 之类的额外依赖。

魔搭接口实测结论（2026-09-30）：
  - 列文件：GET /api/v1/models/{ns}/{name}/repo/files?Revision=master  → Data.Files[{Path, Size}]
  - 下文件：GET /models/{ns}/{name}/resolve/master/{path}              → 支持 Range（HTTP 206）
  注意：`resolve` 直链带 `Access-Control-Allow-Origin: *`，
  而 `/api/v1/.../repo?FilePath=` 不带 —— 所以如果哪天要改回浏览器下载，只能用前者。
"""

from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

MODELSCOPE_BASE = "https://www.modelscope.cn"
HUGGINGFACE_BASE = "https://huggingface.co"
JSON_TIMEOUT = 30
CHUNK_SIZE = 1024 * 1024

DEFAULT_MIRROR = "modelscope"

#: 三种可选模型。约数仅用于界面提示，实际大小以远端列表为准。
MODEL_REGISTRY = (
    {
        "id": "jev-novel-2-0.8b-bf16",
        "label": "JEVnovel 2 · 0.8B",
        "note": "最快，约 1.4 GB，单句约 190 ms（推荐）",
        "modelscope": "alkaid55555/jev-novel-2-0.8b-bf16",
        "huggingface": "aikexue170/jev-novel-2-0.8b-bf16",
    },
    {
        "id": "jev-novel-2-4b-bf16",
        "label": "JEVnovel 2 · 4B",
        "note": "更准，约 8 GB，显存占用更高",
        "modelscope": "alkaid55555/jev-novel-2-4b-bf16",
        "huggingface": "aikexue170/jev-novel-2-4b-bf16",
    },
    {
        "id": "jev-novel-2-27b-bf16",
        "label": "JEVnovel 2 · 27B",
        "note": "判断最细腻，但需要很大的显存，6 GB 显卡跑不动",
        "modelscope": "alkaid55555/jev-novel-2-27b-bf16",
        "huggingface": "aikexue170/jev-novel-2-27b-bf16",
    },
)

MIRRORS = {
    "modelscope": {
        "label": "魔搭 ModelScope（默认，国内直连）",
        "note": "实测可用，支持断点续传",
    },
    "huggingface": {
        "label": "HuggingFace（备用，国内通常需要代理）",
        "note": "本机实测连不通；仅在你自有代理时使用，插件不会自动切换",
    },
}


class ModelError(RuntimeError):
    """模型相关的可读错误。"""


def find_model(model_id: str) -> dict:
    for model in MODEL_REGISTRY:
        if model["id"] == model_id:
            return model
    raise ModelError(f"未知的模型：{model_id!r}")


def resolve_repo(model_id: str, mirror: str) -> str:
    model = find_model(model_id)
    if mirror not in model:
        raise ModelError(f"模型 {model_id} 在 {mirror} 上没有配置仓库地址。")
    return model[mirror]


def file_url(mirror: str, repo: str, path: str) -> str:
    """单个文件的直链。两个镜像都支持 Range，可断点续传。"""
    quoted = urllib.parse.quote(path)
    if mirror == "huggingface":
        return f"{HUGGINGFACE_BASE}/{repo}/resolve/main/{quoted}"
    return f"{MODELSCOPE_BASE}/{repo}/resolve/master/{quoted}"


def list_url(mirror: str, repo: str) -> str:
    """列出仓库里所有文件的接口。"""
    if mirror == "huggingface":
        return f"{HUGGINGFACE_BASE}/api/models/{repo}/tree/main?recursive=true"
    return f"{MODELSCOPE_BASE}/api/v1/models/{repo}/repo/files?Revision=master"


def parse_file_list(mirror: str, payload) -> list[dict]:
    """把两个镜像各不相同的列表响应归一化成 [{path, size}]。

    魔搭：{ Data: { Files: [ {Path, Size, ...} ] } }
    抱脸：[ {type: 'file', path, size} ]（目录项 type='directory'）
    """
    out: list[dict] = []

    if mirror == "huggingface":
        if not isinstance(payload, list):
            raise ModelError("抱脸返回的文件列表结构不符合预期。")
        for item in payload:
            if not isinstance(item, dict) or item.get("type") != "file":
                continue
            path = item.get("path")
            if isinstance(path, str) and path != "":
                out.append({"path": path, "size": int(item.get("size") or 0)})
        return out

    files = None
    if isinstance(payload, dict):
        data = payload.get("Data")
        if isinstance(data, dict):
            files = data.get("Files")
    if not isinstance(files, list):
        raise ModelError("魔搭返回的文件列表结构不符合预期。")

    for item in files:
        if not isinstance(item, dict):
            continue
        path = item.get("Path") or item.get("path")
        if isinstance(path, str) and path != "":
            out.append({"path": path, "size": int(item.get("Size") or item.get("size") or 0)})
    return out


def _get_json(url: str):
    request = urllib.request.Request(url, headers={"User-Agent": "jev-sentence-check"})
    with urllib.request.urlopen(request, timeout=JSON_TIMEOUT) as response:
        return json.loads(response.read().decode("utf-8"))


def list_remote_files(model_id: str, mirror: str = DEFAULT_MIRROR) -> list[dict]:
    repo = resolve_repo(model_id, mirror)
    try:
        payload = _get_json(list_url(mirror, repo))
    except urllib.error.URLError as exc:
        hint = "（抱脸在国内通常需要代理）" if mirror == "huggingface" else ""
        raise ModelError(f"拉取文件列表失败：{exc.reason if hasattr(exc, 'reason') else exc}{hint}") from exc
    files = parse_file_list(mirror, payload)
    if not files:
        raise ModelError("远端返回的文件列表是空的。")
    return files


def model_dir(target_root: str, model_id: str) -> Path:
    return Path(target_root).expanduser().resolve() / model_id


def is_installed(target_root: str, model_id: str) -> bool:
    """判定标准：目录里同时有 config.json 和 infer.py ——
    前者决定模型结构，后者是自定义架构的唯一推理实现，缺一个都跑不起来。"""
    directory = model_dir(target_root, model_id)
    return (directory / "config.json").is_file() and (directory / "infer.py").is_file()


# --------------------------------------------------------------- 下载任务


class DownloadJob:
    """一次模型下载的状态机。线程安全，供 /download_status 轮询。"""

    def __init__(self, model_id: str, mirror: str, target_root: str):
        self.model_id = model_id
        self.mirror = mirror
        self.target = model_dir(target_root, model_id)
        self.state = "pending"          # pending | listing | downloading | done | failed | cancelled
        self.error: str | None = None
        self.message = "准备中"
        self.files: list[dict] = []
        self.total_bytes = 0
        self.done_bytes = 0
        self.current_file: str | None = None
        self.started_at = time.time()
        self.finished_at: float | None = None
        self._cancel = threading.Event()

    def cancel(self) -> None:
        self._cancel.set()

    @property
    def cancelled(self) -> bool:
        return self._cancel.is_set()

    def snapshot(self) -> dict:
        percent = round(self.done_bytes / self.total_bytes * 100, 1) if self.total_bytes > 0 else 0.0
        return {
            "state": self.state,
            "model": self.model_id,
            "mirror": self.mirror,
            "target": str(self.target),
            "message": self.message,
            "error": self.error,
            "fileCount": len(self.files),
            "currentFile": self.current_file,
            "totalBytes": self.total_bytes,
            "doneBytes": self.done_bytes,
            "percent": percent,
            "elapsedSeconds": round((self.finished_at or time.time()) - self.started_at, 1),
        }


def _download_one(url: str, dest: Path, on_bytes, should_cancel) -> None:
    """下载单个文件，支持断点续传。

    dest 已存在时用 Range 续传；万一服务端无视 Range 返回了 200，
    必须把文件截断重写，否则会得到「前半段重复」的坏文件。
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    existing = dest.stat().st_size if dest.exists() else 0

    headers = {"User-Agent": "jev-sentence-check"}
    if existing > 0:
        headers["Range"] = f"bytes={existing}-"

    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=60) as response:
        if existing > 0 and getattr(response, "status", 200) != 206:
            existing = 0
            mode = "wb"
        else:
            mode = "ab" if existing > 0 else "wb"

        with open(dest, mode) as handle:
            while True:
                if should_cancel():
                    raise ModelError("已取消。")
                chunk = response.read(CHUNK_SIZE)
                if not chunk:
                    break
                handle.write(chunk)
                on_bytes(len(chunk))


def run_download(job: DownloadJob) -> None:
    """在后台线程里跑。所有异常都收敛成 job.state = 'failed'。"""
    try:
        job.state = "listing"
        job.message = "正在获取文件列表…"
        job.files = list_remote_files(job.model_id, job.mirror)
        job.total_bytes = sum(f["size"] for f in job.files)

        repo = resolve_repo(job.model_id, job.mirror)
        job.target.mkdir(parents=True, exist_ok=True)

        job.state = "downloading"

        # 先把「本地已存在的部分」一次性计入进度，这样断点续传时进度条是准的，
        # 后面循环里就不要再为跳过的文件重复计数。
        job.done_bytes = 0
        existing_sizes: dict[str, int] = {}
        for item in job.files:
            dest = job.target / item["path"]
            size = dest.stat().st_size if dest.exists() else 0
            if item["size"] > 0:
                size = min(size, item["size"])
            existing_sizes[item["path"]] = size
            job.done_bytes += size

        for index, item in enumerate(job.files, start=1):
            if job.cancelled:
                job.state = "cancelled"
                job.message = "已取消"
                job.finished_at = time.time()
                return

            path = item["path"]
            job.current_file = path
            job.message = f"[{index}/{len(job.files)}] {path}"

            dest = job.target / path
            already = existing_sizes[path]

            if item["size"] > 0 and already >= item["size"]:
                # 上次已经下完整了，进度也在上面计过了，直接跳过
                continue

            def on_bytes(count):
                job.done_bytes += count

            try:
                _download_one(file_url(job.mirror, repo, path), dest, on_bytes, lambda: job.cancelled)
            except ModelError:
                job.state = "cancelled"
                job.message = "已取消"
                job.finished_at = time.time()
                return
            except Exception as exc:  # noqa: BLE001
                raise ModelError(f"下载 {path} 失败：{exc}") from exc

            if item["size"] > 0:
                actual = dest.stat().st_size
                if actual != item["size"]:
                    raise ModelError(f"{path} 大小不符：期望 {item['size']}，实际 {actual}。可重试续传。")

        job.state = "done"
        job.message = "下载完成"
        job.current_file = None
        job.finished_at = time.time()
    except Exception as exc:  # noqa: BLE001
        job.state = "failed"
        job.error = str(exc)
        job.message = "下载失败"
        job.finished_at = time.time()


class DownloadManager:
    """同一时刻只允许一个下载任务，避免把磁盘和带宽打满。"""

    def __init__(self):
        self._lock = threading.Lock()
        self._job: DownloadJob | None = None

    def start(self, model_id: str, mirror: str, target_root: str, force: bool = False) -> dict:
        if mirror not in MIRRORS:
            raise ModelError(f"未知的下载源：{mirror!r}")

        with self._lock:
            if self._job is not None and self._job.state in ("listing", "downloading", "pending"):
                raise ModelError("已有一个下载任务在进行中，请等它结束或先取消。")

            if not force and is_installed(target_root, model_id):
                raise ModelError(f"{model_id} 已经装好了，无需重复下载。")

            job = DownloadJob(model_id, mirror, target_root)
            self._job = job
            threading.Thread(target=run_download, args=(job,), name="jev-download", daemon=True).start()
            return job.snapshot()

    def status(self) -> dict | None:
        with self._lock:
            return self._job.snapshot() if self._job is not None else None

    def cancel(self) -> dict | None:
        with self._lock:
            if self._job is None:
                return None
            self._job.cancel()
            return self._job.snapshot()
