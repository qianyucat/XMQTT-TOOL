/**
 * 主题树
 * ------------------------------------------------------------------
 * 扫描结果是一张「主题 → 命中次数」的平表，界面要按 `/` 分层展示。
 * 拆成纯函数有三个好处：
 *
 * 1. 单测能直接覆盖（构建、排序、折叠、搜索四条规则互不影响）；
 * 2. React 侧用 `useMemo` 缓存，节点上千时不会每次渲染都重建一遍；
 * 3. 「折叠态」只是 `Set<string>` 输入，不要求树结构自己记住状态 ——
 *    状态只有一份，在 store 里。
 */

import type { CollectedTopic } from '@shared/models';

export interface TopicNode {
  /** 路径里的最后一段，用于显示 */
  name: string;
  /** 完整路径，也是折叠态与订阅判断的键 */
  path: string;
  /** 子树内所有主题的命中次数之和 */
  count: number;
  /** 有真实主题落在该节点上时指向那条记录；纯中间节点为 null */
  leaf: CollectedTopic | null;
  children: TopicNode[];
}

export interface TopicRow {
  node: TopicNode;
  depth: number;
}

/** 过滤 + 排序：搜索词统一按小写包含匹配，结果按主题名排序 */
export function filterTopics(topics: Iterable<CollectedTopic>, search: string): CollectedTopic[] {
  const list = [...topics];
  const needle = search.trim().toLowerCase();
  const filtered = needle ? list.filter((t) => t.topic.toLowerCase().includes(needle)) : list;
  return filtered.sort((a, b) => a.topic.localeCompare(b.topic));
}

/**
 * 构建树。
 * `children` 用数组而不是 Map：渲染要顺序遍历，排序只做一次，比每次渲染再排便宜。
 */
export function buildTopicTree(topics: CollectedTopic[]): TopicNode[] {
  const root: TopicNode = { name: '', path: '', count: 0, leaf: null, children: [] };
  const index = new Map<string, TopicNode>([['', root]]);

  for (const item of topics) {
    const parts = item.topic.split('/');
    let parent = root;
    root.count += item.count;

    for (let i = 0; i < parts.length; i += 1) {
      const path = parts.slice(0, i + 1).join('/');
      let node = index.get(path);
      if (!node) {
        node = { name: parts[i], path, count: 0, leaf: null, children: [] };
        index.set(path, node);
        parent.children.push(node);
      }
      node.count += item.count;
      if (i === parts.length - 1) node.leaf = item;
      parent = node;
    }
  }

  sortTree(root);
  return root.children;
}

/** 递归按名称排序（就地，只跑一次） */
function sortTree(node: TopicNode): void {
  node.children.sort((a, b) => a.name.localeCompare(b.name));
  for (const child of node.children) sortTree(child);
}

/**
 * 把树摊平成可见行。
 *
 * 折叠节点只输出自身一行、不进子树 —— 这正是「折叠」的语义，
 * 也顺便让渲染侧不必递归（行数多时递归组件会产生很深的调用栈）。
 */
export function flattenTopicTree(nodes: TopicNode[], collapsed: Set<string>): TopicRow[] {
  const rows: TopicRow[] = [];

  const walk = (list: TopicNode[], depth: number): void => {
    for (const node of list) {
      rows.push({ node, depth });
      if (node.children.length && !collapsed.has(node.path)) walk(node.children, depth + 1);
    }
  };

  walk(nodes, 0);
  return rows;
}

/** 平铺模式：每个主题一行，不带层级 */
export function flatTopicRows(topics: CollectedTopic[]): TopicRow[] {
  return topics.map((topic) => ({
    node: { name: topic.topic, path: topic.topic, count: topic.count, leaf: topic, children: [] },
    depth: 0,
  }));
}
