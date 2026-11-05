/**
 * 应用外壳
 * ------------------------------------------------------------------
 * 阶段 4 起 React 接管整棵界面：顶部连接条、左侧导航、四个视图都在这里装配。
 * `index.html` 只剩下三个布局槽位与 `#app-root`。
 *
 * 为什么仍然用 portal 而不是「一个包住整页的 React 根」：
 * 布局是 `.app { grid-template-rows: 40px 1fr }`，标题栏与 `.body`（导航 + 内容区）
 * 分属网格的不同层级。用 portal 把子树「投递」到各自的槽位，DOM 结构与 CSS 一行都不用改；
 * 若把 React 根挂在 `.app` 外面再包一层 div，40px 的固定行高会立刻失效。
 *
 * 挂载时机：`boot()` 放在本组件首次提交之后 —— 它要读 `#toasts`、给 `<html>` 打主题，
 * 还要求所有视图节点已经存在。
 */

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { boot } from '../app';
import { DialogHost } from '../components/Dialog';
import { act, useAppStore } from '../store/appStore';
import { LogView } from '../views/LogView';
import { PublishView } from '../views/PublishView';
import { ServerEditor } from '../views/ServerEditor';
import { StatusView } from '../views/StatusView';
import { WorkbenchView } from '../views/WorkbenchView';
import { Rail } from './Rail';
import { TitleBar } from './TitleBar';

/** React 18 的 effect 在开发模式下会被调用两次；引导只允许跑一次 */
let booted = false;

function mountPoint(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`[shell] 找不到外壳挂载点 #${id}`);
  return node;
}

export function AppShell() {
  const view = useAppStore((s) => s.view);

  useEffect(() => {
    if (booted) return;
    booted = true;
    void boot();

    // 心跳：运行时长这类「随时间走」的派生值需要一个节拍，5 秒足够，
    // 再密只会白刷一遍连接条与扫描计时。
    const timer = setInterval(() => act().heartbeat(), 5000);
    return () => clearInterval(timer);
  }, []);

  /*
   * 四个视图全部常驻挂载，只切 `is-active`。
   * 卸载重挂的代价太大了：消息表要重建虚拟列表、主题树要重新构树、
   * 详情面板的高亮状态会丢 —— 而这些恰恰是用户切来切去时最不希望变的。
   */
  return (
    <>
      {createPortal(<TitleBar />, mountPoint('titlebar-root'))}
      {createPortal(<Rail />, mountPoint('rail-root'))}
      {createPortal(
        <>
          <PublishView active={view === 'publish'} />
          <WorkbenchView active={view === 'browser'} />
          <StatusView active={view === 'status'} />
          <LogView active={view === 'log'} />
        </>,
        mountPoint('content-root')
      )}
      {/* 弹层自己会 portal 到 body，挂在这里只是为了跟随 React 生命周期 */}
      <DialogHost />
      <ServerEditor />
    </>
  );
}
