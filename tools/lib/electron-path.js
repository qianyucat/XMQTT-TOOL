'use strict';

/**
 * Electron 可执行文件解析（跨平台）
 * ------------------------------------------------------------------
 * 为什么单独抽一个模块：
 *   Windows 上可执行文件叫 electron.exe，Linux/macOS 上叫 electron（无后缀），
 *   而各脚本（launch / dev / e2e / screenshots）都要解析同一件事。
 *   散落四份 `'electron.exe'` 字面量正是跨平台迁移时最容易漏的地方。
 *
 * 解析优先级：
 *   1. node_modules/electron/path.txt —— 官方 electron 包安装时写入的相对文件名
 *      （Windows: "electron.exe"；Linux/macOS: "electron"）。这是唯一权威来源。
 *   2. 按平台推断的默认名（path.txt 缺失时的兜底）。
 *   3. 实在找不到就返回候选路径，由调用方决定报错文案。
 *
 * 注意：path.txt 里的内容是「相对于 dist/ 的文件名」，不要拿它当绝对路径用。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 按平台推断 dist 目录下的可执行文件名 */
function platformExeName() {
  return process.platform === 'win32' ? 'electron.exe' : 'electron';
}

/**
 * 解析 electron 可执行文件的绝对路径。
 * @param {string} projectRoot 项目根目录
 * @returns {{ exe: string, distDir: string, found: boolean }}
 */
function resolveElectronExe(projectRoot) {
  const electronPkg = path.join(projectRoot, 'node_modules', 'electron');
  const distDir = path.join(electronPkg, 'dist');
  const pathFile = path.join(electronPkg, 'path.txt');

  let exeName = platformExeName();
  try {
    const fromFile = fs.readFileSync(pathFile, 'utf8').trim();
    if (fromFile) exeName = fromFile;
  } catch {
    /* path.txt 不存在：用平台默认名兜底 */
  }

  const exe = path.join(distDir, exeName);
  return { exe, distDir, found: fs.existsSync(exe) };
}

/**
 * 解析并校验，失败时直接退出进程（脚本场景用）。
 * @param {string} projectRoot
 * @returns {string} 可执行文件绝对路径
 */
function requireElectronExe(projectRoot) {
  const { exe, found } = resolveElectronExe(projectRoot);
  if (found) return exe;

  console.error('[XMQTT] 未找到 Electron 可执行文件：');
  console.error(`        ${exe}`);
  console.error('        Windows:  node tools/assemble-deps.mjs');
  console.error('        Linux/macOS:  npm install   （Electron 二进制随依赖一起下载）');
  process.exit(1);
}

module.exports = { resolveElectronExe, requireElectronExe, platformExeName };
