/**
 * 判定结果的持久化层。
 *
 * 结果存进当前聊天的 `chat_metadata['jev-sentence-check']`，**不写回消息原文**，
 * 所以不会触发 SillyTavern 的「消息已编辑」流程，也不会污染角色卡或聊天记录。
 *
 * 缓存以楼层号（mesid）为键。SillyTavern 一条消息可以有多个 swipe（重 roll 的候选），
 * 所以还要记下当初判定的是哪个 swipe，以及正文的 hash。
 * 只要 swipe 换了或正文被编辑过，旧结果立即失效 —— 宁可不高亮，也不能高亮错地方。
 */

export const NAMESPACE = 'jev-sentence-check';
export const CACHE_VERSION = 1;

/**
 * FNV-1a 32 位。只用来「察觉正文有没有被改过」，不用于安全用途。
 * @param {unknown} text
 * @returns {string} 8 位十六进制
 */
export function hashText(text) {
    const source = String(text ?? '');
    let hash = 0x811c9dc5;
    for (let i = 0; i < source.length; i++) {
        hash ^= source.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

/**
 * @param {object} metadata chat_metadata
 * @param {{ create?: boolean }} [options]
 * @returns {{ version: number, model: string, threshold: number, floors: Record<string, object> }|null}
 */
export function getRoot(metadata, options = {}) {
    if (metadata === null || typeof metadata !== 'object') {
        return null;
    }

    let root = metadata[NAMESPACE];
    const rootBroken = root === null || typeof root !== 'object' || Array.isArray(root);

    if (rootBroken) {
        if (options.create !== true) {
            return null;
        }
        root = { version: CACHE_VERSION, model: '', threshold: 0.5, floors: {} };
        metadata[NAMESPACE] = root;
    }

    if (root.floors === null || typeof root.floors !== 'object' || Array.isArray(root.floors)) {
        if (options.create !== true) {
            return null;
        }
        root.floors = {};
    }

    if (!Number.isInteger(root.version)) {
        root.version = CACHE_VERSION;
    }

    return root;
}

/**
 * @param {object} metadata
 * @param {number|string} messageId
 * @returns {object|null}
 */
export function readFloor(metadata, messageId) {
    const root = getRoot(metadata);
    if (root === null) {
        return null;
    }
    const entry = root.floors[String(messageId)];
    return entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? entry : null;
}

/**
 * @param {object} metadata
 * @param {number|string} messageId
 * @param {{ swipeId: number, hash: string, model: string, threshold: number, sentences: object[] }} entry
 * @returns {object}
 */
export function writeFloor(metadata, messageId, entry) {
    const root = getRoot(metadata, { create: true });
    root.version = CACHE_VERSION;
    root.model = entry.model ?? root.model;
    root.threshold = typeof entry.threshold === 'number' ? entry.threshold : root.threshold;

    const stored = { ...entry, checkedAt: entry.checkedAt ?? Date.now() };
    root.floors[String(messageId)] = stored;
    return stored;
}

/**
 * 缓存是否仍然对应当前这条楼层的当前 swipe 与当前正文。
 * @param {object|null} entry
 * @param {{ swipeId: number, hash: string }} current
 * @returns {boolean}
 */
export function isEntryFresh(entry, current) {
    if (entry === null || typeof entry !== 'object') {
        return false;
    }
    return entry.swipeId === current.swipeId && entry.hash === current.hash;
}

/**
 * @param {object} metadata
 * @param {number|string} messageId
 */
export function clearFloor(metadata, messageId) {
    const root = getRoot(metadata);
    if (root !== null) {
        delete root.floors[String(messageId)];
    }
}

/**
 * @param {object} metadata
 */
export function clearAll(metadata) {
    const root = getRoot(metadata, { create: true });
    root.floors = {};
}

/**
 * 把缓存条目转成 highlighter 需要的入参。
 * @param {object|null} entry
 * @returns {Array<{ text: string, className: string, title: string }>}
 */
export function toHighlightItems(entry) {
    if (entry === null || typeof entry !== 'object' || !Array.isArray(entry.sentences)) {
        return [];
    }

    const items = [];
    for (const sentence of entry.sentences) {
        if (sentence === null || typeof sentence !== 'object') {
            continue;
        }
        if (sentence.needs_revision !== true) {
            continue;
        }
        if (typeof sentence.text !== 'string' || sentence.text === '') {
            continue;
        }
        const probability = typeof sentence.bad === 'number' ? sentence.bad : null;
        items.push({
            text: sentence.text,
            className: 'jev-mark',
            title: probability === null
                ? '模型判定：需要修改'
                : `模型判定：需要修改 · bad ${Math.round(probability * 100)}%`,
        });
    }
    return items;
}

/**
 * @param {object} metadata
 * @returns {{ floors: number, sentences: number, flagged: number }}
 */
export function summarize(metadata) {
    const root = getRoot(metadata);
    if (root === null) {
        return { floors: 0, sentences: 0, flagged: 0 };
    }

    let floors = 0;
    let sentences = 0;
    let flagged = 0;

    for (const entry of Object.values(root.floors)) {
        if (entry === null || typeof entry !== 'object' || !Array.isArray(entry.sentences)) {
            continue;
        }
        floors++;
        sentences += entry.sentences.length;
        flagged += entry.sentences.filter(s => s !== null && typeof s === 'object' && s.needs_revision === true).length;
    }

    return { floors, sentences, flagged };
}
