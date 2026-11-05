/**
 * 连接动作
 * ------------------------------------------------------------------
 * 从 `app.ts` 拆出来的三条连接命令：连接选中项、断开、重新拉状态。
 *
 * 为什么单独成模块：视图（订阅/主题工作台）在订阅、退订、静音、换编码之后
 * 需要「重新拉一次连接状态」，而 `app.ts` 依赖全部视图 —— 视图反过来 import
 * `app.ts` 就是循环依赖。这里只依赖 store 与 ipc，视图可以放心引用。
 *
 * 状态更新之后**不需要**在这里刷新界面：`app.ts` 订阅了 store，
 * `connectionId` / `connections` 一变就会跑一遍依赖连接的刷新。
 */

import { api } from '../ipc/client';
import { errMsg, toast } from './util';
import { act, selectActiveConn, selectSelectedServer } from '../store/appStore';

/**
 * 连接当前选中的服务器。
 * @returns 是否发起了连接；`false` 表示没有可用的服务器配置（调用方决定是否弹出编辑器）
 */
export async function connectSelected(): Promise<boolean> {
  const server = selectSelectedServer(act());
  if (!server) {
    toast('warn', '未配置服务器', '请点顶部的「新建」按钮添加一个服务器配置');
    return false;
  }

  const store = act();
  try {
    const snapshot = await api.connect(server);

    // 切换连接到新 broker：清空上一连接的消息与主题，避免串台。
    // connectionId 要在 await 之后重读 —— 期间用户可能已经切换/断开了连接。
    const currentId = act().connectionId;
    if (currentId && currentId !== snapshot.id) {
      act().clearMessages();
      act().clearTopics();
    }
    store.setConnectionId(snapshot.id);
    store.upsertConnection(snapshot);

    store.mergeSettings(await api.patchSettings({ lastServerId: server.id ?? null }));
  } catch (err) {
    toast('error', '连接失败', errMsg(err));
  }
  return true;
}

/** 断开当前连接。重连中同样可点 —— 那是现场排查 broker 不通时唯一的出口。 */
export async function disconnectActive(): Promise<void> {
  const id = act().connectionId;
  if (!id) return;
  try {
    await api.disconnect(id);
  } catch (err) {
    toast('error', '断开失败', errMsg(err));
  }
}

/**
 * 重新拉一次当前连接状态。
 *
 * 订阅 / 退订 / 静音 / 换编码之后调用 —— 这些动作的真实结果在 `mqtt-manager.js` 里，
 * 前端不自行推测订阅表，只以主进程返回的快照为准。
 */
export async function reloadConnection(): Promise<void> {
  const id = act().connectionId;
  if (!id) return;
  try {
    const snapshot = await api.state(id);
    if (snapshot) act().upsertConnection(snapshot);
  } catch {
    /* 连接可能已经断开，主进程会另行推送状态 */
  }
}

/** 供界面判断「现在有没有可操作的连接」 */
export function currentStatus() {
  return selectActiveConn(act())?.status ?? 'disconnected';
}
