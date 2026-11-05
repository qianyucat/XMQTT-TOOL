/**
 * 主进程事件 → store
 * ------------------------------------------------------------------
 * 这是「事件下行」那半条通路（见计划 §5.2）：主进程推什么，这里就原样写进
 * zustand，界面自己从 store 派生。**这一层不做任何渲染决策** ——
 * 阶段 3 之前这里还要顺手调 `collector.render()` / `subscribe.appendMessages()`，
 * 现在那些调用全部消失，事件到达即完成，不再关心谁在看。
 *
 * 六个通道全部走 `EventChannel` 白名单，通道名拼错在编译期就报，
 * 运行时还有 preload 那道闸门兜底。
 */

import { EVENTS } from '@shared/channels';
import { api } from './client';
import { act } from '../store/appStore';
import { applyTheme } from '../lib/theme';
import { exportConfig, importConfig } from '../lib/config';
import type { UiMessage } from '../store/types';

/**
 * 渲染层自增的消息序号。
 * 只用于 React 的 key 与「选中哪一条」的判定 —— 主进程不知道它的存在，
 * 时间戳又不能当 key（同一毫秒可能来好几条）。
 */
let msgSeq = 0;

export function bindIpcEvents(): void {
  api.on(EVENTS.messages, (batch) => {
    // 只为当前连接的消息编号并入列
    const current: UiMessage[] = batch
      .filter((m) => m.connectionId === act().connectionId)
      .map((m) => ({ ...m, uid: ++msgSeq }));

    if (current.length) act().pushMessages(current);
  });

  api.on(EVENTS.status, (snapshot) => {
    act().upsertConnection(snapshot);
  });

  api.on(EVENTS.connections, (list) => {
    for (const snapshot of list) act().upsertConnection(snapshot);
  });

  api.on(EVENTS.log, (entry) => {
    act().pushLog(entry);
  });

  api.on(EVENTS.topics, (delta) => {
    if (delta.connectionId !== act().connectionId) return;
    act().applyTopicDelta(delta);
  });

  api.on(EVENTS.menu, async (payload) => {
    if (payload.action === 'theme') applyTheme(payload.value);
    else if (payload.action === 'export-config') await exportConfig();
    else if (payload.action === 'import-config') await importConfig();
  });
}
