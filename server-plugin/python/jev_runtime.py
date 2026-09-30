"""JEVnovel 2 推理运行时。

职责：把 `models/jev-novel-2-0.8b-bf16` 包成一个「加载一次、常驻显存、可重复 predict」的服务。

设计取舍：
  * **不复制模型定义**。`infer.py` 里的 `JevModel` 是自定义架构，唯一权威实现就在模型仓库里。
    这里用 importlib 直接把模型目录下的 `infer.py` 当模块加载，复用它导出的 `Predictor`。
    这样模型作者更新推理逻辑时我们自动跟着走，不存在两份实现漂移的问题。
  * 在 `Predictor` 之上只补三件事：**超长句兜底**、**显存不足自动降 batch**、**串行化**。
"""

from __future__ import annotations

import importlib.util
import threading
from pathlib import Path

# 软标点，用于超长句的二次切分
SOFT_BREAKS = "，；、：,;:"


class JevRuntimeError(RuntimeError):
    """运行时错误，会被服务层翻译成对用户可读的报错。"""


def _load_infer_module(model_dir: Path):
    """把模型目录下的 infer.py 作为独立模块加载。"""
    infer_path = model_dir / "infer.py"
    if not infer_path.is_file():
        raise JevRuntimeError(
            f"模型目录里找不到 infer.py：{infer_path}。"
            "jev-novel-2 是自定义架构，必须用模型自带的推理脚本。"
        )

    spec = importlib.util.spec_from_file_location("jev_model_infer", infer_path)
    if spec is None or spec.loader is None:
        raise JevRuntimeError(f"无法加载推理脚本：{infer_path}")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_predictor_cpu(infer, model_dir: Path):
    """纯 CPU 加载路径。

    模型自带的 `infer.load_model` 在入口处硬性要求 CUDA（infer.py:54-55），
    但它后面的全部步骤——meta 建模、safetensors 校验、权重装载、rotary 替换——
    都是设备无关的。这里按**完全相同的步骤**在 CPU 上重载，
    模型定义仍然复用 infer.py 里的 `JevModel`（不复制架构代码），
    只有「加载协议」这一小段属于我们。

    权重转成 fp32：PyTorch CPU 对 bf16 的算子覆盖不全，且这是实测基准
    （0.8B fp32 约 1164 ms/句）对应的形态。代价是内存翻倍——
    0.8B 约 3.2 GB，4B 要 16 GB 内存。
    """
    import json

    import torch
    from safetensors import safe_open
    from torch import nn
    from transformers import AutoTokenizer, Qwen3_5TextConfig
    from transformers.models.qwen3_5.modeling_qwen3_5 import (
        Qwen3_5TextModel,
        Qwen3_5TextRotaryEmbedding,
    )

    directory = model_dir.resolve()
    device = torch.device("cpu")
    info = json.loads((directory / "config.json").read_text(encoding="utf-8"))
    config = Qwen3_5TextConfig(**info["text_config"])
    config._attn_implementation = "sdpa"
    config.use_cache = False

    with torch.device("meta"):
        model = infer.JevModel(Qwen3_5TextModel(config), info["pointer_dim"])

    expected = dict(model.named_parameters())
    index = json.loads((directory / "model.safetensors.index.json").read_text(encoding="utf-8"))
    mapping = index["weight_map"]
    if set(mapping) != set(expected):
        raise JevRuntimeError("权重清单与模型结构不匹配（模型文件可能不完整）。")
    for name in sorted(set(mapping.values())):
        keys = [key for key, shard in mapping.items() if shard == name]
        with safe_open(str(directory / name), framework="pt", device="cpu") as shard:
            if set(shard.keys()) != set(keys):
                raise JevRuntimeError("权重分片内容与清单不符。")
            for key in keys:
                value = shard.get_tensor(key)
                if value.dtype != torch.bfloat16 or value.shape != expected[key].shape:
                    raise JevRuntimeError(f"权重形状或 dtype 不符合预期：{key}")
                parent, _, leaf = key.rpartition(".")
                module = model.get_submodule(parent)
                # 与 GPU 路径唯一的实质差别：落成 fp32，CPU 上算子覆盖最全
                setattr(module, leaf, nn.Parameter(value.to(device=device, dtype=torch.float32),
                                                   requires_grad=False))
                del value
    model.backbone.rotary_emb = Qwen3_5TextRotaryEmbedding(config).to(device=device)
    if any(value.is_meta for value in list(model.parameters()) + list(model.buffers())):
        raise JevRuntimeError("模型加载不完整。")
    model.requires_grad_(False)
    model.eval()
    model.float()

    # 复用官方 Predictor 的推理逻辑，只把加载好的部件装进去——
    # 这样 CPU 与 GPU 走完全相同的 predict 代码，不会出现两条路径结果不一致。
    predictor = infer.Predictor.__new__(infer.Predictor)
    predictor.model = model
    predictor.config = info
    predictor.device = device
    predictor.tokenizer = AutoTokenizer.from_pretrained(
        directory, local_files_only=True, trust_remote_code=False, use_fast=True,
        fix_mistral_regex=False, config=Qwen3_5TextConfig(**info["text_config"]),
    )
    if not predictor.tokenizer.is_fast:
        raise JevRuntimeError("需要一个 fast tokenizer。")
    predictor.threshold = float(info["bad_threshold"])
    return predictor


class JevRuntime:
    """线程安全的懒加载推理运行时。"""

    def __init__(self, model_dir: str | Path, device: str = "cuda:0"):
        self.model_dir = Path(model_dir).resolve()
        self.device = device
        self._infer = None
        self._predictor = None
        self._lock = threading.Lock()
        self._load_error: str | None = None

    # ---------------------------------------------------------------- 生命周期

    @property
    def is_ready(self) -> bool:
        return self._predictor is not None

    @property
    def load_error(self) -> str | None:
        return self._load_error

    def load(self):
        """加载权重（幂等）。首次调用会占用几十秒并吃掉约 2GiB 显存。"""
        if self._predictor is not None:
            return self._predictor

        with self._lock:
            if self._predictor is not None:
                return self._predictor

            if not self.model_dir.is_dir():
                raise JevRuntimeError(f"模型目录不存在：{self.model_dir}")

            try:
                self._infer = _load_infer_module(self.model_dir)
                if self.device.split(":")[0] == "cpu":
                    # 模型自带加载器在入口硬性要求 CUDA（infer.py:54-55），
                    # CPU 走我们自己的加载器——模型定义仍复用 infer.py。
                    self._predictor = _load_predictor_cpu(self._infer, self.model_dir)
                else:
                    # GPU：Predictor.__init__ 内部会校验 CUDA 与 bf16 支持，
                    # 不满足条件时直接 raise，我们原样透出即可。
                    self._predictor = self._infer.Predictor(str(self.model_dir), self.device)
            except JevRuntimeError:
                raise
            except Exception as exc:  # noqa: BLE001 - 需要把底层报错原样带给用户
                self._load_error = f"{type(exc).__name__}: {exc}"
                raise JevRuntimeError(self._load_error) from exc

            return self._predictor

    def unload(self):
        with self._lock:
            self._predictor = None
            self._infer = None
            try:
                import torch

                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:  # noqa: BLE001
                pass

    # ------------------------------------------------------------ 超长句兜底

    def _fits(self, sentence: str) -> bool:
        """复刻 `infer.encode_sentence` 的长度校验，但只问「放不放得下」。"""
        try:
            self._infer.encode_sentence(sentence, self._predictor.tokenizer, self._predictor.config)
            return True
        except ValueError:
            return False

    def _split_overlong(self, sentence: str) -> list[str]:
        """把超出 token 上限的句子按软标点递归二分；找不到软标点就按中点硬切。"""
        pieces: list[str] = []
        stack = [sentence]

        while stack:
            current = stack.pop(0)
            if self._fits(current) or len(current) <= 1:
                pieces.append(current)
                continue

            cut = -1
            for index in range(len(current) // 2, 0, -1):
                if current[index - 1] in SOFT_BREAKS:
                    cut = index
                    break
            if cut <= 0:
                cut = len(current) // 2

            head, tail = current[:cut], current[cut:]
            if not head or not tail or head == current:
                pieces.append(current)
                continue
            stack.insert(0, tail)
            stack.insert(0, head)

        return pieces or [sentence]

    # ------------------------------------------------------------------ 推理

    def predict(self, sentences: list[str], batch_size: int = 8, include_ordinal: bool = False,
                threshold: float | None = None) -> list[dict]:
        """对一组句子做判定。返回结果与入参一一对应。

        threshold 只重算 `needs_revision` / `label` 这两个**派生**字段；
        `bad_probability` 始终原样返回 —— 前端因此可以直接拿已缓存的概率
        按新阈值重算高亮，不必把整批句子重新过一遍 GPU。

        刻意**不改** `predictor.threshold`：HTTP 服务是多线程的，
        改共享状态会让并发请求互相串味。
        """
        if threshold is not None:
            if not isinstance(threshold, (int, float)) or isinstance(threshold, bool):
                raise JevRuntimeError("threshold 必须是 0~1 之间的数。")
            threshold = float(threshold)
            if not 0.0 <= threshold <= 1.0:
                raise JevRuntimeError("threshold 必须在 0~1 之间。")

        predictor = self.load()

        cleaned = [s if isinstance(s, str) else "" for s in sentences]
        # 空句不入模型，占位后原样返回，避免污染 batch
        indexed = [(i, s) for i, s in enumerate(cleaned) if s.strip() != ""]
        results: list[dict | None] = [None] * len(cleaned)

        # 先按「是否放得下」把句子展开成待推理的子句
        expanded: list[tuple[int, str]] = []
        oversplit_flags: dict[int, bool] = {}
        for index, sentence in indexed:
            if self._fits(sentence):
                expanded.append((index, sentence))
                continue
            oversplit_flags[index] = True
            for piece in self._split_overlong(sentence):
                expanded.append((index, piece))

        raw = self._run_batches(predictor, [text for _, text in expanded], batch_size, include_ordinal)

        # 归并回原下标
        grouped: dict[int, list[dict]] = {}
        for (index, _), item in zip(expanded, raw):
            grouped.setdefault(index, []).append(item)

        for index, items in grouped.items():
            results[index] = self._merge(items, bool(oversplit_flags.get(index)))

        for index in range(len(results)):
            if results[index] is None:
                results[index] = _empty_result()

        if threshold is not None:
            for item in results:
                _apply_threshold(item, threshold)

        return results  # type: ignore[return-value]

    @staticmethod
    def _merge(items: list[dict], oversplit: bool) -> dict:
        """一句话被拆成多个子句时：任一子句需要修改，整句就算需要修改。"""
        if len(items) == 1 and not oversplit:
            return items[0]

        bad_probability = max(float(item["bad_probability"]) for item in items)
        needs_revision = any(bool(item["needs_revision"]) for item in items)
        merged = {
            "label": "bad" if needs_revision else "not_bad",
            "needs_revision": needs_revision,
            "bad_probability": bad_probability,
            "probabilities": {
                "not_bad": 1.0 - bad_probability,
                "bad": bad_probability,
            },
        }
        if oversplit:
            merged["oversplit"] = True
            merged["parts"] = [item.get("bad_probability") for item in items]
        return merged

    @staticmethod
    def _run_batches(predictor, texts: list[str], batch_size: int, include_ordinal: bool) -> list[dict]:
        """分批推理；显存不足时自动砍半重试。"""
        if not texts:
            return []

        size = max(1, int(batch_size))
        results: list[dict] = []
        offset = 0

        while offset < len(texts):
            chunk = texts[offset:offset + size]
            try:
                results.extend(
                    predictor.predict(chunk, batch_size=len(chunk), include_ordinal=include_ordinal)
                )
                offset += len(chunk)
            except Exception as exc:  # noqa: BLE001
                if not _is_oom(exc):
                    raise
                import torch

                torch.cuda.empty_cache()
                if size == 1:
                    raise JevRuntimeError(
                        f"单句推理即显存不足，无法继续。原始报错：{exc}"
                    ) from exc
                size = max(1, size // 2)

        return results


def _is_oom(exc: Exception) -> bool:
    name = type(exc).__name__
    if name in {"OutOfMemoryError", "CudaOutOfMemoryError"}:
        return True
    return "out of memory" in str(exc).lower()


def _apply_threshold(result: dict, threshold: float) -> None:
    """按给定阈值重算派生字段，原地修改。概率字段保持不动。"""
    probability = result.get("bad_probability")
    if not isinstance(probability, (int, float)) or isinstance(probability, bool):
        return
    needs_revision = float(probability) >= threshold
    result["needs_revision"] = needs_revision
    result["label"] = "bad" if needs_revision else "not_bad"
    result["threshold"] = threshold


def _empty_result() -> dict:
    return {
        "label": "not_bad",
        "needs_revision": False,
        "bad_probability": 0.0,
        "probabilities": {"not_bad": 1.0, "bad": 0.0},
        "skipped": True,
    }


def cuda_report() -> dict:
    """给 /health 用的硬件体检，方便用户一眼看出环境问题。"""
    report: dict = {"torch": None, "cuda_available": False, "device": None, "bf16_supported": False}
    try:
        import torch

        report["torch"] = torch.__version__
        report["cuda_available"] = bool(torch.cuda.is_available())
        if report["cuda_available"]:
            report["device"] = torch.cuda.get_device_name(0)
            report["bf16_supported"] = bool(torch.cuda.is_bf16_supported())
            free, total = torch.cuda.mem_get_info()
            report["vram_free_mib"] = round(free / 1024 / 1024)
            report["vram_total_mib"] = round(total / 1024 / 1024)
    except Exception as exc:  # noqa: BLE001
        report["error"] = f"{type(exc).__name__}: {exc}"
    return report


__all__ = ["JevRuntime", "JevRuntimeError", "cuda_report"]
