/**
 * 列表过滤与裁剪
 * ------------------------------------------------------------------
 * 消息、日志两条列表各有自己的匹配规则，但「大小写不敏感包含匹配」与
 * 「超出上限从头部淘汰」是共用的。抽出来既避免两处规则慢慢漂移，
 * 也让单测能直接验证边界（0 条、正好等于上限、超一条）。
 */

import type { LogEntry, MqttMessage } from '@shared/models';

/** 消息过滤：主题或内容包含关键字 */
export function matchMessage(m: Pick<MqttMessage, 'topic' | 'payload'>, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (!needle) return true;
  return m.topic.toLowerCase().includes(needle) || String(m.payload).toLowerCase().includes(needle);
}

/** 日志过滤：级别精确匹配 + 正文包含关键字 */
export function matchLog(entry: LogEntry, level: string, text: string): boolean {
  if (level !== 'all' && entry.level !== level) return false;
  const needle = text.trim().toLowerCase();
  if (!needle) return true;
  return entry.message.toLowerCase().includes(needle);
}

/**
 * 只保留末尾 `max` 条。
 * 返回原数组引用而不是空操作 —— 调用方靠 `next === prev` 判断是否需要重渲染。
 */
export function tail<T>(list: T[], max: number): T[] {
  if (max <= 0) return [];
  return list.length > max ? list.slice(list.length - max) : list;
}
