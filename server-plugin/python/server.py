"""JEVnovel 2 句子质检服务。

两种入口共用同一份推理代码：

  * `--stdio`（默认）：按行读 JSON 请求、按行写 JSON 响应。
    给 SillyTavern 的 Node 服务端插件用 —— 不占端口、无 CORS、无防火墙问题，
    进程生命周期与 SillyTavern 绑定。

  * `--http --port N`：给 TauriTavern（它没有 Express 服务端插件加载器）
    或手工 curl 调试用。

约定：
  * **stdout 只走协议**，所有日志走 stderr。否则会污染 JSONL 流。
  * 协议：请求 `{"id": <any>, "op": "...", ...}` →
    响应 `{"id": <same>, "ok": true, "result": {...}}`
    或   `{"id": <same>, "ok": false, "error": "..."}`
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

# 必须在 import torch 之前设置，见模型仓库 infer.py 的做法
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("FLA_TILELANG", "1")

from jev_runtime import JevRuntime, JevRuntimeError, cuda_report  # noqa: E402
import models  # noqa: E402

DEFAULT_BATCH_SIZE = 8

#: 这些是我们自己抛的「可读错误」，给用户的提示不需要带类名前缀，
#: 也不需要打栈（打出来只会淹没真正的问题）。
EXPECTED_ERRORS = (JevRuntimeError, models.ModelError)


def log(message: str) -> None:
    """日志一律走 stderr，保护 stdout 的 JSONL 协议。"""
    print(f"[jev] {message}", file=sys.stderr, flush=True)


class Service:
    """把运行时包成一组 op，stdio 与 http 两种传输层共用。

    `model_dir` 允许为空——刚装好后端、还没下模型的全新环境必须能先把服务起起来：
    模型下载由后端执行，后端起不来就永远下不了模型（鸡生蛋死锁）。
    无模型时 health/模型管理正常工作，predict 给出可读报错。
    """

    def __init__(self, model_dir: str | Path | None, device: str, batch_size: int,
                 models_root: str | None = None):
        self.device = device
        self.batch_size = batch_size
        self._load_lock = threading.Lock()
        self._loading = False
        self._last_error: str | None = None

        if model_dir:
            resolved = Path(model_dir).expanduser().resolve()
            self.models_root = str(Path(models_root).expanduser().resolve()) if models_root \
                else str(resolved.parent)
            self.runtime: JevRuntime | None = JevRuntime(resolved, device)
        else:
            # 未指定模型：默认落在 server.py 上两级的 models/（独立包布局正好是安装根）
            self.models_root = str(Path(models_root).expanduser().resolve()) if models_root \
                else str(Path(__file__).resolve().parent.parent.parent / "models")
            self.runtime = None
        self.downloads = models.DownloadManager()

    # ------------------------------------------------------------------ ops

    def health(self) -> dict:
        return {
            "ready": bool(self.runtime and self.runtime.is_ready),
            "loading": self._loading,
            "error": self._last_error,
            "model_configured": self.runtime is not None,
            "model_dir": str(self.runtime.model_dir) if self.runtime else "",
            "device": self.device,
            "batch_size": self.batch_size,
            "cuda": cuda_report(),
        }

    def warmup(self) -> dict:
        """非阻塞预热：立刻返回 loading，权重在后台线程里加载。"""
        if self.runtime is None:
            return self.health()
        if self.runtime.is_ready:
            return self.health()

        with self._load_lock:
            if not self._loading:
                self._loading = True
                self._last_error = None
                threading.Thread(target=self._load_worker, name="jev-warmup", daemon=True).start()

        return self.health()

    def _load_worker(self) -> None:
        try:
            log("开始加载模型权重……")
            self.runtime.load()
            log("模型已就绪。")
        except Exception as exc:  # noqa: BLE001
            self._last_error = str(exc)
            log(f"模型加载失败：{exc}")
            log(traceback.format_exc())
        finally:
            self._loading = False

    def predict(self, sentences: list[str], include_ordinal: bool = False, batch_size: int | None = None,
                threshold: float | None = None) -> dict:
        if not isinstance(sentences, list):
            raise JevRuntimeError("sentences 必须是数组。")

        if self.runtime is None:
            raise JevRuntimeError(
                "后端还没有配置模型。请在总控面板「模型」一栏下载一个模型，"
                "下载完成后重启后端即可。")

        # 首次 predict 会阻塞几秒到几十秒，这是预期内的
        if not self.runtime.is_ready:
            self.warmup()
            self.runtime.load()

        size = batch_size if isinstance(batch_size, int) and batch_size > 0 else self.batch_size
        results = self.runtime.predict(sentences, batch_size=size, include_ordinal=include_ordinal,
                                       threshold=threshold)
        return {
            "results": results,
            "count": len(results),
            "threshold": threshold,
            "needs_revision": sum(1 for item in results if item.get("needs_revision")),
        }

    # ------------------------------------------------------------- 模型管理

    def list_models(self) -> dict:
        """可选模型清单 + 本地是否已装 + 下载源。前端据此渲染下拉框。"""
        current = str(self.runtime.model_dir) if self.runtime else ""
        entries = []
        for model in models.MODEL_REGISTRY:
            directory = models.model_dir(self.models_root, model["id"])
            entries.append({
                "id": model["id"],
                "label": model["label"],
                "note": model["note"],
                "installed": models.is_installed(self.models_root, model["id"]),
                "path": str(directory),
                "isCurrent": str(directory) == current,
                "repos": {"modelscope": model["modelscope"], "huggingface": model["huggingface"]},
            })
        return {
            "models": entries,
            "mirrors": [{"id": key, **value} for key, value in models.MIRRORS.items()],
            "defaultMirror": models.DEFAULT_MIRROR,
            "modelsRoot": self.models_root,
            "currentModelDir": current,
        }

    def download_model(self, model_id: str, mirror: str | None = None, target_root: str | None = None,
                       force: bool = False) -> dict:
        return self.downloads.start(
            model_id,
            mirror or models.DEFAULT_MIRROR,
            target_root or self.models_root,
            force=force,
        )

    def download_status(self) -> dict:
        return {"job": self.downloads.status()}

    def cancel_download(self) -> dict:
        return {"job": self.downloads.cancel()}

    def shutdown(self) -> dict:
        if self.runtime is not None:
            self.runtime.unload()
        return {"bye": True}


def dispatch(service: Service, request: dict) -> dict:
    """把请求分派到具体 op。返回 result（异常由调用方转成 error）。"""
    op = request.get("op")

    if op == "ping":
        return {"pong": True}
    if op == "health":
        return service.health()
    if op == "warmup":
        return service.warmup()
    if op == "predict":
        return service.predict(
            request.get("sentences", []),
            include_ordinal=bool(request.get("include_ordinal", False)),
            batch_size=request.get("batch_size"),
            threshold=request.get("threshold"),
        )
    if op == "list_models":
        return service.list_models()
    if op == "download_model":
        return service.download_model(
            request.get("model", ""),
            mirror=request.get("mirror"),
            target_root=request.get("target_root"),
            force=bool(request.get("force", False)),
        )
    if op == "download_status":
        return service.download_status()
    if op == "cancel_download":
        return service.cancel_download()
    if op == "unload":
        return service.shutdown()

    raise JevRuntimeError(f"未知的 op：{op!r}")


# --------------------------------------------------------------------- stdio


def handle_line(service: Service, line: str) -> dict | None:
    line = line.strip()
    if line == "":
        return None

    request_id = None
    try:
        request = json.loads(line)
        request_id = request.get("id")
        result = dispatch(service, request)
        return {"id": request_id, "ok": True, "result": result}
    except Exception as exc:  # noqa: BLE001
        log(f"请求处理失败：{exc}")
        if isinstance(exc, EXPECTED_ERRORS):
            # 这类是我们自己抛的可读错误，原样透出，别加类名前缀
            message = str(exc)
        else:
            message = f"{type(exc).__name__}: {exc}"
            log(traceback.format_exc())
        return {"id": request_id, "ok": False, "error": message}


def run_stdio(service: Service) -> int:
    stdin = sys.stdin
    stdout = sys.stdout
    # 中文必须走 UTF-8，否则 Windows 默认 GBK 会把句子写坏
    try:
        stdin.reconfigure(encoding="utf-8", errors="replace")
        stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

    log("stdio 模式就绪，等待请求。")
    stdout.write(json.dumps({"id": None, "ok": True, "result": {"hello": True}}, ensure_ascii=False) + "\n")
    stdout.flush()

    for line in stdin:
        response = handle_line(service, line)
        if response is None:
            continue
        stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        stdout.flush()
        if response.get("ok") and isinstance(response.get("result"), dict) and response["result"].get("bye"):
            break

    log("stdin 关闭，退出。")
    return 0


# ---------------------------------------------------------------------- http

# 允许的来源：本机地址，以及桌面端壳子自己的 scheme。
#
# ⚠️ 别用前缀白名单硬编码。Tauri 在不同平台用的 origin 不一样：
#     macOS / Linux → tauri://localhost
#     Windows       → http://tauri.localhost
#   只写前者的话，Windows 上的 TauriTavern 预检能过（HTTP 204）但拿不到
#   Access-Control-Allow-Origin，浏览器会拦下真实请求，表现为
#   `Failed to fetch`，而且服务端日志里只有 OPTIONS、一个 GET 都看不到。
#   所以按 URL 解析出 scheme / host 再判断。
ALLOWED_ORIGIN_SCHEMES = frozenset({"tauri", "file"})
ALLOWED_ORIGIN_HOSTS = frozenset({"localhost", "127.0.0.1", "::1", "tauri.localhost"})


def _origin_allowed(origin: str | None) -> bool:
    """只接受本机 / 本地壳子来源，挡住外部网页把这个服务当免费推理后端。

    服务只监听 127.0.0.1，所以这里是纵深防御：防止用户浏览器里随便打开的
    一个网页把本地 GPU 当算力用。
    """
    if not origin:
        return True

    try:
        parsed = urlsplit(origin)
    except ValueError:
        return False

    if parsed.scheme in ALLOWED_ORIGIN_SCHEMES:
        return True

    return (parsed.hostname or "").lower() in ALLOWED_ORIGIN_HOSTS


class HttpHandler(BaseHTTPRequestHandler):
    service: Service = None  # type: ignore[assignment]
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # noqa: A003
        log(f"http {self.address_string()} {fmt % args}")

    def _send(self, status: int, payload: dict | None = None, origin: str | None = None) -> None:
        # 204 按 RFC 不能带 body；带上会破坏 keep-alive 的帧边界
        body = b"" if status == 204 or payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")

        self.send_response(status)
        if body:
            self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))

        if origin and _origin_allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

        if body:
            self.wfile.write(body)

    def do_OPTIONS(self):  # noqa: N802
        origin = self.headers.get("Origin")

        # 来源被拒时回 403，而不是一个「看起来成功」的 204。
        # 浏览器两种都会拦掉真实请求，但日志里能一眼看出是来源问题，
        # 而不是留下一个查不出所以然的 Failed to fetch。
        if origin and not _origin_allowed(origin):
            log(f"拒绝来源 {origin}（不在允许列表内；浏览器会因此拦下后续请求）")
            self._send(403, {"ok": False, "error": "origin not allowed"}, origin)
            return

        self._send(204, None, origin)

    def do_GET(self):  # noqa: N802
        origin = self.headers.get("Origin")
        route = self.path.rstrip("/")

        if route in ("/health", ""):
            self._send(200, {"ok": True, "result": self.service.health()}, origin)
            return
        if route == "/models":
            self._send(200, {"ok": True, "result": self.service.list_models()}, origin)
            return
        if route == "/download_status":
            self._send(200, {"ok": True, "result": self.service.download_status()}, origin)
            return

        self._send(404, {"ok": False, "error": "not found"}, origin)

    def do_POST(self):  # noqa: N802
        origin = self.headers.get("Origin")

        # 无论最终是否放行这个来源，都要先把请求体读干净。
        # 否则 keep-alive 连接上会残留未读字节，下一次读取会读到上一个请求的尾巴，
        # 表现为一堆 ConnectionResetError 栈。
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""

        if not _origin_allowed(origin):
            log(f"拒绝来源 {origin}（不在允许列表内）")
            self._send(403, {"ok": False, "error": "origin not allowed"}, origin)
            return

        try:
            request = json.loads(raw.decode("utf-8") or "{}")
        except Exception as exc:  # noqa: BLE001
            self._send(400, {"ok": False, "error": f"invalid json: {exc}"}, origin)
            return

        route = self.path.rstrip("/")
        if route == "/predict":
            request.setdefault("op", "predict")
        elif route == "/warmup":
            request.setdefault("op", "warmup")
        elif route == "/unload":
            request.setdefault("op", "unload")
        elif route == "/download":
            request.setdefault("op", "download_model")
        elif route == "/cancel_download":
            request.setdefault("op", "cancel_download")

        try:
            result = dispatch(self.service, request)
            self._send(200, {"ok": True, "result": result}, origin)
        except Exception as exc:  # noqa: BLE001
            log(f"http 请求处理失败：{exc}")
            if isinstance(exc, EXPECTED_ERRORS):
                message = str(exc)
            else:
                message = f"{type(exc).__name__}: {exc}"
                log(traceback.format_exc())
            self._send(500, {"ok": False, "error": message}, origin)


class QuietThreadingHTTPServer(ThreadingHTTPServer):
    """客户端提前断开（浏览器刷新、取消请求、健康检查探针）不该甩一屏栈。

    这类网络噪音会把它上面的真实报错淹掉，所以只对连接类异常静默，
    其他异常照常交给父类打印。
    """

    def handle_error(self, request, client_address) -> None:
        error = sys.exc_info()[1]
        if isinstance(error, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


def run_http(service: Service, host: str, port: int) -> int:
    HttpHandler.service = service
    server = QuietThreadingHTTPServer((host, port), HttpHandler)
    log(f"http 模式就绪：http://{host}:{port}/  （/health, /predict, /warmup）")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("收到中断，退出。")
    finally:
        server.server_close()
    return 0


# ---------------------------------------------------------------------- main


def main() -> int:
    parser = argparse.ArgumentParser(description="JEVnovel 2 句子质检服务")
    parser.add_argument("--model-dir", default=None,
                        help="模型目录（含 config.json / infer.py）。省略时自动探测，"
                             "探测不到则以「无模型」模式启动（供面板下载模型用）")
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    parser.add_argument("--stdio", action="store_true", help="以 JSONL 走 stdin/stdout（默认）")
    parser.add_argument("--http", action="store_true", help="改用 HTTP 入口")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8791)
    parser.add_argument("--preload", action="store_true", help="启动时就在后台加载权重")
    parser.add_argument("--models-root", default=None,
                        help="新下载的模型放哪个目录（默认与当前模型同一层）")
    args = parser.parse_args()

    if args.batch_size < 1:
        parser.error("--batch-size 必须为正整数")

    # 未指定模型时按注册表顺序自动探测已安装的（0.8B 优先）；
    # 都没有就以「无模型」模式启动，让面板能完成首次模型下载。
    if args.model_dir is None:
        models_root = Path(args.models_root).expanduser().resolve() if args.models_root \
            else Path(__file__).resolve().parent.parent.parent / "models"
        args.models_root = str(models_root)
        for model in models.MODEL_REGISTRY:
            candidate = models.model_dir(str(models_root), model["id"])
            if models.is_installed(str(models_root), model["id"]):
                args.model_dir = str(candidate)
                log(f"未指定 --model-dir，自动使用已安装的模型：{candidate}")
                break
        if args.model_dir is None:
            log(f"未指定 --model-dir 且 {models_root} 下没有已安装的模型，"
                f"以「无模型」模式启动。")

    service = Service(args.model_dir, args.device, args.batch_size, models_root=args.models_root)

    if args.preload:
        service.warmup()

    if args.http:
        return run_http(service, args.host, args.port)
    return run_stdio(service)


if __name__ == "__main__":
    sys.exit(main())
