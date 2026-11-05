/**
 * 日志视图
 * ------------------------------------------------------------------
 * 只渲染最近 400 条，更早的仍在 store 里（上限 2000）可被搜索 / 导出。
 *
 * 与旧视图的差别只有一处：以前是「新日志到了就 append 一个 DOM 节点」，
 * 现在是「store 变了就重算一次可见列表」。400 行的重建成本远低于维护
 * 两套渲染路径（全量 render + 增量 append）的复杂度，而且不会出现两条路径
 * 的过滤规则慢慢漂移。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { LogEntry } from '@shared/models';
import { Button } from '../components/Button';
import { Empty } from '../components/Empty';
import { api } from '../ipc/client';
import { matchLog } from '../lib/filters';
import { errMsg, fmtDateTime, fmtTime, toast } from '../lib/util';
import { act, useAppStore } from '../store/appStore';

const MAX_ROWS = 400;
const LEVEL_TEXT: Record<string, string> = { info: 'INFO', success: 'OK', error: 'ERROR', warn: 'WARN' };

function LogRow({ entry }: { entry: LogEntry }) {
  return (
    <div className={`log-row log-row--${entry.level}`} data-testid="log-row">
      <span className="log-row__time">{fmtTime(entry.ts)}</span>
      <span className="log-row__level">{LEVEL_TEXT[entry.level] || entry.level.toUpperCase()}</span>
      <span className="log-row__msg">{entry.message}</span>
    </div>
  );
}

export function LogView({ active }: { active: boolean }) {
  const logs = useAppStore((s) => s.logs);
  const [level, setLevel] = useState('all');
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(
    () => logs.filter((entry) => matchLog(entry, level, text)).slice(-MAX_ROWS),
    [logs, level, text]
  );

  /**
   * 贴底跟随：只有本来就在底部附近才跟着滚。
   * 用户往上翻历史时被强制拉回底部，是日志面板最招人烦的行为。
   */
  useEffect(() => {
    const host = listRef.current;
    if (!host) return;
    const nearBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 60;
    if (nearBottom || active) host.scrollTop = host.scrollHeight;
  }, [visible.length, active]);

  const exportLogs = async () => {
    const list = logs.filter((entry) => matchLog(entry, level, text));
    if (!list.length) {
      toast('warn', '无数据', '当前没有可导出的日志');
      return;
    }
    const content = list
      .map((e) => `[${fmtDateTime(e.ts)}] ${(LEVEL_TEXT[e.level] || e.level).padEnd(5)} ${e.message}`)
      .join('\r\n');

    try {
      const res = await api.saveText({
        title: '导出日志',
        defaultName: `xmqtt-log-${Date.now()}.txt`,
        content,
        filters: [{ name: '文本', extensions: ['txt'] }],
      });
      if (res.saved) toast('success', '已导出', `${list.length} 条日志`);
    } catch (err) {
      toast('error', '导出失败', errMsg(err));
    }
  };

  return (
    <section className={`view${active ? ' is-active' : ''}`} id="view-log">
      <div className="pane">
        <div className="pane__head">
          <h2 className="pane__title">日志</h2>
          <div className="pane__actions">
            <select
              id="logLevel"
              className="select select--sm"
              data-testid="log-level"
              value={level}
              onChange={(e) => setLevel(e.target.value)}
            >
              <option value="all">全部级别</option>
              <option value="info">信息</option>
              <option value="success">成功</option>
              <option value="error">错误</option>
            </select>
            <input
              id="logSearch"
              className="input input--sm"
              type="search"
              placeholder="搜索日志"
              spellCheck={false}
              data-testid="log-search"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <Button size="sm" data-testid="log-export" onClick={() => void exportLogs()}>
              导出
            </Button>
            <Button size="sm" data-testid="log-clear" onClick={() => act().clearLogs()}>
              清空
            </Button>
          </div>
        </div>

        <div className="pane__body pane__body--log">
          <div className="log-list" id="logList" data-testid="log-list" ref={listRef}>
            {visible.length ? (
              visible.map((entry, i) => <LogRow key={`${entry.ts}-${i}`} entry={entry} />)
            ) : (
              <Empty>暂无日志。</Empty>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
