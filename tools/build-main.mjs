/**
 * 主进程 / preload 编译入口（命令行）
 * ------------------------------------------------------------------
 * 用法：
 *   node tools/build-main.mjs
 *
 * `npm run build` / `npm start` / `npm run dev` 都已接上这一步；
 * 单独跑它的场景是「只想刷产物、不想起窗口」，比如排查打包内容。
 *
 * 真正的编译逻辑在 tools/lib/build-main.js —— 那几个启动器是 CJS，
 * 需要直接 require 同一份实现，不能各写一遍。
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildMain } = require('./lib/build-main.js');

buildMain()
  .then(({ files, durationMs }) => {
    for (const f of files) console.log(`  ${f}`);
    console.log(`[build-main] 完成（${durationMs}ms）`);
  })
  .catch((err) => {
    console.error('[build-main] 编译失败:', err && err.message ? err.message : err);
    process.exit(1);
  });
