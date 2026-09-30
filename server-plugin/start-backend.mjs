#!/usr/bin/env node
/**
 * 独立后端启动器（direct 模式）。
 *
 * 给**没有 SillyTavern 服务端插件加载器**的环境用 —— 主要是 TauriTavern：
 * 它的 /api/plugins/* 是路由层硬编码的内置插件，装进 plugins/ 的 Node 插件不会被加载，
 * 所以前端扩展会自动降级到「直连 127.0.0.1:8791」这条路径，本脚本就是那个服务的启动器。
 *
 * 也适合手工调试：跑起来后直接 curl http://127.0.0.1:8791/health 。
 *
 * 用法：
 *   node server-plugin/start-backend.mjs                 # 启动（自动探测 python 与模型）
 *   node server-plugin/start-backend.mjs --setup         # 先创建虚拟环境并装依赖
 *   node server-plugin/start-backend.mjs --setup --venv D:\jev\venv
 *   node server-plugin/start-backend.mjs --python <路径> --model <模型目录> --port 8791
 *
 * 探测顺序（找到即用）：
 *   python: --python → 环境变量 JEV_PYTHON → 共享 venv → 仓库内 runtime/venv → PATH 上的 python
 *   model:  --model  → 环境变量 JEV_MODEL → 从仓库目录向上查找 models/jev-novel-2-0.8b-bf16
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url)); // server-plugin/
const REPO = path.dirname(HERE);
const MODEL_DIR_NAME = 'jev-novel-2-0.8b-bf16';
const DEFAULT_PORT = 8791;
const TORCH_INDEX = 'https://download.pytorch.org/whl/cu128';

const argv = process.argv.slice(2);
const argValue = (name) => {
    const index = argv.indexOf(name);
    return index !== -1 && index + 1 < argv.length ? argv[index + 1] : null;
};

/** 共享 venv 位置。刻意放在用户数据目录而不是仓库里 ——
 *  TauriTavern 更新扩展时会清空克隆目录（只保留 .git），放在里面会被一起删掉。 */
function sharedVenvDir() {
    const home = os.homedir();
    if (process.platform === 'win32') {
        return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'jev-sentence-check', 'venv');
    }
    if (process.platform === 'darwin') {
        return path.join(home, 'Library', 'Application Support', 'jev-sentence-check', 'venv');
    }
    return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'jev-sentence-check', 'venv');
}

const venvPython = (venvDir) => (process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python'));

function findPython() {
    const candidates = [
        argValue('--python'),
        process.env.JEV_PYTHON,
        venvPython(sharedVenvDir()),
        venvPython(path.join(REPO, 'runtime', 'venv')),
    ].filter(Boolean);

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    for (const name of ['python', 'python3']) {
        const probe = spawnSync(name, ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' });
        if (probe.status === 0) {
            return name;
        }
    }
    return null;
}

function findModel() {
    const explicit = argValue('--model') || process.env.JEV_MODEL;
    if (explicit) {
        const resolved = path.resolve(explicit);
        return fs.existsSync(path.join(resolved, 'config.json')) ? resolved : null;
    }

    let dir = REPO;
    for (;;) {
        const candidate = path.join(dir, 'models', MODEL_DIR_NAME);
        if (fs.existsSync(path.join(candidate, 'config.json'))) {
            return candidate;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            return null;
        }
        dir = parent;
    }
}

function run(command, args) {
    console.log(`\n$ ${command} ${args.join(' ')}\n`);
    const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    if (result.status !== 0) {
        console.error(`\n命令失败（退出码 ${result.status}）。`);
        process.exit(1);
    }
}

function setup() {
    const venvDir = argValue('--venv') ? path.resolve(argValue('--venv')) : sharedVenvDir();
    console.log('=== 创建 Python 环境 ===');
    console.log(`虚拟环境: ${venvDir}`);

    const python = venvPython(venvDir);
    if (!fs.existsSync(python)) {
        const base = findPython();
        if (base === null || base === python) {
            console.error('找不到可用的 Python。请先安装 Python 3.11+，或用 --python <路径> 指定。');
            process.exit(1);
        }
        console.log(`用 ${base} 创建虚拟环境…`);
        run(base, ['-m', 'venv', venvDir]);
    } else {
        console.log('虚拟环境已存在，跳过创建。');
    }

    console.log('\n=== 安装依赖（CUDA 版 torch 的 wheel 有 2.7 GB，慢是正常的）===');
    run(python, ['-m', 'pip', 'install', '--progress-bar', 'off', '--index-url', TORCH_INDEX, 'torch==2.11.0']);
    run(python, ['-m', 'pip', 'install', '--progress-bar', 'off', 'transformers==5.17.0', 'safetensors==0.8.0']);

    console.log('\n依赖安装完成。');
    console.log('注：模型仓库 requirements.txt 里的 flash-linear-attention / tilelang / causal-conv1d');
    console.log('    不需要装 —— transformers 会自动回退到参考实现，实测可用。');
}

function main() {
    if (argv.includes('--help') || argv.includes('-h')) {
        const doc = fs.readFileSync(url.fileURLToPath(import.meta.url), 'utf8')
            .split('*/')[0]
            .replace(/^#![^\n]*\n/, '')
            .replace(/^\/\*\*?[ \t]*\n?/, '')
            .replace(/^[ \t]*\*[ \t]?/gm, '')
            .trim();
        console.log(doc);
        return;
    }

    if (argv.includes('--setup')) {
        setup();
        if (!argv.includes('--start')) {
            console.log('\n接下来运行（不加 --setup）即可启动后端：');
            console.log('  node server-plugin/start-backend.mjs');
            return;
        }
    }

    const python = findPython();
    if (python === null) {
        console.error('找不到 Python 解释器。');
        console.error('  先跑一次：node server-plugin/start-backend.mjs --setup');
        console.error('  或用 --python <路径> / 环境变量 JEV_PYTHON 指定。');
        process.exit(1);
    }

    const model = findModel();
    if (model === null) {
        console.error(`找不到模型目录（含 config.json 的 ${MODEL_DIR_NAME}）。`);
        console.error('  用 --model <路径> 或环境变量 JEV_MODEL 指定。');
        console.error('  模型来自 ModelScope：alkaid55555/jev-novel-2-0.8b-bf16');
        process.exit(1);
    }

    const port = Number(argValue('--port') ?? DEFAULT_PORT);
    const host = argValue('--host') ?? '127.0.0.1';
    const serverScript = path.join(HERE, 'python', 'server.py');
    const device = argValue('--device') ?? 'cuda:0';

    console.log('=== jev-sentence-check 独立后端 ===');
    console.log(`Python:  ${python}`);
    console.log(`模型:    ${model}`);
    console.log(`监听:    http://${host}:${port}`);
    console.log('');
    console.log('首次启动要加载约 1.4 GiB 权重，等日志出现「模型已就绪」即可。');
    console.log('保持这个窗口开着；按 Ctrl+C 停止。');
    console.log('');

    const child = spawn(python, [
        serverScript,
        '--model-dir', model,
        '--device', device,
        '--http', '--host', host, '--port', String(port),
        '--preload',
    ], {
        stdio: 'inherit',
        cwd: path.dirname(serverScript),
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });

    const stop = () => {
        if (child.exitCode === null) {
            child.kill();
        }
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    child.on('exit', code => process.exit(code ?? 0));
}

main();
