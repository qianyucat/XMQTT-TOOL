/**
 * 渲染层入口
 * ------------------------------------------------------------------
 * 两件事，顺序不能换：
 *
 * 1. 装上测试门面 `window.__xmqtt`（ADR-05）。它只暴露**能力**：
 *    `getState()` / `actions` / `api` / `dialog` / 几个派生选择器。
 *    没有 `views.*`，没有「替视图重绘」这种后门 —— 界面的真相只有 store 一份，
 *    测试要改状态就走 action，要观察就 subscribe，与真实调用方同一条路径。
 * 2. `createRoot` 挂载外壳。外壳首次提交后才会跑 `boot()`（见 `AppShell`）。
 *
 * 为什么不做成「仅 dev/test 注入」：这个工具全程本地运行、不分发，多一条
 * `import.meta.env.DEV` 分支只会让「打包后 e2e 跑不起来」变成经典事故。
 * 门面里没有任何越权能力，留着比藏在条件里更可靠。
 */

import { createRoot } from 'react-dom/client';
import { AppShell } from './layout/AppShell';
import { api } from './ipc/client';
import { dialog } from './lib/dialog';
import {
  act,
  selectActiveConn,
  selectIsConnected,
  selectSelectedServer,
  selectUserSubs,
  switchView,
  useAppStore,
} from './store/appStore';

window.__xmqtt = {
  getState: () => useAppStore.getState(),
  subscribe: (listener) => useAppStore.subscribe(listener),
  actions: act,
  api,
  dialog,
  switchView,
  selectors: {
    activeConn: () => selectActiveConn(act()),
    selectedServer: () => selectSelectedServer(act()),
    isConnected: () => selectIsConnected(act()),
    userSubs: () => selectUserSubs(act()),
  },
};

const container = document.getElementById('app-root');
if (!container) throw new Error('[boot] 缺少 React 挂载点 #app-root');

createRoot(container).render(<AppShell />);
