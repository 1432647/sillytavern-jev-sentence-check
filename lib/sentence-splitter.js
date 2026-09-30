/**
 * 句子切块器。
 *
 * 输入：楼层的**原始 markdown 文本**（`chat[mesid].mes`，不是渲染后的 HTML）。
 * 输出：可直接喂给模型的纯文本单句数组。
 *
 * 设计要点：
 *  - 剥掉的 markdown 标记必须与渲染后 HTML 的「纯文本层」一致，
 *    否则 highlighter 无法在渲染结果里定位（见 lib/highlight.js）。
 *  - 围栏代码块整块丢弃；行内代码保留文字、只去反引号。
 *  - 引号内部的句末标点不切分，避免把一句对白切碎。
 *  - 单句超过 maxChars 时按软标点再切；仍超长则硬切。
 *
 * @param {string} markdown
 * @param {{ maxChars?: number, minChars?: number }} [options]
 * @returns {string[]}
 */

const DEFAULT_MAX_CHARS = 400;
const DEFAULT_MIN_CHARS = 6;

const OPEN_QUOTES = new Set(['“', '「', '『', '‘']);
const CLOSE_QUOTES = new Set(['”', '」', '』', '’']);
const TERMINALS = new Set(['。', '！', '？', '!', '?', '…', '～']);
const STRAIGHT_QUOTE = '"';

// 句末终止符（允许后面跟一串收尾引号/括号）
const HAS_TERMINAL = /[。！？!?…～][”"』」’'）)】\]]*$/;
// 片段若不含任何「实义字符」就丢弃
const HAS_CONTENT = /[0-9A-Za-z\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/;
const SOFT_BREAK = /[，；、：,;:]/;

/**
 * 从用户在设置里填的内容解析出要排除的标签名。
 *
 * 接受这几种写法（可混用、逗号/空白/换行分隔、自动去重）：
 *   `<1></1>`   `<1/>`   `<1>`   `1`
 *
 * @param {unknown} input
 * @returns {string[]}
 */
export function parseExcludeTags(input) {
    if (typeof input !== 'string' || input.trim() === '') {
        return [];
    }

    const names = new Set();
    const tagPattern = /<\s*\/?\s*([A-Za-z0-9_\-.:]+)[^>]*>/g;
    let matched = false;
    let match;

    while ((match = tagPattern.exec(input)) !== null) {
        matched = true;
        names.add(match[1]);
    }

    if (matched) {
        return [...names];
    }

    // 一个尖括号都没有，就当成裸标签名列表
    for (const token of input.split(/[,，、;；\s]+/)) {
        const trimmed = token.trim();
        if (trimmed !== '') {
            names.add(trimmed);
        }
    }

    return [...names];
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 删掉被排除标签包裹的内容。
 *
 * 只处理**有闭合标签**的区域 —— 没有闭合的开放标签原样保留，
 * 免得用户一个笔误就把后面所有正文都吞掉（那样会静默漏检，比报错更糟）。
 */
function removeExcludedRegions(text, excludeTags) {
    let out = text;

    for (const tag of excludeTags) {
        if (typeof tag !== 'string' || tag === '') {
            continue;
        }
        const name = escapeRegExp(tag);
        const pattern = new RegExp(
            `<\\s*${name}(\\s[^>]*)?>[\\s\\S]*?<\\s*/\\s*${name}\\s*>`,
            'gi',
        );
        out = out.replace(pattern, '');
    }

    return out;
}

/**
 * 把 markdown 文本预处理成「可切句的纯文本」。
 * @param {string} markdown
 * @param {string[]} [excludeTags] 需要整段排除的标签名
 * @returns {string}
 */
export function stripMarkdown(markdown, excludeTags = []) {
    let text = String(markdown).replace(/\r\n?/g, '\n');

    // 0. 先摘掉用户标记为「不判定」的区域
    if (excludeTags.length > 0) {
        text = removeExcludedRegions(text, excludeTags);
    }

    // 1. 围栏代码块：先删成对的，再删到文件末尾仍未闭合的
    text = text.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*/gm, '\n');
    text = text.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*$/m, '\n');

    // 2. HTML 注释
    text = text.replace(/<!--[\s\S]*?-->/g, '');
    // 3. 图片整块丢弃（含 alt 与 url）
    text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
    // 4. 链接保留文字
    text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    // 5. HTML 标签
    text = text.replace(/<\/?[a-zA-Z][^>]*>/g, '');
    // 6. 花括号宏
    text = text.replace(/\{\{[^}]*\}\}/g, '');
    // 7. 行内代码：只去反引号，保留内容
    text = text.replace(/`([^`\n]*)`/g, '$1');

    // 8. 强调标记：先处理双字符，再处理成对的单字符
    text = text
        .replace(/\*\*([^*\n]+)\*\*/g, '$1')
        .replace(/__([^_\n]+)__/g, '$1')
        .replace(/~~([^~\n]+)~~/g, '$1')
        .replace(/\*([^*\n]+)\*/g, '$1')
        .replace(/_([^_\n]+)_/g, '$1');

    // 9. 表格分隔行 / 水平线（只由 | - : 空格组成）
    text = text.replace(/^[ \t]*[|:\-][|:\- \t]*$/gm, '');

    // 10. 行首的结构前缀：引用、标题、列表
    text = text
        .split('\n')
        .map(line => line
            .replace(/^[ \t]*>[ \t]?/, '')
            .replace(/^[ \t]*#{1,6}[ \t]+/, '')
            .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/, ''))
        .join('\n');

    // 11. 折叠空白
    return text
        .replace(/[ \t\u3000]+/g, ' ')
        .split('\n')
        .map(line => line.trim())
        .join('\n');
}

/**
 * 按终止符切分，引号内部不切。
 * @param {string} text
 * @returns {string[]}
 */
function splitByTerminals(text) {
    const fragments = [];
    let buffer = '';
    let quoteDepth = 0;

    const flush = () => {
        const trimmed = buffer.trim();
        if (trimmed !== '') {
            fragments.push(trimmed);
        }
        buffer = '';
    };

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (ch === '\n') {
            flush();
            continue;
        }

        if (OPEN_QUOTES.has(ch) || ch === STRAIGHT_QUOTE) {
            quoteDepth++;
            buffer += ch;
            continue;
        }

        if (CLOSE_QUOTES.has(ch)) {
            quoteDepth = Math.max(0, quoteDepth - 1);
            buffer += ch;
            continue;
        }

        buffer += ch;

        if (TERMINALS.has(ch) && quoteDepth === 0) {
            // 吸收紧随其后的同类终止符与收尾引号，避免 "？！" 或 "。”" 被拆开
            while (i + 1 < text.length) {
                const next = text[i + 1];
                if (TERMINALS.has(next)) {
                    i++;
                    buffer += next;
                    continue;
                }
                if (CLOSE_QUOTES.has(next) || (next === STRAIGHT_QUOTE && quoteDepth > 0)) {
                    i++;
                    buffer += next;
                    quoteDepth = Math.max(0, quoteDepth - 1);
                    continue;
                }
                break;
            }
            flush();
        }
    }

    flush();
    return fragments;
}

/**
 * 把过短且无终止符的片段并入前一句。
 * @param {string[]} fragments
 * @param {number} minChars
 * @returns {string[]}
 */
function mergeShortFragments(fragments, minChars) {
    const merged = [];
    for (const fragment of fragments) {
        const previous = merged[merged.length - 1];
        if (previous !== undefined && fragment.length < minChars && !HAS_TERMINAL.test(fragment)) {
            merged[merged.length - 1] = `${previous}${fragment}`;
            continue;
        }
        merged.push(fragment);
    }
    return merged;
}

/**
 * 超长片段按软标点再切；找不到软标点就硬切。
 * @param {string} fragment
 * @param {number} maxChars
 * @returns {string[]}
 */
function enforceMaxChars(fragment, maxChars) {
    if (fragment.length <= maxChars) {
        return [fragment];
    }

    const pieces = [];
    let rest = fragment;

    while (rest.length > maxChars) {
        let cut = -1;
        for (let i = Math.min(maxChars, rest.length - 1); i >= 1; i--) {
            if (SOFT_BREAK.test(rest[i - 1])) {
                cut = i;
                break;
            }
        }
        if (cut <= 0) {
            cut = maxChars;
        }
        pieces.push(rest.slice(0, cut));
        rest = rest.slice(cut);
    }

    if (rest !== '') {
        pieces.push(rest);
    }

    return pieces;
}

/**
 * @param {string} markdown
 * @param {{ maxChars?: number, minChars?: number, excludeTags?: string[] }} [options]
 *   excludeTags：被这些标签包裹的内容整段排除，不参与判定
 * @returns {string[]}
 */
export function splitSentences(markdown, options = {}) {
    const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0
        ? options.maxChars
        : DEFAULT_MAX_CHARS;
    const minChars = Number.isInteger(options.minChars) && options.minChars >= 0
        ? options.minChars
        : DEFAULT_MIN_CHARS;
    const excludeTags = Array.isArray(options.excludeTags) ? options.excludeTags : [];

    if (typeof markdown !== 'string' || markdown.trim() === '') {
        return [];
    }

    const plain = stripMarkdown(markdown, excludeTags);
    const fragments = splitByTerminals(plain)
        .filter(fragment => HAS_CONTENT.test(fragment));

    return mergeShortFragments(fragments, minChars)
        .flatMap(fragment => enforceMaxChars(fragment, maxChars))
        .filter(fragment => HAS_CONTENT.test(fragment));
}
