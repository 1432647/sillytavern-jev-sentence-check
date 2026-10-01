/**
 * 生成「安装独立后端」的一键脚本。
 *
 * 为什么是「生成脚本」而不是「直接安装」：
 *   扩展跑在浏览器沙箱里，**没有能力创建 venv、跑 pip、或往任意目录写文件**。
 *   这是平台限制，不是实现偷懒。所以能做到的上限是：
 *   把后端源码 + 安装步骤打成一个脚本，用户双击一次。
 *
 * 为什么用 base64 内嵌而不是让脚本 `git clone`：
 *   扩展自己的目录里**已经带着后端源码**（仓库里的 server-plugin/），
 *   直接读出来嵌进去就不用依赖用户机器上有 git、也不用再连一次 GitHub。
 *
 * 为什么切成多段再拼：
 *   cmd.exe 单行长度上限约 8191 字符，而一个 .py 文件的 base64 有几十 KB，
 *   必须拆成多行用 >> 追加到一个临时文件，最后再 certutil -decode 解回来。
 *   （base64 字符集里没有 cmd 的元字符，用 echo 追加是安全的。）
 */

/** 需要随包安装的后端文件（相对 server-plugin/python/），落到 <安装根>/server/。 */
export const BACKEND_FILES = ['server.py', 'jev_runtime.py', 'models.py', 'requirements.txt'];

/** 随包安装的启动器（相对 server-plugin/），落到 <安装根>/ —— 启动器会自动识别两种布局。 */
export const LAUNCHER_FILES = ['start-backend.mjs'];

/** cmd.exe 单行安全长度，留足余量。 */
const CHUNK_SIZE = 4000;

const TORCH_INDEX = 'https://download.pytorch.org/whl/cu128';

/**
 * 两种设备的安装差异。
 *
 * GPU：必须用 pytorch 官方源装 cu128 构建（PyPI 默认是 CPU 版）。
 * CPU：PyPI 默认 wheel 就是 CPU 版，约 200 MB；权重在 CPU 上以 fp32 运行，
 *      所以内存需求比显存大——0.8B 约 4 GB，4B 要 16 GB 起。
 */
export const DEVICE_KINDS = {
    gpu: {
        label: 'GPU（NVIDIA CUDA）',
        torchArgs: ['--index-url', TORCH_INDEX],
        deviceFlag: 'cuda:0',
        note: '需要 NVIDIA 显卡且支持 bf16。权重常驻约 1.5 GiB（0.8B）。',
    },
    cpu: {
        label: '纯 CPU（内存，无需显卡）',
        torchArgs: [],
        deviceFlag: 'cpu',
        note: '实测 0.8B 约 1.2 s/句（14 线程）。fp32 权重驻留内存：0.8B 约 4 GB，4B 需 16 GB 起。',
    },
};

/**
 * 把字符串按固定长度切块。
 * @param {string} value
 * @param {number} [size]
 * @returns {string[]}
 */
export function chunk(value, size = CHUNK_SIZE) {
    const text = String(value ?? '');
    if (size <= 0) {
        throw new RangeError('size 必须为正数');
    }
    const out = [];
    for (let i = 0; i < text.length; i += size) {
        out.push(text.slice(i, i + size));
    }
    return out;
}

/**
 * 跨环境的 base64 编码。浏览器用 btoa（需要先转 UTF-8 字节），Node 用 Buffer。
 * @param {string} text
 * @returns {string}
 */
export function toBase64(text) {
    const source = String(text ?? '');

    if (typeof Buffer !== 'undefined') {
        return Buffer.from(source, 'utf8').toString('base64');
    }

    const bytes = new TextEncoder().encode(source);
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

function joinLines(lines) {
    return `${lines.join('\r\n')}\r\n`;
}

/**
 * 生成 Windows 一键安装脚本。
 *
 * @param {{ targetDir: string, files: Array<{path: string, content: string}>, rootFiles?: Array<{path: string, content: string}>, deviceKind?: string }} options
 * @returns {string}
 */
export function buildWindowsInstaller(options) {
    const target = String(options.targetDir ?? '').replace(/"/g, '');
    const files = Array.isArray(options.files) ? options.files : [];
    const rootFiles = Array.isArray(options.rootFiles) ? options.rootFiles : [];
    const device = DEVICE_KINDS[options.deviceKind] ?? DEVICE_KINDS.gpu;
    const torchArgs = device.torchArgs.map(arg => ` "${arg}"`).join('');
    const torchLine = `"%PY%" -m pip install --progress-bar off${torchArgs} torch==2.11.0`;

    const lines = [
        '@echo off',
        'chcp 65001 > nul',
        'setlocal',
        'title JEV Sentence Check - install backend',
        '',
        `set "ROOT=${target}"`,
        'set "SRC=%ROOT%\\server"',
        'set "VENV=%ROOT%\\runtime\\venv"',
        'set "PY=%VENV%\\Scripts\\python.exe"',
        '',
        'echo.',
        'echo   JEV Sentence Check - backend installer',
        'echo   --------------------------------------',
        'echo   Install to : %ROOT%',
        `echo   Device     : ${device.label}`,
        `echo              : ${device.note}`,
        'echo.',
        'echo   This will download the PyTorch build for the device above',
        'echo   (about 3 GB for CUDA, about 0.2 GB for CPU).',
        'echo.',
        'pause',
        '',
        'where python > nul 2> nul',
        'if errorlevel 1 goto :no_python',
        '',
        'echo.',
        'echo Creating folders ...',
        'if not exist "%SRC%" mkdir "%SRC%"',
        'if not exist "%VENV%" mkdir "%VENV%"',
        '',
        'echo.',
        'echo Unpacking backend files ...',
    ];

    for (const file of files) {
        const relative = String(file.path).replace(/\\/g, '\\\\');
        const safeName = String(file.path).replace(/[^A-Za-z0-9._-]/g, '_');
        const tmp = `%TEMP%\\jev_${safeName}.b64`;
        const pieces = chunk(toBase64(file.content));

        lines.push(`REM ---- ${file.path} ----`);
        lines.push(`> "${tmp}" echo ${pieces[0] ?? ''}`);
        for (let i = 1; i < pieces.length; i++) {
            lines.push(`>> "${tmp}" echo ${pieces[i]}`);
        }
        lines.push(`certutil -decode "${tmp}" "%SRC%\\${relative}" > nul`);
        lines.push(`del "${tmp}" > nul 2> nul`);
    }

    // 启动器直接落在安装根（不进 server/），与它探测的目录布局一致
    for (const file of rootFiles) {
        const safeName = String(file.path).replace(/[^A-Za-z0-9._-]/g, '_');
        const tmp = `%TEMP%\\jev_root_${safeName}.b64`;
        const pieces = chunk(toBase64(file.content));

        lines.push(`REM ---- ${file.path}（安装根） ----`);
        lines.push(`> "${tmp}" echo ${pieces[0] ?? ''}`);
        for (let i = 1; i < pieces.length; i++) {
            lines.push(`>> "${tmp}" echo ${pieces[i]}`);
        }
        lines.push(`certutil -decode "${tmp}" "%ROOT%\\${file.path}" > nul`);
        lines.push(`del "${tmp}" > nul 2> nul`);
    }

    lines.push(
        '',
        'echo.',
        'echo Creating Python environment ...',
        'python -m venv "%VENV%"',
        'if errorlevel 1 goto :failed',
        '',
        'echo.',
        'echo Installing PyTorch (this is the slow part) ...',
        torchLine,
        'if errorlevel 1 goto :failed',
        '',
        'echo.',
        'echo Installing transformers and safetensors ...',
        '"%PY%" -m pip install --progress-bar off transformers==5.17.0 safetensors==0.8.0',
        'if errorlevel 1 goto :failed',
        '',
        'echo.',
        'echo Done.',
        'echo.',
        'echo Next: start the backend with',
        `echo   node ^"%ROOT%\\start-backend.mjs^" --device ${device.deviceFlag}`,
        'echo (that file comes from the extension folder; if you do not have it,',
        `echo  run: "%PY%" "%SRC%\\server.py" --model-dir ^<模型目录^> --http --device ${device.deviceFlag} --preload)`,
        'echo.',
        'pause',
        'exit /b 0',
        '',
        ':no_python',
        'echo.',
        'echo [ERROR] "python" was not found on PATH.',
        'echo         Install Python 3.11+ and check "Add to PATH".',
        'echo.',
        'pause',
        'exit /b 1',
        '',
        ':failed',
        'echo.',
        'echo [ERROR] Something failed. See the messages above,',
        'echo         fix it, then run this file again.',
        'echo.',
        'pause',
        'exit /b 1',
        '',
    );

    return joinLines(lines);
}

/**
 * 生成 POSIX（macOS / Linux）一键安装脚本。
 * @param {{ targetDir: string, files: Array<{path: string, content: string}>, rootFiles?: Array<{path: string, content: string}>, deviceKind?: string }} options
 * @returns {string}
 */
export function buildPosixInstaller(options) {
    const target = String(options.targetDir ?? '').replace(/"/g, '');
    const files = Array.isArray(options.files) ? options.files : [];
    const rootFiles = Array.isArray(options.rootFiles) ? options.rootFiles : [];
    const device = DEVICE_KINDS[options.deviceKind] ?? DEVICE_KINDS.gpu;
    const torchArgs = device.torchArgs.join(' ');
    const torchLine = torchArgs
        ? `"$PY" -m pip install --progress-bar off ${torchArgs} torch==2.11.0`
        : `"$PY" -m pip install --progress-bar off torch==2.11.0`;

    const lines = [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        '',
        `ROOT="${target}"`,
        'SRC="$ROOT/server"',
        'VENV="$ROOT/runtime/venv"',
        'PY="$VENV/bin/python"',
        '',
        'echo',
        'echo "  JEV Sentence Check - backend installer"',
        `echo "  Device: ${device.label}"`,
        'echo "  This downloads PyTorch for the device above."',
        'echo',
        'read -r -p "Press Enter to continue, Ctrl+C to abort. " _',
        '',
        'command -v python3 >/dev/null || { echo "[ERROR] python3 not found."; exit 1; }',
        '',
        'mkdir -p "$SRC" "$VENV"',
        'echo "Unpacking backend files ..."',
    ];

    for (const file of files) {
        const tmp = `"$(mktemp)"`;
        const pieces = chunk(toBase64(file.content));
        lines.push(`# ---- ${file.path} ----`);
        lines.push(`cat > ${tmp} <<'JEV_B64_EOF'`);
        for (const piece of pieces) {
            lines.push(piece);
        }
        lines.push('JEV_B64_EOF');
        lines.push(`base64 -d ${tmp} > "$SRC/${file.path}"`);
        lines.push(`rm -f ${tmp}`);
    }

    for (const file of rootFiles) {
        const tmp = `"$(mktemp)"`;
        const pieces = chunk(toBase64(file.content));
        lines.push(`# ---- ${file.path}（安装根） ----`);
        lines.push(`cat > ${tmp} <<'JEV_B64_EOF'`);
        for (const piece of pieces) {
            lines.push(piece);
        }
        lines.push('JEV_B64_EOF');
        lines.push(`base64 -d ${tmp} > "$ROOT/${file.path}"`);
        lines.push(`rm -f ${tmp}`);
    }

    lines.push(
        '',
        'echo "Creating Python environment ..."',
        'python3 -m venv "$VENV"',
        '',
        'echo "Installing PyTorch (this is the slow part) ..."',
        torchLine,
        '"$PY" -m pip install --progress-bar off transformers==5.17.0 safetensors==0.8.0',
        '',
        'echo',
        'echo "Done. Start it with:"',
        `echo "  node \\"$ROOT/start-backend.mjs\\" --device ${device.deviceFlag}"`,
        '',
    );

    return joinLines(lines);
}

/**
 * 按平台挑脚本。
 * @param {{ platform?: string, targetDir: string, files: Array<{path: string, content: string}>, deviceKind?: string }} options
 * @returns {{ filename: string, content: string }}
 */
export function buildInstaller(options) {
    const platform = options.platform
        ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '');
    const isWindows = /win/i.test(String(platform));

    return isWindows
        ? { filename: 'install-backend.bat', content: buildWindowsInstaller(options) }
        : { filename: 'install-backend.sh', content: buildPosixInstaller(options) };
}

/** 预构建包所在的仓库（GitHub Releases 托管，单文件上限 2GiB，超限拆卷）。 */
export const DIST_REPO = '1432647/sillytavern-jev-backend-dist';

/** 各设备预构建包的资产名前缀（GPU 包超限拆卷为 .001/.002…）。 */
const BUNDLE_PREFIX = {
    gpu: 'jev-backend-gpu-',
    cpu: 'jev-backend-cpu-',
};

/**
 * 从 GitHub Release 数据里挑出某设备的预构建包资产。
 *
 * @param {{ assets?: Array<{ name?: string, browser_download_url?: string, size?: number }> }} release
 *        GitHub API 的 release 对象（/releases/latest）
 * @param {string} deviceKind 'gpu' | 'cpu'
 * @returns {Array<{ name: string, url: string, size: number }>} 命中的资产（按文件名排序）
 */
export function pickBundleAssets(release, deviceKind) {
    const prefix = BUNDLE_PREFIX[deviceKind];
    if (!prefix || !release || !Array.isArray(release.assets)) {
        return [];
    }
    return release.assets
        .filter(asset => typeof asset?.name === 'string' && asset.name.startsWith(prefix))
        .map(asset => ({
            name: asset.name,
            url: asset.browser_download_url ?? '',
            size: Number(asset.size ?? 0),
        }))
        .filter(asset => asset.url !== '')
        .sort((a, b) => a.name.localeCompare(b.name));
}

/** 面板下载入口用的 release 查询地址。 */
export function distReleaseApiUrl() {
    return `https://api.github.com/repos/${DIST_REPO}/releases/latest`;
}
