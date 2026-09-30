/**
 * 把 jev-sentence-check 装进 SillyTavern。
 *
 * 做四件事：
 *   1. extension/ → <ST>/public/scripts/extensions/third-party/jev-sentence-check/
 *   2. server-plugin/ → <ST>/plugins/jev-sentence-check/
 *   3. 往服务端插件目录写 config.json（绝对路径），并生成 direct 模式启动脚本
 *   4. 检查 / 修正 <ST>/config.yaml 的 enableServerPlugins
 *
 * 用法：
 *   node install.mjs                          # 自动寻找同级的 SillyTavern
 *   node install.mjs --sillytavern D:\path\to\SillyTavern
 *   node install.mjs --no-config              # 不动 config.yaml
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));

const EXTENSION_DIR_NAME = 'jev-sentence-check';
const PLUGIN_DIR_NAME = 'jev-sentence-check';

const argv = process.argv.slice(2);

function argValue(name) {
    const index = argv.indexOf(name);
    return index !== -1 && index + 1 < argv.length ? argv[index + 1] : null;
}

const skipConfig = argv.includes('--no-config');

function detectSillyTavern() {
    const explicit = argValue('--sillytavern');
    if (explicit !== null) {
        return path.resolve(explicit);
    }

    const candidates = [
        path.join(HERE, 'SillyTavern'),
        path.resolve(HERE, '..', 'SillyTavern'),
        path.resolve(HERE, '..', '..', 'SillyTavern'),
    ];

    for (const candidate of candidates) {
        if (fs.existsSync(path.join(candidate, 'package.json'))
            && fs.existsSync(path.join(candidate, 'public', 'scripts', 'extensions'))) {
            return candidate;
        }
    }
    return null;
}

function detectPython() {
    const explicit = argValue('--python');
    if (explicit !== null) {
        return path.resolve(explicit);
    }

    const candidates = [
        path.join(HERE, 'runtime', 'venv', 'Scripts', 'python.exe'),
        path.join(HERE, 'runtime', 'venv', 'bin', 'python'),
    ];

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return candidates[0];
}

function detectModelDir() {
    const explicit = argValue('--model');
    if (explicit !== null) {
        return path.resolve(explicit);
    }

    const candidates = [
        path.resolve(HERE, '..', 'models', 'jev-novel-2-0.8b-bf16'),
        path.join(HERE, 'models', 'jev-novel-2-0.8b-bf16'),
    ];

    for (const candidate of candidates) {
        if (fs.existsSync(path.join(candidate, 'config.json'))) {
            return candidate;
        }
    }
    return candidates[0];
}

function copyTree(source, target) {
    try {
        fs.rmSync(target, { recursive: true, force: true });
    } catch (error) {
        if (error.code === 'EBUSY' || error.code === 'EPERM' || error.code === 'ENOTEMPTY') {
            throw new Error(
                `无法覆盖 ${target}：目录被占用。\n`
                + '  最常见的原因：SillyTavern 还在运行，Python 推理子进程占着 plugins/jev-sentence-check/python/。\n'
                + '  请先完全退出 SillyTavern，再重新运行 install.mjs。',
            );
        }
        throw error;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, {
        recursive: true,
        force: true,
        filter: (src) => {
            const name = path.basename(src);
            return name !== '__pycache__' && name !== '.venv' && name !== 'config.json';
        },
    });
}

function ensureServerPlugins(configPath, defaultConfigPath) {
    if (fs.existsSync(configPath) === false) {
        if (fs.existsSync(defaultConfigPath)) {
            fs.copyFileSync(defaultConfigPath, configPath);
            console.log(`  已从 default/config.yaml 创建 ${configPath}`);
        } else {
            console.log(`  ! 找不到 ${configPath}，也找不到默认配置；请启动一次 SillyTavern 让它生成。`);
            return { changed: false, needsManual: true };
        }
    }

    const original = fs.readFileSync(configPath, 'utf8');
    const pattern = /^([ \t]*)enableServerPlugins[ \t]*:.*$/m;

    if (pattern.test(original)) {
        const updated = original.replace(pattern, '$1enableServerPlugins: true');
        if (updated === original) {
            console.log('  enableServerPlugins 已经是 true。');
            return { changed: false, needsManual: false };
        }
        fs.writeFileSync(configPath, updated, 'utf8');
        console.log('  config.yaml: enableServerPlugins false → true');
        return { changed: true, needsManual: false };
    }

    fs.writeFileSync(configPath, `${original.replace(/\s*$/, '')}\nenableServerPlugins: true\n`, 'utf8');
    console.log('  config.yaml: 追加了 enableServerPlugins: true');
    return { changed: true, needsManual: false };
}

function writeBackendLauncher(targetPath, pythonExe, serverScript, modelDir, port) {
    const content = [
        '@echo off',
        'REM 由 install.mjs 生成，路径已写死为绝对路径，不要手改。',
        'REM 用途：TauriTavern 等没有 SillyTavern 服务端插件加载器的环境，',
        'REM 或者想在浏览器/终端里手工调试时，直接起这个独立服务。',
        '',
        `"${pythonExe}" "${serverScript}" --model-dir "${modelDir}" --device cuda:0 --http --port ${port} --preload`,
        'echo.',
        'echo 服务已退出。按任意键关闭窗口。',
        'pause > nul',
        '',
    ].join('\r\n');

    fs.writeFileSync(targetPath, content, 'utf8');
}

function main() {
    console.log('=== jev-sentence-check 安装 ===\n');

    try {
        install();
    } catch (error) {
        console.error(`\n安装失败：${error.message}`);
        process.exit(1);
    }
}

function install() {
    const stRoot = detectSillyTavern();
    if (stRoot === null) {
        console.error('找不到 SillyTavern 目录。请用 --sillytavern <路径> 显式指定。');
        process.exit(1);
    }
    console.log(`SillyTavern: ${stRoot}`);

    const pythonExe = detectPython();
    const modelDir = detectModelDir();
    console.log(`Python:      ${pythonExe}${fs.existsSync(pythonExe) ? '' : '   ! 不存在'}`);
    console.log(`模型目录:    ${modelDir}${fs.existsSync(modelDir) ? '' : '   ! 不存在'}`);
    console.log('');

    // 在复制任何文件之前先卡住。
    // 不这么做的话，会静默写入一个指向不存在解释器的 config.json，
    // 直到用户在界面上点「预热」时才报错，那时已经很难定位了。
    const problems = [];
    if (!fs.existsSync(pythonExe)) {
        problems.push(`找不到 Python 解释器：${pythonExe}`);
    }
    if (!fs.existsSync(modelDir)) {
        problems.push(`找不到模型目录：${modelDir}`);
    }
    if (problems.length > 0 && !argv.includes('--force')) {
        console.error('安装前检查未通过：');
        for (const problem of problems) {
            console.error(`  - ${problem}`);
        }
        console.error('');
        console.error('请先按 README 的「安装」步骤建好 Python 环境并下好模型，然后重跑。');
        console.error('也可以用 --python <路径> / --model <路径> 显式指定，');
        console.error('或加 --force 跳过这项检查（不推荐，部署后需要手工修 config.json）。');
        process.exit(1);
    }

    // 1. 前端扩展
    const extensionTarget = path.join(stRoot, 'public', 'scripts', 'extensions', 'third-party', EXTENSION_DIR_NAME);
    copyTree(path.join(HERE, 'extension'), extensionTarget);
    console.log(`[1/4] 前端扩展 → ${extensionTarget}`);

    // 2. 服务端插件
    const pluginTarget = path.join(stRoot, 'plugins', PLUGIN_DIR_NAME);
    copyTree(path.join(HERE, 'server-plugin'), pluginTarget);
    console.log(`[2/4] 服务端插件 → ${pluginTarget}`);

    // 3. config.json + 启动脚本
    const serverScript = path.join(pluginTarget, 'python', 'server.py');
    const config = {
        pythonExe,
        serverScript,
        modelDir,
        device: 'cuda:0',
        batchSize: 8,
        predictTimeoutMs: 240000,
    };
    fs.writeFileSync(path.join(pluginTarget, 'config.json'),
        `${JSON.stringify(config, null, 4)}\n`, 'utf8');
    console.log('[3/4] 已写入 config.json');
    console.log(`      pythonExe    = ${pythonExe}`);
    console.log(`      serverScript = ${serverScript}`);
    console.log(`      modelDir     = ${modelDir}`);

    writeBackendLauncher(path.join(pluginTarget, 'start-backend.cmd'), pythonExe, serverScript, modelDir, 8791);
    writeBackendLauncher(path.join(HERE, 'start-backend.cmd'), pythonExe, serverScript, modelDir, 8791);

    // 4. config.yaml
    if (skipConfig) {
        console.log('[4/4] 已跳过 config.yaml（--no-config）');
    } else {
        console.log('[4/4] 检查 config.yaml');
        ensureServerPlugins(
            path.join(stRoot, 'config.yaml'),
            path.join(stRoot, 'default', 'config.yaml'),
        );
    }

    console.log('\n完成。接下来：');
    if (!fs.existsSync(pythonExe)) {
        console.log(`  1. 建 Python 环境并装依赖：`);
        console.log(`     python -m venv "${path.dirname(path.dirname(pythonExe))}"`);
        console.log(`     "${pythonExe}" -m pip install torch==2.11.0 --index-url https://download.pytorch.org/whl/cu128`);
        console.log(`     "${pythonExe}" -m pip install transformers==5.17.0 safetensors==0.8.0`);
    } else {
        console.log('  1. Python 环境已就绪。');
    }
    console.log('  2. 启动 SillyTavern，在扩展菜单里点「JEV 句子质检」。');
    console.log('  3. 弹窗里先点一次「预热后端」，等状态变成「就绪」。');
    console.log('');
    console.log('注：本安装只新增了上述两个目录，并在 config.yaml 里改一行 enableServerPlugins。');
    console.log('    卸载用 uninstall.mjs。');
}

main();
