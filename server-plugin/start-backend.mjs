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
 * 兼容两种目录布局（自动识别）：
 *   仓库布局：  <根>/server-plugin/python/server.py   （本脚本在 server-plugin/ 里）
 *   独立布局：  <根>/server/server.py                 （本脚本在安装根，由安装脚本放置）
 *
 * 没有模型也能启动：以「无模型」模式跑起来后，在总控面板里下载模型，重启即用。
 *
 * 用法：
 *   node server-plugin/start-backend.mjs                 # 启动（自动探测 python 与模型）
 *   node server-plugin/start-backend.mjs --setup         # 先创建虚拟环境并装依赖
 *   node server-plugin/start-backend.mjs --setup --venv D:\jev\venv
 *   node server-plugin/start-backend.mjs --python <路径> --model <模型目录> --port 8791
 *
 * 探测顺序（找到即用）：
 *   python: --python → 环境变量 JEV_PYTHON → 本目录 venv → 上级 venv → 共享 venv → PATH 的 python
 *   model:  --model  → 环境变量 JEV_MODEL → 从本目录与上级目录向上查找 models/jev-novel-2-0.8b-bf16
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url)); // server-plugin/ 或安装根
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

/** 两种布局都要认：仓库布局的 server-plugin/python/，安装脚本的 server/。 */
function findServerScript() {
    const candidates = [
        path.join(HERE, 'python', 'server.py'),
        path.join(HERE, 'server', 'server.py'),
    ];
    return candidates.find(candidate => fs.existsSync(candidate)) ?? null;
}

function findPython() {
    const candidates = [
        argValue('--python'),
        process.env.JEV_PYTHON,
        venvPython(path.join(HERE, 'runtime', 'venv')),
        venvPython(path.join(REPO, 'runtime', 'venv')),
        venvPython(sharedVenvDir()),
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

/** 从 root 开始逐级向上找 models/<模型名>/config.json。 */
function searchModelUpward(root) {
    let dir = root;
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

function findModel() {
    const explicit = argValue('--model') || process.env.JEV_MODEL;
    if (explicit) {
        const resolved = path.resolve(explicit);
        return fs.existsSync(path.join(resolved, 'config.json')) ? resolved : null;
    }
    // 本目录优先（独立布局把模型装在安装根的 models/ 里）
    return searchModelUpward(HERE) ?? searchModelUpward(REPO);
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

    const serverScript = findServerScript();
    if (serverScript === null) {
        console.error(`找不到 server.py（找过 ${path.join(HERE, 'python')} 与 ${path.join(HERE, 'server')}）。`);
        process.exit(1);
    }

    const model = findModel();
    const standaloneLayout = serverScript === path.join(HERE, 'server', 'server.py');
    if (model === null) {
        console.log('未找到已安装的模型 —— 以「无模型」模式启动。');
        console.log('  启动后到总控面板「模型」一栏下载，完成后重启本脚本即可。');
        console.log('');
    }

    const port = Number(argValue('--port') ?? DEFAULT_PORT);
    const host = argValue('--host') ?? '127.0.0.1';
    const device = argValue('--device') ?? 'cuda:0';

    const serverArgs = [
        '--device', device,
        '--http', '--host', host, '--port', String(port),
        '--preload',
    ];
    if (model !== null) {
        serverArgs.push('--model-dir', model);
    }
    // 独立布局：模型也装在安装根的 models/ 下，显式指定，无模型时的默认值才正确
    if (standaloneLayout) {
        serverArgs.push('--models-root', path.join(HERE, 'models'));
    }

    console.log('=== jev-sentence-check 独立后端 ===');
    console.log(`Python:  ${python}`);
    console.log(`模型:    ${model ?? '（未配置——无模型模式）'}`);
    console.log(`监听:    http://${host}:${port}`);
    console.log('');
    console.log('首次启动要加载约 1.4 GiB 权重，等日志出现「模型已就绪」即可。');
    console.log('保持这个窗口开着；按 Ctrl+C 停止。');
    console.log('');

    const child = spawn(python, [serverScript, ...serverArgs], {
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
