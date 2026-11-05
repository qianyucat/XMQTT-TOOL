'use strict';

/**
 * 跨平台启动器（npm start 的入口）
 * ------------------------------------------------------------------
 * 为什么不用 `electron .`：
 *
 * 1) UNC 工作目录 —— Windows 的 CreateProcess 不接受 UNC 路径作为 lpCurrentDirectory。
 *    项目可能位于网络共享盘，npm 脚本的 cwd 就是项目根（UNC），直接起 electron 会失败。
 *    这里用 node 拉起（node 本身能跑在 UNC cwd 下），并把子进程 cwd 指定为本地临时目录。
 *    该处理在 Linux/macOS 上是无害的（那两个平台没有这个限制）。
 *
 * 2) ELECTRON_RUN_AS_NODE —— DSH / Codex 这类宿主的进程环境里带这个变量，
 *    继承下去会让 electron 退化成 node，require('electron') 拿不到 app。
 *    这里在 spawn 的 env 里剔除。
 *
 * 3) Chromium 沙箱 —— 远程/虚拟机会话下 GPU 子进程起不来（error_code=18），
 *    Electron 会在窗口出现前 FATAL 退出，必须 --no-sandbox。
 *    Linux 上额外要点：普通用户运行还需要 SUID sandbox 就绪，--no-sandbox 同时规避它。
 *
 * 可执行文件名由 tools/lib/electron-path.js 按平台解析（win32 是 electron.exe，其余是 electron），
 * 不要在这里写死后缀。
 *
 * 用法：
 *   node tools/launch.js              启动
 *   node tools/launch.js --devtools   带开发者工具
 *   node tools/launch.js --sandboxed  保留 Chromium 沙箱
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const { requireElectronExe } = require('./lib/electron-path.js');
const { ensureMainBuild } = require('./lib/build-main.js');

const projectRoot = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (argv.includes('--devtools')) env.XMQTT_DEVTOOLS = '1';

/*
 * Chromium 参数按平台给，默认值与 src/main/main.ts 里的 SOFTWARE_RENDER 保持一致：
 *   macOS  → 不关 GPU、不加 --no-sandbox。真机的 GPU 与 seatbelt 沙箱都正常，
 *            关掉只会让滚动、弹层动画退化成 CPU 光栅，--no-sandbox 还会削弱渲染进程隔离。
 *   Windows / Linux → 默认带 --disable-gpu --no-sandbox。远程会话与无头服务器上
 *            GPU 子进程与 SUID sandbox 起不来，不带就是「双击没反应」。
 * 两个平台都可以用 XMQTT_SOFTWARE_RENDER=1/0 强制覆盖。
 */
const isMac = process.platform === 'darwin';
const softwareRender = process.env.XMQTT_SOFTWARE_RENDER
  ? process.env.XMQTT_SOFTWARE_RENDER !== '0'
  : !isMac;

const electronArgs = [projectRoot];
if (softwareRender) electronArgs.push('--disable-gpu');
if (!isMac && !argv.includes('--sandboxed')) electronArgs.push('--no-sandbox');
if (argv.includes('--devtools')) electronArgs.push('--auto-open-devtools-for-tabs');

async function main() {
  /*
   * 阶段 6 起 package.json 的 main 指向编译产物 dist/main/main.js，
   * 所以启动前必须先把主进程编出来；否则 Electron 拿到的是旧产物或直接报找不到入口。
   * esbuild 增量只有几十毫秒，每次启动都重编最省心。
   */
  await ensureMainBuild();

  const electronExe = requireElectronExe(projectRoot);
  console.log(`[XMQTT] ${electronExe}`);
  console.log(`[XMQTT] 参数: ${electronArgs.slice(1).join(' ')}`);

  const child = spawn(electronExe, electronArgs, {
    cwd: os.tmpdir(), // 见文件头说明：必须是本地路径
    env,
    stdio: 'inherit',
    windowsHide: false,
  });

  child.on('exit', (code) => {
    process.exit(code === null ? 0 : code);
  });

  child.on('error', (err) => {
    console.error('[XMQTT] 启动失败:', err.message);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error('[XMQTT] 启动失败:', err && err.message ? err.message : err);
  process.exit(1);
});
