/**
 * 冒烟测试
 * ------------------------------------------------------------------
 * 用本机 aedes 起一个真实 broker，跑通「连接 → 订阅 → 发布 → 收到」的完整链路，
 * 顺带覆盖通配符、QoS 1、retain 这三个调试场景里最常用的行为。
 *
 * 目的：在没有外网、没有公共 broker 的环境里，验证 mqtt 依赖树被正确装配且可用。
 *
 * 用法：node tools/smoke-test.mjs
 * 前置：XMQTT_EXTRA_PACKAGES=aedes node tools/assemble-deps.mjs --only=packages
 */

import { createServer } from 'node:net';
import { once } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/* aedes 0.x 导出构造函数、1.x 导出 { Aedes, default }，两种都认 */
const aedesMod = require('aedes');
const Aedes = typeof aedesMod === 'function' ? aedesMod : aedesMod.Aedes || aedesMod.default;
const mqtt = require('mqtt');

const PORT = 18831;
const HOST = '127.0.0.1';

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

/** 等待某条消息，超时抛错 */
function waitMessage(client, predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('message', onMsg);
      reject(new Error('等待消息超时'));
    }, timeoutMs);

    const onMsg = (topic, payload, packet) => {
      if (!predicate(topic, payload.toString(), packet)) return;
      clearTimeout(timer);
      client.off('message', onMsg);
      resolve({ topic, payload: payload.toString(), packet });
    };

    client.on('message', onMsg);
  });
}

async function main() {
  console.log('== XMQTT Tool 冒烟测试 ==\n');

  /* -------------------- 启动本地 broker -------------------- */
  const broker = new Aedes();
  const server = createServer(broker.handle);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, resolve);
  });
  console.log(`[broker] aedes 已监听 ${HOST}:${PORT}\n`);

  const url = `mqtt://${HOST}:${PORT}`;

  try {
    /* -------------------- 1. 连接 -------------------- */
    const sub = mqtt.connect(url, { clientId: 'smoke-sub', clean: true, reconnectPeriod: 0 });
    const pub = mqtt.connect(url, { clientId: 'smoke-pub', clean: true, reconnectPeriod: 0 });

    await Promise.all([once(sub, 'connect'), once(pub, 'connect')]);
    check('两个客户端建立连接', sub.connected && pub.connected, url);

    /* -------------------- 2. 单层通配符 + 订阅 -------------------- */
    await new Promise((res, rej) =>
      sub.subscribe('test/+/data', { qos: 1 }, (err) => (err ? rej(err) : res()))
    );

    const wait1 = waitMessage(sub, (t) => t === 'test/a/data');
    pub.publish('test/a/data', 'hello-xmqtt', { qos: 1 });
    const msg1 = await wait1;
    check('单层通配符 test/+/data 收到消息', msg1.payload === 'hello-xmqtt', `payload=${msg1.payload}`);

    /* -------------------- 3. 不匹配的主题不应到达 -------------------- */
    let leaked = false;
    const onLeak = () => { leaked = true; };
    sub.on('message', onLeak);
    pub.publish('other/x/data', 'should-not-arrive', { qos: 0 });
    await new Promise((r) => setTimeout(r, 400));
    sub.off('message', onLeak);
    check('非匹配主题被正确过滤', !leaked);

    /* -------------------- 4. 多层通配符 + 主题收集 -------------------- */
    const collected = new Set();
    const scan = mqtt.connect(url, { clientId: 'smoke-scan', clean: true, reconnectPeriod: 0 });
    await once(scan, 'connect');
    scan.on('message', (t) => collected.add(t));
    await new Promise((res, rej) => scan.subscribe('#', { qos: 0 }, (err) => (err ? rej(err) : res())));

    const topics = ['factory/line1/robot/cmd', 'factory/line1/robot/status', 'sensor/temp/1', 'sensor/temp/2'];
    for (const t of topics) pub.publish(t, JSON.stringify({ topic: t }), { qos: 0 });
    await new Promise((r) => setTimeout(r, 600));
    check('通配符 # 收集到全部 4 个主题', collected.size === 4, `实际 ${collected.size} 个`);

    /* -------------------- 5. retain 消息 -------------------- */
    pub.publish('retain/check', 'retained-value', { qos: 1, retain: true });
    await new Promise((r) => setTimeout(r, 300));

    const late = mqtt.connect(url, { clientId: 'smoke-late', clean: true, reconnectPeriod: 0 });
    await once(late, 'connect');
    const waitRetain = waitMessage(late, (t) => t === 'retain/check');
    await new Promise((res, rej) => late.subscribe('retain/check', { qos: 1 }, (err) => (err ? rej(err) : res())));
    const retained = await waitRetain;
    check('retain 消息对后订阅者可见', retained.payload === 'retained-value', `payload=${retained.payload}`);

    /* -------------------- 6. JSON 解析（详情面板依赖） -------------------- */
    const waitJson = waitMessage(scan, (t) => t === 'json/check');
    pub.publish('json/check', JSON.stringify({ Control: { KeyCtrl: { KeyId: 67108920 } } }), { qos: 0 });
    const jsonMsg = await waitJson;
    let parsedOk = false;
    try {
      parsedOk = JSON.parse(jsonMsg.payload).Control.KeyCtrl.KeyId === 67108920;
    } catch { /* 保持 false */ }
    check('JSON 载荷可解析（格式化功能前置条件）', parsedOk);

    /* -------------------- 7. 退订 -------------------- */
    await new Promise((res, rej) => sub.unsubscribe('test/+/data', (err) => (err ? rej(err) : res())));
    let afterUnsub = false;
    const onAfter = (t) => { if (t === 'test/a/data') afterUnsub = true; };
    sub.on('message', onAfter);
    pub.publish('test/a/data', 'after-unsubscribe', { qos: 0 });
    await new Promise((r) => setTimeout(r, 400));
    sub.off('message', onAfter);
    check('退订后不再收到消息', !afterUnsub);

    /* -------------------- 清理 -------------------- */
    for (const c of [sub, pub, scan, late]) c.end(true);
  } finally {
    await new Promise((r) => server.close(r));
    broker.close();
  }

  console.log(`\n== 结果：${passed} 通过 / ${failed} 失败 ==`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\n冒烟测试异常终止:', err);
  process.exit(1);
});
