/**
 * 列表过滤与裁剪（`lib/filters.ts`）
 * ------------------------------------------------------------------
 * 这两条规则被消息表、日志面板共用，边界条件（空关键字、正好等于上限、超一条）
 * 是最容易被「顺手优化」改坏的地方，所以逐个钉死。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchLog, matchMessage, tail } from '../../src/renderer/lib/filters';

test('matchMessage：空过滤器一律通过', () => {
  assert.equal(matchMessage({ topic: 'a/b', payload: 'x' }, ''), true);
  assert.equal(matchMessage({ topic: 'a/b', payload: 'x' }, '   '), true);
});

test('matchMessage：主题与内容都参与匹配，且大小写不敏感', () => {
  assert.equal(matchMessage({ topic: 'Factory/Line1', payload: 'x' }, 'factory'), true);
  assert.equal(matchMessage({ topic: 'a/b', payload: 'Hello World' }, 'hello'), true);
  assert.equal(matchMessage({ topic: 'a/b', payload: 'x' }, 'nothing'), false);
});

test('matchLog：级别精确匹配 + 正文包含', () => {
  const entry = { connectionId: 'c', level: 'error' as const, message: '连接超时', ts: 1 };
  assert.equal(matchLog(entry, 'all', ''), true);
  assert.equal(matchLog(entry, 'error', ''), true);
  assert.equal(matchLog(entry, 'info', ''), false);
  assert.equal(matchLog(entry, 'all', '超时'), true);
  assert.equal(matchLog(entry, 'all', '断开'), false);
});

test('tail：不超上限时返回原引用（调用方靠引用相等跳过重渲染）', () => {
  const list = [1, 2, 3];
  assert.equal(tail(list, 3), list);
  assert.equal(tail(list, 10), list);
});

test('tail：超上限时只保留末尾，且不修改原数组', () => {
  const list = [1, 2, 3, 4, 5];
  const sliced = tail(list, 2);
  assert.deepEqual(sliced, [4, 5]);
  assert.deepEqual(list, [1, 2, 3, 4, 5]);
});

test('tail：上限 <= 0 时返回空数组', () => {
  assert.deepEqual(tail([1, 2], 0), []);
  assert.deepEqual(tail([1, 2], -1), []);
});
