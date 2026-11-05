/**
 * 顶部连接条
 * ------------------------------------------------------------------
 * 视觉状态全部从 store 派生：连接状态、统计、按钮可用性、主题、服务器下拉。
 * 阶段 3 之前这些是 `app.ts` 里 `refreshConnectionUI()` 直接改 `textContent`
 * 与 `className` 的 —— 数据变一次就得记一遍「哪些 DOM 要跟着改」，漏一个就是脏界面。
 *
 * 阶段 4 收回来的最后一块：`#serverSelect` 的 option 以前由旧视图
 * `servers.renderSelect()` 填充（React 只管一个空 `<select>`，谁也别碰谁）。
 * 现在下拉就是 `servers` + `selectedServerId` 的纯函数结果。
 *
 * 一个刻意的例外：运行时长按 `stats.connectedAt` 现算，不用主进程下发的
 * `uptimeMs` —— 那是「序列化那一刻」的快照，两次推送之间不会变，5 秒心跳就白刷了。
 */

import { useEffect } from 'react';
import type { ConnectionStatus } from '@shared/models';
import { BrandMark } from '../components/BrandMark';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { api } from '../ipc/client';
import { connectSelected, disconnectActive } from '../lib/connection';
import { openServerEditor } from '../lib/server-editor';
import { toggleTheme } from '../lib/theme';
import { fmtDuration, fmtNumber } from '../lib/util';
import { act, selectActiveConn, useAppStore } from '../store/appStore';

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  disconnected: '未连接',
  connecting: '连接中…',
  connected: '已连接',
  reconnecting: '重连中…',
  error: '连接错误',
};

export function TitleBar() {
  const conn = useAppStore(selectActiveConn);
  const servers = useAppStore((s) => s.servers);
  const selectedServerId = useAppStore((s) => s.selectedServerId);
  // 订阅心跳：只为了让下面那段时长计算每 5 秒重新求值一次
  const now = useAppStore((s) => s.now);

  const connStatus: ConnectionStatus = conn ? conn.status : 'disconnected';
  const connecting = connStatus === 'connecting';

  /*
   * 选中项兜底：配置被删掉、首次导入、或者上次用的那台已经不存在时，
   * 落到列表第一项。放在 effect 里而不是渲染里算，是因为
   * `connectSelected()` 读的是 store —— 界面显示 A 而 store 是 null 的话，
   * 点「连接」会得到一句「未配置服务器」。
   */
  useEffect(() => {
    if (!servers.length) {
      if (selectedServerId !== null) act().setSelectedServer(null);
      return;
    }
    if (!servers.some((s) => s.id === selectedServerId)) {
      act().setSelectedServer(servers[0].id ?? null);
    }
  }, [servers, selectedServerId]);

  const meta = (() => {
    if (!conn) return '';
    const parts = [conn.url];
    if (connStatus === 'connected') {
      const uptime = conn.stats.connectedAt ? now - conn.stats.connectedAt : conn.uptimeMs;
      parts.push(`↑${fmtNumber(conn.stats.published)} ↓${fmtNumber(conn.stats.received)}`);
      parts.push(fmtDuration(uptime));
    }
    if (conn.error) parts.push(`· ${conn.error}`);
    return parts.join('  ·  ');
  })();

  const onConnect = () => {
    void connectSelected().then((started) => {
      // 没有可用配置时直接把编辑器打开，少一次「知道了，然后呢」
      if (!started) openServerEditor(null);
    });
  };

  return (
    <>
      <div className="titlebar__brand">
        <BrandMark className="brand-mark" />
        <span className="brand-name">XMQTT Tool</span>
      </div>

      <div className="titlebar__conn">
        <div className="conn-group">
          <select
            id="serverSelect"
            className="select select--server"
            title="选择服务器配置"
            data-testid="server-select"
            disabled={!servers.length}
            value={selectedServerId ?? ''}
            onChange={(e) => {
              const id = e.target.value || null;
              act().setSelectedServer(id);
              // 记住上次用的那台；失败不影响当前选择
              api.patchSettings({ lastServerId: id }).catch(() => {});
            }}
          >
            {servers.length ? (
              servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name ? `${s.name}  ·  ${s.host}:${s.port}` : `${s.host}:${s.port}`}
                </option>
              ))
            ) : (
              <option value="">（尚未配置服务器）</option>
            )}
          </select>

          <button
            id="btnServerEdit"
            type="button"
            className="btn btn--icon"
            title="编辑当前服务器配置"
            data-testid="server-edit"
            onClick={() => openServerEditor(selectedServerId)}
          >
            <Icon name="settings" />
          </button>
          <button
            id="btnServerNew"
            type="button"
            className="btn btn--icon"
            title="新建服务器配置"
            data-testid="server-new"
            onClick={() => openServerEditor(null)}
          >
            <Icon name="plus" />
          </button>
        </div>

        {/*
          按钮可用性只由「有没有可用的连接动作」决定，不能把重连中当忙状态一起禁用：
          broker 掉线后客户端会一直自动重连，此时若「断开」不可点，用户就只能关窗口
          才能停下来 —— 现场排查 broker 不通的场景里这恰恰是最需要能断开的时候。
        */}
        <Button
          id="btnConnect"
          variant="primary"
          data-testid="connect"
          disabled={connecting || connStatus === 'connected'}
          onClick={onConnect}
        >
          连接
        </Button>
        <Button
          id="btnDisconnect"
          data-testid="disconnect"
          disabled={!conn || connStatus === 'disconnected'}
          onClick={() => void disconnectActive()}
        >
          断开
        </Button>

        <div className="conn-status" id="connStatus" data-testid="conn-status">
          <span className={`dot dot--${connStatus === 'disconnected' ? 'idle' : connStatus}`} />
          <span className="conn-status__text">{STATUS_TEXT[connStatus]}</span>
          <span className="conn-status__meta" id="connMeta">
            {meta}
          </span>
        </div>
      </div>

      <div className="titlebar__right">
        <button
          id="btnTheme"
          type="button"
          className="btn btn--icon"
          title="切换主题"
          data-testid="theme"
          onClick={toggleTheme}
        >
          <Icon name="sun-moon" />
        </button>
      </div>
    </>
  );
}
