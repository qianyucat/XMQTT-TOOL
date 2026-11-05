'use strict';

/**
 * 主进程 / preload 编译（esbuild → CJS）
 * ------------------------------------------------------------------
 * 阶段 6：`src/main/*.ts` 与 `src/preload/*.ts` 一起迁到 TypeScript，
 * 但 Electron 只能直接跑 CJS，所以这里用 esbuild 编出 `dist/`。
 *
 * 为什么 `bundle: false`（逐文件 1:1 转换）而不是打包成单文件：
 *   1. `tools/test-manager.mjs` 必须能 `require('dist/main/mqtt-manager.js')`
 *      在**裸 node** 里跑 33 项测试。打包成单文件后会把它和 main.js 揉在一起，
 *      一 require 就把 electron 拉进来，那条独立测试通道就废了。
 *   2. 1:1 输出让「源码文件 → 产物文件」可一一对照，堆栈里的行号也还对得上。
 *   3. 相对 import 原样保留成 `require('./xxx')`，不需要维护 external 名单。
 *
 * 因此 `src/shared/*.ts` 也要一起编进 `dist/shared/`：
 * 主进程要 `require('../shared/channels')`，路径必须真的存在。
 *
 * 产物布局（`outbase` 为 `src`，所以目录结构原样保留）：
 *   src/main/*.ts       → dist/main/*.js
 *   src/preload/*.ts    → dist/preload/*.js
 *   src/shared/*.ts     → dist/shared/*.js
 */

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..', '..');

/** 需要编译的三组源码 */
const ENTRY_GLOBS = ['src/main/*.ts', 'src/preload/*.ts', 'src/shared/*.ts'];

/** 编译产物里的入口文件，用来判断「是否已经编过」 */
const MAIN_ENTRY = path.join(ROOT, 'dist', 'main', 'main.js');

/**
 * 执行一次编译。
 *
 * @param {{ quiet?: boolean }} [opts]
 * @returns {Promise<{ files: string[], durationMs: number }>}
 */
async function buildMain(opts = {}) {
  const esbuild = require('esbuild');
  const started = Date.now();

  const result = await esbuild.build({
    entryPoints: ENTRY_GLOBS,
    outdir: path.join(ROOT, 'dist'),
    outbase: path.join(ROOT, 'src'),
    absWorkingDir: ROOT,
    bundle: false,
    platform: 'node',
    // Electron 28.3.3 内置 Node 18.18；语法降到 node18 以免用到更新的内置能力
    target: 'node18',
    format: 'cjs',
    logLevel: 'silent',
    // 逐文件转换不需要 metafile；产物不写 sourcemap（与原 .js 源码行为一致）
    metafile: false,
    sourcemap: false,
  });

  const warnings = result.warnings || [];
  if (warnings.length && !opts.quiet) {
    for (const w of warnings) {
      console.warn(`[build-main] ${w.text}${w.location ? ` (${w.location.file})` : ''}`);
    }
  }

  if (!fs.existsSync(MAIN_ENTRY)) {
    throw new Error(`[build-main] 编译完成但没有产出 ${MAIN_ENTRY}`);
  }

  const files = collectJs(path.join(ROOT, 'dist', 'main'))
    .concat(collectJs(path.join(ROOT, 'dist', 'preload')))
    .concat(collectJs(path.join(ROOT, 'dist', 'shared')))
    .map((f) => path.relative(ROOT, f));

  const durationMs = Date.now() - started;
  if (!opts.quiet) {
    console.log(`[build-main] ${files.length} 个文件 → dist/（${durationMs}ms）`);
  }
  return { files, durationMs };
}

function collectJs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.js'))
    .map((d) => path.join(dir, d.name));
}

/**
 * 供各个启动器（launch / dev / e2e / screenshots / smoke）调用：
 * 每次启动前重编一次，保证跑的是当前源码。
 * esbuild 增量只有几十毫秒，比「忘了 build 结果跑的是旧产物」便宜得多。
 */
async function ensureMainBuild(opts = {}) {
  try {
    return await buildMain(opts);
  } catch (err) {
    console.error('[build-main] 主进程编译失败，无法启动应用。');
    console.error(`           ${err && err.message ? err.message : err}`);
    process.exit(1);
  }
}

module.exports = { buildMain, ensureMainBuild, MAIN_ENTRY, ROOT };
