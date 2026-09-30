# JEV Sentence Check

给 SillyTavern 的逐句质检扩展：对**你选中的楼层**做中文分句，逐句送
[JEVnovel 2 · 0.8B](https://modelscope.cn/models/alkaid55555/jev-novel-2-0.8b-bf16) 判断「可以保留 / 需要修改」，
把判定为**需要修改**的句子在楼层里高亮出来。

模型是面向 AIGC 文学创作训练的「八股文」检测器，针对的是 AI 写小说时的
高频形容词、堆砌修辞、结构性句式（如「不是……而是」）等局部最优表达。
它只判断单句，不判断句间关系 —— 这也正是本扩展要在前端做分句的原因。

---

## 它做什么 / 不做什么

**做**

- 一个入口按钮：「JEV 句子质检」，点开弹窗输入楼层表达式（如 `3,5,7-9`）
- 弹窗里实时预览解析出的楼层（编号 · 说话人 · 正文前 30 字），避免选错
- 分句 → 逐句判定 → 高亮「需要修改」的句子
- 结果持久化在**当前聊天的 metadata** 里：切 swipe、刷新页面、重开聊天后高亮还在
- 后端首次加载权重慢，所以有「预热」按钮与进度提示

**不做**

- 不自动改写句子（只高亮，改不改由你决定）
- 不修改消息原文，不触发 SillyTavern 的「消息已编辑」流程
- 不做流式生成过程中的实时检查
- 只支持这一个模型（配置里留了 `modelDir` 字段，但没做多模型切换 UI）

---

## 架构

模型跑在 Python + CUDA 上，而 SillyTavern 扩展跑在浏览器里，所以必然是两段式：

```
浏览器 ── UI 扩展 ──┬─ st-plugin 模式 → SillyTavern Node 服务端插件 → Python 子进程
                    └─ direct 模式    → 独立 Python HTTP 服务
```

| 模式 | 什么时候用 | 说明 |
|---|---|---|
| `st-plugin` | 原版 SillyTavern | 由 `plugins/jev-sentence-check/` 托管并守护 Python 子进程。不占端口、无 CORS，进程随 ST 一起退出 |
| `direct` | TauriTavern，或其他没有服务端插件加载器的环境 | 手工启动独立服务（`start-backend.cmd`），前端直连 `127.0.0.1:8791` |
| `auto`（默认） | 都行 | 先探 `st-plugin`，404 就降级到 `direct` |

> 为什么需要 `direct`：TauriTavern 是 SillyTavern 的 fork，前端扩展机制保留，
> 但它**没有** Express 的 `plugin-loader`，`/api/plugins/*` 是路由层硬编码的内置插件，
> 装进 `plugins/` 的 Node 插件不会被加载。所以那里只能走 `direct`。

---

## 目录结构

```
sillytavern-jev-sentence-check/
├── install.mjs / uninstall.mjs     安装 / 卸载
├── extension/                      前端扩展 → public/scripts/extensions/third-party/
│   ├── manifest.json
│   ├── index.js
│   ├── style.css
│   └── lib/
│       ├── sentence-splitter.js    分句器（纯函数）
│       ├── floor-parser.js         楼层表达式解析（纯函数）
│       ├── highlight.js            HTML 纯文本层定位 + 包裹 <mark>（字符串版，给渲染 hook）
│       ├── highlight-dom.js        就地 DOM 包裹（TreeWalker + Range，保住既有监听器）
│       ├── store.js                chat_metadata 缓存读写（纯函数）
│       └── transport.js            后端传输层 + 自动降级
└── server-plugin/                  服务端插件 → plugins/
    ├── index.mjs                   Express 路由 + Python 子进程守护
    └── python/
        ├── server.py               stdio JSONL / HTTP 双入口
        ├── jev_runtime.py          模型加载、批量推理、超长兜底、OOM 降档
        └── requirements.txt
```

> 本仓库只发布**插件本体与安装脚本**。本地开发包另含 `test/`（JS 124 个 + Python 19 个单测）
> 与 `docs/DESIGN.md`（设计文档，含 SillyTavern 内部 API 的实测依据），未一并发布。

---

## 安装

### 前置条件

- SillyTavern 1.19.0 或更新
- Node.js ≥ 20（SillyTavern 自身要求）
- NVIDIA GPU，支持 bf16（模型**强制要求 CUDA**，不是可选加速）
- Python 3.11+

### 步骤

**1. 装 SillyTavern 依赖并生成配置**

```bash
cd SillyTavern
npm install
node server.js        # 首次启动会生成 config.yaml，然后 Ctrl+C 退出
```

**2. 建 Python 环境**

以下命令在**本仓库目录里**执行：

```bash
python -m venv runtime/venv
runtime/venv/Scripts/python.exe -m pip install torch==2.11.0 --index-url https://download.pytorch.org/whl/cu128
runtime/venv/Scripts/python.exe -m pip install transformers==5.17.0 safetensors==0.8.0
```

> CUDA 版 torch 的 wheel 有 **2.7 GB**，在 Windows 上解压可能要二三十分钟，属正常。
>
> 模型仓库的 `requirements.txt` 里还有 `flash-linear-attention` / `tilelang` /
> `causal-conv1d`。那三件在 Windows 上编译风险很高，而模型自带的 `infer.py`
> 本身只 import `torch` / `safetensors` / `transformers`。
> **先只装这三件** —— 实测 transformers 会自动回退到参考 PyTorch 实现，跑得通；
> 只有当你想把单句耗时从 ~190ms 再压下去时，才需要去折腾那几个优化内核。

**3. 安装扩展**

> ⚠️ **覆盖安装前请先完全退出 SillyTavern。**
> Python 推理子进程会占住 `plugins/jev-sentence-check/python/` 目录，
> ST 还在跑时覆盖会失败（`EBUSY`）。这是实测撞到过的坑，安装脚本会给出提示但不会替你退出 ST。

```bash
node install.mjs --sillytavern <SillyTavern 路径>
```

脚本会：

- 把 `extension/` 复制到 `public/scripts/extensions/third-party/jev-sentence-check/`
- 把 `server-plugin/` 复制到 `plugins/jev-sentence-check/`
- 写入带绝对路径的 `config.json` 与 `start-backend.cmd`
- 把 `config.yaml` 的 `enableServerPlugins` 改成 `true`（已经是 `true` 就不动）

**4. 启动并使用**

1. 启动 SillyTavern，页面刷新后打开扩展菜单（输入框上方的 ⋮）
2. 点「JEV 句子质检」
3. 点一次「预热后端」，等到状态灯变绿（首次要加载 1.4GiB 权重）
4. 填楼层号 → 「开始检查」→ 高亮出现

---

## 楼层表达式

| 写法 | 含义 |
|---|---|
| `7` | 第 7 层 |
| `3,5,7` | 第 3、5、7 层 |
| `7-9` | 第 7 到 9 层（含两端） |
| `9-7` | 同上，倒着写也行 |
| `3、5，7；9 11` | 中文标点、分号、空格都能当分隔符 |

**楼层号就是消息左上角的编号，从 0 开始。**
SillyTavern 默认不显示这个编号，可以在「用户设置」里打开
`Show sequential message numbers in the chat log`；
不打开也没关系 —— 弹窗里的预览会逐条列出编号、说话人和正文前 30 字，照着核对即可。

对话框里还有「全部 / 仅 AI 楼层 / 最近 5 条 / 已检查过的」四个快捷填充按钮。

---

## 分句规则

1. **剥掉保护区**：围栏代码块整块丢弃，不送进模型；行内代码只去反引号
2. **剥掉行首结构**：引用 `>`、标题 `#`、列表 `-` / `1.`
3. **剥掉行内标记**：`**粗体**`、`*斜体*`、`~~删除线~~`、链接（保留文字）、图片（丢弃）、`{{宏}}`、HTML 标签
4. **按句末标点切**：`。！？!?…～` 与换行
5. **引号内部不切**：`她说：“你好。”然后走了。` 是一整句，不会被切成 `她说：“你好。`
6. **过短片段前向合并**：长度 < 6 且没有句末标点的片段并入前一句
7. **超长再切**：单句超过 400 字符时按 `，；、：` 再分；后端还会用真 tokenizer 复核，
   仍然超限就二分兜底（此时只要任一片段需要修改，整句就算需要修改）

---

## 高亮与缓存

- 结果写进 `chat_metadata['jev-sentence-check']`，**不写回消息原文**
- 每条缓存记录 `swipeId` 与正文 `hash`
- 重 roll（换 swipe）或编辑过正文后，旧结果**自动失效**并停止高亮 ——
  宁可不高亮，也不能高亮错位置
- 想重新检查，再跑一次即可
- 设置面板与对话框里都有「清除」入口

---

## 排错

| 现象 | 排查方向 |
|---|---|
| 状态灯红，提示「找不到后端」 | 原版 ST：确认 `config.yaml` 里 `enableServerPlugins: true` 且已重启。其他环境：先跑 `start-backend.cmd` |
| 「后端加载失败：...CUDA...」 | 模型强制要求 CUDA + bf16。确认 `nvidia-smi` 正常、装的是 CUDA 版 torch 而不是 CPU 版 |
| 「找不到 Python 解释器」 | 跑一次 `install.mjs` 重新写 `config.json`，或检查 `runtime/venv` 是否存在 |
| 预热卡很久 | 首次要加载 1.4GiB 权重，正常要几十秒。`/api/plugins/jev-sentence-check/logs` 能看到子进程日志 |
| 少数句子没高亮 | 分句结果与渲染后的 HTML 纯文本层不一致时会跳过。这类句子会保留在缓存里，可在这层排查 |
| 显存不足 | 后端会自动砍半 batch 重试。仍失败就调小 `config.json` 里的 `batchSize` |

---

## 开发

本仓库是发布子集，未包含回归测试。如果你要改这份代码，以下几点能帮你少走弯路：

- 分句器、楼层表达式解析、高亮定位、缓存读写、传输层都写成了**纯函数或可注入依赖**的形式，
  可以完全脱离 SillyTavern 与 GPU 做单测；DOM 高亮器（`lib/highlight-dom.js`）
  用 jsdom 就能测，不需要真浏览器。
- **改完必须重跑 `install.mjs`**。SillyTavern 里的是副本，改源码不会自动同步。
- 覆盖安装前先完全退出 SillyTavern（原因见上文 `EBUSY`）。
- 有两份高亮实现：字符串版给渲染 hook，DOM 版给就地应用。**两者的跳过集合与匹配语义
  必须保持一致**，否则同一个句子在两条路径下会得到不同结果。
