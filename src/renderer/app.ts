/**
 * 应用引导
 * ------------------------------------------------------------------
 * 阶段 4 之后这个文件只剩一件事：**把主进程的初始快照灌进 store**。
 * 界面刷新不再由这里驱动 —— 视图是 React 的，store 一变就自己重渲染。
 *
 * 已经搬走的东西，别再往回加：
 *   · 主进程事件订阅      → `ipc/events.ts`
 *   · 连接 / 断开 / 重拉  → `lib/connection.ts`
 *   · 主题切换            → `lib/theme.ts`
 *   · 配置导入导出        → `lib/config.ts`
 *   · 视图切换与高亮      → `layout/Rail.tsx`
 *   · 各视图的首次渲染    → 各视图组件自己从 store 派生
 *
 * 唯一还留在这里的 DOM 操作是 `document.body.classList.toggle('is-offline')`：
 * 它是一层**全局**样式开关（CSS 里把 `.needs-connection` 统一置灰并屏蔽点击），
 * 作用域比任何单个组件都大，挂在 shell 的 store 订阅上最省事。
 */

import { api } from './ipc/client';
import { bindIpcEvents } from './ipc/events';
import { errMsg, toast } from './lib/util';
import { act, selectActiveConn, useAppStore } from './store/appStore';

let watching = false;

/** 离线态：所有「需要连接才能用」的控件由 CSS 统一置灰，各视图不必各记一份禁用清单 */
function syncOfflineClass(): void {
  const status = selectActiveConn(useAppStore.getState())?.status ?? 'disconnected';
  document.body.classList.toggle('is-offline', status !== 'connected');
  document.body.dataset.connState = status;
}

function watchStore(): void {
  if (watching) return;
  watching = true;

  useAppStore.subscribe((next, prev) => {
    if (next.connectionId !== prev.connectionId || next.connections !== prev.connections) {
      syncOfflineClass();
    }
  });
}

export async function boot(): Promise<void> {
  // 1. 应用信息与设置
  try {
    act().setInfo(await api.info());
    act().setSettings(await api.getSettings());
  } catch (err) {
    toast('error', '初始化失败', errMsg(err));
    return;
  }

  const settings = act().settings;
  document.documentElement.dataset.theme = settings.theme || 'dark';
  act().setMaxMessages(settings.maxMessagesPerSub || 5000);

  // 2. 服务器配置：恢复上次使用的那台
  try {
    act().setServers(await api.listServers());
    const last = settings.lastServerId;
    if (last && act().servers.some((s) => s.id === last)) act().setSelectedServer(last);
  } catch (err) {
    toast('error', '读取服务器配置失败', errMsg(err));
  }

  // 3. 消息模板与发布历史
  try {
    const [templates, history] = await Promise.all([api.listTemplates(), api.listHistory()]);
    act().setTemplates(templates);
    act().setHistory(history);
  } catch (err) {
    toast('error', '读取模板失败', errMsg(err));
  }

  // 4. 事件下行 + 离线态联动
  bindIpcEvents();
  watchStore();
  syncOfflineClass();

  if (!act().servers.length) {
    toast('info', '还没有服务器配置', '点顶部的「新建」按钮，或从「文件 → 导入连接配置」导入。', 6000);
  }
}
