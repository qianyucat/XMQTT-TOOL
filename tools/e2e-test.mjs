/**
 * 端到端测试（真实 Electron 窗口 + 真实 broker）
 * ------------------------------------------------------------------
 * 为什么需要它：Manager 层单测覆盖不到「渲染层 → preload → IPC → 主进程 → broker →
 * 回推 → 渲染层」这条完整链路。历史上的 IPC 断链（通道名不一致、返回值解包错误、
 * 事件没订阅上）恰好只会在这条链路上暴露。
 *
 * 实现方式：给 Electron 开一个 DevTools 端口，用 CDP 在真实页面上下文里驱动 DOM
 * （点按钮、填输入框），再用 DOM 状态做断言 —— 走的是应用自己的事件处理函数，
 * 与人工点击等价，但可重复、可回归。
 *
 * 阶段 5 的两处改造（ADR-05）：
 *
 * 1. **观察走 `window.__xmqtt`**：`getState()` / `selectors.*` / `actions`。
 *    不再碰 `window.X.views.*` 这种内部对象 —— 那是实现细节，重构必然漂移。
 * 2. **选择器走 `data-testid`**：class 会随样式重构改名，testid 不会。
 *
 * 还有一个必须注意的坑：**表单是受控组件**（值存在 zustand 里），
 * 直接 `input.value = 'x'` 只改 DOM、不进 store，点「发布」发出去的还是旧值。
 * 所以下面统一用 `type()` / `pick()`，它们先调原生 setter 再派发 input/change，
 * React 才会收到 onChange。这是受控输入的定义，不是取巧。
 *
 * 隔离性：通过 XMQTT_USER_DATA 指向临时目录，不触碰用户真实配置。
 *
 * 用法：node tools/e2e-test.mjs
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/*
 * aedes 导出形态跨版本不一致（0.x 是构造函数，1.x 是 { Aedes, default }），
 * 这里统一抹平，避免换环境装出来的版本直接把测试打死。
 */
const aedesMod = require('aedes');
const Aedes = typeof aedesMod === 'function' ? aedesMod : aedesMod.Aedes || aedesMod.default;
const WebSocket = require('ws');
const { requireElectronExe } = require('./lib/electron-path.js');

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const BROKER_PORT = 18833;
const CDP_PORT = 9223;
const USER_DATA = path.join(os.tmpdir(), 'xmqtt-e2e-userdata');
const SHOT_DIR = path.join(os.tmpdir(), 'xmqtt-e2e-shots');

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? `  ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 页面内的操作片段                                                     */
/* ------------------------------------------------------------------ */

const j = (v) => JSON.stringify(v);

/** 往受控输入框 / 下拉框写值：先走原生 setter，再派发 React 认的事件 */
function type(selector, value) {
  return `(() => {
    const el = document.querySelector(${j(selector)});
    if (!el) throw new Error('找不到元素 ' + ${j(selector)});
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
                : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
                : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${j(String(value))});
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    return true;
  })()`;
}

const click = (selector) => `(() => {
  const el = document.querySelector(${j(selector)});
  if (!el) throw new Error('找不到元素 ' + ${j(selector)});
  if (el.disabled) throw new Error('元素处于禁用态 ' + ${j(selector)});
  el.click();
  return true;
})()`;

const text = (selector) => `(document.querySelector(${j(selector)}) || {}).textContent`;
const count = (selector) => `document.querySelectorAll(${j(selector)}).length`;
const nav = (view) => click(`.rail__item[data-view="${view}"]`);

/* ------------------------------------------------------------------ */
/* CDP 通道                                                            */
/* ------------------------------------------------------------------ */

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
          reject(new Error(`CDP 调用超时: ${method}`));
        }
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
    } catch { /* 还没起来，继续等 */ }
    await sleep(500);
  }
  throw new Error('等待 DevTools 端口超时');
}

/** 在页面里执行表达式并取回 JSON 值 */
async function evalJs(cdp, expression) {
  const res = await cdp('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    const detail = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
    throw new Error(`页面执行出错: ${detail}`);
  }
  return res.result?.value;
}

/** 轮询直到表达式返回真值 */
async function waitUntil(cdp, expression, label, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evalJs(cdp, expression);
    if (last) return last;
    await sleep(250);
  }
  throw new Error(`等待超时: ${label}（最后取值 ${JSON.stringify(last)}）`);
}

async function screenshot(cdp, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const res = await cdp('Page.captureScreenshot', { format: 'png' });
  const file = path.join(SHOT_DIR, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
  return file;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  console.log('== XMQTT Tool 端到端测试 ==\n');

  /* ---------------- 准备隔离环境 ---------------- */
  fs.rmSync(USER_DATA, { recursive: true, force: true });
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.writeFileSync(
    path.join(USER_DATA, 'xmqtt-config.json'),
    JSON.stringify({
      version: 1,
      servers: [
        {
          id: 'e2e-server',
          name: 'E2E 测试 Broker',
          protocol: 'mqtt',
          host: '127.0.0.1',
          port: BROKER_PORT,
          clientId: 'xmqtt-e2e',
          protocolVersion: 4,
          keepalive: 30,
          connectTimeout: 5000,
          reconnectPeriod: 1000,
          clean: true,
          autoReconnect: true,
          rejectUnauthorized: true,
        },
      ],
      templates: [],
      publishHistory: [],
      settings: { theme: 'dark', autoScroll: true, lastServerId: 'e2e-server' },
    }),
    'utf8'
  );

  /* ---------------- 启动 broker ---------------- */
  const broker = new Aedes();
  const server = createServer(broker.handle);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(BROKER_PORT, '127.0.0.1', resolve);
  });
  console.log(`[broker] aedes 监听 127.0.0.1:${BROKER_PORT}`);

  const brokerClients = [];
  broker.on('client', (c) => brokerClients.push(c.id));

  /* ---------------- 启动应用 ---------------- */
  // 主进程是 TS（阶段 6），electron 读 dist/main/main.js，起窗口前先编一次
  await require('./lib/build-main.js').ensureMainBuild({ quiet: true });
  const electronExe = requireElectronExe(ROOT);
  const env = { ...process.env, XMQTT_USER_DATA: USER_DATA };
  delete env.ELECTRON_RUN_AS_NODE;

  const appProc = spawn(
    electronExe,
    [
      ROOT,
      '--no-sandbox',
      '--disable-gpu',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${path.join(USER_DATA, 'chromium')}`,
    ],
    { cwd: os.tmpdir(), env, stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let appLog = '';
  appProc.stdout.on('data', (d) => { appLog += d.toString(); });
  appProc.stderr.on('data', (d) => { appLog += d.toString(); });

  let ws;
  try {
    const page = await waitForCdp(CDP_PORT);
    console.log(`[app] 窗口已就绪: ${page.title}`);

    ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const cdp = makeCdp(ws);

    await cdp('Runtime.enable');
    await cdp('Page.enable');

    /* ---------------- 1. 渲染层引导 ---------------- */
    const bootOk = await waitUntil(cdp, `!!window.__xmqtt && !!window.__xmqtt.api`, '页面脚本加载');
    check('渲染层脚本加载完成（测试门面已就位）', bootOk === true);

    const railCount = await evalJs(cdp, count('.rail__item'));
    check('左侧导航渲染 4 个视图入口（订阅与扫描已合并）', railCount === 4, `实际 ${railCount}`);

    // boot() 是异步的：导航立刻就绪，但服务器下拉要等主进程返回配置
    const serverOptions = await waitUntil(
      cdp,
      `document.querySelector('[data-testid="server-select"]').options.length`,
      '服务器配置从主进程载入'
    );
    check('服务器配置从主进程载入', serverOptions === 1, `${serverOptions} 项`);

    /* ---------------- 2. 连接 ---------------- */
    await evalJs(cdp, click('[data-testid="connect"]'));
    await waitUntil(cdp, `__xmqtt.selectors.activeConn()?.status === 'connected'`, '建立 MQTT 连接');

    const connState = await evalJs(
      cdp,
      `(() => { const c = __xmqtt.selectors.activeConn(); return { status: c.status, url: c.url }; })()`
    );
    check('点击「连接」后状态变为已连接', connState.status === 'connected', connState.url);
    check('broker 侧看到客户端接入', brokerClients.includes('xmqtt-e2e'), brokerClients.join(','));

    const statusText = await evalJs(cdp, `document.querySelector('#connStatus .conn-status__text').textContent`);
    check('顶部状态条显示「已连接」', statusText === '已连接', statusText);

    /* ---------------- 3. 订阅 ---------------- */
    await evalJs(cdp, nav('browser'));
    await evalJs(cdp, type('[data-testid="sub-topic"]', 'e2e/+/data'));
    await evalJs(cdp, type('[data-testid="sub-qos"]', '1'));
    await evalJs(cdp, click('[data-testid="sub-add"]'));
    await waitUntil(cdp, `__xmqtt.selectors.activeConn().subscriptions.length === 1`, '订阅写入');

    const subTopic = await evalJs(cdp, `__xmqtt.selectors.activeConn().subscriptions[0].topic`);
    check('订阅 e2e/+/data 成功', subTopic === 'e2e/+/data', subTopic);

    const subItem = await evalJs(cdp, count('[data-testid="sub-item"]'));
    check('已订阅列表渲染出条目', subItem === 1, `${subItem} 条`);

    /* ---------------- 4. 发布 + 回环接收 ---------------- */
    await evalJs(cdp, nav('publish'));
    await evalJs(cdp, type('[data-testid="pub-topic"]', 'e2e/a/data'));
    await evalJs(cdp, type('[data-testid="pub-qos"]', '1'));
    await evalJs(cdp, type('[data-testid="pub-payload"]', '{"hello":"xmqtt"}'));
    await evalJs(cdp, click('[data-testid="pub-send"]'));

    /*
     * 先切回订阅页再断言消息表：本视图隐藏时容器高度为 0，
     * 虚拟列表一行都不渲染（5000 行不拖慢其它页面的原因）。
     * 所以「消息到达」的观察点必须在它可见的时候。
     */
    await evalJs(cdp, nav('browser'));
    await waitUntil(cdp, `document.querySelectorAll('[data-testid="msg-row"]').length >= 1`, '消息进入表格');

    const msgRow = await evalJs(
      cdp,
      `(() => {
         const tr = document.querySelector('[data-testid="msg-row"]');
         const tds = [...tr.querySelectorAll('td')].map(td => td.textContent);
         return { topic: tds[3], qos: tds[1], preview: tds[5] };
       })()`
    );
    check('发布的消息经 broker 回环并落入消息表', msgRow.topic === 'e2e/a/data', JSON.stringify(msgRow));
    check('消息表显示 QoS', msgRow.qos === '1', msgRow.qos);
    check('消息表显示内容预览', msgRow.preview.includes('hello'), msgRow.preview);

    /* ---------------- 5. 消息详情 ---------------- */
    await evalJs(cdp, click('[data-testid="msg-row"]'));
    const detailTopic = await evalJs(cdp, text('[data-testid="detail-topic"]'));
    check('点击消息行后详情面板显示主题', String(detailTopic).includes('e2e/a/data'), detailTopic);

    await evalJs(cdp, click('[data-testid="detail-format"]'));
    const detailHtml = await evalJs(cdp, `document.querySelector('[data-testid="detail-payload"]').innerHTML`);
    check('JSON 格式化产生语法着色', detailHtml.includes('tok-key'), detailHtml.slice(0, 60));

    /* ---------------- 6. 主题工作台：扫描 → 点主题即订阅 ---------------- */
    await evalJs(cdp, nav('browser'));
    await evalJs(cdp, click('[data-testid="scan-start"]'));
    await waitUntil(cdp, `__xmqtt.selectors.activeConn().scan.active === true`, '扫描启动');

    // 从 broker 侧注入多个主题，模拟现场设备的真实流量
    const inject = (topic, payload) =>
      broker.publish({ cmd: 'publish', topic, payload: Buffer.from(payload), qos: 0, retain: false }, () => {});
    for (const t of ['e2e/a/data', 'e2e/b/data', 'plant/line2/robot/status', 'plant/line2/robot/cmd']) {
      inject(t, 'x');
    }

    await waitUntil(cdp, `__xmqtt.getState().topics.size >= 4`, '主题收集');
    const topicCount = await evalJs(cdp, `__xmqtt.getState().topics.size`);
    check('主题扫描收集到注入的全部主题', topicCount >= 4, `${topicCount} 个`);

    // 主题渲染带 400ms 合并窗口（扫描期每秒可能涌入上千个新主题），断言必须等它落地
    const treeRows = await waitUntil(
      cdp,
      `(() => { const n = document.querySelectorAll('[data-testid="topic-tree"] [data-testid="tree-row"]').length; return n >= 4 ? n : 0; })()`,
      '主题树渲染'
    );
    check('主题树按层级渲染出行', treeRows >= 4, `${treeRows} 行`);

    const badge = await waitUntil(
      cdp,
      `(() => { const t = document.querySelector('#railTopicCount').textContent; return Number(t) >= 4 ? t : 0; })()`,
      '导航角标更新'
    );
    check('导航角标显示主题数', Number(badge) >= 4, badge);

    /* ---- 6b. 折叠 / 展开（边界：树上千节点时的核心交互） ---- */
    const parentRow = await evalJs(
      cdp,
      `(() => {
         const rows = [...document.querySelectorAll('[data-testid="topic-tree"] [data-testid="tree-row"]')];
         const row = rows.find(r => r.dataset.topic === 'plant/line2');
         return row ? row.dataset.topic : null;
       })()`
    );
    check('主题树含可折叠的中间节点', parentRow === 'plant/line2', String(parentRow));

    const rowsBeforeCollapse = await evalJs(cdp, count('[data-testid="tree-row"]'));
    await evalJs(
      cdp,
      `(() => {
         const row = [...document.querySelectorAll('[data-testid="tree-row"]')].find(r => r.dataset.topic === 'plant/line2');
         row.click();
         return true;
       })()`
    );
    await sleep(200);
    const rowsAfterCollapse = await evalJs(cdp, count('[data-testid="tree-row"]'));
    check('点击中间节点折叠子树', rowsAfterCollapse < rowsBeforeCollapse, `${rowsBeforeCollapse} → ${rowsAfterCollapse}`);

    await evalJs(
      cdp,
      `(() => {
         const row = [...document.querySelectorAll('[data-testid="tree-row"]')].find(r => r.dataset.topic === 'plant/line2');
         row.click();
         return true;
       })()`
    );
    await sleep(200);
    const rowsRestored = await evalJs(cdp, count('[data-testid="tree-row"]'));
    check('再次点击展开子树', rowsRestored === rowsBeforeCollapse, `${rowsRestored} 行`);

    /* ---- 6c. 点主题行即订阅（合并视图的核心交互） ---- */
    const subsBefore = await evalJs(cdp, `__xmqtt.selectors.userSubs().length`);
    await evalJs(
      cdp,
      `(() => {
         const rows = [...document.querySelectorAll('[data-testid="topic-tree"] .tree-row--leaf')];
         const target = rows.find(r => r.dataset.topic === 'plant/line2/robot/status');
         if (!target) throw new Error('没找到目标主题行');
         target.click();
         return true;
       })()`
    );
    await waitUntil(
      cdp,
      `__xmqtt.selectors.userSubs().some(s => s.topic === 'plant/line2/robot/status')`,
      '点主题行完成订阅'
    );
    const subsAfter = await evalJs(cdp, `__xmqtt.selectors.userSubs().length`);
    check('点击主题行直接订阅该主题', subsAfter === subsBefore + 1, `${subsBefore} → ${subsAfter}`);

    const markedSubscribed = await waitUntil(
      cdp,
      `!!document.querySelector('[data-testid="topic-tree"] .tree-row.is-subscribed[data-topic="plant/line2/robot/status"]')`,
      '已订阅标记'
    );
    check('已订阅的主题行有视觉标记', markedSubscribed === true);

    await evalJs(cdp, click('[data-testid="scan-stop"]'));
    await waitUntil(cdp, `__xmqtt.selectors.activeConn().scan.active === false`, '扫描停止');
    check('停止扫描后状态复位', true);

    /* ---------------- 7. 消息过滤（边界：过滤后 0 行 / 恢复） ---------------- */
    await evalJs(cdp, type('[data-testid="msg-filter"]', 'no-such-topic-xyz'));
    await sleep(200);
    const filteredRows = await evalJs(cdp, count('[data-testid="msg-row"]'));
    check('无关关键字把消息表过滤成空', filteredRows === 0, `${filteredRows} 行`);

    await evalJs(cdp, type('[data-testid="msg-filter"]', ''));
    await sleep(200);
    const restoredRows = await evalJs(cdp, count('[data-testid="msg-row"]'));
    check('清空关键字后消息行恢复', restoredRows >= 1, `${restoredRows} 行`);

    /* ---------------- 8. 消息模板（含弹层取消） ---------------- */
    await evalJs(cdp, nav('publish'));
    await evalJs(cdp, type('[data-testid="pub-topic"]', 'e2e/saved'));
    await evalJs(cdp, type('[data-testid="pub-payload"]', 'saved-payload'));

    // 8a. 先验一次「取消」：弹层要能被 Esc 正常关掉，且不产生模板
    await evalJs(cdp, click('[data-testid="pub-save-template"]'));
    await waitUntil(cdp, `!!document.querySelector('[data-testid="dialog"]')`, '模板命名弹层');
    await evalJs(cdp, `document.querySelector('[data-testid="dialog-cancel"]').click(); true`);
    await waitUntil(cdp, `!document.querySelector('[data-testid="dialog"]')`, '弹层关闭');
    check('取消命名不会写入模板', (await evalJs(cdp, `__xmqtt.getState().templates.length`)) === 0);

    // 8b. 正常保存
    await evalJs(cdp, click('[data-testid="pub-save-template"]'));
    await waitUntil(cdp, `!!document.querySelector('[data-testid="dialog-input"]')`, '模板命名输入框');
    await evalJs(cdp, type('[data-testid="dialog-input"]', 'E2E 模板'));
    await evalJs(cdp, click('[data-testid="dialog-confirm"]'));
    await waitUntil(cdp, `document.querySelectorAll('[data-testid="template-item"]').length >= 1`, '模板保存');
    const tplTitle = await evalJs(cdp, text('[data-testid="template-item"] .list-item__title'));
    check('消息模板可保存并出现在列表', tplTitle === 'E2E 模板', tplTitle);

    /* ---------------- 9. 日志 ---------------- */
    await evalJs(cdp, nav('log'));
    const logRows = await evalJs(cdp, count('[data-testid="log-row"]'));
    check('日志面板记录了操作', logRows > 0, `${logRows} 条`);

    /* ---------------- 10. 状态页 ---------------- */
    await evalJs(cdp, nav('status'));
    const statCards = await evalJs(cdp, count('[data-testid="stat"]'));
    check('状态页渲染统计卡片', statCards >= 6, `${statCards} 张`);

    const subRows = await evalJs(cdp, count('[data-testid="status-sub-row"]'));
    check('状态页列出当前订阅', subRows >= 1, `${subRows} 行`);

    /* ---------------- 11. 扫描进行中断开：状态必须复位 ---------------- */
    await evalJs(cdp, nav('browser'));
    await evalJs(cdp, click('[data-testid="scan-start"]'));
    await waitUntil(cdp, `__xmqtt.selectors.activeConn().scan.active === true`, '扫描重新启动');

    await evalJs(cdp, click('[data-testid="disconnect"]'));
    await waitUntil(cdp, `__xmqtt.selectors.activeConn().status === 'disconnected'`, '断开连接');
    check('断开后状态回落到未连接', true);
    check(
      '扫描进行中断开后 active 复位（不残留「扫描中」）',
      (await evalJs(cdp, `__xmqtt.selectors.activeConn().scan.active === false`)) === true
    );

    /* ---------------- 11b. 断开后需要连接的功能应一律变灰 ---------------- */
    const offline = await evalJs(
      cdp,
      `(() => ({
         bodyOffline: document.body.classList.contains('is-offline'),
         subAdd: document.querySelector('[data-testid="sub-add"]').disabled,
         scanStart: document.querySelector('[data-testid="scan-start"]').disabled,
         scanStop: document.querySelector('[data-testid="scan-stop"]').disabled,
         pubSend: document.querySelector('[data-testid="pub-send"]').disabled,
         subTopicEditable: !document.querySelector('[data-testid="sub-topic"]').disabled
       }))()`
    );
    check('断开后 body 进入离线态', offline.bodyOffline === true);
    check(
      '订阅 / 扫描 / 发布 按钮全部禁用',
      offline.subAdd && offline.scanStart && offline.scanStop && offline.pubSend,
      JSON.stringify(offline)
    );
    check('主题输入框仍可编辑（允许先写好再连接）', offline.subTopicEditable === true);

    /* ---------------- 12. 掉线重连时仍可主动断开 ---------------- */
    // 现场最常见的场景：broker 地址不通（地址填错 / 设备没上电）。此时客户端会一直
    // 自动重连，如果「断开」被当成忙状态禁用，用户就只能关窗口才能停下来。
    await evalJs(
      cdp,
      `(async () => {
         const list = await __xmqtt.api.saveServer({
           id: 'e2e-dead', name: '不可达 broker', protocol: 'mqtt',
           host: '127.0.0.1', port: 18899, clientId: 'xmqtt-dead',
           autoReconnect: true, reconnectPeriod: 400, connectTimeout: 1200
         });
         __xmqtt.actions().setServers(list);
         __xmqtt.actions().setSelectedServer('e2e-dead');
         return document.querySelector('[data-testid="server-select"]').value;
       })()`
    );
    await evalJs(cdp, click('[data-testid="connect"]'));
    await waitUntil(
      cdp,
      `(() => { const s = __xmqtt.selectors.activeConn()?.status; return s === 'reconnecting' || s === 'error'; })()`,
      '进入重连/错误态'
    );

    const disconnectEnabled = await evalJs(
      cdp,
      `document.querySelector('[data-testid="disconnect"]').disabled === false`
    );
    check('连接不可达时「断开」仍可点击', disconnectEnabled === true);

    await evalJs(cdp, click('[data-testid="disconnect"]'));
    await waitUntil(cdp, `__xmqtt.selectors.activeConn().status === 'disconnected'`, '手动停止重连');
    check('点击后能停掉自动重连', true);

    /* ---------------- 截图留档 ---------------- */
    const shot = await screenshot(cdp, 'e2e-final');
    console.log(`\n[shot] 截图: ${shot}`);
  } catch (err) {
    failed += 1;
    console.error(`\n测试中断: ${err.message}`);
    if (appLog) console.error('--- 应用输出 ---\n' + appLog.slice(-2000));
  } finally {
    try { ws?.close(); } catch { /* 忽略 */ }
    try { appProc.kill(); } catch { /* 忽略 */ }
    await sleep(600);
    await new Promise((r) => server.close(r));
    broker.close();
  }

  console.log(`\n== 结果：${passed} 通过 / ${failed} 失败 ==`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('测试异常:', err);
  process.exit(1);
});
