/**
 * 楼层副本（swipe）操作。
 *
 * 为什么需要这个模块：用户要求「不要改坏原文」—— 检测前先把选中的楼层各复制成
 * 一个新的 swipe，之后所有的标记与修改都发生在那份副本上，原文永远留在 swipe[0]。
 *
 * ST 的 swipe 数据规则（实测自 public/script.js 与 slash-commands.js）：
 *   - 内容存在 `message.swipes[]`（字符串数组），`message.mes` 是 `swipes[swipe_id]` 的镜像
 *   - 每个 swipe 对应一条 `message.swipe_info[]`，形如 { send_date, gen_started, gen_finished, extra }
 *   - 用户消息、系统消息、`extra.isSmallSys`、`extra.swipeable === false` 都不能承载 swipe
 *   - ST 没有 `swipe.add`，官方只有 `/addswipe` 命令；批量操作要直接改数据
 *
 * 这里只做「数据层」的事，不碰 DOM —— 所以可以完全脱离浏览器做单测。
 * 切换显示由 index.js 调 ST 的 swipe() 完成（必须传 swipe_picker 来源，
 * 否则 ST 会因为「只能滑最后一条」而拒绝操作历史楼层）。
 */

/** 与 ST `public/scripts/constants.js:179` 对齐。少了它历史楼层切不过去。 */
export const SWIPE_SOURCE_SWIPE_PICKER = 'swipe_picker';
/** 与 ST `public/scripts/constants.js:166` 对齐。 */
export const SWIPE_DIRECTION_RIGHT = 'right';

function cloneExtra(extra) {
    if (extra === null || typeof extra !== 'object') {
        return {};
    }
    try {
        if (typeof structuredClone === 'function') {
            return structuredClone(extra);
        }
    } catch {
        // 含函数/循环引用等，退回 JSON 拷贝
    }
    try {
        return JSON.parse(JSON.stringify(extra));
    } catch {
        return {};
    }
}

function makeSwipeInfo(message) {
    return {
        send_date: typeof message.send_date === 'number' ? message.send_date : Date.now(),
        gen_started: null,
        gen_finished: null,
        extra: cloneExtra(message.extra),
    };
}

/**
 * 这条楼层能不能承载 swipe。规则与 ST 的 `isMessageSwipeable` / `ensureSwipes` 一致。
 * @param {object} message
 * @returns {boolean}
 */
export function canHoldSwipe(message) {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
        return false;
    }
    if (message.is_user === true || message.is_system === true) {
        return false;
    }
    const extra = message.extra;
    if (extra !== null && typeof extra === 'object') {
        if (extra.isSmallSys === true) {
            return false;
        }
        if (extra.swipeable === false) {
            return false;
        }
    }
    return true;
}

/**
 * 按 ST 的规则补齐 `swipes` / `swipe_info` / `swipe_id`（幂等）。
 * @param {object} message
 * @returns {boolean} 是否改动过
 */
export function ensureSwipeArray(message) {
    let changed = false;

    if (!Array.isArray(message.swipes) || message.swipes.length === 0) {
        message.swipes = [typeof message.mes === 'string' ? message.mes : ''];
        message.swipe_info = [makeSwipeInfo(message)];
        message.swipe_id = 0;
        return true;
    }

    if (!Array.isArray(message.swipe_info)) {
        message.swipe_info = [];
        changed = true;
    }
    if (message.swipe_info.length !== message.swipes.length) {
        const existing = message.swipe_info;
        message.swipe_info = message.swipes.map((_, index) => (
            existing[index] !== null && typeof existing[index] === 'object' ? existing[index] : makeSwipeInfo(message)
        ));
        changed = true;
    }

    const id = Number(message.swipe_id);
    if (!Number.isInteger(id) || id < 0 || id >= message.swipes.length) {
        message.swipe_id = 0;
        changed = true;
    } else if (message.swipe_id !== id) {
        message.swipe_id = id;
        changed = true;
    }

    return changed;
}

/**
 * 把当前内容复制成一个新的 swipe（追加到末尾），**不自动切换**。
 *
 * @param {object} message
 * @param {string} [content] 新 swipe 的内容，默认与当前显示的一致
 * @returns {number} 新 swipe 的下标；无法承载时返回 -1
 */
export function duplicateToNewSwipe(message, content) {
    if (!canHoldSwipe(message)) {
        return -1;
    }

    ensureSwipeArray(message);

    const text = typeof content === 'string'
        ? content
        : (typeof message.mes === 'string' ? message.mes : '');

    message.swipes.push(text);
    message.swipe_info.push(makeSwipeInfo(message));

    return message.swipes.length - 1;
}

/**
 * 把某条楼层的当前内容写回它自己的 swipe，再切到目标 swipe。
 *
 * 对应 ST 的 `syncSwipeToMes` + `message.swipe_id = target`。
 * 直接改数据而不用 ST 的 `swipe()`，是为了批量切换时避开动画与
 * 「只能滑最后一条」的限制；界面刷新由调用方负责。
 *
 * @param {object} message
 * @param {number} swipeId
 * @returns {boolean} 是否切换成功
 */
export function moveToSwipe(message, swipeId) {
    ensureSwipeArray(message);

    if (!Number.isInteger(swipeId) || swipeId < 0 || swipeId >= message.swipes.length) {
        return false;
    }

    // 当前显示的内容先落回它自己的槽位，避免用户刚编辑过的内容丢失
    const currentId = Number(message.swipe_id);
    if (Number.isInteger(currentId) && currentId >= 0 && currentId < message.swipes.length
        && typeof message.mes === 'string') {
        message.swipes[currentId] = message.mes;
    }

    message.swipe_id = swipeId;
    message.mes = message.swipes[swipeId];
    return true;
}

/**
 * 把一句话的替换结果写进某条楼层的指定 swipe。
 *
 * 只在**能精确找到原句**时才替换，找不到就返回 false ——
 * 宁可让用户看到「这句含有格式标记、无法就地修改」，也不要猜着改坏正文。
 *
 * @param {object} message
 * @param {number} swipeId
 * @param {string} original 原句（纯文本形式）
 * @param {string} replacement 替换后的内容
 * @returns {boolean}
 */
export function replaceSentenceInSwipe(message, swipeId, original, replacement) {
    if (typeof original !== 'string' || original === '') {
        return false;
    }
    ensureSwipeArray(message);

    const target = Number.isInteger(swipeId) ? message.swipes[swipeId] : undefined;
    if (typeof target !== 'string') {
        return false;
    }

    const at = target.indexOf(original);
    if (at === -1) {
        return false;
    }

    const updated = target.slice(0, at) + replacement + target.slice(at + original.length);
    message.swipes[swipeId] = updated;

    if (Number(message.swipe_id) === swipeId) {
        message.mes = updated;
    }
    return true;
}
