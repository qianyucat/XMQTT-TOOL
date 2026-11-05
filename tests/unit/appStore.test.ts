/**
 * 渲染层 store（`store/appStore.ts`）
 * ------------------------------------------------------------------
 * 只测**纯状态逻辑**：裁剪、增量合并、折叠、派生选择器。
 * 不测 DOM、不测 IPC —— 那些由 e2e 覆盖，混进来只会让这组用例变慢且脆弱。
 *
 * 每个用例前把 store 重置回初始快照：zustand 是模块级单例，
 * 用例之间串状态会让失败信息完全对不上号。
 */

import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_DRAFT,
  act,
  selectActiveConn,
  selectIsConnected,
  selectLogErrorCount,
  selectScanning,
  selectTopicCount,
  selectUserSubs,
  useAppStore,
} from '../../src/renderer/store/appStore';
import type { ConnectionState, LogEntry, MqttMessage, Subscription } from '../../src/shared/models';
import type { UiMessage } from '../../src/renderer/store/types';

const initial = useAppStore.getState();

beforeEach(() => {
  useAppStore.setState({ ...initial });
});

/* ------------------------------ 夹具 ------------------------------ */

function sub(topic: string, overrides: Partial<Subscription> = {}): Subscription {
  return {
    topic,
    qos: 0,
    muted: false,
    encoding: 'utf8',
    isScan: false,
    received: 0,
    subscribedAt: 0,
    ...overrides,
  };
}

function conn(overrides: Partial<ConnectionState> = {}): ConnectionState {
  return {
    id: 'c1',
    name: '本地',
    url: 'mqtt://127.0.0.1:1883',
    status: 'connected',
    error: null,
    config: { id: 'c1', host: '127.0.0.1', port: 1883 },
    uptimeMs: 0,
    lastMessageAt: null,
    stats: { received: 0, published: 0, bytesIn: 0, bytesOut: 0, connectedAt: null },
    scan: { active: false, filter: null, startedAt: null, collected: 0 },
    subscriptions: [],
    ...overrides,
  };
}

function msg(uid: number, topic = 'a/b'): UiMessage {
  const base: Omit<MqttMessage, 'topic'> = {
    connectionId: 'c1',
    payload: 'x',
    bytes: 1,
    qos: 0,
    retain: false,
    dup: false,
    ts: uid,
  };
  return { ...base, topic, uid };
}

function log(level: LogEntry['level'], message = 'm'): LogEntry {
  return { connectionId: 'c1', level, message, ts: 1 };
}

/* ---------------------------- 消息裁剪 ---------------------------- */

test('pushMessages：超过上限时从头部淘汰', () => {
  act().setMaxMessages(100); // 下限被夹到 100
  assert.equal(act().maxMessages, 100);

  act().pushMessages([msg(1), msg(2), msg(3)]);
  assert.equal(act().messages.length, 3);

  act().setMaxMessages(1000);
  const batch = Array.from({ length: 1200 }, (_, i) => msg(i + 10));
  act().pushMessages(batch);

  // 3 条旧的 + 1200 条新的 = 1203，裁到 1000 之后头部少了 203 条
  assert.equal(act().messages.length, 1000);
  assert.equal(act().messages[0].uid, 210);
  assert.equal(act().messages[999].uid, 1209);
});

test('pushMessages：空批次不产生新数组（避免无意义重渲染）', () => {
  act().pushMessages([msg(1)]);
  const before = act().messages;
  act().pushMessages([]);
  assert.equal(act().messages, before);
});

test('clearMessages：同时清掉选中项', () => {
  act().pushMessages([msg(1), msg(2)]);
  act().selectMessage(act().messages[0]);
  act().clearMessages();

  assert.equal(act().messages.length, 0);
  assert.equal(act().selectedMessage, null);
});

test('setMaxMessages：不允许把上限设成 0 以下', () => {
  act().setMaxMessages(10);
  assert.equal(act().maxMessages, 100);
});

/* ---------------------------- 日志裁剪 ---------------------------- */

test('pushLog：超过 2000 条后从头部淘汰', () => {
  for (let i = 0; i < 2100; i += 1) act().pushLog(log('info', `#${i}`));

  assert.equal(act().logs.length, 2000);
  assert.equal(act().logs[0].message, '#100');
  assert.equal(act().logs[1999].message, '#2099');
});

test('selectLogErrorCount：只数 error 级别', () => {
  act().pushLog(log('info'));
  act().pushLog(log('error'));
  act().pushLog(log('success'));
  act().pushLog(log('error'));

  assert.equal(selectLogErrorCount(act()), 2);
});

/* ---------------------------- 主题增量 ---------------------------- */

test('applyTopicDelta：新增并合并同主题的计数', () => {
  act().applyTopicDelta({
    connectionId: 'c1',
    total: 2,
    added: [
      { topic: 'a/b', count: 1, ts: 1 },
      { topic: 'a/c', count: 2, ts: 2 },
    ],
  });
  assert.equal(selectTopicCount(act()), 2);

  act().applyTopicDelta({ connectionId: 'c1', total: 2, added: [{ topic: 'a/b', count: 5, ts: 3 }] });
  assert.equal(selectTopicCount(act()), 2);
  assert.equal(act().topics.get('a/b')?.count, 5);
  assert.equal(act().topics.get('a/b')?.ts, 3);
});

test('applyTopicDelta：reset 清空重来', () => {
  act().applyTopicDelta({ connectionId: 'c1', total: 1, added: [{ topic: 'a', count: 1, ts: 1 }] });
  act().applyTopicDelta({ connectionId: 'c1', total: 0, added: [], reset: true });

  assert.equal(selectTopicCount(act()), 0);
});

test('applyTopicDelta：换新 Map 实例，订阅者才会收到通知', () => {
  const before = act().topics;
  act().applyTopicDelta({ connectionId: 'c1', total: 1, added: [{ topic: 'a', count: 1, ts: 1 }] });
  assert.notEqual(act().topics, before);
});

test('clearTopics：连带清空折叠态', () => {
  act().applyTopicDelta({ connectionId: 'c1', total: 1, added: [{ topic: 'a/b', count: 1, ts: 1 }] });
  act().toggleCollapsed('a');
  assert.equal(act().collapsedPaths.size, 1);

  act().clearTopics();
  assert.equal(act().collapsedPaths.size, 0);
});

test('toggleCollapsed：两次点击回到原状态', () => {
  act().toggleCollapsed('a/b');
  assert.equal(act().collapsedPaths.has('a/b'), true);
  act().toggleCollapsed('a/b');
  assert.equal(act().collapsedPaths.has('a/b'), false);
});

/* ---------------------------- 连接派生 ---------------------------- */

test('selectActiveConn / selectIsConnected：按 connectionId 取快照', () => {
  assert.equal(selectActiveConn(act()), null);
  assert.equal(selectIsConnected(act()), false);

  act().setConnectionId('c1');
  act().upsertConnection(conn());

  assert.equal(selectActiveConn(act())?.id, 'c1');
  assert.equal(selectIsConnected(act()), true);

  act().upsertConnection(conn({ status: 'reconnecting' }));
  assert.equal(selectIsConnected(act()), false);
});

test('upsertConnection：换新 Map 实例，同 id 覆盖旧值', () => {
  act().upsertConnection(conn());
  const before = act().connections;

  act().upsertConnection(conn({ status: 'error', error: 'ECONNREFUSED' }));

  assert.notEqual(act().connections, before);
  assert.equal(act().connections.size, 1);
  assert.equal(act().connections.get('c1')?.status, 'error');
});

test('selectUserSubs：过滤掉扫描用的旁路订阅', () => {
  act().setConnectionId('c1');
  act().upsertConnection(
    conn({
      subscriptions: [sub('a/#'), sub('#', { isScan: true }), sub('b/+', { muted: true })],
    })
  );

  assert.deepEqual(
    selectUserSubs(act()).map((s) => s.topic),
    ['a/#', 'b/+']
  );
});

test('selectScanning：跟着 scan.active 走', () => {
  act().setConnectionId('c1');
  act().upsertConnection(conn());
  assert.equal(selectScanning(act()), false);

  act().upsertConnection(
    conn({ scan: { active: true, filter: '#', startedAt: 1, collected: 0 } })
  );
  assert.equal(selectScanning(act()), true);
});

/* ---------------------------- 发布草稿 ---------------------------- */

test('setPublishDraft：局部更新，其余字段保持', () => {
  act().setPublishDraft({ topic: 'a/b', payload: 'x' });
  act().setPublishDraft({ qos: 2 });

  assert.deepEqual(act().publishDraft, { ...EMPTY_DRAFT, topic: 'a/b', payload: 'x', qos: 2 });
});

test('resetPublishDraft：回到初始值，且不复用同一个对象引用', () => {
  act().setPublishDraft({ topic: 'a/b' });
  act().resetPublishDraft();

  assert.deepEqual(act().publishDraft, EMPTY_DRAFT);
  assert.notEqual(act().publishDraft, EMPTY_DRAFT);
});

/* ---------------------------- 设置合并 ---------------------------- */

test('mergeSettings：只覆盖传入的键', () => {
  act().setSettings({ theme: 'dark', autoScroll: true });
  act().mergeSettings({ theme: 'light' });

  assert.equal(act().settings.theme, 'light');
  assert.equal(act().settings.autoScroll, true);
});
