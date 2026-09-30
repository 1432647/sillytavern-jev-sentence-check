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

# 必须在 import torch 之前设置，见模型仓库 infer.py 的做法
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("FLA_TILELANG", "1")

from jev_runtime import JevRuntime, JevRuntimeError, cuda_report  # noqa: E402

DEFAULT_BATCH_SIZE = 8


def log(message: str) -> None:
    """日志一律走 stderr，保护 stdout 的 JSONL 协议。"""
    print(f"[jev] {message}", file=sys.stderr, flush=True)


class Service:
    """把运行时包成一组 op，stdio 与 http 两种传输层共用。"""

    def __init__(self, model_dir: str, device: str, batch_size: int):
        self.runtime = JevRuntime(model_dir, device)
        self.batch_size = batch_size
        self._load_lock = threading.Lock()
        self._loading = False
        self._last_error: str | None = None

    # ------------------------------------------------------------------ ops

    def health(self) -> dict:
        return {
            "ready": self.runtime.is_ready,
            "loading": self._loading,
            "error": self._last_error,
            "model_dir": str(self.runtime.model_dir),
            "device": self.runtime.device,
            "batch_size": self.batch_size,
            "cuda": cuda_report(),
        }

    def warmup(self) -> dict:
        """非阻塞预热：立刻返回 loading，权重在后台线程里加载。"""
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

    def predict(self, sentences: list[str], include_ordinal: bool = False, batch_size: int | None = None) -> dict:
        if not isinstance(sentences, list):
            raise JevRuntimeError("sentences 必须是数组。")

        # 首次 predict 会阻塞几秒到几十秒，这是预期内的
        if not self.runtime.is_ready:
            self.warmup()
            self.runtime.load()

        size = batch_size if isinstance(batch_size, int) and batch_size > 0 else self.batch_size
        results = self.runtime.predict(sentences, batch_size=size, include_ordinal=include_ordinal)
        return {
            "results": results,
            "count": len(results),
            "needs_revision": sum(1 for item in results if item.get("needs_revision")),
        }

    def shutdown(self) -> dict:
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
        )
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
        if not isinstance(exc, JevRuntimeError):
            log(traceback.format_exc())
        return {"id": request_id, "ok": False, "error": f"{type(exc).__name__}: {exc}"}


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

ALLOWED_ORIGIN_PREFIXES = ("http://127.0.0.1", "http://localhost", "http://[::1]", "tauri://")


def _origin_allowed(origin: str | None) -> bool:
    """只接受本机来源，挡住外部页面拿这个服务当免费推理后端。"""
    if origin is None:
        return True
    return origin.startswith(ALLOWED_ORIGIN_PREFIXES)


class HttpHandler(BaseHTTPRequestHandler):
    service: Service = None  # type: ignore[assignment]
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # noqa: A003
        log(f"http {self.address_string()} {fmt % args}")

    def _send(self, status: int, payload: dict, origin: str | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if origin and _origin_allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):  # noqa: N802
        self._send(204, {}, self.headers.get("Origin"))

    def do_GET(self):  # noqa: N802
        if self.path.rstrip("/") in ("/health", ""):
            self._send(200, {"ok": True, "result": self.service.health()}, self.headers.get("Origin"))
            return
        self._send(404, {"ok": False, "error": "not found"}, self.headers.get("Origin"))

    def do_POST(self):  # noqa: N802
        origin = self.headers.get("Origin")

        # 无论最终是否放行这个来源，都要先把请求体读干净。
        # 否则 keep-alive 连接上会残留未读字节，下一次读取会读到上一个请求的尾巴，
        # 表现为一堆 ConnectionResetError 栈。
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""

        if not _origin_allowed(origin):
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

        try:
            result = dispatch(self.service, request)
            self._send(200, {"ok": True, "result": result}, origin)
        except Exception as exc:  # noqa: BLE001
            log(f"http 请求处理失败：{exc}")
            if not isinstance(exc, JevRuntimeError):
                log(traceback.format_exc())
            self._send(500, {"ok": False, "error": f"{type(exc).__name__}: {exc}"}, origin)


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
    parser.add_argument("--model-dir", required=True, help="模型目录（含 config.json / infer.py）")
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    parser.add_argument("--stdio", action="store_true", help="以 JSONL 走 stdin/stdout（默认）")
    parser.add_argument("--http", action="store_true", help="改用 HTTP 入口")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8791)
    parser.add_argument("--preload", action="store_true", help="启动时就在后台加载权重")
    args = parser.parse_args()

    if args.batch_size < 1:
        parser.error("--batch-size 必须为正整数")

    service = Service(args.model_dir, args.device, args.batch_size)

    if args.preload:
        service.warmup()

    if args.http:
        return run_http(service, args.host, args.port)
    return run_stdio(service)


if __name__ == "__main__":
    sys.exit(main())
