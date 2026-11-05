#!/usr/bin/env node
/**
 * 单元测试运行器（esbuild 打包 → node --test）
 * ------------------------------------------------------------------
 * 为什么不用 vitest：本项目在离线环境开发，`npm install` 拿不到新包。
 * 而 vitest 的三大能力这里其实都不需要 ——
 *
 *   · 断言        → 内置 `node:assert/strict` 就够
 *   · 用例组织    → 内置 `node:test` 的 test/beforeEach
 *   · TS / 别名   → esbuild 一步转译 + `alias`（构建链里本来就有它）
 *
 * 代价是要自己写这几十行胶水；收益是**零新增依赖**，CI 与本地跑的是同一条命令。
 *
 * 流程：把 `tests/unit/*.test.ts` 各自 bundle 成 `.unit-out/*.test.mjs`，
 * 再交给 `node --test`。bundle 而不是逐个转译，是为了让 `@shared/*` 这类路径
 * 别名、以及被引入的组件源码都在同一步里解析完。
 *
 * 用法：node tools/unit-test.mjs
 */

import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SRC = path.join(ROOT, 'tests', 'unit');
const OUT = path.join(ROOT, '.unit-out');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const entries = readdirSync(SRC)
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => path.join(SRC, name));

if (!entries.length) {
  console.error('[unit] tests/unit 下没有 *.test.ts');
  process.exit(1);
}

await esbuild.build({
  entryPoints: entries,
  outdir: OUT,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: 'inline',
  logLevel: 'warning',
  // 与 tsconfig paths 保持一致：两处必须同源，否则「编辑器里能跳转、测试里找不到模块」
  alias: {
    '@shared': path.join(ROOT, 'src', 'shared'),
    '@renderer': path.join(ROOT, 'src', 'renderer'),
  },
});

/*
 * 必须把文件名一个个列出来，不能只给目录：`node --test <dir>` 在不同小版本上
 * 行为不一致（22.x 会把目录当模块去 require，直接 MODULE_NOT_FOUND）。
 */
const generated = readdirSync(OUT)
  .filter((name) => name.endsWith('.test.mjs'))
  .map((name) => path.join(OUT, name));

const result = spawnSync(process.execPath, ['--test', ...generated], { stdio: 'inherit' });
process.exit(result.status ?? 1);
