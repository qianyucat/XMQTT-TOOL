/**
 * Broker 状态视图
 * ------------------------------------------------------------------
 * 展示当前连接的身份信息、收发统计与订阅表。数据全部来自主进程上报的
 * state 快照，前端不做任何增量推算 —— 否则会出现「界面数字和真实连接不一致」
 * 这类最难查的问题。
 *
 * 已连接时长按 `stats.connectedAt` 现算：主进程下发的 `uptimeMs` 是序列化那一刻
 * 的快照，两次推送之间不会变，靠它做秒级跳动会「卡住」。
 */

import type { ConnectionStatus } from '@shared/models';
import { selectActiveConn, useAppStore } from '../store/appStore';
import { fmtBytes, fmtDuration, fmtNumber, fmtTime } from '../lib/util';

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  disconnected: '未连接',
  connecting: '连接中',
  connected: '已连接',
  reconnecting: '重连中',
  error: '错误',
};

interface StatProps {
  label: string;
  value: string;
  small?: boolean;
}

function Stat({ label, value, small }: StatProps) {
  return (
    <div className="stat" data-testid="stat">
      <div className="stat__label">{label}</div>
      <div className={`stat__value${small ? ' stat__value--sm' : ''}`}>{value}</div>
    </div>
  );
}

export function StatusView({ active }: { active: boolean }) {
  const conn = useAppStore(selectActiveConn);
  const now = useAppStore((s) => s.now);

  const detail: Array<[string, string]> = conn
    ? [
        ['名称', conn.name],
        ['地址', conn.url],
        ['Client ID', conn.config.clientId || '(自动生成)'],
        ['用户名', conn.config.username || '(无)'],
        [
          'MQTT 版本',
          conn.config.protocolVersion === 5 ? '5.0' : conn.config.protocolVersion === 3 ? '3.1' : '3.1.1',
        ],
        ['Clean Session', conn.config.clean === false ? '否' : '是'],
        ['Keep Alive', `${conn.config.keepalive || 60} 秒`],
        [
          '重连间隔',
          conn.config.autoReconnect === false ? '已关闭' : `${conn.config.reconnectPeriod || 3000} 毫秒`,
        ],
        [
          '最后一条消息',
          conn.lastMessageAt
            ? `${fmtTime(conn.lastMessageAt)}（${fmtDuration(now - conn.lastMessageAt)}前）`
            : '—',
        ],
        ['错误信息', conn.error || '—'],
      ]
    : [['提示', '尚未建立连接。请在顶部选择服务器后点「连接」。']];

  const stats = conn?.stats;
  const subs = conn ? conn.subscriptions : [];

  return (
    <section className={`view${active ? ' is-active' : ''}`} id="view-status">
      <div className="pane">
        <div className="pane__head">
          <h2 className="pane__title">Broker 状态</h2>
        </div>

        <div className="pane__body pane__body--status">
          <div className="stat-grid" id="statGrid" data-testid="stat-grid">
            {conn && stats ? (
              <>
                <Stat label="状态" value={STATUS_TEXT[conn.status] || conn.status} small />
                <Stat
                  label="已连接时长"
                  value={fmtDuration(stats.connectedAt ? now - stats.connectedAt : conn.uptimeMs)}
                />
                <Stat label="收到消息" value={fmtNumber(stats.received)} />
                <Stat label="发布消息" value={fmtNumber(stats.published)} />
                <Stat label="接收字节" value={fmtBytes(stats.bytesIn)} />
                <Stat label="发送字节" value={fmtBytes(stats.bytesOut)} />
                <Stat label="订阅数" value={fmtNumber(subs.length)} />
                <Stat label="扫描到主题" value={fmtNumber(conn.scan ? conn.scan.collected : 0)} />
              </>
            ) : (
              <>
                <Stat label="状态" value="未连接" small />
                <Stat label="服务器" value="—" small />
              </>
            )}
          </div>

          <div className="pane__subhead">
            <span>连接详情</span>
          </div>
          <div className="kv" id="connDetail" data-testid="conn-detail">
            {detail.map(([key, value]) => (
              <div key={key} style={{ display: 'contents' }}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </div>

          <div className="pane__subhead">
            <span>当前订阅</span>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>主题过滤器</th>
                  <th style={{ width: 64 }}>QoS</th>
                  <th style={{ width: 96 }}>已收消息</th>
                  <th style={{ width: 96 }}>状态</th>
                  <th style={{ width: 96 }}>编码</th>
                </tr>
              </thead>
              <tbody id="statusSubBody" data-testid="status-subs">
                {subs.length ? (
                  subs.map((sub) => (
                    <tr key={sub.topic} data-testid="status-sub-row">
                      <td className="cell-mono">{sub.topic}</td>
                      <td>{sub.qos}</td>
                      <td className="cell-mono">{fmtNumber(sub.received)}</td>
                      <td>{sub.isScan ? '扫描中' : sub.muted ? '已静音' : '正常'}</td>
                      <td>{sub.encoding || 'utf8'}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td className="cell-empty" colSpan={5}>
                      {conn ? '暂无订阅' : '无数据'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}
