/**
 * JEV Sentence Check —— SillyTavern 服务端插件。
 *
 * 职责：托管并守护 Python 推理子进程，把它的 stdio JSONL 协议包成 HTTP 路由。
 *
 *   GET  /api/plugins/jev-sentence-check/health    后端状态（含 CUDA 体检）
 *   POST /api/plugins/jev-sentence-check/warmup    非阻塞预热（后台加载权重）
 *   POST /api/plugins/jev-sentence-check/predict   { sentences: string[] }
 *   POST /api/plugins/jev-sentence-check/restart   杀掉子进程重来
 *   GET  /api/plugins/jev-sentence-check/logs      最近的子进程日志（排错用）
 *
 * 为什么走 stdio 而不是 HTTP 端口：
 *   不占端口、不会冲突、无 CORS、无防火墙问题；Python 的 stderr 直接变成插件日志；
 *   进程生命周期与 SillyTavern 强绑定，ST 退出即回收。
 *
 * 注意：本文件是 .mjs。插件目录里**故意不放 package.json**，
 *   因为 src/plugin-loader.js 对「目录内有 package.json 且有 main」会走 npm 包分支，
 *   用 .mjs 走 ESM 分支最干净。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));

export const info = {
    id: 'jev-sentence-check',
    name: 'JEV Sentence Check',
    description: 'Hosts the JEVnovel 2 0.8B sentence-quality classifier for the jev-sentence-check chat extension.',
};

// ------------------------------------------------------------------ 日志环形缓冲

const LOG_LIMIT = 400;
const logBuffer = [];

function pushLog(stream, text) {
    const line = `[${new Date().toISOString()}] [${stream}] ${text}`;
    logBuffer.push(line);
    if (logBuffer.length > LOG_LIMIT) {
        logBuffer.splice(0, logBuffer.length - LOG_LIMIT);
    }
}

// ------------------------------------------------------------------------ 配置

const DEFAULT_CONFIG = {
    pythonExe: '',
    serverScript: path.join(HERE, 'python', 'server.py'),
    modelDir: '',
    device: 'cuda:0',
    batchSize: 8,
    predictTimeoutMs: 240000,
};

/**
 * 配置解析优先级：config.json 里的值 → 从插件目录向上查找推断。
 *
 * 为什么用「向上查找」而不是写死相对路径：
 *   同一份代码既可能跑在源码位置（jev-sentence-check/server-plugin/），
 *   也可能跑在部署位置（SillyTavern/plugins/jev-sentence-check/），
 *   深度不同，写死的 ../ 数量在两种情形下会解析到不同地方。
 *   向上查找对两种位置都成立。config.json 由 install.mjs 写绝对路径，是权威来源。
 */
function findUp(relativePath) {
    let directory = HERE;
    for (;;) {
        const candidate = path.join(directory, relativePath);
        if (fs.existsSync(candidate)) {
            return candidate;
        }
        const parent = path.dirname(directory);
        if (parent === directory) {
            return null;
        }
        directory = parent;
    }
}

function resolveConfigured(value, findUpPath) {
    if (typeof value === 'string' && value.trim() !== '') {
        return path.resolve(HERE, value.trim());
    }
    return findUp(findUpPath) ?? '';
}

function loadConfig() {
    const configPath = path.join(HERE, 'config.json');
    let fileConfig = {};

    if (fs.existsSync(configPath)) {
        try {
            fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch (error) {
            pushLog('plugin', `config.json 解析失败，改用推断路径：${error.message}`);
        }
    } else {
        pushLog('plugin', '未找到 config.json，改用向上查找推断路径。建议跑一次 install.mjs。');
    }

    return {
        ...DEFAULT_CONFIG,
        ...fileConfig,
        pythonExe: resolveConfigured(fileConfig.pythonExe, path.join('runtime', 'venv', 'Scripts', 'python.exe')),
        serverScript: resolveConfigured(fileConfig.serverScript, path.join('python', 'server.py')),
        modelDir: resolveConfigured(fileConfig.modelDir, path.join('models', 'jev-novel-2-0.8b-bf16')),
        batchSize: Number.isInteger(fileConfig.batchSize) ? fileConfig.batchSize : DEFAULT_CONFIG.batchSize,
        predictTimeoutMs: Number.isInteger(fileConfig.predictTimeoutMs)
            ? fileConfig.predictTimeoutMs
            : DEFAULT_CONFIG.predictTimeoutMs,
    };
}

// ------------------------------------------------------------- Python 子进程

let backendInstance = null;

export class PythonBackend {
    #child = null;
    #pending = new Map();
    #buffer = '';
    #nextId = 1;
    #lastExit = null;
    #startedAt = null;

    constructor(config) {
        this.config = config;
    }

    get running() {
        return this.#child !== null && this.#child.exitCode === null && this.#child.signalCode === null;
    }

    status() {
        return {
            processRunning: this.running,
            pid: this.running ? this.#child.pid : null,
            startedAt: this.#startedAt,
            lastExit: this.#lastExit,
            pendingRequests: this.#pending.size,
            config: {
                pythonExe: this.config.pythonExe,
                serverScript: this.config.serverScript,
                modelDir: this.config.modelDir,
                device: this.config.device,
                batchSize: this.config.batchSize,
            },
            pathsExist: {
                pythonExe: fs.existsSync(this.config.pythonExe),
                serverScript: fs.existsSync(this.config.serverScript),
                modelDir: fs.existsSync(this.config.modelDir),
            },
        };
    }

    start() {
        if (this.running) {
            return;
        }

        const { pythonExe, serverScript, modelDir, device, batchSize } = this.config;

        if (!fs.existsSync(pythonExe)) {
            throw new Error(`找不到 Python 解释器：${pythonExe}。请先跑 install.mjs 或检查 config.json。`);
        }
        if (!fs.existsSync(serverScript)) {
            throw new Error(`找不到推理服务脚本：${serverScript}`);
        }
        if (!fs.existsSync(modelDir)) {
            throw new Error(`找不到模型目录：${modelDir}`);
        }

        const args = [
            serverScript,
            '--model-dir', modelDir,
            '--device', device,
            '--batch-size', String(batchSize),
            '--stdio',
        ];

        pushLog('plugin', `启动 Python 后端：${pythonExe} ${args.join(' ')}`);

        const child = spawn(pythonExe, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            cwd: path.dirname(serverScript),
            env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        });

        this.#child = child;
        this.#buffer = '';
        this.#startedAt = new Date().toISOString();
        this.#lastExit = null;

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => this.#onStdout(chunk));

        child.stderr.setEncoding('utf8');
        child.stderr.on('data', chunk => {
            for (const line of String(chunk).split(/\r?\n/)) {
                if (line.trim() !== '') {
                    pushLog('python', line);
                }
            }
        });

        child.on('error', error => {
            pushLog('plugin', `子进程错误：${error.message}`);
            this.#failAll(new Error(`Python 子进程错误：${error.message}`));
        });

        child.on('exit', (code, signal) => {
            pushLog('plugin', `子进程退出：code=${code} signal=${signal}`);
            this.#lastExit = { code, signal, at: new Date().toISOString() };
            this.#child = null;
            this.#failAll(new Error(`Python 子进程已退出（code=${code} signal=${signal}）。`));
        });
    }

    #onStdout(chunk) {
        this.#buffer += chunk;
        let index = this.#buffer.indexOf('\n');
        while (index !== -1) {
            const line = this.#buffer.slice(0, index).trim();
            this.#buffer = this.#buffer.slice(index + 1);
            if (line !== '') {
                this.#onMessage(line);
            }
            index = this.#buffer.indexOf('\n');
        }
    }

    #onMessage(line) {
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            pushLog('python', line);
            return;
        }

        // 子进程启动时的 hello 行没有 id，忽略
        if (message.id === null || message.id === undefined) {
            return;
        }

        const pending = this.#pending.get(message.id);
        if (pending === undefined) {
            pushLog('plugin', `收到无法归属的响应 id=${message.id}`);
            return;
        }

        this.#pending.delete(message.id);
        clearTimeout(pending.timer);

        if (message.ok) {
            pending.resolve(message.result);
        } else {
            pending.reject(new Error(message.error || '后端返回了未说明的错误'));
        }
    }

    #failAll(error) {
        for (const [, pending] of this.#pending) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.#pending.clear();
    }

    request(op, payload = {}, timeoutMs = this.config.predictTimeoutMs) {
        this.start();

        const id = this.#nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pending.delete(id);
                reject(new Error(`后端响应超时（${timeoutMs}ms）：op=${op}`));
            }, timeoutMs);

            this.#pending.set(id, { resolve, reject, timer, op });

            try {
                this.#child.stdin.write(`${JSON.stringify({ id, op, ...payload })}\n`);
            } catch (error) {
                this.#pending.delete(id);
                clearTimeout(timer);
                reject(new Error(`写入子进程失败：${error.message}`));
            }
        });
    }

    async stop() {
        const child = this.#child;
        if (child === null) {
            return;
        }

        this.#child = null;
        this.#failAll(new Error('后端已被主动停止。'));

        try {
            child.stdin.write(`${JSON.stringify({ id: null, op: 'unload' })}\n`);
            child.stdin.end();
        } catch {
            // 子进程可能已经走了，忽略
        }

        await new Promise(resolve => {
            const killTimer = setTimeout(() => {
                try {
                    child.kill('SIGKILL');
                } catch {
                    // 已经退出
                }
                resolve();
            }, 3000);

            child.once('exit', () => {
                clearTimeout(killTimer);
                resolve();
            });
        });
    }
}

// --------------------------------------------------------------------- 路由

function asyncRoute(handler) {
    return (req, res) => {
        Promise.resolve(handler(req, res)).catch(error => {
            pushLog('plugin', `路由出错：${error.stack || error.message}`);
            if (!res.headersSent) {
                res.status(500).json({ ok: false, error: error.message });
            }
        });
    };
}

export async function init(router) {
    const config = loadConfig();
    const backend = new PythonBackend(config);

    pushLog('plugin', 'jev-sentence-check 服务端插件已加载。');

    router.get('/health', asyncRoute(async (req, res) => {
        const status = backend.status();

        if (!status.processRunning) {
            res.json({ ok: true, ...status, backend: { ready: false, loading: false, error: null } });
            return;
        }

        try {
            const health = await backend.request('health', {}, 10000);
            res.json({ ok: true, ...status, backend: health });
        } catch (error) {
            res.json({ ok: true, ...status, backend: { ready: false, loading: false, error: error.message } });
        }
    }));

    router.post('/warmup', asyncRoute(async (req, res) => {
        const result = await backend.request('warmup', {}, 30000);
        res.json({ ok: true, ...result });
    }));

    router.post('/predict', asyncRoute(async (req, res) => {
        const sentences = req.body?.sentences;

        if (!Array.isArray(sentences)) {
            res.status(400).json({ ok: false, error: '请求体需要 sentences: string[]' });
            return;
        }
        if (sentences.length > 2000) {
            res.status(400).json({ ok: false, error: `单次最多 2000 句，收到 ${sentences.length} 句。` });
            return;
        }

        const result = await backend.request('predict', {
            sentences,
            include_ordinal: Boolean(req.body?.include_ordinal),
        });

        res.json({ ok: true, ...result });
    }));

    router.post('/restart', asyncRoute(async (req, res) => {
        await backend.stop();
        backend.start();
        const result = await backend.request('warmup', {}, 30000);
        res.json({ ok: true, ...result });
    }));

    router.get('/logs', (req, res) => {
        res.json({ ok: true, lines: logBuffer.slice(-200) });
    });

    backendInstance = backend;
}

export { loadConfig, pushLog };

export async function exit() {
    if (backendInstance !== null) {
        pushLog('plugin', 'SillyTavern 正在退出，回收 Python 子进程。');
        await backendInstance.stop();
        backendInstance = null;
    }
}

export default { info, init, exit };
