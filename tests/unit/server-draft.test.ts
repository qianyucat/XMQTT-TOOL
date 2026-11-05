/**
 * 服务器配置的表单映射（`lib/server-draft.ts`）
 * ------------------------------------------------------------------
 * 这里全是「字符串 ↔ 数字/布尔」的边界转换，出错的样子很难看：
 * 端口变成 NaN、名称变成空白项、遗嘱存出半截配置。逐条钉住。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PORTS,
  EMPTY_DRAFT,
  buildServerConfig,
  shouldFollowProtocolPort,
  toDraft,
} from '../../src/renderer/lib/server-draft';

test('toDraft：null 返回默认草稿（且是副本）', () => {
  const draft = toDraft(null);
  assert.deepEqual(draft, EMPTY_DRAFT);
  assert.notEqual(draft, EMPTY_DRAFT);
});

test('toDraft：数字字段转字符串，布尔字段按「不是 false 就是 true」处理', () => {
  const draft = toDraft({
    id: 's1',
    name: '测试',
    host: '10.0.0.1',
    port: 8883,
    keepalive: 45,
    clean: false,
  });

  assert.equal(draft.port, '8883');
  assert.equal(draft.keepalive, '45');
  assert.equal(draft.clean, false);
  assert.equal(draft.autoReconnect, true); // undefined 视为默认开启
  assert.equal(draft.protocolVersion, '4');
});

test('toDraft：遗嘱字段摊平，未配置时是空串 / 0 / false', () => {
  const withWill = toDraft({
    host: 'h',
    port: 1,
    will: { topic: 'w/t', payload: 'bye', qos: 1, retain: true, encoding: 'utf8' },
  });
  assert.equal(withWill.willTopic, 'w/t');
  assert.equal(withWill.willQos, '1');
  assert.equal(withWill.willRetain, true);

  const without = toDraft({ host: 'h', port: 1 });
  assert.equal(without.willTopic, '');
  assert.equal(without.willQos, '0');
  assert.equal(without.willRetain, false);
});

test('buildServerConfig：数字字段按草稿解析', () => {
  const config = buildServerConfig(
    { ...EMPTY_DRAFT, name: 'A', host: '127.0.0.1', port: '1884', keepalive: '30' },
    's1'
  );

  assert.equal(config.id, 's1');
  assert.equal(config.port, 1884);
  assert.equal(config.keepalive, 30);
});

test('buildServerConfig：名称为空时回落到 host:port', () => {
  const config = buildServerConfig({ ...EMPTY_DRAFT, name: '   ', host: '10.0.0.9' }, null);
  assert.equal(config.name, '10.0.0.9:1883');
});

test('buildServerConfig：端口非法时回落到协议默认端口', () => {
  const empty = buildServerConfig({ ...EMPTY_DRAFT, port: '' }, null);
  assert.equal(empty.port, DEFAULT_PORTS.mqtt);

  const junk = buildServerConfig({ ...EMPTY_DRAFT, port: 'abc' }, null);
  assert.equal(junk.port, DEFAULT_PORTS.mqtt);

  const tls = buildServerConfig({ ...EMPTY_DRAFT, protocol: 'mqtts', port: '' }, null);
  assert.equal(tls.port, DEFAULT_PORTS.mqtts);
});

test('buildServerConfig：遗嘱主题为空时不存 will（避免半截配置）', () => {
  const config = buildServerConfig({ ...EMPTY_DRAFT, willTopic: '   ' }, null);
  assert.equal(config.will, undefined);
});

test('buildServerConfig：遗嘱主题非空时完整落地', () => {
  const config = buildServerConfig(
    {
      ...EMPTY_DRAFT,
      willTopic: ' w/t ',
      willPayload: 'offline',
      willQos: '2',
      willRetain: true,
    },
    null
  );

  assert.deepEqual(config.will, {
    topic: 'w/t',
    payload: 'offline',
    qos: 2,
    retain: true,
    encoding: 'utf8',
  });
});

test('shouldFollowProtocolPort：空格 / 0 / 上一协议的默认端口才跟随', () => {
  assert.equal(shouldFollowProtocolPort(''), true);
  assert.equal(shouldFollowProtocolPort('   '), true);
  assert.equal(shouldFollowProtocolPort('0'), true);
  assert.equal(shouldFollowProtocolPort('abc'), true);

  assert.equal(shouldFollowProtocolPort(String(DEFAULT_PORTS.mqtt)), true);
  assert.equal(shouldFollowProtocolPort(String(DEFAULT_PORTS.wss)), true);

  // 用户手改过的端口不能被协议切换覆盖
  assert.equal(shouldFollowProtocolPort('1999'), false);
});
