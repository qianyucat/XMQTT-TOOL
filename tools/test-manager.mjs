/**
 * MqttManager 功能测试
 * ------------------------------------------------------------------
 * MqttManager 刻意不依赖 Electron（只用 node:events + mqtt），所以可以直接用 node 跑，
 * 不必启动 GUI。这里覆盖调试工具真正依赖的能力：连接状态机、订阅/退订、发布、
 * 静音、编码切换、主题扫描。
 *
 * 阶段 6 起源码是 TS，被测对象是 `dist/main/mqtt-manager.js`（esbuild 逐文件编译的产物）。
 * 之所以能这么测，是因为 build-main 用 `bundle: false`：
 * mqtt-manager.js 独立成文件，没被揉进 main.js，require 它不会把 electron 拉进来。
 *
 * 用法：node tools/test-manager.mjs
 */

import { createServer } from 'node:net';
import { once } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// 先把主进程编译出来，再 require 产物，避免测到上一次的旧代码
await require('./lib/build-main.js').ensureMainBuild({ quiet: true });

/*
 * aedes 的导出形态跨版本不一致：
 *   - 老版（0.x）：module.exports = Aedes（直接是构造函数）
 *   - 新版（1.x）：exports = { Aedes, default, __esModule }
 * 两种都要认，否则换个环境装出来就 `Aedes is not a constructor`。
 */
const aedesMod = require('aedes');
const Aedes = typeof aedesMod === 'function' ? aedesMod : aedesMod.Aedes || aedesMod.default;
const mqtt = require('mqtt');
const { MqttManager, topicMatches } = require('../dist/main/mqtt-manager.js');

const PORT = 18832;
const HOST = '127.0.0.1';
const CONN_ID = 'test-conn';

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

/** 等待 manager 抛出的某个事件满足条件 */
function waitFor(manager, event, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      manager.off(event, handler);
      reject(new Error(`等待事件 ${event} 超时`));
    }, timeoutMs);
    const handler = (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      manager.off(event, handler);
      resolve(payload);
    };
    manager.on(event, handler);
  });
}

async function main() {
  console.log('== MqttManager 功能测试 ==\n');

  const broker = new Aedes();
  const server = createServer(broker.handle);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, resolve);
  });
  console.log(`[broker] aedes 监听 ${HOST}:${PORT}\n`);

  const manager = new MqttManager();
  const collected = [];

  // Manager 的对外通道：消息批量、状态、主题增量、日志
  manager.on('messages', (batch) => collected.push(...batch));
  manager.on('status', () => {});
  manager.on('log', () => {});

  const external = mqtt.connect(`mqtt://${HOST}:${PORT}`, { clientId: 'external-pub', reconnectPeriod: 0 });
  await once(external, 'connect');

  try {
    /* ---------------- 0. 通配符匹配语义 ---------------- */
    check('+ 匹配单层', topicMatches('a/+/c', 'a/b/c'));
    check('+ 不跨层', topicMatches('a/+', 'a/b/c') === false);
    check('# 匹配剩余所有层级', topicMatches('a/#', 'a/b/c'));
    check('# 同时匹配父级自身', topicMatches('a/#', 'a'));
    check('精确主题匹配', topicMatches('a/b', 'a/b'));
    check('不同主题不匹配', topicMatches('a/b', 'a/c') === false);
    check('# 匹配全部', topicMatches('#', 'any/thing/here'));

    /* ---------------- 1. URL 与连接 ---------------- */
    check(
      'buildUrl 生成正确的连接串',
      MqttManager.buildUrl({ protocol: 'mqtt', host: 'broker.local', port: 1883 }) ===
        'mqtt://broker.local:1883',
      MqttManager.buildUrl({ protocol: 'mqtt', host: 'broker.local', port: 1883 })
    );
    check(
      'buildUrl 支持 WebSocket 路径',
      MqttManager.buildUrl({ protocol: 'ws', host: 'h', port: 8083, path: '/mqtt' }) === 'ws://h:8083/mqtt'
    );

    const connectP = waitFor(manager, 'status', (s) => s.id === CONN_ID && s.status === 'connected');
    manager.connect({ id: CONN_ID, name: 'test', protocol: 'mqtt', host: HOST, port: PORT, clean: true });
    await connectP;

    const state = manager.getState(CONN_ID);
    check('连接成功并进入 connected 状态', state.status === 'connected');
    check('连接串正确', state.url === `mqtt://${HOST}:${PORT}`, state.url);

    /* ---------------- 2. 订阅与接收 ---------------- */
    await manager.subscribe(CONN_ID, 'demo/+/value', 1);
    check('订阅写入状态表', manager.getState(CONN_ID).subscriptions.some((s) => s.topic === 'demo/+/value'));

    collected.length = 0;
    external.publish('demo/a/value', 'payload-A', { qos: 1 });
    await sleep(400);
    check('收到匹配主题的消息', collected.length === 1 && collected[0].payload === 'payload-A',
      collected.length ? `topic=${collected[0].topic} payload=${collected[0].payload}` : '没收到');

    /* ---------------- 3. 统计 ---------------- */
    const st = manager.getState(CONN_ID);
    check('统计收到消息数与字节数', st.stats.received >= 1 && st.stats.bytesIn > 0,
      `received=${st.stats.received} bytesIn=${st.stats.bytesIn}`);

    /* ---------------- 4. 静音 ---------------- */
    manager.setSubscriptionMuted(CONN_ID, 'demo/+/value', true);
    collected.length = 0;
    external.publish('demo/a/value', 'muted-payload', { qos: 0 });
    await sleep(400);
    check('静音后不再上报消息', collected.length === 0);

    manager.setSubscriptionMuted(CONN_ID, 'demo/+/value', false);
    collected.length = 0;
    external.publish('demo/a/value', 'unmuted', { qos: 0 });
    await sleep(400);
    check('取消静音后恢复上报', collected.length === 1);

    /* ---------------- 4b. 通配符订阅的编码设置要生效 ---------------- */
    manager.setSubscriptionEncoding(CONN_ID, 'demo/+/value', 'hex');
    collected.length = 0;
    external.publish('demo/a/value', 'AB', { qos: 0 });
    await sleep(400);
    check(
      '通配符订阅的编码设置生效（HEX）',
      collected.length === 1 && collected[0].payload === '41 42',
      collected.length ? `payload=${collected[0].payload}` : '没收到'
    );
    manager.setSubscriptionEncoding(CONN_ID, 'demo/+/value', 'utf8');

    /* ---------------- 5. 发布 ---------------- */
    const pubSub = mqtt.connect(`mqtt://${HOST}:${PORT}`, { clientId: 'verify-pub', reconnectPeriod: 0 });
    await once(pubSub, 'connect');
    const gotPub = new Promise((resolve) => {
      pubSub.on('message', (t, p) => resolve({ t, p: p.toString() }));
    });
    await new Promise((res, rej) => pubSub.subscribe('out/#', (e) => (e ? rej(e) : res())));

    const result = await manager.publish(CONN_ID, {
      topic: 'out/topic',
      payload: '{"n":1}',
      qos: 1,
      retain: false,
    });
    const received = await Promise.race([gotPub, sleep(3000).then(() => null)]);
    check('发布的消息被 broker 转发', received && received.p === '{"n":1}');
    check('发布返回字节数', result.bytes === 7, `bytes=${result.bytes}`);
    check('发布计入统计', manager.getState(CONN_ID).stats.published === 1);

    /* ---------------- 6. 十六进制发送 ---------------- */
    const gotHex = new Promise((resolve) => {
      pubSub.on('message', (t, p) => {
        if (t === 'out/hex') resolve(p.toString('hex'));
      });
    });
    await manager.publish(CONN_ID, { topic: 'out/hex', payload: '01 A0 FF', qos: 0, encoding: 'hex' });
    const hex = await Promise.race([gotHex, sleep(3000).then(() => null)]);
    check('HEX 编码发布得到正确字节', hex === '01a0ff', `实际=${hex}`);

    /* ---------------- 7. 主题扫描 ---------------- */
    await manager.startScan(CONN_ID, '#');
    check('扫描状态置为激活', manager.getState(CONN_ID).scan.active === true);

    const topicEvents = [];
    manager.on('topics', (e) => topicEvents.push(e));

    for (const t of ['scan/a/1', 'scan/a/2', 'scan/b/1']) {
      external.publish(t, 'x', { qos: 0 });
    }
    await sleep(600);

    const topics = manager.getCollected(CONN_ID).map((t) => t.topic);
    check('扫描收集到全部主题', topics.length === 3, `收集到 ${topics.length}: ${topics.join(',')}`);
    check('增量事件包含新增主题', topicEvents.some((e) => e.added && e.added.length > 0));

    await manager.stopScan(CONN_ID);
    const afterStop = manager.getState(CONN_ID);
    check('停止扫描后 active 复位', afterStop.scan.active === false);
    check('停止扫描后取消通配符订阅', !afterStop.subscriptions.some((s) => s.isScan));

    const keptTopics = manager.getCollected(CONN_ID).length;
    external.publish('scan/c/after-stop', 'x', { qos: 0 });
    await sleep(400);
    check('停止后不再收集新主题', manager.getCollected(CONN_ID).length === keptTopics);

    manager.clearCollected(CONN_ID);
    check('清空主题列表', manager.getCollected(CONN_ID).length === 0);

    /* ---------------- 8. 退订 ---------------- */
    await manager.unsubscribe(CONN_ID, 'demo/+/value');
    check('退订后订阅表移除', !manager.getState(CONN_ID).subscriptions.some((s) => s.topic === 'demo/+/value'));

    /* ---------------- 9. 错误分支 ---------------- */
    let dupErr = '';
    try {
      await manager.subscribe(CONN_ID, 'demo/+/value', 0);
      await manager.subscribe(CONN_ID, 'demo/+/value', 0);
    } catch (err) {
      dupErr = err.message;
    }
    check('重复订阅被拒绝', dupErr.includes('已订阅'), dupErr);

    let pubErr = '';
    try {
      await manager.publish(CONN_ID, { topic: '', payload: 'x' });
    } catch (err) {
      pubErr = err.message;
    }
    check('空主题发布被拒绝', pubErr.includes('主题'), pubErr);

    /* ---------------- 10. 断开 ---------------- */
    manager.disconnect(CONN_ID);
    check('断开后状态复位', manager.getState(CONN_ID).status === 'disconnected');
    check('断开后清理客户端引用', manager.getState(CONN_ID).config !== undefined);

    pubSub.end(true);
  } finally {
    external.end(true);
    manager.shutdown();
    await new Promise((r) => server.close(r));
    broker.close();
  }

  console.log(`\n== 结果：${passed} 通过 / ${failed} 失败 ==`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\n测试异常终止:', err);
  process.exit(1);
});
