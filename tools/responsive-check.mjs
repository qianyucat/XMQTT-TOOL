/**
 * 响应式几何回归检查
 * ------------------------------------------------------------------
 * 跑真机（Electron + 真 Broker），用 CDP 模拟视口宽度与触屏指针，在四个档位上
 * 断言一批「肉眼很难看出来、但一定会坏事」的几何事实：
 *
 *   · 表格列宽之和必须等于表格宽度（少的那部分就是「预览列被压成 34px」）
 *   · 行高必须等于 --table-row-h（虚拟滚动的滚动条长度靠它，错了不报错）
 *   · 窄档位导航必须在底部、宽档位必须在左侧
 *   · 抽屉关闭时树在画面外、打开时在画面内且遮罩可点
 *   · 详情条在窄档位折叠后不能高于 60px
 *
 * 这些断言刻意不比较像素，只比较几何 —— 截图会随时间戳抖动，几何不会。
 *
 * 用法：node tools/responsive-check.mjs
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
process.chdir(ROOT);

const aedesMod = require(path.join(ROOT, 'node_modules/aedes'));
const Aedes = typeof aedesMod === 'function' ? aedesMod : aedesMod.Aedes || aedesMod.default;
const WebSocket = require(path.join(ROOT, 'node_modules/ws'));
const { requireElectronExe } = require(path.join(ROOT, 'tools/lib/electron-path.js'));

const BROKER_PORT = 18843;
const CDP_PORT = 9233;
const USER_DATA = path.join(os.tmpdir(), 'xmqtt-resp-check');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ 断言收集 ------------------------------ */

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
};

/* ------------------------------ 环境准备 ------------------------------ */

fs.rmSync(USER_DATA, { recursive: true, force: true });
fs.mkdirSync(USER_DATA, { recursive: true });
fs.writeFileSync(
  path.join(USER_DATA, 'xmqtt-config.json'),
  JSON.stringify(
    {
      version: 1,
      servers: [
        {
          id: 'r-server', name: '回归 Broker', protocol: 'mqtt', host: '127.0.0.1', port: BROKER_PORT,
          clientId: 'xmqtt-resp', protocolVersion: 4, keepalive: 60, connectTimeout: 8000,
          reconnectPeriod: 3000, clean: true, autoReconnect: true, rejectUnauthorized: true,
        },
      ],
      templates: [
        { id: 'r1', name: '控制帧', topic: 'protocol/trackless/robot/control', payload: '{"Control":{"KeyCtrl":{"KeyCount":831}}}', qos: 1, retain: false, encoding: 'utf8' },
      ],
      publishHistory: [],
      settings: { theme: 'dark', autoScroll: true, lastServerId: 'r-server' },
    },
    null,
    2
  )
);

const broker = new Aedes();
const server = createServer(broker.handle);
await new Promise((res, rej) => {
  server.once('error', rej);
  server.listen(BROKER_PORT, '127.0.0.1', res);
});

const pub = (topic, payload, opts = {}) =>
  broker.publish(
    { cmd: 'publish', topic, payload: Buffer.from(payload), qos: opts.qos ?? 0, retain: !!opts.retain },
    () => {}
  );

pub('factory/line1/config', JSON.stringify({ line: 1, speed: 0.8, mode: 'auto' }), { retain: true });

let tick = 0;
const timer = setInterval(() => {
  tick += 1;
  pub('factory/line1/robot/status', tick % 2 === 0 ? 'RUNNING' : 'IDLE');
  pub('protocol/trackless/robot/control', JSON.stringify({ Control: { KeyCtrl: { KeyCount: 831, KeyStatus: 1 } } }));
  pub('sensor/temp/1', JSON.stringify({ value: (20 + tick).toFixed(2), unit: 'C' }));
  pub('protocol/trackless/robot/feedback/progress', JSON.stringify({ percent: Math.min(100, tick * 3) }));
}, 400);

function makeCdp(ws) {
  let nextId = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  });
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`CDP 超时 ${method}`));
        }
      }, 25000);
    });
}

async function waitForCdp(port, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* 还没起来 */
    }
    await sleep(400);
  }
  throw new Error('等 CDP 超时');
}

/* ------------------------------ 主流程 ------------------------------ */

const electronExe = requireElectronExe(ROOT);
const env = { ...process.env, XMQTT_USER_DATA: USER_DATA };
delete env.ELECTRON_RUN_AS_NODE;
const appProc = spawn(electronExe, [ROOT, '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`], {
  cwd: os.tmpdir(),
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let ws;
let exitCode = 0;
try {
  const page = await waitForCdp(CDP_PORT);
  ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });
  const cdp = makeCdp(ws);
  await cdp('Runtime.enable');
  await cdp('Page.enable');

  const evalJs = async (expression) => {
    const res = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || 'eval 失败');
    return res.result?.value;
  };
  const waitUntil = async (expr, label, timeoutMs = 25000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evalJs(expr)) return true;
      await sleep(250);
    }
    throw new Error(`等待超时: ${label}`);
  };
  const setInput = (sel, value) =>
    evalJs(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(String(value))});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);

  /* --- 铺数据：连上、订阅、扫描，让表格真的有行 --- */

  await waitUntil(`!!document.querySelector('#serverSelect') && !!window.__xmqtt`, 'DOM 就绪');
  await waitUntil(`document.querySelector('#serverSelect').options.length === 1`, '配置载入');
  await evalJs(`document.querySelector('[data-testid="connect"]').click(); true`);
  await waitUntil(`__xmqtt.selectors.activeConn()?.status === 'connected'`, '连接建立');
  await evalJs(`document.querySelector('.rail__item[data-view="browser"]').click(); true`);
  for (const topic of ['factory/#', 'protocol/#', 'sensor/+/temp']) {
    await setInput('[data-testid="sub-topic"]', topic);
    await evalJs(`document.querySelector('[data-testid="sub-add"]').click(); true`);
    await sleep(220);
  }
  await evalJs(`document.querySelector('[data-testid="scan-start"]').click(); true`);
  await sleep(3000);

  /* --- 逐档断言 --- */

  const geometry = () =>
    evalJs(`(() => {
      const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
      };
      const root = getComputedStyle(document.documentElement);
      const table = document.getElementById('msgTable');
      const wrap = document.getElementById('msgTableWrap');
      const ths = [...table.querySelectorAll('thead th')];
      const visible = ths.filter((el) => getComputedStyle(el).display !== 'none');
      const row = table.querySelector('tbody tr[data-testid="msg-row"]');
      const ms = table.querySelector('.cell-time__ms');
      return {
        vw: innerWidth,
        docScrollW: document.documentElement.scrollWidth,
        rowH: parseFloat(root.getPropertyValue('--table-row-h')),
        controlH: parseFloat(root.getPropertyValue('--control-h')),
        rail: box('.rail'),
        railDir: getComputedStyle(document.querySelector('.rail')).flexDirection,
        content: box('.content'),
        tree: box('.pane--workbench'),
        msgPane: box('.pane--messages'),
        detail: box('.msg-detail'),
        scrim: (() => {
          const el = document.querySelector('.scrim');
          const cs = getComputedStyle(el);
          return { display: cs.display, pe: cs.pointerEvents, opacity: cs.opacity };
        })(),
        table: { w: Math.round(table.getBoundingClientRect().width), wrapW: Math.round(wrap.getBoundingClientRect().width) },
        cols: visible.map((el) => ({ cls: el.className, w: Math.round(el.getBoundingClientRect().width) })),
        rowRectH: row ? Math.round(row.getBoundingClientRect().height) : null,
        msVisible: ms ? getComputedStyle(ms).display !== 'none' : false,
      };
    })()`);

  const tiers = [
    { name: '桌面 1390', w: 1390, h: 863, coarse: false, tier: 'wide' },
    { name: '桌面 1180（六列仍要放得下）', w: 1180, h: 800, coarse: false, tier: 'wide' },
    { name: '紧凑 900', w: 900, h: 780, coarse: false, tier: 'compact' },
    { name: '紧凑 900 · 触屏', w: 900, h: 780, coarse: true, tier: 'compact' },
    { name: '手机 390 · 触屏', w: 390, h: 844, coarse: true, tier: 'phone' },
  ];

  for (const t of tiers) {
    await cdp('Emulation.setDeviceMetricsOverride', {
      width: t.w,
      height: t.h,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: t.coarse, maxTouchPoints: t.coarse ? 5 : 1 });
    await sleep(900);
    try {
    const g = await geometry();

    // 1. 不出现整页横向滚动
    check(`${t.name} · 无横向溢出`, g.docScrollW <= g.vw + 1, `scrollWidth=${g.docScrollW} vw=${g.vw}`);

    // 2. 列宽之和填满表格（差 2px 以内）—— 少的那部分就是某一列被压塌
    const sum = g.cols.reduce((s, c) => s + c.w, 0);
    check(
      `${t.name} · 列宽之和 == 表宽`,
      Math.abs(sum - g.table.w) <= 2,
      `sum=${sum} table=${g.table.w} cols=${g.cols.map((c) => c.w).join('/')}`
    );

    // 3. 预览列不能被压到看不见
    const prev = g.cols.find((c) => c.cls.includes('col-prev'));
    check(`${t.name} · 预览列 ≥ 90px`, !!prev && prev.w >= 90, prev ? `${prev.w}px` : '列不存在');

    // 4. 行高：鼠标 28 / 触屏 44，且与实际行高一致（虚拟滚动的命门）
    const wantRow = t.coarse ? 44 : 28;
    check(`${t.name} · --table-row-h == ${wantRow}`, g.rowH === wantRow, `${g.rowH}px`);
    check(`${t.name} · 实际行高 == 令牌`, g.rowRectH === null || Math.abs(g.rowRectH - wantRow) <= 1, `${g.rowRectH}px`);

    // 5. 控件高度：鼠标 30 / 触屏 36
    check(`${t.name} · --control-h == ${t.coarse ? 36 : 30}`, g.controlH === (t.coarse ? 36 : 30), `${g.controlH}px`);

    // 6. 导航位置：窄档位在底部，宽档位在左侧
    if (t.tier === 'phone') {
      check(`${t.name} · 导航为底部横向`, g.railDir === 'row' && g.rail.h < 90, `dir=${g.railDir} h=${g.rail.h}`);
      check(`${t.name} · 导航在内容下方`, g.rail.y >= g.content.y + g.content.h - 1, `rail.y=${g.rail.y}`);
    } else {
      check(`${t.name} · 导航为左侧纵向`, g.railDir === 'column' && g.rail.w <= 90, `dir=${g.railDir} w=${g.rail.w}`);
    }

    // 7. 窄档位：树默认在画面外，消息面板吃满宽度
    if (t.tier === 'phone') {
      check(`${t.name} · 树默认在画面外`, g.tree.x + g.tree.w <= 0, `tree right=${g.tree.x + g.tree.w}`);
      check(`${t.name} · 消息面板占满宽度`, Math.abs(g.msgPane.w - g.vw) <= 2, `${g.msgPane.w}px`);
      check(`${t.name} · 详情条折叠后 ≤ 60px`, g.detail.h <= 60, `${g.detail.h}px`);
      check(`${t.name} · 毫秒在窄档位隐藏`, g.msVisible === false, `msVisible=${g.msVisible}`);
    } else {
      check(`${t.name} · 树在左侧可见`, g.tree.x >= 0 && g.tree.w >= 260, `x=${g.tree.x} w=${g.tree.w}`);
    }

    // 8. 宽档位六列全显，紧凑档位减列
    const wantCols = g.msgPane.w >= 720 ? 6 : g.msgPane.w >= 480 ? 4 : 3;
    check(`${t.name} · 列数 == ${wantCols}`, g.cols.length === wantCols, `实际 ${g.cols.length} 列`);
    } catch (err) {
      check(`${t.name} · 断言未抛异常`, false, err instanceof Error ? err.message : String(err));
    }
  }

  /* --- 手机档的两个展开态 --- */

  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: false });
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await sleep(700);

  await evalJs(`document.getElementById('msgDrawerBtn').click(); true`);
  await sleep(500);
  const drawer = await geometry();
  check('手机 390 · 抽屉打开后树进入画面', drawer.tree.x >= -1 && drawer.tree.w >= 240, `x=${drawer.tree.x} w=${drawer.tree.w}`);
  check('手机 390 · 抽屉遮罩可点', drawer.scrim.pe === 'auto' && drawer.scrim.display !== 'none', `pe=${drawer.scrim.pe}`);

  await evalJs(`document.getElementById('treeScrim').click(); true`);
  await sleep(500);
  const closed = await geometry();
  check('手机 390 · 遮罩点击后树退场', closed.tree.x + closed.tree.w <= 0, `right=${closed.tree.x + closed.tree.w}`);

  await evalJs(`document.querySelector('.msg-detail__head').click(); true`);
  await sleep(500);
  const opened = await geometry();
  check('手机 390 · 详情展开后 > 180px', opened.detail.h > 180, `${opened.detail.h}px`);
} catch (err) {
  check('执行过程未抛异常', false, err instanceof Error ? err.message : String(err));
} finally {
  clearInterval(timer);
  try {
    ws?.close();
  } catch {
    /* 忽略 */
  }
  try {
    appProc.kill();
  } catch {
    /* 忽略 */
  }
  await sleep(400);
  await new Promise((r) => server.close(r));
  broker.close();
}

/* ------------------------------ 输出报告 ------------------------------ */

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.name}${r.detail ? `  ${r.detail}` : ''}`);
}
console.log(`\n== 几何断言：${results.length - failed.length} 通过 / ${failed.length} 失败 ==`);
if (failed.length) {
  console.error('\n失败项：');
  for (const f of failed) console.error(`  · ${f.name}  ${f.detail ?? ''}`);
  exitCode = 1;
}
process.exit(exitCode);
