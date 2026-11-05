/**
 * 界面截图生成
 * ------------------------------------------------------------------
 * 起一个本地 broker（周期性灌入贴近产线的模拟报文），用 CDP 驱动真实窗口走到
 * 「已连接 + 已有订阅 + 已收到消息 + 已扫描到主题」的状态，再逐视图截图。
 *
 * 产出用于交付说明与回归对比，也顺带验证「真实配置 + 真实数据」下的渲染效果。
 *
 * 用法：node tools/screenshots.mjs
 * 输出：screenshots/*.png
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/* aedes 0.x 导出构造函数、1.x 导出 { Aedes, default }，两种都认 */
const aedesMod = require('aedes');
const Aedes = typeof aedesMod === 'function' ? aedesMod : aedesMod.Aedes || aedesMod.default;
const WebSocket = require('ws');
const { requireElectronExe } = require('./lib/electron-path.js');

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT_DIR = path.join(ROOT, 'screenshots');
const BROKER_PORT = 18835;
const CDP_PORT = 9224;
const USER_DATA = path.join(os.tmpdir(), 'xmqtt-shot-userdata');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeCdp(ws) {
  let nextId = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
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
        if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP 超时: ${method}`)); }
      }, 20000);
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
    } catch { /* 继续等 */ }
    await sleep(400);
  }
  throw new Error('等待 DevTools 端口超时');
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.rmSync(USER_DATA, { recursive: true, force: true });
  fs.mkdirSync(USER_DATA, { recursive: true });

  fs.writeFileSync(
    path.join(USER_DATA, 'xmqtt-config.json'),
    JSON.stringify(
      {
        version: 1,
        servers: [
          {
            id: 'shot-server',
            name: '本地测试 Broker',
            protocol: 'mqtt',
            host: '127.0.0.1',
            port: BROKER_PORT,
            clientId: 'xmqtt-demo',
            protocolVersion: 4,
            keepalive: 60,
            connectTimeout: 8000,
            reconnectPeriod: 3000,
            clean: true,
            autoReconnect: true,
            rejectUnauthorized: true,
          },
        ],
        templates: [
          {
            id: 't1',
            name: '控制帧 · 按键',
            topic: 'protocol/trackless/robot/control',
            payload: '{\n  "Control": {\n    "KeyCtrl": {\n      "KeyCount": 831,\n      "KeyId": 67108920,\n      "KeyStatus": 1\n    }\n  }\n}',
            qos: 1,
            retain: false,
            encoding: 'utf8',
          },
          { id: 't2', name: '参数查询', topic: 'protocol/trackless/robot/info/param', payload: '{ "Param": {} }', qos: 0, retain: false, encoding: 'utf8' },
          { id: 't3', name: '切换运行模式', topic: 'factory/line1/mode', payload: 'auto', qos: 1, retain: true, encoding: 'utf8' },
        ],
        publishHistory: [],
        settings: { theme: 'dark', autoScroll: true, lastServerId: 'shot-server' },
      },
      null,
      2
    ),
    'utf8'
  );

  /* ---------------- broker + 模拟流量 ---------------- */
  const broker = new Aedes();
  const server = createServer(broker.handle);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(BROKER_PORT, '127.0.0.1', resolve);
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
    pub(
      'protocol/trackless/robot/control',
      JSON.stringify({
        Control: { KeyCtrl: { KeyCount: 831, KeyId: 67108920, KeyStatus: 1 }, Cmd: {} },
        FeedbackAbnormal: {},
        Param: {},
        Status: { OnlineStatus: true },
        System: { HardwareVersion: '' },
      })
    );
    for (const i of [1, 2, 3]) {
      pub(`sensor/temp/${i}`, JSON.stringify({ value: (20 + Math.random() * 8).toFixed(2), unit: 'C', ts: Date.now() }));
    }
    pub('protocol/trackless/robot/feedback/progress', JSON.stringify({ percent: Math.min(100, tick * 3) }));
  }, 1000);

  /* ---------------- 启动应用 ---------------- */
  // 主进程是 TS（阶段 6），electron 读 dist/main/main.js，截图前先编一次
  await require('./lib/build-main.js').ensureMainBuild({ quiet: true });
  const electronExe = requireElectronExe(ROOT);
  const env = { ...process.env, XMQTT_USER_DATA: USER_DATA };
  delete env.ELECTRON_RUN_AS_NODE;

  const appProc = spawn(
    electronExe,
    [ROOT, '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`],
    { cwd: os.tmpdir(), env, stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let ws;
  try {
    const page = await waitForCdp(CDP_PORT);
    ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

    const cdp = makeCdp(ws);
    await cdp('Runtime.enable');
    await cdp('Page.enable');

    const evalJs = async (expression) => {
      const res = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || 'eval 失败');
      return res.result?.value;
    };
    const waitUntil = async (expr, label, timeoutMs = 15000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evalJs(expr)) return true;
        await sleep(250);
      }
      throw new Error(`等待超时: ${label}`);
    };
    const shot = async (name) => {
      const res = await cdp('Page.captureScreenshot', { format: 'png' });
      const file = path.join(OUT_DIR, `${name}.png`);
      fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
      console.log(`  → ${path.relative(ROOT, file)}`);
    };

    /*
     * 受控输入：表单值存在 zustand 里，直接 `input.value = x` 只改 DOM 不进 store，
     * 后续点击（订阅 / 发布）拿到的还是旧值。必须先调原生 setter 再派发 input/change。
     */
    const typeInto = async (selector, value) => {
      await evalJs(
        `(() => {
           const el = document.querySelector(${JSON.stringify(selector)});
           if (!el) throw new Error('找不到元素 ' + ${JSON.stringify(selector)});
           const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
                       : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
                       : HTMLInputElement.prototype;
           Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))});
           el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
           return true;
         })()`
      );
    };
    const clickSel = (selector) => evalJs(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
    const nav = (view) => evalJs(`document.querySelector('.rail__item[data-view="${view}"]').click(); true`);

    // CDP 拿到的 target 可能在 DOM 尚未解析完时就连上了，先等页面骨架
    await waitUntil(`!!document.querySelector('#serverSelect') && !!window.__xmqtt`, '页面 DOM 就绪');
    await waitUntil(`document.querySelector('#serverSelect').options.length === 1`, '配置载入');
    const theme = await evalJs(`document.documentElement.dataset.theme`);
    console.log(`[shot] 当前主题: ${theme}`);

    // 连接 → 订阅 → 扫描
    await clickSel('[data-testid="connect"]');
    await waitUntil(`__xmqtt.selectors.activeConn()?.status === 'connected'`, '连接');

    await nav('browser');
    for (const [topic, qos] of [
      ['factory/#', '1'],
      ['protocol/#', '0'],
      ['sensor/+/temp', '0'],
    ]) {
      await typeInto('[data-testid="sub-topic"]', topic);
      await typeInto('[data-testid="sub-qos"]', qos);
      await clickSel('[data-testid="sub-add"]');
      await sleep(300);
    }

    await nav('browser');
    await clickSel('[data-testid="scan-start"]');
    await waitUntil(`__xmqtt.selectors.activeConn()?.scan.active === true`, '扫描启动');

    // 让模拟流量积累一会儿
    await sleep(7000);

    /* ---------------- 逐视图截图 ---------------- */
    console.log('[shot] 生成截图:');

    // 发布页：载入一个模板
    await nav('publish');
    await evalJs(`(() => {
      const item = document.querySelector('[data-testid="template-item"]');
      if (item) item.click();
      return true;
    })()`);
    await sleep(400);
    await shot('01-publish');

    // 主题工作台：扫描结果 + 已订阅 + 消息详情（合并后的主战场）
    await nav('browser');
    await sleep(400);
    // 从主题树里点一个主题订阅，展示「扫描 → 订阅 → 查看」的闭环
    await evalJs(
      `(() => {
         const rows = [...document.querySelectorAll('[data-testid="tree-row"].tree-row--leaf')];
         const target = rows.find(r => r.dataset.topic === 'factory/line1/robot/status') || rows[0];
         if (target) target.click();
         return true;
       })()`
    );
    await sleep(900);
    // 选中一条 JSON 消息并格式化
    await evalJs(
      `(() => {
         const rows = [...document.querySelectorAll('[data-testid="msg-row"]')];
         const jsonRow = rows.reverse().find(tr => tr.textContent.includes('KeyCtrl')) || rows[0];
         if (jsonRow) jsonRow.click();
         return true;
       })()`
    );
    await clickSel('[data-testid="detail-format"]');
    await sleep(500);
    await shot('02-browser');

    // 平铺模式
    await clickSel('[data-testid="scan-tree-mode"]');
    await sleep(500);
    await shot('03-browser-flat');
    await clickSel('[data-testid="scan-tree-mode"]');
    await sleep(300);

    // 状态页
    await nav('status');
    await sleep(400);
    await shot('04-status');

    // 日志页
    await nav('log');
    await sleep(400);
    await shot('05-log');

    /*
     * 弹层：服务器编辑器是唯一会遮住整窗的表单，字号 / 输入框边界 / 按钮层级
     * 在这块最容易和主界面走形，所以单独留一张。取消即回到原视图，不影响后续步骤。
     */
    await clickSel('[data-testid="server-new"]');
    await sleep(600);
    await shot('08-dialog');
    await clickSel('[data-testid="server-cancel"]');
    await sleep(300);

    // 浅色主题
    await nav('browser');
    await clickSel('[data-testid="theme"]');
    await sleep(500);
    const themeAfter = await evalJs(`document.documentElement.dataset.theme`);
    console.log(`[shot] 切换到: ${themeAfter}`);
    await shot('06-browser-light');

    // 切回深色，再看离线态
    await clickSel('[data-testid="theme"]');
    await sleep(300);

    // 离线态：扫描进行中断开，所有需要连接才能完成的动作整体变灰
    await clickSel('[data-testid="scan-start"]');
    await sleep(700);
    await clickSel('[data-testid="disconnect"]');
    await sleep(900);
    await shot('07-offline');

    const stats = await evalJs(
      `(() => ({
         messages: __xmqtt.getState().messages.length,
         topics: __xmqtt.getState().topics.size,
         subs: __xmqtt.selectors.userSubs().length,
         received: __xmqtt.selectors.activeConn().stats.received
       }))()`
    );
    console.log(`[shot] 数据量: ${JSON.stringify(stats)}`);

  } finally {
    clearInterval(timer);
    try { ws?.close(); } catch { /* 忽略 */ }
    try { appProc.kill(); } catch { /* 忽略 */ }
    await sleep(500);
    await new Promise((r) => server.close(r));
    broker.close();
  }

  console.log('\n截图完成。');
  process.exit(0);
}

main().catch((err) => {
  console.error('截图失败:', err);
  process.exit(1);
});
