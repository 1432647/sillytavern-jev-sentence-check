/**
 * 从 SillyTavern 卸载 jev-sentence-check。
 *
 * 只删自己装进去的两个目录。**不动** config.yaml（enableServerPlugins 留着不影响什么），
 * 也**不动**任何聊天记录 —— 判定结果存在 chat_metadata 里，卸载后只是不再显示高亮。
 * 想彻底清掉聊天里的残留结果，可以在卸载前用扩展设置里的「清除本聊天结果」。
 *
 * 用法：
 *   node uninstall.mjs
 *   node uninstall.mjs --sillytavern D:\path\to\SillyTavern
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

function argValue(name) {
    const index = argv.indexOf(name);
    return index !== -1 && index + 1 < argv.length ? argv[index + 1] : null;
}

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

function remove(target) {
    if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true });
        console.log(`已删除 ${target}`);
        return true;
    }
    console.log(`不存在，跳过 ${target}`);
    return false;
}

function main() {
    const stRoot = detectSillyTavern();
    if (stRoot === null) {
        console.error('找不到 SillyTavern 目录。请用 --sillytavern <路径> 显式指定。');
        process.exit(1);
    }

    console.log(`=== 从 ${stRoot} 卸载 jev-sentence-check ===\n`);

    remove(path.join(stRoot, 'public', 'scripts', 'extensions', 'third-party', 'jev-sentence-check'));
    remove(path.join(stRoot, 'plugins', 'jev-sentence-check'));

    console.log('\n完成。');
    console.log('config.yaml 未改动（enableServerPlugins 保持原样，不影响其他插件）。');
    console.log('Python 环境与模型目录未删除，如需回收空间请手动处理 runtime/venv。');
}

main();
