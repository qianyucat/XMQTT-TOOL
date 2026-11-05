/**
 * 本地开发 Broker（可选）
 * ------------------------------------------------------------------
 * 用 aedes 在 127.0.0.1:1883 起一个真实 broker，并周期性发布几类典型报文：
 *   - 文本状态      factory/line1/robot/status
 *   - JSON 控制帧   protocol/trackless/robot/control   （结构参照产线 MQTT 帧）
 *   - 数值遥测      sensor/temp/1 .. 3
 *   - 保留消息      factory/line1/config
 *
 * 用途：没有外网、也没有现场设备时，用来验证「订阅 / 主题扫描 / JSON 格式化 /
 * 模板发布」这些功能是否正常。
 *
 * 用法：
 *   node tools/dev-broker.mjs            启动并持续发布模拟数据
 *   node tools/dev-broker.mjs --quiet    只起 broker，不自动发布
 *   node tools/dev-broker.mjs --port=1884
 */

import { createServer } from 'node:net';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Aedes = require('aedes');

const argv = process.argv.slice(2);
const QUIET = argv.includes('--quiet');
const PORT = Number((argv.find((a) => a.startsWith('--port=')) || '').split('=')[1]) || 1883;
const HOST = '127.0.0.1';

const broker = new Aedes();
const server = createServer(broker.handle);

server.listen(PORT, HOST, () => {
  console.log(`[dev-broker] aedes 已监听 mqtt://${HOST}:${PORT}`);
  if (QUIET) {
    console.log('[dev-broker] --quiet 模式：不自动发布模拟数据');
  } else {
    console.log('[dev-broker] 开始周期发布模拟数据（Ctrl+C 退出）');
  }
});

broker.on('client', (client) => {
  console.log(`[dev-broker] 客户端接入: ${client.id}`);
});
broker.on('clientDisconnect', (client) => {
  console.log(`[dev-broker] 客户端断开: ${client.id}`);
});
broker.on('subscribe', (subscriptions, client) => {
  const topics = subscriptions.map((s) => `${s.topic}(q${s.qos})`).join(', ');
  console.log(`[dev-broker] ${client?.id} 订阅: ${topics}`);
});
broker.on('publish', (packet, client) => {
  // client 为空表示 broker 自身发布的模拟数据，不打印以免刷屏
  if (client) console.log(`[dev-broker] ${client.id} 发布: ${packet.topic} (${packet.payload.length} B)`);
});

/* ------------------------------------------------------------------ */
/* 模拟数据                                                            */
/* ------------------------------------------------------------------ */

function publish(topic, payload, opts = {}) {
  broker.publish(
    {
      cmd: 'publish',
      topic,
      payload: Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)),
      qos: opts.qos ?? 0,
      retain: !!opts.retain,
    },
    () => {}
  );
}

// 保留消息：新订阅者一连上就能收到，用来演示 retain 语义
publish('factory/line1/config', JSON.stringify({ line: 1, speed: 0.8, mode: 'auto' }), { retain: true });

if (!QUIET) {
  let tick = 0;

  setInterval(() => {
    tick += 1;

    publish('factory/line1/robot/status', tick % 2 === 0 ? 'RUNNING' : 'IDLE');

    publish('protocol/trackless/robot/control', {
      Control: {
        KeyCtrl: { KeyCount: 831, KeyId: 67108920, KeyStatus: 1 },
        Cmd: {},
      },
      FeedbackAbnormal: {},
      Param: {},
      Status: { OnlineStatus: true },
      System: { HardwareVersion: '' },
    });

    for (const i of [1, 2, 3]) {
      publish(`sensor/temp/${i}`, JSON.stringify({ value: (20 + Math.random() * 8).toFixed(2), unit: 'C', ts: Date.now() }));
    }

    if (tick % 5 === 0) {
      publish('factory/line1/robot/heartbeat', String(Date.now()));
    }
  }, 2000);

  console.log('[dev-broker] 模拟主题:');
  console.log('  factory/line1/robot/status      文本状态');
  console.log('  protocol/trackless/robot/control  JSON 控制帧');
  console.log('  sensor/temp/1..3                 JSON 遥测');
  console.log('  factory/line1/config             保留消息');
}

const shutdown = () => {
  console.log('\n[dev-broker] 正在关闭…');
  server.close(() => {
    broker.close();
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
