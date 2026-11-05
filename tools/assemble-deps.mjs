/**
 * 离线依赖装配脚本（Windows 专用）
 * ==================================================================
 * ⚠ 平台限定：本脚本只在 **Windows** 上运行（依赖 robocopy / PowerShell /
 *   win32 版 Electron 缓存 zip）。Linux / macOS 上不需要它 —— 直接
 *   `npm install` 即可（配国内镜像，见 README「跨平台」一节）。
 *   在非 Windows 上执行会立刻退出并提示。
 *
 * 本机没有外网（registry.npmjs.org / registry.npmmirror.com 均不可达），无法执行
 * `npm install`。本脚本从本机既有的离线资源装配项目的 node_modules。
 *
 * 资源一：mqtt 运行时依赖闭包
 *   默认源：D:\deps\mqtt-deps\node_modules（可用 XMQTT_DEP_SRC 覆盖）
 *   该目录是 Bun 风格的隔离布局，存在三种形态：
 *     - 普通名         mqtt / @types/ws
 *     - 哈希副本       .mqtt-aBXPU32z        （Bun 为消解版本冲突生成的隐藏副本）
 *     - 嵌套依赖       .mqtt-aBXPU32z/node_modules/debug  （部分包仅在此可见）
 *   实测坑点：主源里 `.debug-PxZlHyt2` 是「空壳」（只有空 src/、没有 package.json），
 *   因此必须做包有效性校验 + 多源回退，否则装配出来的树缺 debug，mqtt 无法 require。
 *
 *   回退源（按优先级）：
 *     - R:\Program Files\nodejs 等扁平 node_modules
 *     - R:\Program Files\DSH NEXT\resources\app\node_modules（DSH 自身是 Electron 应用，依赖齐全）
 *     - R:\AI_Tools\deepseek-harness-master\node_modules\.pnpm（pnpm 虚拟 store）
 *
 * 资源二：Electron 二进制
 *   %LOCALAPPDATA%\electron\Cache\electron-v<ver>-win32-x64.zip（无需联网的官方 zip）
 *   解压到 node_modules/electron/dist，并补写 path.txt 供 electron/index.js 定位可执行文件。
 *
 * 拷贝实现说明（重要）
 *   不要用 fs.cpSync：实测在「本地盘源 -> UNC 网络共享目标」组合下会静默丢文件
 *   （29 个文件只拷过去 2 个且不报错）。统一使用 Windows 原生 robocopy。
 *   另外 SMB 目录缓存会让「刚拷完立刻 readdir」读到过期视图，所以校验放在全部拷贝之后统一做。
 *
 * 用法：
 *   node tools/assemble-deps.mjs                 全量装配
 *   node tools/assemble-deps.mjs --only=packages 只装配 mqtt 闭包
 *   node tools/assemble-deps.mjs --only=electron 只装配 Electron
 *   node tools/assemble-deps.mjs --force         强制重新解压 Electron
 *   node tools/assemble-deps.mjs --verify        装配后做 require 冒烟
 *
 * 环境变量：
 *   XMQTT_DEP_SRC        主包源 node_modules
 *   XMQTT_FALLBACK_SRC   回退源列表（改分号分隔）
 *   XMQTT_ELECTRON_ZIP   Electron 离线 zip
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DST_NODE_MODULES = path.join(ROOT, 'node_modules');

const DEP_SRC =
  process.env.XMQTT_DEP_SRC ||
  'D:\\deps\\mqtt-deps\\node_modules';

const FALLBACK_SRC = (
  process.env.XMQTT_FALLBACK_SRC ||
  [
    'R:\\Program Files\\DSH NEXT\\resources\\app\\node_modules',
    'R:\\Program Files\\nodejs\\node_modules',
  ].join(';')
)
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

const PNPM_STORES = ['R:\\AI_Tools\\deepseek-harness-master\\node_modules\\.pnpm'];

/**
 * 额外装配的根包（逗号分隔）。
 * 用于本地冒烟测试：XMQTT_EXTRA_PACKAGES=aedes 会额外装一个本地 broker。
 * 正式运行只需要 mqtt，因此默认不装。
 */
const EXTRA_PACKAGES = (process.env.XMQTT_EXTRA_PACKAGES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** 运行期真正需要的根包（渲染层不用 node，MQTT 逻辑全部在主进程） */
const ROOT_PACKAGES = ['mqtt', ...EXTRA_PACKAGES];

const HASHED_RE = /^\.(.+)-[A-Za-z0-9_-]{8}$/;

/* ------------------------------------------------------------------ */
/* 源索引                                                             */
/* ------------------------------------------------------------------ */

function countFiles(dir, depth) {
  let count = 0;
  const stack = [[dir, depth]];
  while (stack.length) {
    const [cur, d] = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of ents) {
      if (ent.isFile()) count++;
      else if (ent.isDirectory() && d > 0) stack.push([path.join(cur, ent.name), d - 1]);
      if (count > 0) return count;
    }
  }
  return count;
}

/**
 * 包可用性校验。
 * 只认「有可解析 package.json 且目录里确实还有文件」的目录 —— 空壳目录
 * （如主源里的 .debug-PxZlHyt2：只有空 src/）会被拒绝，从而触发回退源查找。
 */
function isUsablePackage(dir) {
  if (!fs.existsSync(path.join(dir, 'package.json'))) return false;
  return countFiles(dir, 2) > 0;
}

function scanFlat(root, index, priority) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name === '.bin') continue;
    const full = path.join(root, ent.name);

    if (ent.name.startsWith('@')) {
      let subs;
      try {
        subs = fs.readdirSync(full, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sub of subs) {
        if (sub.isDirectory()) addCandidate(index, `${ent.name}/${sub.name}`, path.join(full, sub.name), priority);
      }
      continue;
    }

    const m = HASHED_RE.exec(ent.name);
    if (m) addCandidate(index, m[1], full, priority - 1);
    else addCandidate(index, ent.name, full, priority);
  }
}

/** 递归扫描嵌套 node_modules（部分包只在依赖的私有 node_modules 里存在） */
function scanNested(root, index, priority, depth) {
  scanFlat(root, index, priority);
  if (depth <= 0) return;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name === 'node_modules' || ent.name === '.bin') continue;
    const nested = path.join(root, ent.name, 'node_modules');
    if (fs.existsSync(nested)) scanNested(nested, index, priority - 1, depth - 1);
  }
}

/** pnpm 虚拟 store：.pnpm/<name>@<ver>/node_modules/<pkg> */
function scanPnpmStore(store, index, priority) {
  let entries;
  try {
    entries = fs.readdirSync(store, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const nm = path.join(store, ent.name, 'node_modules');
    if (fs.existsSync(nm)) scanFlat(nm, index, priority);
  }
}

/**
 * 候选登记。
 *
 * 规则：**可用性优先于来源优先级**。主源里有大量空壳目录（Bun 隔离布局下未解引用的
 * junction / 安装残留），若让它们凭「主源优先级高」占住索引位，回退源里的真包就永远进不来
 * —— debug、core-util-is 正是这样被挡掉的。因此只有同为可用或同为空壳时才比较优先级。
 */
function addCandidate(index, name, dir, priority) {
  if (!name || name.startsWith('.')) return;
  const usable = isUsablePackage(dir);
  const cur = index.get(name);

  if (!cur) {
    index.set(name, { dir, priority, usable });
    return;
  }
  if (cur.usable) {
    // 已找到真包：只有更高优先级的真包才值得替换
    if (usable && priority > cur.priority) index.set(name, { dir, priority, usable: true });
    return;
  }
  // 现有的是空壳：真包无条件胜出；同为空间才比优先级
  if (usable || priority > cur.priority) index.set(name, { dir, priority, usable });
}

function buildIndex() {
  const index = new Map();
  const stats = { usable: 0, unusable: 0 };
  console.log(`[index] 主源: ${DEP_SRC}`);
  scanNested(DEP_SRC, index, 10, 2);

  for (const fb of FALLBACK_SRC) {
    if (!fs.existsSync(fb)) continue;
    console.log(`[index] 回退源: ${fb}`);
    scanFlat(fb, index, 5);
  }
  for (const store of PNPM_STORES) {
    if (!fs.existsSync(store)) continue;
    console.log(`[index] pnpm store: ${store}`);
    scanPnpmStore(store, index, 3);
  }

  for (const v of index.values()) v.usable ? stats.usable++ : stats.unusable++;
  console.log(`[index] 候选包 ${index.size} 个（可用 ${stats.usable}，空壳 ${stats.unusable}）`);
  return index;
}

/* ------------------------------------------------------------------ */
/* 依赖闭包                                                           */
/* ------------------------------------------------------------------ */

function readPkgMeta(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

function resolveClosure(index, roots) {
  const resolved = new Map();
  const missing = [];
  const queue = [...roots];
  const seen = new Set();

  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);

    const cand = index.get(name);
    if (!cand || !cand.usable) {
      missing.push({ name, reason: cand ? '空壳包' : '未找到' });
      continue;
    }
    resolved.set(name, cand.dir);

    const meta = readPkgMeta(cand.dir);
    if (!meta) continue;
    for (const field of ['dependencies', 'optionalDependencies']) {
      for (const dep of Object.keys(meta[field] || {})) queue.push(dep);
    }
  }
  return { resolved, missing };
}

/* ------------------------------------------------------------------ */
/* 拷贝                                                               */
/* ------------------------------------------------------------------ */

function robocopy(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const r = spawnSync(
    'robocopy',
    [
      src,
      dest,
      '/E',
      '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/NS', '/NC',
      '/R:1', '/W:1',
      '/MT:8',
      '/XD', 'node_modules', '.git', '.github',
    ],
    { encoding: 'utf8', windowsHide: true }
  );
  if (r.error) throw r.error;
  if (r.status >= 8) throw new Error(`robocopy 退出码 ${r.status}`);
}

function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of ents) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else {
        try {
          total += fs.statSync(full).size;
        } catch { /* 忽略瞬时文件 */ }
      }
    }
  }
  return total;
}

function assemblePackages() {
  if (!fs.existsSync(DEP_SRC)) {
    throw new Error(`主包源不存在: ${DEP_SRC}（可用 XMQTT_DEP_SRC 覆盖）`);
  }

  const index = buildIndex();
  const { resolved, missing } = resolveClosure(index, ROOT_PACKAGES);

  if (missing.length) {
    for (const m of missing) console.warn(`[packages] 缺失依赖: ${m.name} (${m.reason})`);
  }

  fs.mkdirSync(DST_NODE_MODULES, { recursive: true });

  const sorted = [...resolved].sort((a, b) => a[0].localeCompare(b[0]));
  console.log(`[packages] 待装配 ${sorted.length} 个包 ...`);
  for (const [name, src] of sorted) {
    const dest = path.join(DST_NODE_MODULES, name);
    try {
      robocopy(src, dest);
    } catch (err) {
      console.error(`[packages]   ! ${name}: ${err.message}`);
    }
  }

  // 拷贝完成后统一校验：SMB 目录缓存会让「刚拷完立刻统计」读到过期视图，故延迟到此处。
  let ok = 0;
  const broken = [];
  let bytes = 0;
  for (const [name] of sorted) {
    const dest = path.join(DST_NODE_MODULES, name);
    const meta = readPkgMeta(dest);
    const files = countFiles(dest, 2);
    if (meta && files > 0) {
      ok++;
      bytes += dirSize(dest);
    } else {
      broken.push(name);
    }
  }

  console.log(`[packages] 完成：有效 ${ok}/${sorted.length} 个包，合计 ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  if (broken.length) {
    console.error(`[packages] 校验失败: ${broken.join(', ')}`);
    throw new Error(`${broken.length} 个包装配后仍然不完整`);
  }
  return { resolved, missing };
}

/* ------------------------------------------------------------------ */
/* Electron                                                           */
/* ------------------------------------------------------------------ */

function findElectronZip() {
  if (process.env.XMQTT_ELECTRON_ZIP) return process.env.XMQTT_ELECTRON_ZIP;
  const cacheDir = path.join(os.homedir(), 'AppData', 'Local', 'electron', 'Cache');
  if (!fs.existsSync(cacheDir)) return null;
  const hit = fs
    .readdirSync(cacheDir)
    .filter((n) => /^electron-v[\d.]+-win32-x64\.zip$/.test(n))
    .sort()
    .pop();
  return hit ? path.join(cacheDir, hit) : null;
}

function findElectronShell() {
  const direct = path.join(DEP_SRC, '.electron-gzcASo3N');
  const candidates = [];
  if (fs.existsSync(direct)) candidates.push(direct);

  try {
    for (const ent of fs.readdirSync(DEP_SRC, { withFileTypes: true })) {
      if (ent.isDirectory() && /^\.electron-[A-Za-z0-9_-]{8}$/.test(ent.name)) {
        candidates.push(path.join(DEP_SRC, ent.name));
      }
    }
  } catch { /* 忽略 */ }

  // 回退：任何带 dist 或含 electron 包元数据的目录都不可用时，从扁平回退源找
  for (const fb of FALLBACK_SRC) {
    const p = path.join(fb, 'electron');
    if (fs.existsSync(path.join(p, 'package.json'))) candidates.push(p);
  }

  return candidates.find((c) => isUsablePackage(c)) || null;
}

function assembleElectron({ force }) {
  const electronDir = path.join(DST_NODE_MODULES, 'electron');
  const distDir = path.join(electronDir, 'dist');
  const exePath = path.join(distDir, 'electron.exe');

  if (fs.existsSync(exePath) && countFiles(distDir, 1) > 10 && !force) {
    console.log(`[electron] 已就绪，跳过（--force 可强制重装）`);
    return;
  }

  const shellSrc = findElectronShell();
  if (!shellSrc) throw new Error('未找到 electron 包外壳（源 node_modules 或回退源）');
  robocopy(shellSrc, electronDir);
  console.log(`[electron] 外壳: ${shellSrc} -> ${electronDir}`);

  // 先在本地临时目录解压，再同步到目标：Expand-Archive 直写 UNC 目标不可靠。
  const zip = findElectronZip();
  if (!zip) throw new Error('未找到 Electron 离线 zip（%LOCALAPPDATA%\\electron\\Cache）');
  const stage = path.join(os.tmpdir(), 'xmqtt-electron-stage');

  if (!fs.existsSync(path.join(stage, 'electron.exe')) || force) {
    console.log(`[electron] 解压 ${path.basename(zip)} -> ${stage}`);
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    const unzip = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${stage.replace(/'/g, "''")}' -Force`,
      ],
      { stdio: 'inherit', windowsHide: true }
    );
    if (unzip.status !== 0) throw new Error(`解压失败，退出码 ${unzip.status}`);
  } else {
    console.log(`[electron] 复用本地暂存: ${stage}`);
  }

  if (!fs.existsSync(path.join(stage, 'electron.exe'))) {
    throw new Error('解压产物缺少 electron.exe');
  }

  robocopy(stage, distDir);
  fs.writeFileSync(path.join(electronDir, 'path.txt'), 'electron.exe', 'utf8');

  if (!fs.existsSync(exePath)) throw new Error(`同步后仍缺少 electron.exe: ${exePath}`);

  const meta = readPkgMeta(electronDir);
  console.log(`[electron] 完成：electron@${meta?.version} -> ${exePath}`);
}

/* ------------------------------------------------------------------ */

function main() {
  const argv = process.argv.slice(2);
  const force = argv.includes('--force');
  const only = (argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || 'all';

  if (only === 'all' || only === 'packages') assemblePackages();
  if (only === 'all' || only === 'electron') assembleElectron({ force });

  if (argv.includes('--verify')) {
    const r = spawnSync(process.execPath, ['-e', "require('mqtt'); console.log('mqtt require OK')"], {
      cwd: ROOT,
      stdio: 'inherit',
      windowsHide: true,
    });
    if (r.status !== 0) throw new Error('require 冒烟失败');
    const e = spawnSync(process.execPath, ['-e', "console.log(require('electron'))"], {
      cwd: ROOT,
      stdio: 'inherit',
      windowsHide: true,
    });
    if (e.status !== 0) throw new Error('electron 路径解析失败');
  }

  console.log('\n装配结束。启动命令:  npm start');
}

if (process.platform !== 'win32') {
  console.error('[assemble-deps] 本脚本仅适用于 Windows（robocopy / PowerShell / win32 Electron 缓存）。');
  console.error(`[assemble-deps] 当前平台 ${process.platform}，请直接执行： npm install`);
  process.exit(1);
}

main();
