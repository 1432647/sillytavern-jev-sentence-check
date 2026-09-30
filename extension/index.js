/**
 * JEV Sentence Check —— SillyTavern 前端扩展。
 *
 * 流程：点扩展菜单里的按钮 → 弹窗输入楼层表达式 → 分句 → 送后端判定
 *       → 结果写进 chat_metadata → 把「需要修改」的句子在楼层里高亮。
 *
 * 几条刻意的设计约束：
 *  - **不改消息原文**。高亮只存在于渲染层与 chat_metadata，不触发 ST 的「消息已编辑」。
 *  - **高亮 hook 必须同步**。MessageFormatter 不允许 async hook，所以 hook 只读缓存，
 *    所有网络请求都在点击流程里完成。
 *  - **按楼层逐条请求**。进度可见、可随时取消，单次失败不会让整批白跑。
 *  - **swipe 与正文 hash 双重校验**。重 roll 或改过正文的楼层，旧结果一律作废，
 *    宁可不高亮也不能高亮错位置。
 */

import { splitSentences } from './lib/sentence-splitter.js';
import { parseFloorExpression, formatFloorExpression } from './lib/floor-parser.js';
import { applyHighlights } from './lib/highlight.js';
import { clearHighlights, highlightElement } from './lib/highlight-dom.js';
import * as store from './lib/store.js';
import { MODES, createTransport } from './lib/transport.js';

const MODEL_NAME = 'jev-novel-2-0.8b-bf16';
const THRESHOLD = 0.5;
const MARK_CLASS = 'jev-mark';
const MAX_FLOORS_PER_RUN = 50;

const DEFAULT_SETTINGS = {
    mode: MODES.AUTO,
    directBase: 'http://127.0.0.1:8791',
    maxChars: 400,
    lastExpression: '',
};

let context = null;
let settings = null;
let transport = null;

const state = {
    running: false,
    cancelled: false,
    selectedFloors: [],
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

/** 取某楼层当前有效的待修改句子；swipe 或正文变了就返回空。 */
function freshHighlightItems(id) {
    const entry = store.readFloor(context.chatMetadata, id);
    const fresh = store.isEntryFresh(entry, {
        swipeId: currentSwipeId(id),
        hash: currentHash(id),
    });
    return fresh ? store.toHighlightItems(entry) : [];
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

async function runCheck(floors) {
    setBusy(true);
    clearError();
    state.cancelled = false;

    const total = floors.length;
    let done = 0;
    let sentenceCount = 0;
    let flaggedCount = 0;
    const checkedIds = [];

    setProgress(0, total, `准备检查 ${total} 个楼层…`);

    try {
        // 先确保后端起来了。首次加载权重可能要几十秒，所以分两步：
        // 先发 warmup（立刻返回），再轮询 health，避免一个长请求撞上 Node 的请求超时。
        setProgress(done, total, '正在确认后端状态…');
        await ensureBackendReady();

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

            const sentences = splitSentences(message.mes, { maxChars: settings.maxChars });
            if (sentences.length === 0) {
                store.clearFloor(context.chatMetadata, id);
                done++;
                setProgress(done, total, `楼层 #${id} 没有可判定的句子，跳过`);
                continue;
            }

            setProgress(done, total, `正在检查楼层 #${id}（${sentences.length} 句）…`);

            const { results } = await transport.predict(sentences);

            const entries = sentences.map((text, index) => ({
                text,
                bad: Number(results[index]?.bad_probability ?? 0),
                needs_revision: Boolean(results[index]?.needs_revision),
            }));

            store.writeFloor(context.chatMetadata, id, {
                swipeId: currentSwipeId(id),
                hash: currentHash(id),
                model: MODEL_NAME,
                threshold: THRESHOLD,
                sentences: entries,
            });

            sentenceCount += entries.length;
            flaggedCount += entries.filter(item => item.needs_revision).length;
            checkedIds.push(id);
            done++;
            setProgress(done, total, `已完成 ${done}/${total} 个楼层`);
        }

        context.saveMetadataDebounced();
        applyToDom(checkedIds);
        showSummary(checkedIds.length, sentenceCount, flaggedCount);

        if (state.cancelled) {
            setProgress(done, total, `已取消（完成 ${done}/${total} 个楼层）`);
        } else {
            setProgress(total, total, `完成：${flaggedCount} 句需要修改`);
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
<div class="jev-dialog" role="dialog" aria-modal="true" aria-label="JEV 句子质检">
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
        模型对<b>单句</b>判断「可以保留 / 需要修改」，判断为需要修改的句子会被高亮。
        楼层号就是消息左上角的编号，<b>从 0 开始</b>。
    </div>

    <div class="jev-section">
        <div class="jev-row">
            <span class="jev-label">楼层</span>
            <input class="text_pole jev-mono" data-role="expression" style="flex:1;min-width:200px;"
                   placeholder="例如 3,5,7-9" />
        </div>
        <div class="jev-row">
            <button class="menu_button" data-role="fill-all">全部</button>
            <button class="menu_button" data-role="fill-ai">仅 AI 楼层</button>
            <button class="menu_button" data-role="fill-last">最近 5 条</button>
            <button class="menu_button" data-role="fill-cached">已检查过的</button>
            <span class="jev-title-spacer"></span>
            <button class="menu_button" data-role="clear-cache">清除本聊天高亮</button>
        </div>
        <div class="jev-preview" data-role="preview"></div>
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
        <button class="menu_button" data-role="warmup">预热后端</button>
        <span class="jev-title-spacer"></span>
        <button class="menu_button" data-role="cancel" disabled>取消</button>
        <button class="menu_button" data-role="run">开始检查</button>
        <button class="menu_button" data-role="close">关闭</button>
    </div>
</div>
`;

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

    find('fill-all').addEventListener('click', () => fillExpression('all'));
    find('fill-ai').addEventListener('click', () => fillExpression('ai'));
    find('fill-last').addEventListener('click', () => fillExpression('last'));
    find('fill-cached').addEventListener('click', () => fillExpression('cached'));

    ui.expression.addEventListener('input', () => {
        settings.lastExpression = ui.expression.value;
        context.saveSettingsDebounced();
        renderPreview();
    });

    overlay.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            state.cancelled = true;
            hideDialog();
        }
    });

    document.body.appendChild(overlay);
    return overlay;
}

function showDialog() {
    ui.overlay.classList.remove('jev-hidden');
    ui.expression.value = settings.lastExpression ?? '';
    renderPreview();
    refreshBackendStatus();
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

function onClearCacheClicked() {
    store.clearAll(context.chatMetadata);
    context.saveMetadataDebounced();
    refreshAllFloors();
    renderPreview();
    showSummary(0, 0, 0);
    ui.progressText.textContent = '已清除本聊天的检查结果。';
    clearError();
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
                    用 JEVnovel 2 · 0.8B 对选中的楼层做逐句质检，把「需要修改」的句子高亮出来。
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
                    <button class="menu_button" id="jev_clear_all">清除本聊天结果</button>
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

    wrapper.querySelector('#jev_clear_all').addEventListener('click', () => {
        store.clearAll(context.chatMetadata);
        context.saveMetadataDebounced();
        refreshAllFloors();
    });
}

// ------------------------------------------------------------------ 入口

function registerMenuButton() {
    const menu = document.getElementById('extensionsMenu');
    if (menu === null) {
        log('没有找到 extensionsMenu，跳过菜单按钮。');
        return;
    }

    const button = element('div', 'list-group-item flex-container flexGap5');
    button.id = 'jev_menu_button';
    button.title = '用 JEVnovel 2 检查选中楼层的句子质量';
    button.innerHTML = `
        <div class="fa-solid fa-magnifying-glass-chart extensionsMenuExtensionButton"></div>
        <span>JEV 句子质检</span>
    `;
    button.addEventListener('click', () => {
        showDialog();
        // 点完收起扩展菜单浮层，避免挡住对话框
        const popup = document.getElementById('extensionsMenu');
        if (popup !== null) {
            popup.style.display = 'none';
        }
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
    registerMenuButton();
    registerSettingsPanel();
    registerHighlightHook();
    registerEvents();

    // hook 只覆盖「之后」的渲染，已经渲染好的楼层要主动补一次
    refreshTimer = setTimeout(refreshSoon, 500);
    refreshInterval = setInterval(refreshSoon, 20000);

    log('扩展已加载。');
}

/** 扩展被停用时清掉自己加的高亮，避免留下没有来源的红色标记。 */
export async function onDisable() {
    clearRefreshTimers();

    try {
        const root = document.getElementById('chat');
        if (root !== null) {
            for (const textElement of root.querySelectorAll('.mes_text')) {
                clearHighlights(textElement);
            }
        }
    } catch (error) {
        log('清理高亮失败', error);
    }
}
