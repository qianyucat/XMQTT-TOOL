/**
 * 生成应用图标（build/icon.png → iconutil 打成 icon.icns）
 * ------------------------------------------------------------------
 * 为什么不用画图工具手工导出：图标要跟界面里的品牌色（--accent #4c94ff）同一套
 * 色值，改配色时一处改完重跑本脚本即可；而且 SVG 源在仓库里，任何人能改能审。
 *
 * 做法：用 Electron 自己渲染一段 SVG 再截图 —— 本机没有 rsvg，
 * 而 Electron 本来就在依赖里，渲染出来的抗锯齿质量也最好。
 *
 * ── 设计（图形标 / 同心菱形隧道）────────────────────────────────
 * 走过的两条死路，留在这里免得再走一遍：
 *
 * 1) **字母标 X 不能用。** × 的几何定义就是「等臂 + 居中 + 对称 + 45° +
 *    单色」，五条全中，缩到 40px 以下一律读作关闭按钮。立交、粗细分层、
 *    加端点端子、双色圆头管道这四种破法全试过，改完还是 ×，只是更难看。
 * 2) **上一版的「一方块射三条线」读作 share。** 一个方框加三条分叉加三个
 *    圆点是系统分享图标的固定画法，扫一眼就是 share，跟 MQTT 无关。
 *
 * 所以换成图形标：**四层同心菱形，向外暗、向心亮**。
 * 语义是消息从四面汇聚到中心的 broker —— 每向外一层，亮度降一档，
 * 视线被自然引到中心那个白点上。
 *
 * 三个决定：
 *
 * 1) **用菱形不用圆或方。** 圆会变成靶心/录制键，方会变成 App 图标本身。
 *    菱形四条边都是 45°，和 MQTT 报文里那种「包」的锐角印象一致，
 *    且在任何尺寸下都有唯一焦点。
 * 2) **明度单调递增，色相只朝一个方向走（靛 232° → 蓝 218° → 青 190°）。**
 *    多色图标最容易翻车的地方是色相来回跳 —— 一旦在 32px 糊在一起，
 *    相邻两层的明度差不够，整个图形就会塌成一块脏色。这里每层明度
 *    至少差 12 个点，缩到 32px 只剩「暗边 + 亮心」两层关系，仍然成立。
 * 3) **层距 76 / 76 / 74 / 60。** 越往里缝越窄，视觉上有加速感；
 *    最外层到中心的亮度比是 3.2 倍，撑住层次不靠发光。
 *
 * 配色放开成多色（用户要求「颜色丰富」）：不再是「骨白主体 + 一点蓝」，
 * 而是一条从 #2f5a9e 走到 #eef4ff 的完整渐变链 —— 但全部收在冷色区间，
 * 不出现暖色，避免变成彩色贴纸。
 *
 * 用法：
 *   node tools/make-icon.mjs
 *   → build/icon.png（1024×1024，透明背景）+ build/icon.icns
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { requireElectronExe } = require('./lib/electron-path.js');

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const BUILD_DIR = path.join(ROOT, 'build');
const PNG = path.join(BUILD_DIR, 'icon.png');

/**
 * macOS 图标规范（Big Sur 之后，iOS 同源）：1024 画布里图形占 824，四周留白，
 * 圆角约为边长的 22.6%（824 × 0.226 ≈ 186）。
 */
const ICON_BODY = { x: 100, y: 104, size: 824, r: 186 };

/* ── 几何（数值写死，改这里就等于改整个图标）─────────────────── */
const CX = 512;   // 底板中心 x
const CY = 516;   // 底板中心 y
const f = (n) => Math.round(n * 10) / 10;

/** 四角菱形（顶点在正上/正下/正左/正右） */
const dia = (r) => `M${CX} ${f(CY - r)}L${f(CX + r)} ${CY}L${CX} ${f(CY + r)}L${f(CX - r)} ${CY}Z`;

/** 由外到内：半径 + 填充（明度逐层抬升） */
const LAYERS = [
  { r: 330, fill: 'url(#l1)' },
  { r: 258, fill: 'url(#l2)' },
  { r: 188, fill: 'url(#l3)' },
  { r: 120, fill: 'url(#l4)' },
  { r: 78, fill: '#eef4ff', op: 0.16 },
  { r: 62, fill: '#eef4ff' },
];

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="body" x1="0.05" y1="0" x2="0.95" y2="1">
      <stop offset="0" stop-color="#182642"/>
      <stop offset="0.5" stop-color="#0e1626"/>
      <stop offset="1" stop-color="#080c16"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.34" r="0.72">
      <stop offset="0" stop-color="#5b6bff" stop-opacity="0.22"/>
      <stop offset="0.55" stop-color="#28d3f0" stop-opacity="0.05"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.16"/>
      <stop offset="0.42" stop-color="#ffffff" stop-opacity="0.02"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.46"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0.04"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0.14"/>
    </linearGradient>

    <!-- 四层渐变：对角走向，同一方向，只抬明度和色相，不来回跳 -->
    <linearGradient id="l1" gradientUnits="userSpaceOnUse" x1="240" y1="244" x2="784" y2="788">
      <stop offset="0" stop-color="#274a8a"/>
      <stop offset="1" stop-color="#3a2c72"/>
    </linearGradient>
    <linearGradient id="l2" gradientUnits="userSpaceOnUse" x1="294" y1="298" x2="730" y2="734">
      <stop offset="0" stop-color="#3a71c8"/>
      <stop offset="1" stop-color="#6250d8"/>
    </linearGradient>
    <linearGradient id="l3" gradientUnits="userSpaceOnUse" x1="350" y1="354" x2="674" y2="678">
      <stop offset="0" stop-color="#3fc4ee"/>
      <stop offset="1" stop-color="#4c94ff"/>
    </linearGradient>
    <linearGradient id="l4" gradientUnits="userSpaceOnUse" x1="414" y1="418" x2="610" y2="614">
      <stop offset="0" stop-color="#9bffe8"/>
      <stop offset="1" stop-color="#6ea8ff"/>
    </linearGradient>
  </defs>

  <rect x="${ICON_BODY.x}" y="${ICON_BODY.y}" width="${ICON_BODY.size}" height="${ICON_BODY.size}"
        rx="${ICON_BODY.r}" fill="url(#body)"/>
  <rect x="${ICON_BODY.x}" y="${ICON_BODY.y}" width="${ICON_BODY.size}" height="${ICON_BODY.size}"
        rx="${ICON_BODY.r}" fill="url(#glow)"/>
  <rect x="${ICON_BODY.x}" y="${ICON_BODY.y}" width="${ICON_BODY.size}" height="${ICON_BODY.size}"
        rx="${ICON_BODY.r}" fill="url(#sheen)"/>
  <rect x="${ICON_BODY.x + 2.5}" y="${ICON_BODY.y + 2.5}" width="${ICON_BODY.size - 5}"
        height="${ICON_BODY.size - 5}" rx="${ICON_BODY.r - 2.5}"
        fill="none" stroke="url(#rim)" stroke-width="3"/>

  <!-- 主体：同心菱形，外暗内亮；倒数第二层是中心白点的柔光 -->
  ${LAYERS.map((l) => `<path d="${dia(l.r)}" fill="${l.fill}"${l.op ? ` fill-opacity="${l.op}"` : ''}/>`).join('\n  ')}
</svg>`;

const HOST_SCRIPT = `
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');

/*
 * 抓帧方式：离屏渲染（offscreen），不是「隐藏窗口 + capturePage」。
 * ------------------------------------------------------------------
 * 走过的死路：show:false 的普通窗口在 Windows 上直接抛
 *   Error: Current display surface not available for capture
 * 隐藏窗口不进合成器，就没有 display surface 可抓。曾经试过关掉硬件加速
 * （app.disableHardwareAcceleration()）想绕过去，结果一样，还多了个副作用：
 * 那个异常没人 catch，Electron 不退出、父进程干等 exit 事件 —— 实测卡了
 * 四分钟不报错不结束，比直接失败更糟。
 * OSR 的 surface 由渲染器自己产出、和窗口是否可见无关，所以这里用
 * webPreferences.offscreen + webContents.capturePage，任何平台都稳。
 */
if (process.platform !== 'darwin') {
  app.commandLine.appendSwitch('no-sandbox');
}

const OUT = process.env.XMQTT_ICON_OUT;
const SVG = fs.readFileSync(process.env.XMQTT_ICON_SVG, 'utf8');
/*
 * 画布用绝对定位钉在 (PAD, PAD)，不靠 padding / flex 居中。
 * ------------------------------------------------------------------
 * Chromium 给透明窗口的实际内容宽度会比请求值多出几个像素，用 padding 顶位
 * 时右侧会漏出一条 alpha=128 的黑色竖带（capturePage 的未绘制区）。绝对定位
 * 不受这个取整影响，裁剪坐标是确定的。
 */
const PAD = 20;
const SIDE = 1024 + PAD * 2;
const HTML = '<!doctype html><html><body style="margin:0;overflow:hidden;background:transparent">'
  + '<div style="position:absolute;left:' + PAD + 'px;top:' + PAD + 'px;width:1024px;height:1024px">'
  + SVG + '</div></body></html>';

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width: SIDE,
      height: SIDE,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      enableLargerThanScreen: true,
      webPreferences: { offscreen: true, backgroundThrottling: false },
    });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML));
    await new Promise((r) => setTimeout(r, 400));
    const raw = await win.webContents.capturePage({ x: 0, y: 0, width: SIDE, height: SIDE });

    /*
     * 从 (PAD, PAD) 取 1024 见方，再缩到目标尺寸。
     * ------------------------------------------------------------------
     * capturePage 的未绘制区会留下 alpha=128 的黑色带（右侧最明显）。在深色 Dock
     * 上看不出来，一旦放到浅色背景上就是一条贯穿的灰竖线 —— 我在验收图里才发现。
     * 裁剪点落在 SVG 自己的留白里（底板距边 100px），所以切掉的都是空的。
     * 若先 resize 再裁，采样会把边缘脏像素带进来，等于白裁，顺序不能反。
     */
    const size = raw.getSize();
    if (!size.width || !size.height) throw new Error('抓帧返回空图');
    const dpr = size.width / SIDE;
    const off = Math.round(PAD * dpr);
    const body = raw.crop({ x: off, y: off, width: Math.round(1024 * dpr), height: Math.round(1024 * dpr) });
    const image = body.resize({ width: 1024, height: 1024, quality: 'best' });
    fs.writeFileSync(OUT, image.toPNG());
    console.log('[icon] ' + OUT + ' ' + JSON.stringify(image.getSize()));
    app.exit(0);
  } catch (err) {
    /* 必须显式退出：未捕获的 rejection 在 Electron 里不会结束进程，
       父进程只能干等 exit 事件（历史事故，见上方注释）。 */
    console.error('[icon] 抓帧失败: ' + ((err && err.message) || err));
    app.exit(1);
  }
});
`;

function runElectron(scriptPath) {
  const exe = requireElectronExe(ROOT);
  return new Promise((resolve, reject) => {
    /*
     * --no-sandbox 是给「在受限宿主（CI / 沙箱）里跑」准备的：那种环境不给
     * seatbelt 所需权限，Chromium 会直接 FATAL 退出。普通桌面终端里加不加都行，
     * 这个脚本只渲染一次本地 SVG，不接触任何外部内容。
     *
     * ELECTRON_RUN_AS_NODE 必须显式清空：父环境若打开了它，Electron 会退化成
     * 纯 node，连 --no-sandbox 都当未知参数拒掉。
     */
    const child = spawn(exe, ['--no-sandbox', '--disable-gpu', scriptPath], {
      cwd: os.tmpdir(),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      stdio: 'inherit',
    });

    /* 看门狗：抓帧本来 2 秒内结束。历史事故里 Electron 卡死、父进程等 exit
       等了四分钟，构建既不报错也不推进 —— 与其静默挂住，不如超时杀掉并失败。 */
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('electron 抓帧超时（90s），已强制结束'));
    }, 90_000);

    child.on('exit', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`electron exit ${code}`));
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * 把截图从屏幕色彩空间（本机是 Display P3）转回 sRGB。
 * ------------------------------------------------------------------
 * capturePage 拿到的是显示器色彩空间的数据：P3 下 #4c94ff 会被写成
 * (94,146,247) 并打上 P3 标记。视觉上没错，但导出的 PNG 里就找不到品牌
 * 色号的字节了 —— 换到按 sRGB 解释的 Windows 上会偏淡。转一次之后
 * 中层那个蓝正好是 (76,148,255)，跟 tokens 里的 --accent 完全一致。
 */
async function matchSrgb() {
  await new Promise((resolve, reject) => {
    const r = spawn('sips', ['--matchTo', '/System/Library/ColorSync/Profiles/sRGB Profile.icc', PNG], {
      stdio: 'ignore',
    });
    r.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`sips --matchTo 失败 ${code}`))));
    r.on('error', reject);
  });
}

/** 用 sips + iconutil 把 1024 PNG 打成 .icns（macOS 专用；其它平台只留 PNG） */
async function makeIcns() {
  const iconset = path.join(BUILD_DIR, 'icon.iconset');
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset, { recursive: true });

  const sizes = [
    [16, 'icon_16x16.png'],
    [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'],
    [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'],
    [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'],
    [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'],
    [1024, 'icon_512x512@2x.png'],
  ];

  for (const [size, name] of sizes) {
    await new Promise((resolve, reject) => {
      const r = spawn('sips', ['-z', String(size), String(size), PNG, '--out', path.join(iconset, name)], {
        stdio: 'ignore',
      });
      r.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`sips 失败: ${name}`))));
      r.on('error', reject);
    });
  }

  await new Promise((resolve, reject) => {
    const r = spawn('iconutil', ['-c', 'icns', iconset, '-o', path.join(BUILD_DIR, 'icon.icns')], {
      stdio: 'inherit',
    });
    r.on('exit', (code) => {
      fs.rmSync(iconset, { recursive: true, force: true });
      code === 0 ? resolve() : reject(new Error(`iconutil exit ${code}`));
    });
    r.on('error', reject);
  });
}

async function main() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });

  const svgFile = path.join(os.tmpdir(), 'xmqtt-icon.svg');
  fs.writeFileSync(svgFile, svg, 'utf8');
  const hostFile = path.join(os.tmpdir(), 'xmqtt-icon-host.cjs');
  fs.writeFileSync(hostFile, HOST_SCRIPT, 'utf8');

  process.env.XMQTT_ICON_OUT = PNG;
  process.env.XMQTT_ICON_SVG = svgFile;
  await runElectron(hostFile);
  console.log('[icon] build/icon.png');

  if (process.platform === 'darwin') {
    await matchSrgb();
    console.log('[icon] 色彩空间 → sRGB');
    await makeIcns();
    console.log('[icon] build/icon.icns');
  } else {
    console.log('[icon] 非 macOS，只输出 build/icon.png');
  }
}

main().catch((err) => {
  console.error('[icon] 失败:', err.message);
  process.exit(1);
});
