/**
 * 楼层表达式解析器。
 *
 * 楼层号 = SillyTavern 的 mesid，从 0 开始（与界面 `.mesIDDisplay` 显示的 `#N` 一致）。
 *
 * 支持的写法：
 *   "1,3,5-8"  "1、3，5;7；9 11"  "8-3"（倒序区间等价）
 *
 * @param {string} input 用户输入
 * @param {{ maxFloor?: number }} [options] maxFloor 为最大合法楼层号（含）
 * @returns {{ floors: number[], invalid: Array<{token: string, reason: string}> }}
 *   floors 已去重并升序；reason 取值 'not-a-number' | 'out-of-range'
 */

const SEPARATOR = /[,，、;；\s]+/;
const RANGE = /^(\d+)-(\d+)$/;
const SINGLE = /^\d+$/;

export function parseFloorExpression(input, options = {}) {
    const maxFloor = Number.isInteger(options.maxFloor) ? options.maxFloor : Number.MAX_SAFE_INTEGER;

    if (typeof input !== 'string' || input.trim() === '') {
        return { floors: [], invalid: [] };
    }

    // 先把 "8 - 3" 这类带空格的区间归一成 "8-3"，否则会被空白分隔符拆散。
    // 注意 "-5" 不会命中：正则需要 '-' 前面有数字。
    const normalized = input.replace(/(\d)\s*-\s*(\d)/g, '$1-$2');
    const tokens = normalized.split(SEPARATOR).filter(token => token !== '');

    const floors = new Set();
    const invalid = [];

    for (const token of tokens) {
        const range = RANGE.exec(token);
        if (range) {
            const lo = Math.min(Number(range[1]), Number(range[2]));
            const hi = Math.max(Number(range[1]), Number(range[2]));
            if (hi > maxFloor) {
                invalid.push({ token, reason: 'out-of-range' });
                continue;
            }
            for (let i = lo; i <= hi; i++) {
                floors.add(i);
            }
            continue;
        }

        if (SINGLE.test(token)) {
            const n = Number(token);
            if (n > maxFloor) {
                invalid.push({ token, reason: 'out-of-range' });
                continue;
            }
            floors.add(n);
            continue;
        }

        invalid.push({ token, reason: 'not-a-number' });
    }

    return { floors: [...floors].sort((a, b) => a - b), invalid };
}

/**
 * 把楼层号数组格式化成紧凑的表达式（用于回填输入框）。
 * @param {number[]} floors
 * @returns {string}
 */
export function formatFloorExpression(floors) {
    if (!Array.isArray(floors) || floors.length === 0) {
        return '';
    }
    const sorted = [...new Set(floors)].sort((a, b) => a - b);
    const parts = [];
    let start = sorted[0];
    let prev = sorted[0];

    for (let i = 1; i <= sorted.length; i++) {
        const current = sorted[i];
        if (current === prev + 1) {
            prev = current;
            continue;
        }
        parts.push(start === prev ? `${start}` : `${start}-${prev}`);
        start = current;
        prev = current;
    }

    return parts.join(',');
}
