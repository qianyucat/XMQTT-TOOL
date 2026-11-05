/**
 * 全局环境声明
 * ------------------------------------------------------------------
 * preload 通过 contextBridge 把 `window.xmqtt` 注入渲染层。
 * 这里只声明形状，具体类型来自 `@shared/bridge`（preload 与渲染层共用同一份），
 * 不在这里重复定义。
 *
 * `window.__xmqtt` 是给 e2e / 截图脚本用的测试门面（ADR-05），
 * 成员类型一律用 `typeof import(...)` 从真实模块推导 ——
 * 手抄一遍就会出现门面与实现各说各话。
 */

import type { XmqttBridge } from '@shared/bridge';

declare global {
  interface Window {
    /** preload 注入的主进程能力，contextIsolation 下的唯一入口 */
    xmqtt: XmqttBridge;
    /** 测试门面：只暴露 store 能力与派生选择器，不暴露视图 */
    __xmqtt: XmqttTestFacade;
  }
}

interface XmqttTestFacade {
  getState: typeof import('./store/appStore').useAppStore.getState;
  subscribe: typeof import('./store/appStore').useAppStore.subscribe;
  actions: typeof import('./store/appStore').act;
  api: typeof import('./ipc/client').api;
  dialog: typeof import('./lib/dialog').dialog;
  switchView: typeof import('./store/appStore').switchView;
  selectors: {
    activeConn: () => import('@shared/models').ConnectionState | null;
    selectedServer: () => import('@shared/models').ServerConfig | null;
    isConnected: () => boolean;
    userSubs: () => import('@shared/models').Subscription[];
  };
}

export {};
