/**
 * 主题树（`lib/topic-tree.ts`）
 * ------------------------------------------------------------------
 * 树上千节点时「构树 / 排序 / 折叠 / 搜索」四条规则互相独立，任何一条被改坏
 * 都只会在特定的扫描结果下暴露。这组用例把每条规则单独钉住。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTopicTree,
  filterTopics,
  flatTopicRows,
  flattenTopicTree,
} from '../../src/renderer/lib/topic-tree';
import type { CollectedTopic } from '../../src/shared/models';

const at = (topic: string, count = 1, ts = 1): CollectedTopic => ({ topic, count, ts });

test('buildTopicTree：按 / 分层，同名中间节点只出现一次', () => {
  const tree = buildTopicTree([at('a/b/c'), at('a/b/d'), at('a/e')]);

  assert.equal(tree.length, 1);
  const [a] = tree;

  assert.equal(a.name, 'a');
  assert.equal(a.path, 'a');
  assert.equal(a.leaf, null);
  assert.deepEqual(
    a.children.map((c) => c.path),
    ['a/b', 'a/e']
  );

  const ab = a.children[0];
  assert.deepEqual(
    ab.children.map((c) => c.path),
    ['a/b/c', 'a/b/d']
  );
  assert.equal(ab.children[0].leaf?.topic, 'a/b/c');
});

test('buildTopicTree：计数在整条路径上累加', () => {
  const tree = buildTopicTree([at('a/b', 2), at('a/c', 3)]);
  const [a] = tree;

  assert.equal(a.count, 5);
  assert.equal(a.children.find((c) => c.name === 'b')?.count, 2);
});

test('buildTopicTree：兄弟节点按名称排序（与输入顺序无关）', () => {
  const tree = buildTopicTree([at('z/1'), at('a/1'), at('m/1')]);
  assert.deepEqual(
    tree.map((n) => n.name),
    ['a', 'm', 'z']
  );
});

test('buildTopicTree：单段主题就是根的子节点，且自己带 leaf', () => {
  const tree = buildTopicTree([at('solo', 7)]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].name, 'solo');
  assert.equal(tree[0].leaf?.count, 7);
  assert.equal(tree[0].children.length, 0);
});

test('flattenTopicTree：全部展开时行数等于节点数', () => {
  const tree = buildTopicTree([at('a/b/c'), at('a/b/d')]);
  const rows = flattenTopicTree(tree, new Set());

  assert.deepEqual(
    rows.map((r) => [r.node.path, r.depth]),
    [
      ['a', 0],
      ['a/b', 1],
      ['a/b/c', 2],
      ['a/b/d', 2],
    ]
  );
});

test('flattenTopicTree：折叠只砍子树，节点自身仍占一行', () => {
  const tree = buildTopicTree([at('a/b/c'), at('a/b/d'), at('x')]);
  const rows = flattenTopicTree(tree, new Set(['a/b']));

  assert.deepEqual(
    rows.map((r) => r.node.path),
    ['a', 'a/b', 'x']
  );
});

test('flattenTopicTree：折叠根级节点时它的子孙全部隐藏', () => {
  const tree = buildTopicTree([at('a/b/c')]);
  const rows = flattenTopicTree(tree, new Set(['a']));
  assert.deepEqual(
    rows.map((r) => r.node.path),
    ['a']
  );
});

test('flatTopicRows：平铺模式下每行都是叶子、深度为 0', () => {
  const rows = flatTopicRows([at('a/b'), at('a/b/c')]);
  assert.deepEqual(
    rows.map((r) => [r.node.path, r.depth, r.node.leaf !== null]),
    [
      ['a/b', 0, true],
      ['a/b/c', 0, true],
    ]
  );
});

test('filterTopics：按小写包含匹配，空搜索返回全部', () => {
  const list = [at('Factory/line1'), at('sensor/temp'), at('factory/line2')];

  // 大小写不敏感：'FACTORY' 同时命中 Factory/line1 与 factory/line2
  const hit = filterTopics(list, 'FACTORY').map((t) => t.topic);
  assert.equal(hit.length, 2);
  assert.deepEqual([...hit].sort(), ['Factory/line1', 'factory/line2']);

  assert.equal(filterTopics(list, '').length, 3);
  assert.equal(filterTopics(list, 'nope').length, 0);
});

test('filterTopics：结果按主题名排序（locale 无关的稳定断言）', () => {
  const sorted = filterTopics([at('b/1'), at('a/1'), at('c/1')], '').map((t) => t.topic);
  assert.deepEqual(sorted, ['a/1', 'b/1', 'c/1']);
});

test('filterTopics：传入 Map.values() 迭代器也能用', () => {
  const map = new Map<string, CollectedTopic>([
    ['a/b', at('a/b')],
    ['c/d', at('c/d')],
  ]);
  assert.equal(filterTopics(map.values(), '').length, 2);
});
