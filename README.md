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
| `direct` | **TauriTavern**，或其他没有服务端插件加载器的环境 | 手工启动独立 HTTP 服务（`server-plugin/start-backend.mjs`），前端直连 `127.0.0.1:8791` |
| `auto`（默认） | 都行 | 先探 `st-plugin`；探测失败、或响应结构不像本后端，就降级到 `direct` |

> 为什么需要 `direct`：TauriTavern 是 SillyTavern 的 fork，前端扩展机制保留，
> 但它**没有** Express 的 `plugin-loader` —— 它的 `/api/plugins/*` 是路由层硬编码的内置插件，
> 装进 `plugins/` 的 Node 插件不会被加载。所以那里只能走 `direct`。

---

## 目录结构

**仓库根目录就是扩展本身。** 这不是风格选择：TauriTavern 与 SillyTavern 的
「从 git URL 安装扩展」都会克隆整个仓库，并要求 `manifest.json` 位于**仓库根**。
放进子目录（比如 `extension/manifest.json`）会直接报
`Validation error: Extension manifest.json is missing`。

```
sillytavern-jev-sentence-check/
├── manifest.json               ┐
├── index.js                    │ 扩展本体
├── style.css                   │ （安装时复制到 extensions/third-party/jev-sentence-check/）
├── lib/                        ┘
│   ├── sentence-splitter.js       分句器（纯函数）
│   ├── floor-parser.js            楼层表达式解析（纯函数）
│   ├── highlight.js               HTML 纯文本层定位 + 包裹 <mark>（字符串版，给渲染 hook）
│   ├── highlight-dom.js           就地 DOM 包裹（TreeWalker + Range，保住既有监听器）
│   ├── store.js                   chat_metadata 缓存读写（纯函数）
│   └── transport.js               后端传输层 + 自动降级
├── server-plugin/             后端
│   ├── index.mjs                  Express 路由 + Python 子进程守护（仅原版 ST 走这条）
│   ├── start-backend.mjs          独立后端启动器（TauriTavern / 手工调试）
│   └── python/
│       ├── server.py              stdio JSONL / HTTP 双入口
│       ├── jev_runtime.py         模型加载、批量推理、超长兜底、OOM 降档
│       └── requirements.txt
├── install.mjs / uninstall.mjs    原版 SillyTavern 的一键安装 / 卸载
└── README.md
```

> 本仓库只发布**插件本体、后端与安装脚本**。本地开发包另含 `test/`（JS 127 个 + Python 19 个单测）
> 与 `docs/DESIGN.md`（设计文档，含 SillyTavern 内部 API 的实测依据），未一并发布。


---

## 安装

### 前置条件

- **TauriTavern**（任意版本）或 **SillyTavern 1.19.0+**
- Node.js ≥ 20
- NVIDIA GPU，支持 bf16（模型**强制要求 CUDA**，不是可选加速）
- Python 3.11+
- 磁盘：CUDA 版 torch 约 2.7 GB（解压后 4 GB+），模型约 1.5 GB

### 第 1 步：建 Python 环境（两个客户端都要）

最省事的做法 —— 一条命令搞定建环境 + 装依赖：

```bash
git clone https://github.com/1432647/sillytavern-jev-sentence-check.git
cd sillytavern-jev-sentence-check
node server-plugin/start-backend.mjs --setup
```

它会在**用户数据目录**建一个共享虚拟环境
（Windows：`%LOCALAPPDATA%\jev-sentence-check\venv`，macOS/Linux 对应各自的用户数据目录）。
刻意不放在仓库里 —— TauriTavern 更新扩展时会清空克隆目录（只保留 `.git`），放里面会被一起删掉。

想自己控制位置就手动来：

```bash
python -m venv <venv 路径>
<venv>/Scripts/python.exe -m pip install torch==2.11.0 --index-url https://download.pytorch.org/whl/cu128
<venv>/Scripts/python.exe -m pip install transformers==5.17.0 safetensors==0.8.0
```

> CUDA 版 torch 的 wheel 有 **2.7 GB**，Windows 上解压二三十分钟属正常。
>
> 模型仓库 `requirements.txt` 里的 `flash-linear-attention` / `tilelang` / `causal-conv1d`
> **不需要装** —— 模型自带的 `infer.py` 只 import `torch` / `safetensors` / `transformers`，
> 实测 transformers 会自动回退到参考 PyTorch 实现并正常出结果。
> 只有当你想把单句耗时从 ~190 ms 再压下去时，才值得去折腾那几个优化内核。

### 第 2 步：装扩展

#### A. TauriTavern

用「从 Git URL 安装扩展」，填仓库地址：

```
https://github.com/1432647/sillytavern-jev-sentence-check
```

它会克隆整个仓库并读取**仓库根**的 `manifest.json`。

然后**手工起后端** —— TauriTavern 没有服务端插件加载器，扩展自己拉不起 Python：

```bash
node server-plugin/start-backend.mjs
```

保持这个窗口开着。日志出现「模型已就绪」后，回到聊天页点扩展菜单里的「JEV 句子质检」，
状态灯会显示 `direct`，直接开始检查即可。

> 启动器会自动探测 Python 与模型。探测不到就用 `--python <路径> --model <模型目录>`，
> 或设环境变量 `JEV_PYTHON` / `JEV_MODEL`。服务固定监听 `127.0.0.1:8791`，
> 需要改端口用 `--port`，并同步改扩展设置里的「独立服务地址」。

#### B. 原版 SillyTavern

先让 ST 自己初始化一次：

```bash
cd SillyTavern
npm install
node server.js        # 首次启动会生成 config.yaml，然后 Ctrl+C 退出
```

> ⚠️ **覆盖安装前请先完全退出 SillyTavern。**
> Python 推理子进程会占住 `plugins/jev-sentence-check/python/` 目录，
> ST 还在跑时覆盖会失败（`EBUSY`）。安装脚本会给出提示，但不会替你退出 ST。

```bash
node install.mjs --sillytavern <SillyTavern 路径>
```

脚本会：

- 把扩展本体（`manifest.json` / `index.js` / `style.css` / `lib/`）复制到
  `public/scripts/extensions/third-party/jev-sentence-check/`
- 把 `server-plugin/` 复制到 `plugins/jev-sentence-check/`
- 写入带绝对路径的 `config.json`
- 把 `config.yaml` 的 `enableServerPlugins` 改成 `true`（已经是 `true` 就不动）

### 第 3 步：用起来

1. 打开扩展菜单（聊天输入框上方的 ⋮）→ 点「JEV 句子质检」
2. 点一次「预热后端」，等到状态灯变绿（首次要加载约 1.4 GiB 权重）
3. 填楼层号 → 「开始检查」→ 高亮出现


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
| 安装时报 `Extension manifest.json is missing` | `manifest.json` 必须在**仓库根目录**。别把它挪进 `extension/` 之类的子目录 —— 安装器只认根目录 |
| 状态灯红，提示「找不到后端」 | TauriTavern：先跑 `node server-plugin/start-backend.mjs` 并确认窗口还开着。原版 ST：确认 `config.yaml` 里 `enableServerPlugins: true` 且已重启 |
| 状态灯显示 `direct` 而不是 `st-plugin` | 说明服务端插件路由没探测到，走了直连。TauriTavern 下这是**正常且预期**的 |
| 「后端加载失败：...CUDA...」 | 模型强制要求 CUDA + bf16。确认 `nvidia-smi` 正常、装的是 CUDA 版 torch 而不是 CPU 版 |
| 「找不到 Python 解释器」 | 原版 ST：重跑 `install.mjs` 重写 `config.json`。TauriTavern：`start-backend.mjs --python <路径>`，或先跑 `--setup` |
| 找不到模型目录 | 用 `--model <路径>` 或环境变量 `JEV_MODEL` 指定。模型来自 ModelScope：`alkaid55555/jev-novel-2-0.8b-bf16` |
| 预热卡很久 | 首次要加载约 1.4 GiB 权重，几十秒正常。原版 ST 可在 `/api/plugins/jev-sentence-check/logs` 看子进程日志；直连模式直接看启动窗口 |
| 少数句子没高亮 | 分句结果与渲染后 HTML 的纯文本层不一致时会跳过。这类句子仍保留在缓存里，可在这层排查 |
| 显存不足 | 后端会自动砍半 batch 重试。仍失败就调小 `config.json` 里的 `batchSize` |
| 端口 8791 被占 | 换 `--port 8792`，并同步改扩展设置面板里的「独立服务地址」 |

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
