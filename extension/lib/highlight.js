/**
 * 高亮渲染器。
 *
 * 在**已经渲染成 HTML** 的消息里，把指定句子包上 `<mark>`。
 *
 * 为什么需要「纯文本层」映射：
 *   切句是在原始 markdown 上做的，剥掉了 ** / * / 反引号等标记；
 *   渲染后这些标记变成了 <strong> / <em> 标签（在纯文本层不可见）。
 *   所以定位时要把 HTML 解码成一个纯文本串，并在两层之间建立下标映射，
 *   再在纯文本层用**游标**顺序查找（游标而非全局查找，才能正确处理重复句子）。
 *
 * @param {string} html 渲染后的 HTML
 * @param {Array<string|{text: string, className?: string, title?: string}>} sentences
 * @returns {{ html: string, matched: number[], unmatched: number[] }}
 *   matched / unmatched 里是入参数组的下标
 */

const DEFAULT_CLASS = 'jev-mark';
const ENTITY_RE = /^&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/;
const NAMED_ENTITIES = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: '\u00a0',
};

/**
 * @param {string} raw 形如 "&amp;" / "&#39;" / "&#x27;"
 * @returns {string|null} 解码结果，无法识别返回 null
 */
function decodeEntity(raw) {
    const body = raw.slice(1, -1);
    if (body.startsWith('#')) {
        const isHex = body[1] === 'x' || body[1] === 'X';
        const code = isHex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
            return null;
        }
        try {
            return String.fromCodePoint(code);
        } catch {
            return null;
        }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? null : named;
}

function escapeAttr(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * 与 lib/highlight-dom.js 保持一致的跳过集合：
 * 代码块/脚本里的文字不参与匹配，避免在代码里插高亮。
 */
const SKIP_TAGS = new Set(['pre', 'code', 'script', 'style']);

/**
 * 把 HTML 拆成「纯文本 + 下标映射」。标签被跳过，HTML 实体被解码，
 * <pre>/<code>/<script>/<style> 的内部文字被排除。
 * @param {string} html
 * @returns {{ plain: string, start: number[], end: number[] }}
 */
function buildIndex(html) {
    const parts = [];
    const start = [];
    const end = [];
    let skipDepth = 0;
    let i = 0;

    const push = (char, from, to) => {
        parts.push(char);
        start.push(from);
        end.push(to);
    };

    while (i < html.length) {
        const char = html[i];

        if (char === '<') {
            const close = html.indexOf('>', i);
            const tagEnd = close === -1 ? html.length : close + 1;

            if (close !== -1) {
                const tagText = html.slice(i + 1, close);
                const isClosing = tagText.startsWith('/');
                const name = (isClosing ? tagText.slice(1) : tagText)
                    .split(/[\s/>]/)[0]
                    .toLowerCase();

                if (SKIP_TAGS.has(name)) {
                    if (isClosing) {
                        skipDepth = Math.max(0, skipDepth - 1);
                    } else if (!tagText.endsWith('/')) {
                        skipDepth++;
                    }
                }
            }

            i = tagEnd;
            continue;
        }

        if (skipDepth > 0) {
            i++;
            continue;
        }

        if (char === '&') {
            const match = ENTITY_RE.exec(html.slice(i, i + 12));
            const decoded = match === null ? null : decodeEntity(match[0]);
            if (match !== null && decoded !== null) {
                const to = i + match[0].length;
                // 按 UTF-16 码元逐个入表，保证下标与 String#indexOf 的口径一致
                for (let k = 0; k < decoded.length; k++) {
                    push(decoded[k], i, to);
                }
                i = to;
                continue;
            }
        }

        push(char, i, i + 1);
        i++;
    }

    return { plain: parts.join(''), start, end };
}

/**
 * @param {string} html
 * @param {Array<string|{text: string, className?: string, title?: string}>} sentences
 * @param {{ className?: string }} [options]
 */
export function applyHighlights(html, sentences, options = {}) {
    const defaultClass = typeof options.className === 'string' && options.className !== ''
        ? options.className
        : DEFAULT_CLASS;
    const source = typeof html === 'string' ? html : String(html ?? '');
    const list = Array.isArray(sentences) ? sentences : [];

    if (list.length === 0) {
        return { html: source, matched: [], unmatched: [] };
    }

    const { plain, start, end } = buildIndex(source);
    const insertions = [];
    const matched = [];
    const unmatched = [];
    let cursor = 0;

    for (let index = 0; index < list.length; index++) {
        const item = list[index];
        const text = typeof item === 'string'
            ? item
            : (item !== null && typeof item === 'object' && typeof item.text === 'string' ? item.text : '');

        if (text === '') {
            unmatched.push(index);
            continue;
        }

        const at = plain.indexOf(text, cursor);
        if (at === -1) {
            unmatched.push(index);
            continue;
        }

        const from = start[at];
        const to = end[at + text.length - 1];
        if (from === undefined || to === undefined || to <= from) {
            unmatched.push(index);
            continue;
        }

        const className = (item !== null && typeof item === 'object' && item.className) || defaultClass;
        const title = item !== null && typeof item === 'object' ? item.title : undefined;
        const open = title === undefined || title === null || title === ''
            ? `<mark class="${escapeAttr(className)}">`
            : `<mark class="${escapeAttr(className)}" title="${escapeAttr(title)}">`;

        insertions.push({ at: from, order: insertions.length, text: open });
        insertions.push({ at: to, order: insertions.length, text: '</mark>' });

        matched.push(index);
        cursor = at + text.length;
    }

    if (insertions.length === 0) {
        return { html: source, matched, unmatched };
    }

    // order 保证同一位置上的 </mark> 排在 <mark> 之前（相邻两句不互相吞并）
    insertions.sort((a, b) => (a.at - b.at) || (a.order - b.order));

    let out = '';
    let last = 0;
    for (const insertion of insertions) {
        out += source.slice(last, insertion.at) + insertion.text;
        last = insertion.at;
    }
    out += source.slice(last);

    return { html: out, matched, unmatched };
}
