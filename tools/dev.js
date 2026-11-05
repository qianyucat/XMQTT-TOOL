'use strict';

/**
 * 开发启动器（npm run dev）
 * ------------------------------------------------------------------
 * 并行拉起两件事：
 *   1. Vite dev server —— 负责渲染层的模块编译、依赖预打包与 HMR
 *   2. Electron 窗口   —— 通过 VITE_DEV_SERVER_URL 加载 dev server 地址
 *
 * 启动约束与 tools/launch.js 完全一致，因为开发态和运行态跑的是同一个 Electron：
 *   - UNC 工作目录：Windows 的 CreateProcess 不接受 UNC 作为 cwd，子进程 cwd 必须指到本地临时目录
 *   - ELECTRON_RUN_AS_NODE：宿主环境带的这个变量会让 electron 退化成 node，必须剔除
 *   - Chromium 沙箱：远程会话下 GPU 子进程起不来，必须 --no-sandbox --disable-gpu
 *
 * 可执行文件名由 tools/lib/electron-path.js 按平台解析，不要写死 .exe 后缀。
 *
 * 退出时连带关掉 dev server，避免端口被占住（strictPort 下次会直接起不来）。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const { requireElectronExe } = require('./lib/electron-path.js');
const { ensureMainBuild } = require('./lib/build-main.js');

const projectRoot = path.resolve(__dirname, '..');

async function main() {
  let createServer;
  try {
    ({ createServer } = await import('vite'));
  } catch (err) {
    console.error('[XMQTT] 未安装 Vite，无法启动开发模式。');
    console.error('        请先执行：npm install');
    console.error(`        原始错误：${err.message}`);
    process.exit(1);
  }

  const server = await createServer({ configFile: path.join(projectRoot, 'vite.config.ts') });
  await server.listen();

  const url = server.resolvedUrls?.local?.[0];
  if (!url) throw new Error('Vite dev server 没有解析出本地地址');

  const env = { ...process.env, VITE_DEV_SERVER_URL: url };
  delete env.ELECTRON_RUN_AS_NODE;
  // 开发态默认带开发者工具，除非显式关掉
  if (env.XMQTT_DEVTOOLS !== '0') env.XMQTT_DEVTOOLS = '1';

  const electronExe = requireElectronExe(projectRoot);
  console.log(`[XMQTT] dev server: ${url}`);
  console.log(`[XMQTT] ${electronExe}`);

  // 主进程也是 TS（阶段 6）：electron 读的是 dist/main/main.js，起窗口前先编一次
  await ensureMainBuild();

  const child = spawn(electronExe, [projectRoot, '--disable-gpu', '--no-sandbox'], {
    cwd: os.tmpdir(), // 见文件头：必须是本地路径
    env,
    stdio: 'inherit',
    windowsHide: false,
  });

  let closing = false;
  const shutdown = async (code) => {
    if (closing) return;
    closing = true;
    try {
      await server.close();
    } catch { /* 退出期异常忽略 */ }
    process.exit(code);
  };

  child.on('exit', (code) => {
    shutdown(code === null ? 0 : code);
  });

  child.on('error', (err) => {
    console.error('[XMQTT] 启动失败:', err.message);
    shutdown(1);
  });

  // Ctrl+C 时先杀 Electron，再关闭 server（走 child.on('exit') 统一收尾）
  process.on('SIGINT', () => {
    child.kill();
  });
}

main().catch((err) => {
  console.error('[XMQTT] dev 启动失败:', err.message);
  process.exit(1);
});
