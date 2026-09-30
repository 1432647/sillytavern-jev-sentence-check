/**
 * 基于 DOM 的高亮器（与 lib/highlight.js 的字符串版对应）。
 *
 * 为什么需要两份实现：
 *   MessageFormatter 的 hook **必须同步返回字符串**，所以渲染管线里只能做字符串替换。
 *   但已经渲染好的楼层要就地改 DOM —— 这时**绝不能整体替换 innerHTML**，
 *   因为 SillyTavern 的 addCopyToCodeBlocks 是用 addEventListener 直接绑在
 *   代码块复制按钮上的（public/script.js:2487、2490），innerHTML 一换，
 *   按钮就变成没反应的死元素，其他扩展挂在正文里的监听器也一样会丢。
 *
 *   所以这条路径用 TreeWalker + Range + surroundContents 做**就地包裹**：
 *   只新增 <mark> 元素，既有的节点对象全部保留。
 *
 * 两份实现共用同一套语义：跳过 <pre>/<code>/<script>/<style> 的内容，
 * 并在「纯文本层」用游标顺序匹配。
 */

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const SHOW_ELEMENT = 1;
const SHOW_TEXT = 4;
const FILTER_ACCEPT = 1;
const FILTER_REJECT = 2;
const FILTER_SKIP = 3;

const SKIP_TAGS = new Set(['PRE', 'CODE', 'SCRIPT', 'STYLE']);

export const DEFAULT_MARK_CLASS = 'jev-mark';

/**
 * 摘掉本扩展加的高亮，把内容还回父节点。保留所有原有节点与监听器。
 * @param {Element} root
 * @param {string} [className]
 * @returns {number} 摘掉的 mark 数量
 */
export function clearHighlights(root, className = DEFAULT_MARK_CLASS) {
    if (root === null || root === undefined) {
        return 0;
    }

    const marks = Array.from(root.querySelectorAll(`mark.${className}`));
    for (const mark of marks) {
        const parent = mark.parentNode;
        if (parent === null) {
            continue;
        }
        while (mark.firstChild !== null) {
            parent.insertBefore(mark.firstChild, mark);
        }
        parent.removeChild(mark);
    }

    // 合并因为摘除而变碎的相邻文本节点，避免 DOM 无限碎片化
    if (marks.length > 0 && typeof root.normalize === 'function') {
        root.normalize();
    }

    return marks.length;
}

/** 收集纯文本层与它的下标映射，跳过 SKIP_TAGS 的内容。 */
function collectSegments(root) {
    const doc = root.ownerDocument;
    const walker = doc.createTreeWalker(root, SHOW_TEXT | SHOW_ELEMENT, {
        acceptNode(node) {
            if (node.nodeType === ELEMENT_NODE) {
                return SKIP_TAGS.has(node.tagName) ? FILTER_REJECT : FILTER_ACCEPT;
            }
            return node.nodeValue.length > 0 ? FILTER_ACCEPT : FILTER_SKIP;
        },
    });

    const segments = [];
    let plain = '';
    let node = walker.nextNode();

    while (node !== null) {
        if (node.nodeType === TEXT_NODE) {
            segments.push({ node, plainStart: plain.length, length: node.nodeValue.length });
            plain += node.nodeValue;
        }
        node = walker.nextNode();
    }

    return { segments, plain };
}

/**
 * 把纯文本层的**起点**下标换算成 DOM 位置。
 *
 * 取「第一个严格包含该下标的文本节点」。当 offset 正好落在两个文本节点的
 * 边界上时（比如 `甲。` 与 `乙。` 分处两个 <p>），必须选**后一个节点的 0**，
 * 而不是前一个节点的末尾 —— 否则 Range 会横跨两个块级元素，
 * surroundContents 会失败。
 */
function locateStart(segments, offset) {
    for (const segment of segments) {
        if (offset < segment.plainStart + segment.length) {
            return { node: segment.node, offset: offset - segment.plainStart };
        }
    }
    // offset 落在纯文本末尾（空串或全部跳过时）
    const last = segments[segments.length - 1];
    return last === undefined ? null : { node: last.node, offset: last.length };
}

/**
 * 把纯文本层的**终点**下标（开区间）换算成 DOM 位置。
 *
 * 看的是「最后一个被包含的字符」落在哪个节点，因此边界处要选**前一个节点的末尾**。
 * 与 locateStart 的取舍方向刚好相反，这正是跨段落 bug 的根源。
 */
function locateEnd(segments, offset) {
    if (offset <= 0) {
        return null;
    }
    const lastCharIndex = offset - 1;
    for (const segment of segments) {
        if (lastCharIndex < segment.plainStart + segment.length) {
            return { node: segment.node, offset: offset - segment.plainStart };
        }
    }
    const last = segments[segments.length - 1];
    return last === undefined ? null : { node: last.node, offset: last.length };
}

/**
 * 就地给 root 里的句子加高亮。
 *
 * @param {Element} root
 * @param {Array<string|{text: string, className?: string, title?: string}>} items
 * @param {{ className?: string }} [options]
 * @returns {{ matched: number[], unmatched: number[] }} 入参数组的下标
 */
export function highlightElement(root, items, options = {}) {
    const className = options.className ?? DEFAULT_MARK_CLASS;
    const matched = [];
    const unmatched = [];

    if (root === null || root === undefined) {
        return { matched, unmatched };
    }

    clearHighlights(root, className);

    if (!Array.isArray(items) || items.length === 0) {
        return { matched, unmatched };
    }

    const doc = root.ownerDocument;
    const { segments, plain } = collectSegments(root);

    // 第一遍：只做匹配，按升序推进游标，先不改 DOM
    const found = [];
    const placed = new Set();
    let cursor = 0;

    for (let index = 0; index < items.length; index++) {
        const item = items[index];
        const text = typeof item === 'string' ? item : item?.text;

        if (typeof text !== 'string' || text === '') {
            continue;
        }

        const at = plain.indexOf(text, cursor);
        if (at === -1) {
            continue;
        }

        found.push({ index, item, start: at, end: at + text.length });
        cursor = at + text.length;
    }

    // 第二遍：**倒序**包裹。
    // surroundContents 会在边界处切分文本节点，倒着改的话，
    // 前面（位置更靠左）那些匹配记下的节点引用依然有效。
    for (let i = found.length - 1; i >= 0; i--) {
        const hit = found[i];
        const start = locateStart(segments, hit.start);
        const end = locateEnd(segments, hit.end);
        if (start === null || end === null) {
            continue;
        }

        const mark = doc.createElement('mark');
        mark.className = typeof hit.item === 'object' && hit.item?.className ? hit.item.className : className;
        if (typeof hit.item === 'object' && hit.item?.title) {
            mark.title = String(hit.item.title);
        }

        try {
            const range = doc.createRange();
            range.setStart(start.node, start.offset);
            range.setEnd(end.node, end.offset);
            range.surroundContents(mark);
            placed.add(hit.index);
        } catch (error) {
            // 跨块级元素等极端情况：放弃这一句，它会落到 unmatched 里，不静默丢失
            console.warn('[jev-sentence-check] 就地高亮失败，跳过该句：', error);
        }
    }

    // matched 反映「真的高亮成功了哪些」，因此按入参顺序重新整理
    for (let index = 0; index < items.length; index++) {
        if (placed.has(index)) {
            matched.push(index);
        } else {
            unmatched.push(index);
        }
    }

    return { matched, unmatched };
}
