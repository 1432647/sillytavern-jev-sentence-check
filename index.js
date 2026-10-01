/**
 * JEV Sentence Check —— SillyTavern 前端扩展。
 *
 * 流程：点输入框上方的按钮 → 总控面板填楼层表达式 → 分句 → 送后端判定
 *       → 结果写进 chat_metadata → 把「需要修改」的句子在楼层里高亮。
 *
 * 几条刻意的设计约束：
 *  - **高亮 hook 必须同步**。MessageFormatter 不允许 async hook，所以 hook 只读缓存，
 *    所有网络请求都在点击流程里完成。
 *  - **按楼层逐条请求**。进度可见、可随时取消，单次失败不会让整批白跑。
 *  - **swipe 与正文 hash 双重校验**。重 roll 或改过正文的楼层，旧结果一律作废，
 *    宁可不高亮也不能高亮错位置。
 *  - **检测前先把楼层复制成新的 swipe**（用户要求）。标记与修改都发生在那份副本上，
 *    原文永远留在 swipe[0]，可以随时滑回去。
 *  - **阈值在显示时套用**。缓存里只存概率，所以调阈值能立刻重算高亮，不必重跑模型。
 */

import { splitSentences, parseExcludeTags } from './lib/sentence-splitter.js';
import { parseFloorExpression, formatFloorExpression } from './lib/floor-parser.js';
import { applyHighlights } from './lib/highlight.js';
import { clearHighlights, highlightElement } from './lib/highlight-dom.js';
import * as store from './lib/store.js';
import { MODES, createTransport } from './lib/transport.js';
import * as swipes from './lib/swipes.js';
import { BACKEND_FILES, LAUNCHER_FILES, buildInstaller, pickBundleAssets, distReleaseApiUrl } from './lib/backend-install.js';

const MARK_CLASS = 'jev-mark';
const MAX_FLOORS_PER_RUN = 50;
const DEFAULT_MODEL = 'jev-novel-2-0.8b-bf16';

/** 后端源码在仓库里的位置（相对本文件）。用 URL 拼，扩展挂在哪都能取到。 */
const BACKEND_SOURCE_BASE = new URL('./server-plugin/python/', import.meta.url);

const DEFAULT_SETTINGS = {
    // 连接相关 —— 留在扩展设置抽屉里
    mode: MODES.AUTO,
    directBase: 'http://127.0.0.1:8791',
    maxChars: 400,
    // 总控面板
    lastExpression: '',
    threshold: store.DEFAULT_THRESHOLD,
    excludeTags: '',
    autoUnmarkAfterEdit: false,
    // 模型管理
    lastModel: DEFAULT_MODEL,
    lastMirror: 'modelscope',
    lastInstallDir: '',
    // 后端设备：装 CUDA 版还是纯 CPU 版的 torch（决定安装体积与速度）
    lastDeviceKind: 'gpu',
};

let context = null;
let settings = null;
let transport = null;

const state = {
    running: false,
    cancelled: false,
    models: null,
    downloadTimer: null,
    /** 正在编辑的高亮：{ messageId, swipeId, text } */
    editing: null,
};

let ui = null;
let refreshInterval = null;

// ------------------------------------------------------------------ 小工具

function log(...args) {
    console.log('[jev-sentence-check]', ...args);
}

function getChat() {
    return Array.isArray(context?.chat) ? context.chat : [];
}

function maxFloor() {
    return getChat().length - 1;
}

function getMessage(id) {
    return getChat()[id] ?? null;
}

/** 当前楼层实际显示的是哪个 swipe。用户消息没有 swipe_id，按 0 处理。 */
function currentSwipeId(id) {
    const message = getMessage(id);
    return Number.isInteger(message?.swipe_id) ? message.swipe_id : 0;
}

/** 正文 hash。正文一旦被编辑，缓存的判定结果立即失效。 */
function currentHash(id) {
    return store.hashText(getMessage(id)?.mes ?? '');
}

function floorLabel(id) {
    const message = getMessage(id);
    if (message === null) {
        return '(不存在)';
    }
    const name = message.name || (message.is_user ? context.name1 : '系统');
    return `${name}`;
}

function previewText(id, limit = 30) {
    const raw = String(getMessage(id)?.mes ?? '').replace(/\s+/g, ' ').trim();
    return raw.length > limit ? `${raw.slice(0, limit)}…` : raw;
}

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}

// ------------------------------------------------------------------ 高亮

/** 用户配置的排除标签：`<1></1>` → `['1']`。 */
function excludeTagNames() {
    return parseExcludeTags(settings?.excludeTags);
}

/** 当前阈值。缓存里只存概率，所以这个值改了立刻生效。 */
function currentThreshold() {
    const value = Number(settings?.threshold);
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : store.DEFAULT_THRESHOLD;
}

/**
 * 取某楼层当前有效的待修改句子；swipe 或正文变了就返回空。
 * 阈值在这里套用 —— 所以调阈值能立刻重算高亮，不必把句子重跑一遍。
 */
function freshHighlightItems(id) {
    const entry = store.readFloor(context.chatMetadata, id);
    const fresh = store.isEntryFresh(entry, {
        swipeId: currentSwipeId(id),
        hash: currentHash(id),
    });
    return fresh ? store.toHighlightItems(entry, currentThreshold()) : [];
}

/**
 * 就地改 DOM 应用高亮。
 *
 * 渲染 hook 只能覆盖「重新渲染」，对已经渲染好的楼层以及刚跑完检查的楼层，
 * 必须走这条路径才能立刻看到结果。
 *
 * 这里刻意**不替换 .mes_text 的 innerHTML** —— SillyTavern 的
 * addCopyToCodeBlocks 用 addEventListener 直接绑在代码块复制按钮上
 * （public/script.js:2487、2490），换掉 innerHTML 会把这些按钮变成死元素。
 * highlightElement 用 Range 就地包裹，既有节点与监听器全部保留。
 */
export function applyToDom(ids) {
    const root = document.getElementById('chat');
    if (root === null) {
        return { applied: 0 };
    }

    let applied = 0;

    for (const id of ids) {
        const mesElement = root.querySelector(`.mes[mesid="${id}"]`);
        const textElement = mesElement?.querySelector('.mes_text');
        if (!mesElement || !textElement) {
            continue;
        }

        const items = freshHighlightItems(id);
        const result = highlightElement(textElement, items);

        mesElement.classList.toggle('jev-has-flags', result.matched.length > 0);
        applied += result.matched.length;
    }

    return { applied };
}

/**
 * 补扫：只处理「有缓存结果的楼层」和「当前带着高亮的楼层」，不扫整个聊天。
 * 长聊天里全量扫 DOM 会明显卡顿，而没缓存的楼层本来也没什么可做。
 */
function refreshAllFloors() {
    const root = document.getElementById('chat');
    if (root === null) {
        return;
    }

    const ids = new Set();

    const cached = store.getRoot(context.chatMetadata);
    for (const key of Object.keys(cached?.floors ?? {})) {
        const id = Number(key);
        if (Number.isInteger(id)) {
            ids.add(id);
        }
    }

    // 缓存可能已经失效（改了正文 / 换了 swipe），这些旧标记也要清掉
    for (const elementWithFlags of root.querySelectorAll('.mes.jev-has-flags[mesid]')) {
        const id = Number(elementWithFlags.getAttribute('mesid'));
        if (Number.isInteger(id)) {
            ids.add(id);
        }
    }

    if (ids.size > 0) {
        applyToDom([...ids]);
    }
}

let refreshTimer = null;

/** 清掉本扩展派生的所有定时器。停用与重新启用都要先清场，否则会叠加。 */
function clearRefreshTimers() {
    if (refreshInterval !== null) {
        clearInterval(refreshInterval);
        refreshInterval = null;
    }
    if (refreshTimer !== null) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
    }
}

function refreshSoon() {
    if (refreshTimer !== null) {
        clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
        refreshTimer = null;
        try {
            refreshAllFloors();
        } catch (error) {
            log('刷新高亮失败', error);
        }
    }, 150);
}

/**
 * 注册渲染管线 hook。
 * hook 必须同步 —— MessageFormatter 对 async hook 直接抛 TypeError。
 */
function registerHighlightHook() {
    const formatter = context.messageFormatter;
    if (formatter === undefined || typeof formatter.addHook !== 'function') {
        log('当前 SillyTavern 没有 messageFormatter，退化为仅在检查完成后应用高亮。');
        return;
    }

    formatter.addHook((mes, ctx) => {
        try {
            if (ctx.isReasoning) {
                return mes;
            }
            // 防御：管线正常情况下拿到的是原始 markdown，不会带我们的标记。
            // 万一拿到的是已处理过的 HTML，直接放行，避免叠出多层 <mark>。
            if (mes.includes(MARK_CLASS)) {
                return mes;
            }
            const id = ctx.messageId;
            if (!Number.isInteger(id) || id < 0) {
                return mes;
            }
            const items = freshHighlightItems(id);
            if (items.length === 0) {
                return mes;
            }
            return applyHighlights(mes, items).html;
        } catch (error) {
            console.error('[jev-sentence-check] 渲染时高亮失败', error);
            return mes;
        }
    }, { stage: formatter.stage.AFTER_MARKDOWN, order: formatter.order.LATE });
}

// ------------------------------------------------------------------ 检查流程

function setProgress(done, total, message) {
    if (ui === null) {
        return;
    }
    const percent = total === 0 ? 0 : Math.round((done / total) * 100);
    ui.progressBar.style.width = `${percent}%`;
    ui.progressText.textContent = message;
}

function showError(message) {
    if (ui === null) {
        return;
    }
    ui.error.textContent = message;
    ui.error.classList.remove('jev-hidden');
}

function clearError() {
    if (ui === null) {
        return;
    }
    ui.error.textContent = '';
    ui.error.classList.add('jev-hidden');
}

function showSummary(floors, sentences, flagged) {
    if (ui === null) {
        return;
    }
    ui.summaryFloors.textContent = String(floors);
    ui.summarySentences.textContent = String(sentences);
    ui.summaryFlagged.textContent = String(flagged);
    ui.summary.classList.remove('jev-hidden');
}

function setBusy(busy) {
    state.running = busy;
    if (ui === null) {
        return;
    }
    ui.runButton.disabled = busy;
    ui.runButton.textContent = busy ? '检查中…' : '开始检查';
    ui.cancelButton.disabled = !busy;
    ui.expression.disabled = busy;
}

/**
 * 让某条楼层显示它自己的某个 swipe。
 *
 * 优先走 ST 的 swipe()（会正确处理动画、计数器、并广播 MESSAGE_SWIPED），
 * 必须传 `swipe_picker` 来源 —— 否则 ST 会因为「只能滑最后一条」而拒绝操作历史楼层。
 * 走不通时才退回「直接改数据 + 让 ST 重绘这一条」。
 */
async function showSwipeFor(messageId, swipeId) {
    const message = getMessage(messageId);
    if (message === null) {
        return false;
    }

    const swipeApi = context.swipe;
    if (swipeApi !== undefined && typeof swipeApi.to === 'function') {
        try {
            await swipeApi.to(null, swipes.SWIPE_DIRECTION_RIGHT, {
                source: swipes.SWIPE_SOURCE_SWIPE_PICKER,
                forceMesId: messageId,
                forceSwipeId: swipeId,
            });
            return true;
        } catch (error) {
            log(`楼层 #${messageId} 走 swipe() 失败，退回直接改数据`, error);
        }
    }

    if (!swipes.moveToSwipe(message, swipeId)) {
        return false;
    }
    try {
        if (typeof context.addOneMessage === 'function') {
            context.addOneMessage(message, { forceId: messageId, type: 'swipe' });
        }
        context.eventSource?.emit?.(context.eventTypes?.MESSAGE_SWIPED, messageId);
    } catch (error) {
        log(`楼层 #${messageId} 重绘失败`, error);
    }
    return true;
}

async function runCheck(floors) {
    setBusy(true);
    clearError();
    state.cancelled = false;

    const total = floors.length;
    let done = 0;
    let sentenceCount = 0;
    let flaggedCount = 0;
    const skipped = [];
    const planned = [];

    setProgress(0, total, `准备检查 ${total} 个楼层…`);

    try {
        // 先确保后端起来了。首次加载权重可能要几十秒，所以分两步：
        // 先发 warmup（立刻返回），再轮询 health，避免一个长请求撞上 Node 的请求超时。
        setProgress(done, total, '正在确认后端状态…');
        await ensureBackendReady();

        const threshold = currentThreshold();
        const tagNames = excludeTagNames();

        for (const id of floors) {
            if (state.cancelled) {
                break;
            }

            const message = getMessage(id);
            if (message === null) {
                done++;
                setProgress(done, total, `楼层 #${id} 不存在，跳过`);
                continue;
            }

            // 1. 先复制出一个新的 swipe。之后的标记与修改都发生在副本上，
            //    原文永远留在原来的那份里，随时可以滑回去。
            //    只加不切 —— 全部处理完再统一切换，避免中途反复重绘。
            const newSwipeId = swipes.duplicateToNewSwipe(message);
            if (newSwipeId === -1) {
                skipped.push(id);
                done++;
                setProgress(done, total, `楼层 #${id} 不支持 swipe，跳过`);
                continue;
            }

            const text = message.swipes[newSwipeId];

            // 2. 分句。被排除标签包裹的内容在这里就被剔掉，根本不送模型。
            const sentences = splitSentences(text, {
                maxChars: settings.maxChars,
                excludeTags: tagNames,
            });

            if (sentences.length === 0) {
                store.clearFloor(context.chatMetadata, id);
                done++;
                setProgress(done, total, `楼层 #${id} 没有可判定的句子，跳过`);
                continue;
            }

            setProgress(done, total, `正在检查楼层 #${id}（${sentences.length} 句）…`);

            const { results } = await transport.predict(sentences, { threshold });

            const entries = sentences.map((sentence, index) => ({
                text: sentence,
                bad: Number(results[index]?.bad_probability ?? 0),
                needs_revision: Boolean(results[index]?.needs_revision),
            }));

            // 缓存挂在**新 swipe** 上，切过去之后高亮才对得上
            store.writeFloor(context.chatMetadata, id, {
                swipeId: newSwipeId,
                hash: store.hashText(text),
                model: DEFAULT_MODEL,
                threshold,
                sentences: entries,
            });

            sentenceCount += entries.length;
            flaggedCount += entries.filter(item => store.needsRevision(item, threshold)).length;
            planned.push({ id, swipeId: newSwipeId });
            done++;
            setProgress(done, total, `已完成 ${done}/${total} 个楼层`);
        }

        context.saveMetadataDebounced();

        // 3. 全部判定完，再统一切到各自的副本并重绘
        if (planned.length > 0) {
            setProgress(done, total, '正在切换到标记版…');
            for (const item of planned) {
                if (state.cancelled) {
                    break;
                }
                await showSwipeFor(item.id, item.swipeId);
            }
        }

        applyToDom(planned.map(item => item.id));
        showSummary(planned.length, sentenceCount, flaggedCount);

        const skippedNote = skipped.length > 0
            ? `（${skipped.length} 个楼层不支持 swipe 被跳过：${skipped.join(', ')}）`
            : '';
        if (state.cancelled) {
            setProgress(done, total, `已取消（完成 ${done}/${total} 个楼层）`);
        } else {
            setProgress(total, total, `完成：${flaggedCount} 句需要修改${skippedNote}`);
        }

        renderPreview();
    } catch (error) {
        log('检查失败', error);
        showError(String(error?.message ?? error));
        setProgress(done, total, '已中止');
    } finally {
        // 无论中途是否出错，已完成的楼层都要落盘，不能白跑
        context.saveMetadataDebounced();
        setBusy(false);
    }
}

/** 后端状态：not-found → 报错；loading → 轮询等；ready → 返回。 */
async function ensureBackendReady() {
    let health;

    try {
        health = await transport.health();
    } catch (error) {
        // 首次探测失败多半是子进程还没起，尝试 warmup 再探
        log('初次探测后端失败，尝试预热', error);
        await transport.warmup();
        health = await transport.health();
    }

    if (health.ready) {
        return health;
    }

    await transport.warmup();

    const deadline = Date.now() + 5 * 60 * 1000;
    let waited = 0;

    while (Date.now() < deadline) {
        if (state.cancelled) {
            throw new Error('已取消。');
        }
        await new Promise(resolve => setTimeout(resolve, 1500));
        waited += 1.5;

        const current = await transport.health();
        if (current.ready) {
            return current;
        }
        if (current.error) {
            throw new Error(`后端加载失败：${current.error}`);
        }
        setProgress(0, 1, `正在加载模型权重…（已等待 ${Math.round(waited)} 秒）`);
    }

    throw new Error('等待后端就绪超时（5 分钟）。请查看拓展日志或后端日志。');
}

// ------------------------------------------------------------------ 对话框 UI

const DIALOG_HTML = `
<div class="jev-dialog" role="dialog" aria-modal="true" aria-label="JEV 句子质检总控面板">
    <h3>
        <span class="fa-solid fa-magnifying-glass-chart"></span>
        <span>JEV 句子质检</span>
        <span class="jev-title-spacer"></span>
        <span class="jev-status" data-role="status">
            <span class="jev-dot" data-role="dot"></span>
            <span data-role="status-text">未连接</span>
        </span>
    </h3>

    <div class="jev-hint">
        模型对<b>单句</b>判断「可以保留 / 需要修改」。检查前会先把选中楼层<b>复制成一个新的滑动（swipe）</b>，
        标记与修改都发生在副本上，原文随时可以滑回去。
        楼层号就是消息左上角的编号，<b>从 0 开始</b>。
    </div>

    <div class="jev-section">
        <div class="jev-section-title">检测</div>
        <div class="jev-row">
            <span class="jev-label">楼层</span>
            <input class="text_pole jev-mono" data-role="expression" style="flex:1;min-width:180px;"
                   placeholder="例如 3,5,7-9" />
        </div>
        <div class="jev-row">
            <button class="menu_button" data-role="fill-all">全部</button>
            <button class="menu_button" data-role="fill-ai">仅 AI 楼层</button>
            <button class="menu_button" data-role="fill-last">最近 5 条</button>
            <button class="menu_button" data-role="fill-cached">已检查过的</button>
            <span class="jev-title-spacer"></span>
            <button class="menu_button" data-role="clear-cache">清除本聊天结果</button>
        </div>
        <div class="jev-preview" data-role="preview"></div>

        <div class="jev-row">
            <span class="jev-label">判定阈值</span>
            <input type="range" min="0.05" max="0.95" step="0.05" data-role="threshold"
                   style="flex:1;min-width:140px;" />
            <span class="jev-mono" data-role="threshold-value">0.50</span>
        </div>
        <div class="jev-hint">
            越小越严格（更多句子会被判定为「需要修改」）。
            改这个值会<b>立刻重算已有结果</b>，不需要重新跑模型。
        </div>

        <label class="jev-label">排除标签 —— 被这些标签包裹的内容不参与判定</label>
        <input class="text_pole jev-mono" data-role="exclude-tags" placeholder="例如 &lt;1&gt;&lt;/1&gt; 或 &lt;skip&gt;" />
        <div class="jev-hint">
            多个用逗号或换行分隔。<code>&lt;1&gt;&lt;/1&gt;</code>、<code>&lt;1/&gt;</code>、<code>1</code> 三种写法都认。
            只有<b>成对闭合</b>的标签会被剥掉 —— 少写一个闭合标签不会吞掉后面的正文。
        </div>
    </div>

    <div class="jev-section">
        <div class="jev-section-title">模型</div>
        <div class="jev-row">
            <span class="jev-label">使用</span>
            <select class="text_pole" data-role="model-select" style="flex:1"></select>
            <button class="menu_button" data-role="model-refresh">刷新</button>
        </div>
        <div class="jev-hint" data-role="model-note"></div>

        <div class="jev-row">
            <span class="jev-label">下载源</span>
            <select class="text_pole" data-role="mirror-select" style="flex:1"></select>
        </div>
        <div class="jev-hint" data-role="mirror-note"></div>

        <div class="jev-row">
            <button class="menu_button" data-role="download-model">下载所选模型</button>
            <button class="menu_button" data-role="cancel-download" disabled>取消下载</button>
            <span class="jev-title-spacer"></span>
            <span class="jev-hint" data-role="download-state"></span>
        </div>
        <div class="jev-progress-track"><div class="jev-progress-bar" data-role="download-bar"></div></div>
    </div>

    <div class="jev-section">
        <div class="jev-section-title">独立后端</div>
        <div class="jev-hint">
            只给<b>没有服务端插件加载器</b>的客户端用（TauriTavern 等）：需要一个单独跑着的 Python 服务。
            右上角状态灯显示 <code>direct</code> 就是走的这条路。
        </div>
        <div class="jev-row">
            <span class="jev-label">设备</span>
            <select class="text_pole" data-role="device-kind" style="flex:1">
                <option value="gpu">GPU（NVIDIA CUDA）— 快，需支持 bf16 的显卡</option>
                <option value="cpu">纯 CPU（内存）— 无需显卡，0.8B 约 1.2 s/句，内存 4 GB 起</option>
            </select>
        </div>
        <div class="jev-hint" data-role="device-note">
            这里的选择决定生成的安装脚本装哪种 PyTorch：GPU 版约 3 GB，CPU 版约 0.2 GB。
            两种模式跑同一套模型与判定逻辑，结果一致。
        </div>
        <div class="jev-row">
            <span class="jev-label">快速安装</span>
            <button class="menu_button" data-role="download-bundle">下载预打包后端</button>
            <span class="jev-title-spacer"></span>
            <span class="jev-hint" data-role="bundle-state"></span>
        </div>
        <div class="jev-hint">
            按上面选的设备下载**打好的整包**（自带 Python，解压即用，机器上不用装 Python，也不用跑安装脚本）。
            GPU 包超过 2GB 会拆成多卷：全部下载后，在命令行里用
            <code>copy /b 文件名.zip.001+文件名.zip.002 文件名.zip</code> 合并，发布页有说明。
        </div>
        <div class="jev-row">
            <span class="jev-label">安装到</span>
            <input class="text_pole jev-mono" data-role="install-dir" style="flex:1"
                   placeholder="例如 D:\\jev-backend" />
        </div>
        <div class="jev-row">
            <button class="menu_button" data-role="generate-installer">生成一键安装脚本</button>
            <button class="menu_button" data-role="warmup">预热后端</button>
        </div>
        <div class="jev-hint" data-role="install-hint">
            浏览器里的扩展没法直接建 Python 环境，所以这里生成一个脚本，
            下载后双击运行一次即可（需要机器上有 Python 3.11+）。
        </div>
    </div>

    <div class="jev-section">
        <div class="jev-progress-track"><div class="jev-progress-bar" data-role="progress-bar"></div></div>
        <div class="jev-hint" data-role="progress-text">就绪。</div>
        <div class="jev-error jev-hidden" data-role="error"></div>
        <div class="jev-summary jev-hidden" data-role="summary">
            <span>楼层 <b data-role="sum-floors">0</b></span>
            <span>句子 <b data-role="sum-sentences">0</b></span>
            <span>需要修改 <b data-role="sum-flagged">0</b></span>
        </div>
    </div>

    <div class="jev-row">
        <span class="jev-title-spacer"></span>
        <button class="menu_button" data-role="cancel" disabled>取消</button>
        <button class="menu_button" data-role="run">开始检查</button>
        <button class="menu_button" data-role="close">关闭</button>
    </div>
</div>
`;

/**
 * 点高亮句子时弹出的小编辑器。
 * 修改会写进**当前这个 swipe**（也就是检查时复制出来的那份），原文不受影响。
 */
const EDIT_HTML = `
<div class="jev-dialog jev-edit-dialog" role="dialog" aria-modal="true" aria-label="修改句子">
    <h3>
        <span class="fa-solid fa-pen-to-square"></span>
        <span>修改这一句</span>
        <span class="jev-title-spacer"></span>
        <span class="jev-hint" data-role="edit-where"></span>
    </h3>

    <div class="jev-section">
        <div class="jev-label">原文（模型判定为需要修改）</div>
        <div class="jev-quote" data-role="edit-original"></div>
        <div class="jev-label">改成</div>
        <textarea class="text_pole jev-mono" data-role="edit-text" rows="4" style="width:100%"></textarea>
    </div>

    <div class="jev-row">
        <label class="checkbox_label" style="display:flex;align-items:center;gap:6px;">
            <input type="checkbox" data-role="edit-always-unmark">
            <span>以后修改后直接取消标记，不再询问</span>
        </label>
    </div>

    <div class="jev-error jev-hidden" data-role="edit-error"></div>

    <div class="jev-row">
        <span class="jev-title-spacer"></span>
        <button class="menu_button" data-role="edit-cancel">取消</button>
        <button class="menu_button" data-role="edit-keep">保存并保留标记</button>
        <button class="menu_button" data-role="edit-unmark">保存并取消标记</button>
    </div>
</div>
`;

/** 摘要按**当前阈值**从缓存重算，这样改阈值后数字也跟着动。 */
function refreshSummary() {
    const stats = store.summarize(context.chatMetadata, currentThreshold());
    showSummary(stats.floors, stats.sentences, stats.flagged);
}

function buildDialog() {
    const overlay = element('div', 'jev-overlay jev-hidden');
    overlay.innerHTML = DIALOG_HTML;

    const dialog = overlay.querySelector('.jev-dialog');
    const find = role => dialog.querySelector(`[data-role="${role}"]`);

    ui = {
        overlay,
        dialog,
        dot: find('dot'),
        statusText: find('status-text'),
        expression: find('expression'),
        preview: find('preview'),
        threshold: find('threshold'),
        thresholdValue: find('threshold-value'),
        excludeTags: find('exclude-tags'),
        modelSelect: find('model-select'),
        modelNote: find('model-note'),
        mirrorSelect: find('mirror-select'),
        mirrorNote: find('mirror-note'),
        downloadButton: find('download-model'),
        cancelDownloadButton: find('cancel-download'),
        downloadBar: find('download-bar'),
        downloadState: find('download-state'),
        installDir: find('install-dir'),
        installHint: find('install-hint'),
        deviceKind: find('device-kind'),
        bundleState: find('bundle-state'),
        progressBar: find('progress-bar'),
        progressText: find('progress-text'),
        error: find('error'),
        summary: find('summary'),
        summaryFloors: find('sum-floors'),
        summarySentences: find('sum-sentences'),
        summaryFlagged: find('sum-flagged'),
        runButton: find('run'),
        cancelButton: find('cancel'),
    };

    find('run').addEventListener('click', onRunClicked);
    find('cancel').addEventListener('click', () => {
        state.cancelled = true;
    });
    find('close').addEventListener('click', () => {
        state.cancelled = true;
        hideDialog();
    });
    find('warmup').addEventListener('click', onWarmupClicked);
    find('clear-cache').addEventListener('click', onClearCacheClicked);
    find('generate-installer').addEventListener('click', onGenerateInstallerClicked);
    find('download-bundle').addEventListener('click', onDownloadBundleClicked);
    find('model-refresh').addEventListener('click', () => refreshModels({ announce: true }));
    find('download-model').addEventListener('click', onDownloadModelClicked);
    find('cancel-download').addEventListener('click', onCancelDownloadClicked);

    for (const kind of ['all', 'ai', 'last', 'cached']) {
        find(`fill-${kind}`).addEventListener('click', () => fillExpression(kind));
    }

    ui.expression.addEventListener('input', () => {
        settings.lastExpression = ui.expression.value;
        context.saveSettingsDebounced();
        renderPreview();
    });

    // 阈值只影响「显示时怎么套用」，所以改完立刻重算高亮即可，不用重跑模型
    ui.threshold.addEventListener('input', () => {
        settings.threshold = Number(ui.threshold.value);
        ui.thresholdValue.textContent = settings.threshold.toFixed(2);
        context.saveSettingsDebounced();
        refreshAllFloors();
        refreshSummary();
    });

    ui.excludeTags.addEventListener('input', () => {
        settings.excludeTags = ui.excludeTags.value;
        context.saveSettingsDebounced();
    });

    ui.modelSelect.addEventListener('change', () => {
        settings.lastModel = ui.modelSelect.value;
        context.saveSettingsDebounced();
        renderModelNote();
    });

    ui.mirrorSelect.addEventListener('change', () => {
        settings.lastMirror = ui.mirrorSelect.value;
        context.saveSettingsDebounced();
        renderMirrorNote();
    });

    ui.installDir.addEventListener('input', () => {
        settings.lastInstallDir = ui.installDir.value;
        context.saveSettingsDebounced();
    });

    ui.deviceKind.addEventListener('change', () => {
        settings.lastDeviceKind = ui.deviceKind.value;
        context.saveSettingsDebounced();
    });

    overlay.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            state.cancelled = true;
            hideDialog();
        }
    });

    document.body.appendChild(overlay);

    buildEditDialog();
    return overlay;
}

/** 点高亮句子时弹出的编辑器。 */
function buildEditDialog() {
    const overlay = element('div', 'jev-overlay jev-hidden');
    overlay.innerHTML = EDIT_HTML;

    const dialog = overlay.querySelector('.jev-dialog');
    const find = role => dialog.querySelector(`[data-role="${role}"]`);

    ui.edit = {
        overlay,
        dialog,
        where: find('edit-where'),
        original: find('edit-original'),
        text: find('edit-text'),
        alwaysUnmark: find('edit-always-unmark'),
        error: find('edit-error'),
        keepButton: find('edit-keep'),
        unmarkButton: find('edit-unmark'),
    };

    find('edit-cancel').addEventListener('click', () => hideEditDialog());
    find('edit-keep').addEventListener('click', () => applyEdit({ unmark: false }));
    find('edit-unmark').addEventListener('click', () => applyEdit({ unmark: true }));

    // 勾上「不再询问」之后就把两个选择收成一个，避免语义含糊
    ui.edit.alwaysUnmark.addEventListener('change', () => {
        settings.autoUnmarkAfterEdit = ui.edit.alwaysUnmark.checked;
        context.saveSettingsDebounced();
        syncEditButtons();
    });

    overlay.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            hideEditDialog();
        }
    });

    // 点遮罩空白处关闭
    overlay.addEventListener('click', event => {
        if (event.target === overlay) {
            hideEditDialog();
        }
    });

    document.body.appendChild(overlay);
}

function showDialog() {
    ui.overlay.classList.remove('jev-hidden');

    ui.expression.value = settings.lastExpression ?? '';
    ui.threshold.value = String(currentThreshold());
    ui.thresholdValue.textContent = currentThreshold().toFixed(2);
    ui.excludeTags.value = settings.excludeTags ?? '';
    ui.installDir.value = settings.lastInstallDir ?? '';
    ui.deviceKind.value = settings.lastDeviceKind === 'cpu' ? 'cpu' : 'gpu';

    renderPreview();
    refreshSummary();
    refreshBackendStatus();
    refreshModels();
    setTimeout(() => ui.expression.focus(), 30);
}

function hideDialog() {
    ui.overlay.classList.add('jev-hidden');
}

function parseExpression() {
    return parseFloorExpression(ui.expression.value, { maxFloor: maxFloor() });
}

function renderPreview() {
    if (ui === null) {
        return;
    }

    const { floors, invalid } = parseExpression();
    ui.preview.replaceChildren();

    if (ui.expression.value.trim() === '') {
        ui.preview.appendChild(element('div', 'jev-hint',
            maxFloor() < 0 ? '当前聊天是空的。' : `当前共 ${maxFloor() + 1} 个楼层（0 ~ ${maxFloor()}）。`));
        return;
    }

    if (invalid.length > 0) {
        const detail = invalid.map(item => item.reason === 'out-of-range'
            ? `"${item.token}" 超出范围（合法 0 ~ ${maxFloor()}）`
            : `"${item.token}" 不是合法的楼层号`).join('；');
        ui.preview.appendChild(element('div', 'jev-error', detail));
    }

    if (floors.length === 0) {
        if (invalid.length === 0) {
            ui.preview.appendChild(element('div', 'jev-hint', '没有解析出任何楼层。'));
        }
        return;
    }

    const header = element('div', 'jev-hint', `解析出 ${floors.length} 个楼层`
        + (floors.length > MAX_FLOORS_PER_RUN ? `（一次最多 ${MAX_FLOORS_PER_RUN} 个，超出的会被忽略）` : ''));
    ui.preview.appendChild(header);

    for (const id of floors.slice(0, 200)) {
        const row = element('div', 'jev-preview-row');
        if (store.readFloor(context.chatMetadata, id) !== null) {
            row.classList.add('jev-cached');
        }
        row.appendChild(element('div', 'jev-preview-id', `#${id}`));
        row.appendChild(element('div', 'jev-preview-name', floorLabel(id)));
        row.appendChild(element('div', 'jev-preview-text', previewText(id)));
        ui.preview.appendChild(row);
    }
}

function fillExpression(kind) {
    const chat = getChat();
    let floors = [];

    if (kind === 'all') {
        floors = chat.map((_, index) => index);
    } else if (kind === 'ai') {
        floors = chat.map((message, index) => (message.is_user ? -1 : index)).filter(id => id >= 0);
    } else if (kind === 'last') {
        floors = chat.map((_, index) => index).slice(-5);
    } else if (kind === 'cached') {
        floors = chat
            .map((_, index) => index)
            .filter(id => store.readFloor(context.chatMetadata, id) !== null);
    }

    ui.expression.value = formatFloorExpression(floors);
    settings.lastExpression = ui.expression.value;
    context.saveSettingsDebounced();
    renderPreview();
}

async function refreshBackendStatus() {
    if (ui === null) {
        return;
    }

    const set = (kind, text) => {
        ui.dot.className = `jev-dot ${kind}`;
        ui.statusText.textContent = text;
    };

    set('', '检测中…');

    try {
        const health = await transport.health();
        if (health.ready) {
            set('jev-ready', `就绪 · ${health.mode ?? transport.mode}`);
        } else if (health.loading) {
            set('jev-loading', '正在加载权重…');
        } else if (health.error) {
            set('jev-error', '后端报错');
        } else if (!health.processRunning) {
            set('', '后端未启动');
        } else {
            set('', '未加载');
        }
    } catch (error) {
        set('jev-error', '找不到后端');
        log('后端探测失败', error);
    }
}

async function onWarmupClicked() {
    clearError();
    ui.statusText.textContent = '正在预热…';
    ui.dot.className = 'jev-dot jev-loading';
    try {
        await transport.warmup();
        await refreshBackendStatus();
    } catch (error) {
        ui.dot.className = 'jev-dot jev-error';
        ui.statusText.textContent = '预热失败';
        showError(String(error?.message ?? error));
    }
}

// ------------------------------------------------------------------ 模型管理

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return '';
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(unit === 0 || value >= 100 ? 0 : 1)} ${units[unit]}`;
}

function selectedModel() {
    const id = ui.modelSelect.value;
    return (state.models?.models ?? []).find(model => model.id === id) ?? null;
}

function renderModelNote() {
    const model = selectedModel();
    if (model === null) {
        ui.modelNote.textContent = '';
        return;
    }
    const bits = [model.note];
    bits.push(model.installed ? `已装在 ${model.path}` : `尚未下载，会存到 ${model.path}`);
    if (model.isCurrent) {
        bits.push('后端当前正在用它');
    }
    ui.modelNote.textContent = bits.filter(Boolean).join(' · ');
}

function renderMirrorNote() {
    const mirror = (state.models?.mirrors ?? []).find(item => item.id === ui.mirrorSelect.value);
    ui.mirrorNote.textContent = mirror?.note ?? '';
}

function fillSelect(select, entries, wanted) {
    select.replaceChildren();
    for (const entry of entries) {
        const option = document.createElement('option');
        option.value = entry.value;
        option.textContent = entry.label;
        select.appendChild(option);
    }
    if (entries.some(entry => entry.value === wanted)) {
        select.value = wanted;
    }
}

/**
 * 拉取模型清单。后端没起来时这里必然失败 —— 但那是**正常状态**，
 * 不该弹错误挡住主流程，只在模型那一栏里说明一下。
 */
async function refreshModels({ announce = false } = {}) {
    try {
        const data = await transport.listModels();
        state.models = data;

        fillSelect(ui.modelSelect,
            (data.models ?? []).map(model => ({
                value: model.id,
                label: `${model.label}${model.installed ? ' ✓' : ''}`,
            })),
            ui.modelSelect.value || settings.lastModel);

        fillSelect(ui.mirrorSelect,
            (data.mirrors ?? []).map(mirror => ({ value: mirror.id, label: mirror.label })),
            settings.lastMirror || data.defaultMirror);

        renderModelNote();
        renderMirrorNote();
        if (announce) {
            ui.downloadState.textContent = '模型列表已刷新。';
        }
        return true;
    } catch (error) {
        state.models = null;
        fillSelect(ui.modelSelect, [{ value: '', label: '（后端未连接）' }], '');
        fillSelect(ui.mirrorSelect, [{ value: '', label: '（后端未连接）' }], '');
        ui.modelNote.textContent = '模型管理需要后端在跑。';
        ui.mirrorNote.textContent = '';
        log('拉取模型列表失败', error);
        return false;
    }
}

function renderDownloadJob(job) {
    const percent = Math.max(0, Math.min(100, Number(job.percent ?? 0)));
    ui.downloadBar.style.width = `${percent}%`;

    const size = job.totalBytes > 0
        ? `${formatBytes(job.doneBytes)} / ${formatBytes(job.totalBytes)}`
        : '';
    ui.downloadState.textContent = [job.message ?? job.state, `${percent.toFixed(1)}%`, size]
        .filter(Boolean).join(' · ');
    if (job.error) {
        ui.downloadState.textContent += ` — ${job.error}`;
    }
}

function stopDownloadPolling() {
    if (state.downloadTimer !== null) {
        clearInterval(state.downloadTimer);
        state.downloadTimer = null;
    }
}

async function pollDownload() {
    try {
        const { job } = await transport.downloadStatus();
        if (!job) {
            ui.downloadState.textContent = '没有进行中的下载。';
            stopDownloadPolling();
            ui.downloadButton.disabled = false;
            ui.cancelDownloadButton.disabled = true;
            return;
        }

        renderDownloadJob(job);

        if (job.state === 'done') {
            stopDownloadPolling();
            ui.downloadButton.disabled = false;
            ui.cancelDownloadButton.disabled = true;
            await refreshModels();
            ui.downloadState.textContent = `${job.model} 下载完成。`;
        } else if (job.state === 'failed' || job.state === 'cancelled') {
            stopDownloadPolling();
            ui.downloadButton.disabled = false;
            ui.cancelDownloadButton.disabled = true;
        }
    } catch (error) {
        stopDownloadPolling();
        ui.downloadButton.disabled = false;
        ui.cancelDownloadButton.disabled = true;
        ui.downloadState.textContent = `查询下载状态失败：${error?.message ?? error}`;
    }
}

async function onDownloadModelClicked() {
    clearError();

    // 先看后端在不在，再看选没选模型 —— 「请先选模型」只在列表都拿到了
    // 却没选中时才有意义；后端没跑时给出真正的原因。
    if (state.models === null) {
        showError('下载模型需要后端在跑。\n'
            + '请先在下面「独立后端」一栏生成安装脚本并运行一次，'
            + '或者用插件提供的启动脚本把后端跑起来，然后点「刷新」。');
        return;
    }

    const model = selectedModel();
    if (model === null) {
        showError('请先选择要下载的模型。');
        return;
    }

    if (model.installed) {
        ui.downloadState.textContent = `${model.id} 已经装好了，无需重复下载。`;
        return;
    }

    try {
        ui.downloadButton.disabled = true;
        ui.cancelDownloadButton.disabled = false;
        ui.downloadState.textContent = '正在提交下载任务…';

        await transport.downloadModel(model.id, { mirror: ui.mirrorSelect.value });

        stopDownloadPolling();
        state.downloadTimer = setInterval(pollDownload, 1000);
        await pollDownload();
    } catch (error) {
        ui.downloadButton.disabled = false;
        ui.cancelDownloadButton.disabled = true;
        showError(String(error?.message ?? error));
    }
}

async function onCancelDownloadClicked() {
    try {
        await transport.cancelDownload();
        ui.downloadState.textContent = '正在取消…';
    } catch (error) {
        showError(String(error?.message ?? error));
    }
}

// ------------------------------------------------------- 生成后端安装脚本

/**
 * 触发浏览器下载（预构建包走 GitHub 的重定向直链，
 * 服务器带 Content-Disposition: attachment，浏览器会直接下载）。
 */
function triggerDownload(url) {
    const link = document.createElement('a');
    link.href = url;
    document.body.appendChild(link);
    link.click();
    link.remove();
}

/**
 * 下载预构建后端包：按设备从 GitHub Release 拿资产并触发浏览器下载。
 * 拆卷的 GPU 包会一次触发多个下载（浏览器可能询问一次「下载多个文件」许可）。
 */
async function onDownloadBundleClicked() {
    clearError();

    const kind = settings.lastDeviceKind === 'cpu' ? 'cpu' : 'gpu';
    ui.bundleState.textContent = '正在查询发布页…';

    try {
        const response = await fetch(distReleaseApiUrl(), {
            headers: { Accept: 'application/vnd.github+json' },
        });
        if (!response.ok) {
            throw new Error(`GitHub 返回 ${response.status}`);
        }
        const release = await response.json();

        const assets = pickBundleAssets(release, kind);
        if (assets.length === 0) {
            throw new Error(`${kind === 'cpu' ? 'CPU' : 'GPU'} 预构建包还没有发布，可以先用下面的「生成一键安装脚本」。`);
        }

        for (const asset of assets) {
            triggerDownload(asset.url);
        }
        const totalGB = (assets.reduce((sum, asset) => sum + asset.size, 0) / 1e9).toFixed(1);
        ui.bundleState.textContent = assets.length > 1
            ? `已开始下载 ${assets.length} 个分卷（共约 ${totalGB} GB）。全部下完后按发布页说明合并，解压即用。`
            : `已开始下载（约 ${totalGB} GB）。下载完成后解压，双击 start-backend.bat 即可。`;
    } catch (error) {
        ui.bundleState.textContent = '';
        showError(`获取预构建包失败：${error?.message ?? error}。可以改用下面的「生成一键安装脚本」。`);
    }
}

function downloadTextFile(filename, content) {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * 生成「一键安装后端」的脚本。
 *
 * 浏览器沙箱里没法建 venv / 跑 pip / 往任意目录写文件，所以这里能做到的上限是：
 * 把**随包携带的后端源码**读出来，打成脚本让用户双击一次。
 * 源码直接从这个扩展自己的目录取（fetch 自己的静态文件），不需要 git，也不用联网。
 */
async function onGenerateInstallerClicked() {
    clearError();

    const targetDir = (ui.installDir.value ?? '').trim();
    if (targetDir === '') {
        showError('请先填写要安装到哪个目录，例如 D:\\jev-backend');
        ui.installDir.focus();
        return;
    }

    ui.installHint.textContent = '正在读取随包的后端源码…';

    try {
        const files = [];
        for (const name of BACKEND_FILES) {
            const response = await fetch(new URL(name, BACKEND_SOURCE_BASE));
            if (!response.ok) {
                throw new Error(`取不到 ${name}（HTTP ${response.status}）`);
            }
            files.push({ path: name, content: await response.text() });
        }

        // 启动器落在安装根（不进 server/），这样它能按自己的布局探测到 venv 与模型
        const rootFiles = [];
        for (const name of LAUNCHER_FILES) {
            const response = await fetch(new URL(`./server-plugin/${name}`, import.meta.url));
            if (!response.ok) {
                throw new Error(`取不到 ${name}（HTTP ${response.status}）`);
            }
            rootFiles.push({ path: name, content: await response.text() });
        }

        const { filename, content } = buildInstaller({
            targetDir,
            files,
            rootFiles,
            deviceKind: settings.lastDeviceKind === 'cpu' ? 'cpu' : 'gpu',
        });
        downloadTextFile(filename, content);

        ui.installHint.textContent = `已生成 ${filename}（在浏览器下载目录里）。`
            + '把它放到任意位置双击运行一次即可——脚本会装好后端和启动器，'
            + '之后在安装目录里运行 node start-backend.mjs 启动。'
            + '没模型也能启动，先到面板「模型」一栏下载，再重启一次后端。';
    } catch (error) {
        ui.installHint.textContent = '';
        const inStPluginsLayout = !location.pathname.includes('/third-party/');
        showError(`生成安装脚本失败：${error?.message ?? error}`
            + (inStPluginsLayout
                ? '\n（看起来是原版 SillyTavern：后端由 install.mjs 装在 plugins/ 里，通常不需要这一步）'
                : ''));
    }
}

function onClearCacheClicked() {
    store.clearAll(context.chatMetadata);
    context.saveMetadataDebounced();
    refreshAllFloors();
    renderPreview();
    refreshSummary();
    ui.progressText.textContent = '已清除本聊天的检查结果。';
    clearError();
}

// ------------------------------------------------------------ 点击修改句子

/**
 * 点聊天区里的高亮句子 → 打开小编辑器。
 *
 * 注意要同时认 `jev-mark` 与 `custom-jev-mark`：ST 的 DOMPurify 钩子
 * 会给消息 HTML 里的 class 加 `custom-` 前缀（public/scripts/chats.js:1921-1933），
 * 所以经过重新渲染的那批标记类名是带前缀的。
 */
function onChatClicked(event) {
    const mark = event.target?.closest?.('mark.jev-mark, mark.custom-jev-mark');
    if (!mark) {
        return;
    }

    const mesElement = mark.closest('.mes[mesid]');
    if (!mesElement) {
        return;
    }

    const messageId = Number(mesElement.getAttribute('mesid'));
    if (!Number.isInteger(messageId)) {
        return;
    }

    const text = mark.textContent ?? '';
    if (text === '') {
        return;
    }

    openEditDialog({ messageId, swipeId: currentSwipeId(messageId), text });
}

/** 勾了「不再询问」就只留一个保存按钮，行为固定为「保存并取消标记」。 */
function syncEditButtons() {
    const always = ui.edit.alwaysUnmark.checked;
    ui.edit.keepButton.classList.toggle('jev-hidden', always);
    ui.edit.unmarkButton.textContent = always ? '保存' : '保存并取消标记';
}

function openEditDialog(target) {
    state.editing = target;

    ui.edit.where.textContent = `楼层 #${target.messageId} · 滑动 ${target.swipeId}`;
    ui.edit.original.textContent = target.text;
    ui.edit.text.value = target.text;
    ui.edit.alwaysUnmark.checked = Boolean(settings.autoUnmarkAfterEdit);
    ui.edit.error.classList.add('jev-hidden');
    ui.edit.error.textContent = '';
    syncEditButtons();

    ui.edit.overlay.classList.remove('jev-hidden');
    setTimeout(() => ui.edit.text.focus(), 30);
}

function hideEditDialog() {
    state.editing = null;
    ui.edit.overlay.classList.add('jev-hidden');
}

function showEditError(message) {
    ui.edit.error.textContent = message;
    ui.edit.error.classList.remove('jev-hidden');
}

/** 从缓存里删掉某楼层的一条句子（按文本匹配），用于「取消标记」。 */
function forgetSentence(messageId, sentenceText) {
    const entry = store.readFloor(context.chatMetadata, messageId);
    if (entry === null || !Array.isArray(entry.sentences)) {
        return;
    }
    const before = entry.sentences.length;
    entry.sentences = entry.sentences.filter(item => item?.text !== sentenceText);
    if (entry.sentences.length !== before) {
        context.saveMetadataDebounced();
    }
}

/**
 * 应用编辑。
 *
 * 只替换**当前这个 swipe** 里的内容 —— 也就是检查时复制出来的那份副本，
 * 原文（swipe[0]）一动不动。找不到原句时宁可报错，也不猜着改坏正文。
 */
async function applyEdit({ unmark }) {
    const target = state.editing;
    if (target === null) {
        return;
    }

    const replacement = ui.edit.text.value;
    if (replacement.trim() === '') {
        showEditError('不能改成空内容。');
        return;
    }

    const message = getMessage(target.messageId);
    if (message === null) {
        showEditError('这条楼层已经不存在了。');
        return;
    }

    const ok = swipes.replaceSentenceInSwipe(message, target.swipeId, target.text, replacement);
    if (!ok) {
        showEditError('在正文里找不到这一句的原文（可能含有格式标记）。\n'
            + '为避免改坏内容，这里不做替换。可以在酒馆里用编辑功能手工改。');
        return;
    }

    // 勾了「不再询问」就一律取消标记 —— 与按钮语义保持一致，不留模糊地带
    const finalUnmark = unmark || Boolean(settings.autoUnmarkAfterEdit);

    // 记住用户的选择：以后不再问
    if (ui.edit.alwaysUnmark.checked) {
        settings.autoUnmarkAfterEdit = true;
        context.saveSettingsDebounced();
    }

    if (finalUnmark) {
        forgetSentence(target.messageId, target.text);
    } else {
        // 保留标记 → 把缓存里的句子文本同步成新文本，高亮才不会失配
        const entry = store.readFloor(context.chatMetadata, target.messageId);
        const sentence = entry?.sentences?.find(item => item?.text === target.text);
        if (sentence) {
            sentence.text = replacement;
            context.saveMetadataDebounced();
        }
    }

    hideEditDialog();

    // 让酒馆重绘这条楼层
    if (typeof context.addOneMessage === 'function') {
        context.addOneMessage(message, { forceId: target.messageId, type: 'swipe' });
    }

    await refreshBackendStatus().catch(() => {});
    setTimeout(() => {
        applyToDom([target.messageId]);
        refreshSummary();
    }, 50);
}

async function onRunClicked() {
    if (state.running) {
        return;
    }

    clearError();
    const { floors, invalid } = parseExpression();

    if (floors.length === 0) {
        showError(invalid.length > 0
            ? '楼层表达式里有非法项，请修正后再试。'
            : '请先填写要检查的楼层，例如 3,5,7-9。');
        return;
    }

    if (floors.length > MAX_FLOORS_PER_RUN) {
        showError(`一次最多检查 ${MAX_FLOORS_PER_RUN} 个楼层，当前选中 ${floors.length} 个。请分批进行。`);
        return;
    }

    const targets = floors.filter(id => getMessage(id) !== null);
    if (targets.length === 0) {
        showError('选中的楼层都不存在（可能聊天已经切换或变短了）。');
        return;
    }

    await runCheck(targets);
}

// ------------------------------------------------------------------ 设置面板

function registerSettingsPanel() {
    const host = document.getElementById('extensions_settings2');
    if (host === null) {
        log('没有找到 extensions_settings2，跳过设置面板。');
        return;
    }

    const wrapper = element('div', 'jev-settings');
    wrapper.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>JEV Sentence Check</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="jev-settings-help">
                    逐句质检的<b>使用入口在聊天输入框上方</b>的「JEV 句子质检」按钮里，
                    那里集中了楼层、阈值、排除标签、模型管理与后端安装。
                    <br>
                    这一栏只放<b>连接相关</b>的设置 —— 平时用默认值就行。
                    结果保存在当前聊天里，不会修改消息原文。
                </div>

                <label class="jev-label" for="jev_mode">后端连接方式</label>
                <select id="jev_mode" class="text_pole">
                    <option value="${MODES.AUTO}">自动探测（推荐）</option>
                    <option value="${MODES.ST_PLUGIN}">SillyTavern 服务端插件</option>
                    <option value="${MODES.DIRECT}">直连独立服务</option>
                </select>

                <label class="jev-label" for="jev_direct_base">独立服务地址</label>
                <input id="jev_direct_base" class="text_pole jev-mono" />

                <label class="jev-label" for="jev_max_chars">单句最大字符数（越小越保险）</label>
                <input id="jev_max_chars" class="text_pole" type="number" min="40" max="900" step="10" />

                <div class="jev-row">
                    <button class="menu_button" id="jev_probe">测试连接</button>
                </div>
                <div class="jev-hint" id="jev_probe_result"></div>
            </div>
        </div>
    `;

    host.appendChild(wrapper);

    const modeSelect = wrapper.querySelector('#jev_mode');
    const directInput = wrapper.querySelector('#jev_direct_base');
    const maxCharsInput = wrapper.querySelector('#jev_max_chars');
    const probeResult = wrapper.querySelector('#jev_probe_result');

    modeSelect.value = settings.mode;
    directInput.value = settings.directBase;
    maxCharsInput.value = String(settings.maxChars);

    modeSelect.addEventListener('change', () => {
        settings.mode = modeSelect.value;
        transport.setMode(settings.mode);
        context.saveSettingsDebounced();
    });

    directInput.addEventListener('change', () => {
        settings.directBase = directInput.value.trim() || DEFAULT_SETTINGS.directBase;
        transport = createTransport({
            getRequestHeaders: () => context.getRequestHeaders(),
            directBase: settings.directBase,
            mode: settings.mode,
        });
        context.saveSettingsDebounced();
    });

    maxCharsInput.addEventListener('change', () => {
        const value = Number(maxCharsInput.value);
        settings.maxChars = Number.isFinite(value) && value >= 40 ? Math.min(value, 900) : DEFAULT_SETTINGS.maxChars;
        maxCharsInput.value = String(settings.maxChars);
        context.saveSettingsDebounced();
    });

    wrapper.querySelector('#jev_probe').addEventListener('click', async () => {
        probeResult.textContent = '正在探测…';
        const info = await transport.describe();
        probeResult.textContent = info.ok
            ? `连接成功：${info.mode} → ${info.base}`
            : `连接失败：\n${info.error}`;
    });
}

// ------------------------------------------------------------------ 入口

/**
 * 入口按钮放在**输入框上方自建的一行**里，而不是塞进顶部魔棒的下拉菜单。
 *
 * 做法与 ST 的 quick-reply 一样：`#send_form` 是输入区总容器，
 * 把新行插到它的第一个子节点之前，就得到「输入框上方的一条横栏」。
 * 参考 public/scripts/extensions/quick-reply/src/ui/ButtonUi.js:39-45。
 *
 * 样式用 `.menu_button`，跟着主题走，不会显得像外来户。
 */
function registerEntryButton() {
    const sendForm = document.getElementById('send_form');
    if (sendForm === null) {
        log('没有找到 #send_form，退回放进扩展菜单。');
        registerMenuButtonFallback();
        return;
    }

    const bar = element('div', 'jev-entry-bar');
    bar.id = 'jev_entry_bar';

    const button = element('div', 'menu_button jev-entry-button');
    button.id = 'jev_entry_button';
    button.title = '对选中的楼层做逐句质检（JEVnovel 2）';
    button.innerHTML = `
        <span class="fa-solid fa-magnifying-glass-chart"></span>
        <span>JEV 句子质检</span>
    `;
    button.addEventListener('click', () => {
        showDialog();
    });

    bar.appendChild(button);

    const firstChild = sendForm.children.length > 0 ? sendForm.children[0] : null;
    if (firstChild !== null) {
        firstChild.insertAdjacentElement('beforebegin', bar);
    } else {
        sendForm.appendChild(bar);
    }
}

/** 极少数布局里没有 #send_form —— 这时退回魔棒下拉，至少有个入口。 */
function registerMenuButtonFallback() {
    const menu = document.getElementById('extensionsMenu');
    if (menu === null) {
        log('连扩展菜单也没有，入口按钮没地方放。');
        return;
    }
    const button = element('div', 'list-group-item flex-container flexGap5');
    button.id = 'jev_menu_button';
    button.innerHTML = `
        <div class="fa-solid fa-magnifying-glass-chart extensionsMenuExtensionButton"></div>
        <span>JEV 句子质检</span>
    `;
    button.addEventListener('click', () => {
        showDialog();
    });
    menu.appendChild(button);
}

function registerEvents() {
    const { eventSource, eventTypes } = context;

    for (const name of [
        eventTypes.CHAT_CHANGED,
        eventTypes.MESSAGE_EDITED,
        eventTypes.MESSAGE_UPDATED,
        eventTypes.MESSAGE_SWIPED,
        eventTypes.MESSAGE_DELETED,
        eventTypes.USER_MESSAGE_RENDERED,
        eventTypes.CHARACTER_MESSAGE_RENDERED,
    ]) {
        if (name !== undefined) {
            eventSource.on(name, () => refreshSoon());
        }
    }
}

/**
 * 点击编辑要挂在 #chat 上做事件委托：消息会被反复重绘，
 * 逐条绑监听器一定会漏，而且和 ST 自己的委托（比如删除模式）冲突。
 */
function registerChatClickHandler() {
    const chat = document.getElementById('chat');
    if (chat === null) {
        log('没有找到 #chat，点击编辑不可用。');
        return;
    }
    chat.addEventListener('click', onChatClicked);
}

// ------------------------------------------------------------------ 生命周期

export async function init() {
    // 扩展可能被停用后再启用，先清掉上一轮的定时器，避免叠加
    clearRefreshTimers();

    context = SillyTavern.getContext();

    settings = Object.assign({}, DEFAULT_SETTINGS, context.extensionSettings['jev-sentence-check'] ?? {});
    context.extensionSettings['jev-sentence-check'] = settings;

    transport = createTransport({
        getRequestHeaders: () => context.getRequestHeaders(),
        directBase: settings.directBase,
        mode: settings.mode,
        logger: log,
    });

    buildDialog();
    registerEntryButton();
    registerSettingsPanel();
    registerHighlightHook();
    registerChatClickHandler();
    registerEvents();

    // hook 只覆盖「之后」的渲染，已经渲染好的楼层要主动补一次
    refreshTimer = setTimeout(refreshSoon, 500);
    refreshInterval = setInterval(refreshSoon, 20000);

    log('扩展已加载。');
}

/** 扩展被停用时清掉自己加的高亮与 DOM，避免留下没有来源的痕迹。 */
export async function onDisable() {
    clearRefreshTimers();
    stopDownloadPolling();

    try {
        const root = document.getElementById('chat');
        if (root !== null) {
            root.removeEventListener('click', onChatClicked);
            for (const textElement of root.querySelectorAll('.mes_text')) {
                clearHighlights(textElement);
            }
        }
        document.getElementById('jev_entry_bar')?.remove();
        document.getElementById('jev_menu_button')?.remove();
        ui?.overlay?.remove();
        ui?.edit?.overlay?.remove();
    } catch (error) {
        log('清理失败', error);
    }
}
