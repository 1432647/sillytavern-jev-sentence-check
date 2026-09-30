/**
 * 传输层：前端到推理后端的通路，支持两种模式并可自动降级。
 *
 *   'st-plugin' —— 打 SillyTavern 服务端插件路由 `/api/plugins/jev-sentence-check/*`。
 *                  原版 SillyTavern 走这条，受 CSRF 保护，需要带 getRequestHeaders()。
 *
 *   'direct'    —— 直接打独立 Python 服务 `http://127.0.0.1:<port>/*`。
 *                  TauriTavern 没有 Express 服务端插件加载器（它的 /api/plugins/*
 *                  是路由层硬编码的内置插件），所以那条路走不通，必须降级到这里。
 *
 * 'auto' 会先探 st-plugin，失败再探 direct。
 *
 * 两种后端的响应外层包装不一致（ST 插件是扁平的，独立服务包了一层 result），
 * 这里统一归一化，上层不用关心。
 */

export const MODES = {
    AUTO: 'auto',
    ST_PLUGIN: 'st-plugin',
    DIRECT: 'direct',
};

export const PLUGIN_ID = 'jev-sentence-check';

const PROBE_TIMEOUT_MS = 4000;

function normalizeEnvelope(payload) {
    if (payload !== null && typeof payload === 'object'
        && payload.result !== null && typeof payload.result === 'object') {
        return { ok: payload.ok !== false, data: payload.result };
    }
    return { ok: payload?.ok !== false, data: payload ?? {} };
}

function normalizeHealth(payload) {
    const { data } = normalizeEnvelope(payload);
    const backend = (data.backend !== null && typeof data.backend === 'object') ? data.backend : data;

    return {
        ready: Boolean(backend.ready),
        loading: Boolean(backend.loading),
        error: typeof backend.error === 'string' ? backend.error : null,
        processRunning: data.processRunning === undefined ? true : Boolean(data.processRunning),
        cuda: backend.cuda ?? null,
        raw: data,
    };
}

function normalizePredict(payload) {
    const { data } = normalizeEnvelope(payload);
    const results = Array.isArray(data.results) ? data.results : [];
    return {
        results,
        count: Number.isInteger(data.count) ? data.count : results.length,
        needsRevision: Number.isInteger(data.needs_revision)
            ? data.needs_revision
            : results.filter(item => item?.needs_revision === true).length,
    };
}

function withTimeout(fetchImpl, url, init, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetchImpl(url, { ...init, signal: controller.signal })
        .finally(() => clearTimeout(timer));
}

/**
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   getRequestHeaders?: () => Record<string, string>,
 *   pluginBase?: string,
 *   directBase?: string,
 *   mode?: string,
 *   logger?: (msg: string) => void,
 * }} options
 */
export function createTransport(options = {}) {
    const fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    const getRequestHeaders = options.getRequestHeaders ?? (() => ({ 'Content-Type': 'application/json' }));
    const pluginBase = (options.pluginBase ?? `/api/plugins/${PLUGIN_ID}`).replace(/\/+$/, '');
    const directBase = (options.directBase ?? 'http://127.0.0.1:8791').replace(/\/+$/, '');
    const logger = options.logger ?? (() => { });

    let configuredMode = options.mode ?? MODES.AUTO;
    let resolved = null;

    function headersFor(mode) {
        if (mode === MODES.ST_PLUGIN) {
            return { 'Content-Type': 'application/json', ...getRequestHeaders() };
        }
        // 独立服务是 127.0.0.1 上的裸 HTTP 服务，不带 ST 的 CSRF 令牌
        return { 'Content-Type': 'application/json' };
    }

    function baseFor(mode) {
        return mode === MODES.ST_PLUGIN ? pluginBase : directBase;
    }

    async function probe(mode) {
        const url = `${baseFor(mode)}/health`;
        const response = await withTimeout(fetchImpl, url, {
            method: 'GET',
            headers: headersFor(mode),
        }, PROBE_TIMEOUT_MS);

        if (!response.ok) {
            throw new Error(`${url} 返回 HTTP ${response.status}`);
        }

        // 只看到 200 不算数：有些环境会把未知路径兜底成前端页面（同样是 200，但内容是 HTML）。
        // 必须确认响应确实是我们后端的 health 结构，否则会误判模式，再拿着垃圾数据往下走。
        let payload;
        try {
            payload = await response.json();
        } catch {
            throw new Error(`${url} 返回的不是 JSON（该路径可能被前端兜底接管了）`);
        }

        const { data } = normalizeEnvelope(payload);
        const backend = (data !== null && typeof data === 'object'
            && data.backend !== null && typeof data.backend === 'object')
            ? data.backend
            : data;

        const looksLikeOurs = backend !== null && typeof backend === 'object'
            && (typeof backend.ready === 'boolean' || typeof backend.loading === 'boolean');

        if (!looksLikeOurs) {
            throw new Error(`${url} 的响应结构不像 jev-sentence-check 后端`);
        }

        return mode;
    }

    async function resolveMode() {
        if (configuredMode !== MODES.AUTO) {
            resolved = configuredMode;
            return resolved;
        }
        if (resolved !== null) {
            return resolved;
        }

        const failures = [];
        for (const candidate of [MODES.ST_PLUGIN, MODES.DIRECT]) {
            try {
                await probe(candidate);
                resolved = candidate;
                logger(`传输层模式解析为 ${candidate}`);
                return resolved;
            } catch (error) {
                failures.push(`${candidate}: ${error.message}`);
            }
        }

        throw new Error(
            '找不到可用的推理后端。已尝试：\n  ' + failures.join('\n  ')
            + '\n\n原版 SillyTavern 需要：plugins/jev-sentence-check/ 已安装，且 config.yaml 里 enableServerPlugins: true。'
            + '\n其他环境（如 TauriTavern）需要先手动启动独立服务：server-plugin/start-backend.cmd。',
        );
    }

    async function call(mode, path, init, timeoutMs) {
        const response = await withTimeout(fetchImpl, `${baseFor(mode)}${path}`, {
            ...init,
            headers: { ...headersFor(mode), ...(init.headers ?? {}) },
        }, timeoutMs);

        let payload = null;
        try {
            payload = await response.json();
        } catch {
            payload = null;
        }

        if (!response.ok) {
            const message = payload?.error ?? payload?.result?.error ?? `HTTP ${response.status}`;
            throw new Error(message);
        }
        if (payload === null) {
            throw new Error('后端返回了非 JSON 响应。');
        }

        const { ok, data } = normalizeEnvelope(payload);
        if (!ok) {
            throw new Error(data.error ?? '后端报告了未说明的错误。');
        }
        return data;
    }

    async function run(path, init, timeoutMs) {
        const mode = await resolveMode();
        try {
            return await call(mode, path, init, timeoutMs);
        } catch (error) {
            // 解析后的模式失效了（比如 ST 刚重启），清空缓存，下次重新探测
            if (configuredMode === MODES.AUTO) {
                resolved = null;
            }
            throw error;
        }
    }

    return {
        get mode() {
            return resolved ?? configuredMode;
        },

        setMode(mode) {
            configuredMode = mode;
            resolved = null;
        },

        reset() {
            resolved = null;
        },

        async health(timeoutMs = 8000) {
            const data = await run('/health', { method: 'GET' }, timeoutMs);
            return { ...normalizeHealth(data), mode: resolved };
        },

        async warmup(timeoutMs = 20000) {
            const data = await run('/warmup', { method: 'POST', body: '{}' }, timeoutMs);
            return normalizeHealth(data);
        },

        async predict(sentences, options = {}) {
            const data = await run('/predict', {
                method: 'POST',
                body: JSON.stringify({
                    sentences,
                    include_ordinal: Boolean(options.includeOrdinal),
                }),
            }, options.timeoutMs ?? 240000);
            return normalizePredict(data);
        },

        async describe() {
            try {
                const mode = await resolveMode();
                return { ok: true, mode, base: baseFor(mode) };
            } catch (error) {
                return { ok: false, mode: null, error: error.message };
            }
        },
    };
}
