/**
 * 主题工作台（React）—— 扫描 → 订阅 → 查看 三合一
 * ------------------------------------------------------------------
 * 这里是全应用最重的视图，也是这次重写的核心：原 `collector.ts`(520) +
 * `subscribe.ts`(454) 两个命令式视图合成的同一个界面。
 *
 * 为什么合并：原界面本来就是「左边主题树、右边消息表」，拆成两个模块只是因为
 * 历史原因（先有订阅页，后加扫描）。合并后「扫到什么 → 点一下订上 → 右边立刻有数据」
 * 这条主链路只在一个组件里，不再需要跨视图调用 `collector.render()` 之类的隐式刷新。
 *
 * 三处工程上的取舍：
 *
 * 1. **消息表用固定行高 + 自建窗口**（`@tanstack/react-virtual`）。
 *    5000 行全量渲染会让滚动一卡一卡的。行高来源只有一个：CSS 的
 *    `--table-row-h`，由 `useTableRowHeight()` 读出来 —— 触屏档它变 44px，
 *    虚拟列表跟着重算，不会出现「滚到底还差一截」。以前这里写死 28 并在注释里
 *    要求「改样式时两边一起改」，那种约定迟早会忘。
 * 2. **主题树不做虚拟化**。树是「一次扫描的结果」，行数上千但滚动远不如消息频繁，
 *    全量渲染换来的是展开/折叠零延迟。构建结果用 `useMemo` 缓存，折叠态是
 *    store 里的 `Set`，只在真的变化时才重建。
 * 3. **不做渲染侧节流**。主进程已经把消息按 60ms、主题按 400ms 合并过一轮，
 *    这里再叠一层只会双重延迟（见计划 §9「双重节流」）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { CollectedTopic, PayloadEncoding, Subscription } from '@shared/models';
import { Button } from '../components/Button';
import { Empty } from '../components/Empty';
import { Icon } from '../components/Icon';
import { Resizer } from '../components/Resizer';
import { api } from '../ipc/client';
import { reloadConnection } from '../lib/connection';
import { dialog } from '../lib/dialog';
import { matchMessage } from '../lib/filters';
import { reencode } from '../lib/payload';
import { useTableRowHeight } from '../lib/layout';
import { useSplitSize } from '../lib/resize';
import { buildTopicTree, filterTopics, flatTopicRows, flattenTopicTree } from '../lib/topic-tree';
import type { TopicNode } from '../lib/topic-tree';
import {
  copyText,
  debounce,
  errMsg,
  fmtBytes,
  fmtDateTime,
  fmtDuration,
  fmtMs,
  fmtNumber,
  fmtTime,
  highlightJson,
  preview,
  toast,
  topicMatches,
  tryFormatJson,
} from '../lib/util';
import { act, selectActiveConn, selectIsConnected, switchView, useAppStore } from '../store/appStore';
import type { UiMessage } from '../store/types';

/** 表格行高不在这里定义 —— 唯一真相是 CSS 的 `--table-row-h`，见 `lib/layout.ts` */

const ENCODINGS: Array<{ value: PayloadEncoding; label: string }> = [
  { value: 'utf8', label: 'UTF-8' },
  { value: 'hex', label: 'HEX' },
  { value: 'base64', label: 'Base64' },
];

const QOS_LIST = ['0', '1', '2'];

/**
 * 左栏「已订阅」区的高度约束（px）。
 *
 * 下界是「标题 + 一条订阅」；上界要按面板**实测**算 —— 上方订阅输入、
 * 下方扫描控件 + 分隔栏 + 树的最小可视高度占掉的部分不能给出去。
 * 用常量估上界会错：两段的实际高度随档位变（紧凑档 padding 更小），
 * 估多了在 680px 高的窗口里树就被挤出面板。
 *
 * 未拖动过时的高度由 CSS 的 `var(--wb-subs-h, 200px)` 决定，这里不重复定义。
 */
const SUBS_MIN_H = 76;
/** 与 CSS 的 `.resizer--y` 高度、`.wb-tree` 的 min-height 对应 */
const RESIZER_H = 9;
const TREE_MIN_H = 70;

/** 主题栏 / 消息栏两边的下限：再窄就只剩滚动条，拖动条也失去意义 */
const TREE_PANE_MIN_W = 240;
const MSG_PANE_MIN_W = 340;
/** 详情面板与上方表格各自的下限 */
const DETAIL_MIN_H = 140;
const TABLE_MIN_H = 160;

/** 已订阅区在当前面板里能长到的最大高度；面板不可见时返回 Infinity（只守下界） */
function maxSubsHeight(pane: HTMLElement | null): number {
  if (!pane || !pane.clientHeight) return Number.POSITIVE_INFINITY;
  const blocks = pane.querySelectorAll<HTMLElement>(':scope > .wb-block');
  const fixed = (blocks[0]?.offsetHeight ?? 0) + (blocks[1]?.offsetHeight ?? 0) + RESIZER_H + TREE_MIN_H;
  return Math.max(SUBS_MIN_H, pane.clientHeight - fixed);
}

/* ================================================================== */
/* 主题行                                                              */
/* ================================================================== */

interface TopicRowProps {
  node: TopicNode;
  depth: number;
  subscribed: boolean;
  exact: string | null;
  onToggle(node: TopicNode): void;
  onSubscribe(topic: string, qos?: number): void;
  onUnsubscribe(topic: string): void;
}

function TopicRow({ node, depth, subscribed, exact, onToggle, onSubscribe, onUnsubscribe }: TopicRowProps) {
  const leaf = node.leaf !== null;
  const hasChildren = node.children.length > 0;
  const collapsed = useAppStore((s) => s.collapsedPaths.has(node.path));

  const title = leaf
    ? subscribed
      ? `${node.path}\n已订阅${exact ? '（点击行不重复订阅，行尾按钮可退订）' : '（被通配符订阅覆盖）'}`
      : `${node.path}\n点击订阅该主题`
    : `${node.path || node.name}\n点击展开 / 折叠`;

  const className = `tree-row${leaf ? ' tree-row--leaf' : ''}${subscribed ? ' is-subscribed' : ''}`;

  const click = (): void => {
    if (hasChildren) {
      onToggle(node);
      return;
    }
    if (!leaf) return;
    if (subscribed) {
      toast('info', '该主题已在订阅范围内', exact || '由通配符订阅覆盖');
      return;
    }
    onSubscribe(node.path, 0);
  };

  return (
    <div
      className={className}
      data-topic={node.path}
      data-depth={depth}
      data-testid="tree-row"
      title={title}
      onClick={click}
    >
      <span className="tree-row__lead" style={{ paddingLeft: depth * 14 }}>
        {hasChildren ? (
          <span className={`tree-row__toggle${collapsed ? ' is-collapsed' : ''}`}>
            <Icon name="chevron-down" size={12} />
          </span>
        ) : (
          <span className="tree-row__dot">·</span>
        )}
      </span>

      <span className="tree-row__name">{node.name}</span>

      {subscribed && (
        <span className="tree-row__tick" title="已订阅">
          <Icon name="check" size={12} />
        </span>
      )}
      {node.count > 0 && <span className="tree-row__count">{fmtNumber(node.count)}</span>}

      {/* 操作按钮 hover 才显形（CSS 控制），保持行面干净 */}
      <span className="tree-row__actions">
        {leaf ? (
          <>
            {exact && (
              <button
                type="button"
                className="icon-btn"
                title={`退订 ${exact}`}
                data-testid="tree-unsubscribe"
                onClick={(e) => {
                  e.stopPropagation();
                  onUnsubscribe(exact);
                }}
              >
                <Icon name="x" size={12} />
              </button>
            )}
            <button
              type="button"
              className="icon-btn"
              title="填入发布框"
              data-testid="tree-to-publish"
              onClick={(e) => {
                e.stopPropagation();
                act().setPublishDraft({ topic: node.path });
                switchView('publish');
              }}
            >
              <Icon name="arrow-up-right" size={13} />
            </button>
            <button
              type="button"
              className="icon-btn"
              title="复制主题"
              data-testid="tree-copy"
              onClick={(e) => {
                e.stopPropagation();
                void copyText(node.path).then(() => toast('success', '已复制', node.path));
              }}
            >
              <Icon name="copy" size={12} />
            </button>
          </>
        ) : (
          <button
            type="button"
            className="icon-btn"
            title={`订阅整棵子树 ${node.path}/#`}
            data-testid="tree-subtree"
            onClick={(e) => {
              e.stopPropagation();
              onSubscribe(`${node.path}/#`, 0);
            }}
          >
            <Icon name="plus" size={12} />
          </button>
        )}
      </span>
    </div>
  );
}

/* ================================================================== */
/* 已订阅条目                                                          */
/* ================================================================== */

function SubItem({
  sub,
  live,
  onFill,
  onMute,
  onUnsubscribe,
  onEncoding,
}: {
  sub: Subscription;
  live: boolean;
  onFill(topic: string): void;
  onMute(topic: string, muted: boolean): void;
  onUnsubscribe(topic: string): void;
  onEncoding(topic: string, encoding: PayloadEncoding): void;
}) {
  return (
    <div className={`sub-item${sub.muted ? ' is-muted' : ''}`} data-testid="sub-item">
      <div className="sub-item__row">
        <span
          className="sub-item__topic"
          title={`${sub.topic}（点击填入上方输入框）`}
          data-testid="sub-topic-label"
          onClick={() => onFill(sub.topic)}
        >
          {sub.topic}
        </span>
        <button
          type="button"
          className={`icon-btn${sub.muted ? ' is-on' : ''}`}
          disabled={!live}
          title={sub.muted ? '恢复接收' : '静音（不显示该主题消息）'}
          data-testid="sub-mute"
          onClick={() => onMute(sub.topic, !sub.muted)}
        >
          <Icon name={sub.muted ? 'volume-x' : 'volume-2'} size={13} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title={live ? '退订' : '未连接，无法退订'}
          disabled={!live}
          data-testid="sub-remove"
          onClick={() => onUnsubscribe(sub.topic)}
        >
          <Icon name="x" size={12} />
        </button>
      </div>

      <div className="sub-item__row sub-item__row--meta">
        <span className="sub-item__meta">{`QoS ${sub.qos} · ${fmtNumber(sub.received)} 条`}</span>
        <select
          className="select select--xs"
          title={live ? '该订阅的消息解码方式' : '未连接，无法修改解码方式'}
          disabled={!live}
          value={sub.encoding || 'utf8'}
          data-testid="sub-encoding"
          onChange={(e) => onEncoding(sub.topic, e.target.value as PayloadEncoding)}
        >
          {ENCODINGS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/* ================================================================== */
/* 主视图                                                              */
/* ================================================================== */

export function WorkbenchView({ active }: { active: boolean }) {
  const conn = useAppStore(selectActiveConn);
  const connected = useAppStore(selectIsConnected);
  const topics = useAppStore((s) => s.topics);
  const treeMode = useAppStore((s) => s.treeMode);
  const collapsed = useAppStore((s) => s.collapsedPaths);
  const topicSearch = useAppStore((s) => s.topicSearch);

  const messages = useAppStore((s) => s.messages);
  const filter = useAppStore((s) => s.messageFilter);
  const selected = useAppStore((s) => s.selectedMessage);
  const detailEncoding = useAppStore((s) => s.detailEncoding);
  const detailFormatted = useAppStore((s) => s.detailFormatted);
  const autoScrollSetting = useAppStore((s) => s.settings.autoScroll !== false);
  const now = useAppStore((s) => s.now);
  const drawerOpen = useAppStore((s) => s.drawerOpen);

  /* ------------------------------ 本地界面态 ------------------------------ */

  const [subTopic, setSubTopic] = useState('');
  const [subQos, setSubQos] = useState('0');
  const [scanFilter, setScanFilter] = useState('#');
  const [searchText, setSearchText] = useState('');
  const [autoScroll, setAutoScroll] = useState(autoScrollSetting);
  const [rate, setRate] = useState(0);
  /**
   * 详情面板在窄档位是折叠的。刻意不由 `selected` 派生：
   * 「选中即展开」会让连续翻看报文时列表被反复挤掉一半，
   * 所以选中只更新摘要行，展开是用户明确的一次点击。
   * 宽档位里这个状态没有任何样式消费，详情常驻 40% 高度。
   */
  const [detailOpen, setDetailOpen] = useState(false);

  /** 行高来自 CSS（触屏档 44px / 鼠标 28px），虚拟列表跟着它算 */
  const rowHeight = useTableRowHeight();

  const subTopicRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  /* ----------------------------- 分栏拖动 ----------------------------- */

  const splitRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const subsRef = useRef<HTMLDivElement>(null);
  const msgBodyRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  /**
   * 三条拖动条，尺寸都写进 CSS 变量（见 `lib/resize.ts` 顶部注释）：
   *
   * - `--browser-left-w` 主题栏宽度（左右拖）
   * - `--wb-subs-h`      已订阅区高度（上下拖）
   * - `--msg-detail-h`   详情面板高度（上下拖，分隔条在它上方，所以 invert）
   *
   * 上界全部按**容器实测**算：写死一个像素上界，换台分辨率不同的机器就会出现
   * 「拖到头了对面还是被压扁」或者「拖不到底」。
   */
  const treeSplit = useSplitSize({
    axis: 'x',
    varName: '--browser-left-w',
    targetRef: paneRef,
    min: TREE_PANE_MIN_W,
    max: () => {
      const host = splitRef.current;
      return host ? host.clientWidth - MSG_PANE_MIN_W : Number.POSITIVE_INFINITY;
    },
    storageKey: 'xmqtt.split.tree',
  });

  const subsSplit = useSplitSize({
    axis: 'y',
    varName: '--wb-subs-h',
    targetRef: subsRef,
    min: SUBS_MIN_H,
    max: () => maxSubsHeight(paneRef.current),
    storageKey: 'xmqtt.split.subs',
  });

  const detailSplit = useSplitSize({
    axis: 'y',
    varName: '--msg-detail-h',
    targetRef: detailRef,
    min: DETAIL_MIN_H,
    max: () => {
      const host = msgBodyRef.current;
      return host ? host.clientHeight - TABLE_MIN_H : Number.POSITIVE_INFINITY;
    },
    invert: true,
    storageKey: 'xmqtt.split.detail',
  });

  /* ------------------------------ 订阅动作 ------------------------------ */

  /**
   * 订阅 / 退订后必须 `await reloadConnection()`。
   * 主进程虽然会推状态事件，但 IPC 是异步的：此刻 store 里还是旧订阅表，
   * 直接重绘会让主题行的「已订阅」标记错一拍，肉眼能看到一次闪烁。
   */
  const subscribeTopic = useCallback(async (topic: string, qos = 0): Promise<void> => {
    const connId = act().connectionId;
    if (!connId) {
      toast('warn', '未连接', '请先连接 Broker 再订阅');
      return;
    }
    try {
      await api.subscribe(connId, topic, qos);
      await reloadConnection();
      toast('success', '已订阅', topic);
      // 窄档位订完就把树收起来 —— 接下来要看的是右边的报文，不是树。
      // 宽档位 drawerOpen 恒为 false，这里是一次空操作。
      if (act().drawerOpen) act().setDrawer(false);
    } catch (err) {
      toast('warn', '订阅失败', errMsg(err));
    }
  }, []);

  const unsubscribeTopic = useCallback(async (topic: string): Promise<void> => {
    const connId = act().connectionId;
    if (!connId) return;
    try {
      await api.unsubscribe(connId, topic);
      await reloadConnection();
      toast('info', '已退订', topic);
    } catch (err) {
      toast('error', '退订失败', errMsg(err));
    }
  }, []);

  const setMuted = useCallback(async (topic: string, muted: boolean): Promise<void> => {
    const connId = act().connectionId;
    if (!connId) return;
    try {
      await api.setMuted(connId, topic, muted);
      await reloadConnection();
    } catch (err) {
      toast('error', '操作失败', errMsg(err));
    }
  }, []);

  const setEncoding = useCallback(async (topic: string, encoding: PayloadEncoding): Promise<void> => {
    const connId = act().connectionId;
    if (!connId) return;
    try {
      await api.setEncoding(connId, topic, encoding);
      await reloadConnection();
    } catch (err) {
      toast('error', '切换编码失败', errMsg(err));
    }
  }, []);

  /* ------------------------------ 扫描控制 ------------------------------ */

  const startScan = async (): Promise<void> => {
    const connId = act().connectionId;
    if (!connId) {
      toast('warn', '未连接', '请先连接 Broker 再扫描');
      return;
    }
    const filterText = scanFilter.trim() || '#';
    try {
      await api.scanStart(connId, filterText);
      await reloadConnection();
      toast('success', '开始扫描', `通配符 ${filterText}`);
    } catch (err) {
      toast('error', '启动扫描失败', errMsg(err));
    }
  };

  const stopScan = async (): Promise<void> => {
    const connId = act().connectionId;
    if (!connId) return;
    try {
      await api.scanStop(connId);
      await reloadConnection();
      toast('info', '已停止扫描', `共 ${act().topics.size} 个主题`);
    } catch (err) {
      toast('error', '停止失败', errMsg(err));
    }
  };

  const clearTopics = async (): Promise<void> => {
    act().clearTopics();
    const connId = act().connectionId;
    if (!connId) return;
    try {
      await api.scanClear(connId);
    } catch {
      /* 连接可能已断开，本地清空已经生效 */
    }
  };

  const exportTopics = async (): Promise<void> => {
    const list = filterTopics(act().topics.values(), act().topicSearch);
    if (!list.length) {
      toast('warn', '无数据', '当前没有可导出的主题');
      return;
    }

    const kind = await dialog.choose('导出主题列表', `共 ${list.length} 个主题`, [
      { value: 'txt', label: '纯文本（每行一个主题）', desc: '便于直接粘贴到订阅框' },
      { value: 'csv', label: 'CSV 表格', desc: '含消息数与最后出现时间' },
      { value: 'json', label: 'JSON', desc: '完整字段' },
    ]);
    if (!kind) return;

    const rows = list.map((t) => ({
      topic: t.topic,
      count: t.count,
      lastSeen: new Date(t.ts).toISOString(),
    }));

    let content: string;
    if (kind === 'csv') {
      content = `\ufeff${['topic,count,lastSeen', ...rows.map((r) => `"${r.topic}",${r.count},${r.lastSeen}`)].join('\r\n')}`;
    } else if (kind === 'json') {
      content = JSON.stringify(rows, null, 2);
    } else {
      content = rows.map((r) => r.topic).join('\r\n');
    }

    try {
      const res = await api.saveText({
        title: '导出主题',
        defaultName: `xmqtt-topics-${Date.now()}.${kind}`,
        content,
        filters: [{ name: kind.toUpperCase(), extensions: [kind] }],
      });
      if (res.saved) toast('success', '已导出', `${list.length} 个主题`);
    } catch (err) {
      toast('error', '导出失败', errMsg(err));
    }
  };

  /* ------------------------------ 派生数据 ------------------------------ */

  const subs = useMemo(() => (conn ? conn.subscriptions.filter((s) => !s.isScan) : []), [conn]);

  /** 主题是否已被某个订阅过滤器覆盖（含通配符覆盖） */
  const isCovered = useCallback(
    (topic: string) => subs.some((s) => topicMatches(s.topic, topic)),
    [subs]
  );
  const exactFilter = useCallback(
    (topic: string) => subs.find((s) => s.topic === topic)?.topic ?? null,
    [subs]
  );

  const rows = useMemo(() => {
    const list = filterTopics(topics.values(), topicSearch);
    return treeMode ? flattenTopicTree(buildTopicTree(list), collapsed) : flatTopicRows(list);
  }, [topics, topicSearch, treeMode, collapsed]);

  const visible = useMemo(() => messages.filter((m) => matchMessage(m, filter)), [messages, filter]);

  /*
   * 「自动滚动」不只滚表格，也把选中项跟到最新一条 —— 右侧详情因此一直在刷新
   * 最新报文，不用每来一条都去点一下。
   *
   * 判据用最新那条的 uid，不用 messages.length：达到 `maxMessagesPerSub` 之后
   * 主进程会截尾，长度不再增长，用长度判断就再也跟不动了。
   * 只在「最新一条换了」时写一次 store —— 用户主动点开旧报文后，选中态保持到
   * 下一条报文到达，不会被每帧抢回来。
   */
  const newest = visible.length ? visible[visible.length - 1] : null;
  const newestUid = newest?.uid ?? null;

  useEffect(() => {
    if (!autoScroll || !newest) return;
    if (act().selectedMessage?.uid === newest.uid) return;
    act().selectMessage(newest);
    // newest 由 newestUid 派生，只认 uid 变化；把对象列进依赖会每条消息都重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoScroll, newestUid]);

  const scanning = !!conn?.scan?.active;
  const scanState = scanning
    ? `扫描中 · ${fmtDuration(now - (conn?.scan?.startedAt ?? 0))}`
    : topics.size
      ? '已停止'
      : '未开始';

  /* ------------------------------ 消息速率 ------------------------------ */

  const arrivals = useRef<number[]>([]);
  const prevCount = useRef(0);

  useEffect(() => {
    const delta = messages.length - prevCount.current;
    prevCount.current = messages.length;
    if (delta > 0) {
      const stamp = Date.now();
      for (let i = 0; i < delta; i += 1) arrivals.current.push(stamp);
    } else if (delta < 0) {
      // 清空或换代：窗口跟着重置，否则速率会显示上一连接的残留值
      arrivals.current = [];
    }
  }, [messages]);

  useEffect(() => {
    const timer = setInterval(() => {
      const cutoff = Date.now() - 1000;
      arrivals.current = arrivals.current.filter((t) => t >= cutoff);
      setRate(arrivals.current.length);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  /* ------------------------------ 虚拟滚动 ------------------------------ */

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => wrapRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });

  /*
   * 行高变了（鼠标 ↔ 触屏）必须让虚拟列表丢掉已测量的尺寸重算一遍。
   * 不调用 measure() 的话，它仍然按旧行高算总高度：
   * 44px 的行配 28px 的账，滚到底会差出几千像素。
   */
  useEffect(() => {
    virtualizer.measure();
    // virtualizer 的方法引用每次渲染都变，列入依赖会无限循环
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowHeight]);

  const items = virtualizer.getVirtualItems();
  const padTop = items.length ? items[0].start : 0;
  const padBottom = items.length ? virtualizer.getTotalSize() - items[items.length - 1].end : 0;

  /**
   * 贴底跟随：只有本来就在底部附近才跟着滚。
   * 用户往上翻历史时被强行拉回底部，是消息面板最招人烦的行为。
   *
   * `active` 也在依赖里：本视图被切走时容器高度是 0，虚拟列表一行都不渲染
   * （这正是它省内存的原因）；切回来时要补一次定位，否则看到的是列表顶部。
   */
  useEffect(() => {
    if (!autoScroll || !visible.length) return;
    const host = wrapRef.current;
    if (!host) return;
    const nearBottom = host.scrollHeight - host.scrollTop - host.clientHeight < rowHeight * 3;
    if (!nearBottom) return;
    virtualizer.scrollToIndex(visible.length - 1, { align: 'end' });
    // virtualizer 的方法引用在每次渲染后都会变，列入依赖会造成无限循环
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible.length, autoScroll, active]);

  /* ------------------------------ 导出消息 ------------------------------ */

  const csvEscape = (v: unknown): string => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const exportMessages = async (): Promise<void> => {
    const list = messages.filter((m) => matchMessage(m, filter));
    if (!list.length) {
      toast('warn', '无数据', '当前没有可导出的消息');
      return;
    }

    const kind = await dialog.choose('导出格式', '选择导出文件的格式', [
      { value: 'csv', label: 'CSV 表格', desc: '时间/主题/QoS/长度/内容，便于 Excel 打开' },
      { value: 'json', label: 'JSON 数组', desc: '保留完整字段，便于程序再处理' },
      { value: 'txt', label: '纯文本', desc: '每条一行：[时间] 主题 | 内容' },
    ]);
    if (!kind) return;

    let content: string;
    if (kind === 'csv') {
      const head = 'time,topic,qos,retain,dup,bytes,payload';
      const body = list.map((m: UiMessage) =>
        [fmtDateTime(m.ts), m.topic, m.qos, m.retain, m.dup, m.bytes, m.payload].map(csvEscape).join(',')
      );
      // BOM 让 Excel 正确识别 UTF-8 中文
      content = `\ufeff${[head, ...body].join('\r\n')}`;
    } else if (kind === 'json') {
      content = JSON.stringify(
        list.map(({ ts, topic, qos, retain, dup, bytes, payload }) => ({
          time: new Date(ts).toISOString(),
          topic,
          qos,
          retain,
          dup,
          bytes,
          payload,
        })),
        null,
        2
      );
    } else {
      content = list.map((m) => `[${fmtDateTime(m.ts)}] ${m.topic} | ${m.payload}`).join('\r\n');
    }

    try {
      const res = await api.saveText({
        title: '导出消息',
        defaultName: `xmqtt-messages-${Date.now()}.${kind}`,
        content,
        filters: [{ name: kind.toUpperCase(), extensions: [kind] }],
      });
      if (res.saved) toast('success', '已导出', `${list.length} 条消息`);
    } catch (err) {
      toast('error', '导出失败', errMsg(err));
    }
  };

  /* ------------------------------ 详情面板 ------------------------------ */

  const detailText = selected ? reencode(String(selected.payload), detailEncoding) : '';
  const detailPretty =
    selected && detailEncoding === 'utf8' && detailFormatted ? tryFormatJson(detailText) : null;

  const search = useMemo(() => debounce((text: string) => act().setTopicSearch(text.trim()), 160), []);

  /* ------------------------------ 渲染 ------------------------------ */

  return (
    <section className={`view${active ? ' is-active' : ''}`} id="view-browser">
      {/*
        窄档位里左栏是抽屉（CSS 用 translateX 移出画面，不是 display:none ——
        树的展开态、滚动位置、已订阅列表全部原地保留）。
        宽档位 is-drawer-open 没有任何样式消费，DOM 结构完全不变。
      */}
      <div
        className={`split split--browser${drawerOpen ? ' is-drawer-open' : ''}`}
        ref={splitRef}
        style={treeSplit.style}
      >
        {/* 遮罩：只在窄档位抽屉展开时可点，宽档位 pointer-events 恒为 none */}
        <div
          className="scrim"
          id="treeScrim"
          data-testid="tree-scrim"
          aria-hidden="true"
          onClick={() => act().setDrawer(false)}
        />
        {/* ======================= 左：主题工作台 ======================= */}
        {/*
          自上而下：订阅输入 → 已订阅 → 拖动分隔栏 → 主题扫描（控件 + 树）。
          grid 换成 flex 就是为了中间这条分隔栏：它要给「已订阅」一个确定高度，
          同时让树吃掉剩下的全部高度，grid 的 fr 做不到这一点。
        */}
        <div
          className="pane pane--workbench"
          ref={paneRef}
          style={subsSplit.style}
        >
          <div className="wb-block">
            <div className="field__row">
              <input
                id="subTopic"
                ref={subTopicRef}
                className="input input--sm"
                type="text"
                placeholder="订阅主题：sensor/+/temp 或 factory/#"
                spellCheck={false}
                autoComplete="off"
                data-testid="sub-topic"
                value={subTopic}
                onChange={(e) => setSubTopic(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  const topic = subTopic.trim();
                  if (!topic) return;
                  void subscribeTopic(topic, Number(subQos) || 0).then(() => setSubTopic(''));
                }}
              />
              <select
                id="subQos"
                className="select select--sm"
                title="订阅 QoS"
                data-testid="sub-qos"
                value={subQos}
                onChange={(e) => setSubQos(e.target.value)}
              >
                {QOS_LIST.map((q) => (
                  <option key={q} value={q}>
                    Q{q}
                  </option>
                ))}
              </select>
              <Button
                variant="primary"
                size="sm"
                id="subAdd"
                className="needs-connection"
                disabled={!connected}
                data-testid="sub-add"
                onClick={() => {
                  const topic = subTopic.trim();
                  if (!topic) {
                    toast('warn', '主题为空', '请输入主题或通配符，例如 sensor/+/temp');
                    subTopicRef.current?.focus();
                    return;
                  }
                  void subscribeTopic(topic, Number(subQos) || 0).then(() => setSubTopic(''));
                }}
              >
                订阅
              </Button>
            </div>
          </div>

          {/* 已订阅：高度由下面的分隔栏决定，列表在内部滚动，不吃树的地方 */}
          <div className="wb-subs" ref={subsRef}>
            <div className="wb-head">
              <span className="wb-title">已订阅</span>
              <span className="chip" id="subCount" data-testid="sub-count">
                {subs.length}
              </span>
            </div>
            <div className="wb-subs__list" id="subList" data-testid="sub-list">
              {!conn ? (
                <Empty>未连接。连接后可在此管理订阅。</Empty>
              ) : subs.length ? (
                subs.map((sub) => (
                  <SubItem
                    key={sub.topic}
                    sub={sub}
                    live={connected}
                    onFill={setSubTopic}
                    onMute={(topic, muted) => void setMuted(topic, muted)}
                    onUnsubscribe={(topic) => void unsubscribeTopic(topic)}
                    onEncoding={(topic, encoding) => void setEncoding(topic, encoding)}
                  />
                ))
              ) : (
                <Empty>暂无订阅。在上方输入主题后点「订阅」，或扫描主题后点主题行。</Empty>
              )}
            </div>
          </div>

          {/*
            分隔栏：拖动改已订阅区的高度（键盘上下键可调，双击复位）。
            扫描时看树、核对订阅时看列表 —— 固定比例总有一边不够用，
            所以这个比例交给手，不写死在 CSS 里。
          */}
          <Resizer api={subsSplit} label="拖动调整已订阅区域高度" testId="wb-resizer" />

          <div className="wb-block">
            <div className="wb-head">
              <span className="wb-title">主题扫描</span>
              <span className="chip" id="scanCount" data-testid="scan-count">
                {topics.size ? `${fmtNumber(topics.size)} 个` : '0'}
              </span>
              <span className="hint" id="scanState" data-testid="scan-state">
                {scanState}
              </span>
            </div>

            <div className="field__row">
              <input
                id="scanFilter"
                className="input input--sm"
                type="text"
                spellCheck={false}
                title="扫描用的通配符过滤器，默认 # 表示全量"
                data-testid="scan-filter"
                disabled={scanning}
                value={scanFilter}
                onChange={(e) => setScanFilter(e.target.value)}
              />
              <Button
                variant="primary"
                size="sm"
                id="scanStart"
                className="needs-connection"
                disabled={!connected || scanning}
                data-testid="scan-start"
                onClick={() => void startScan()}
              >
                开始
              </Button>
              <Button
                size="sm"
                id="scanStop"
                className="needs-connection"
                disabled={!scanning}
                data-testid="scan-stop"
                onClick={() => void stopScan()}
              >
                停止
              </Button>
            </div>

            <div className="field__row">
              <input
                id="scanSearch"
                className="input input--sm"
                type="search"
                placeholder="搜索主题"
                spellCheck={false}
                data-testid="scan-search"
                disabled={topics.size === 0}
                value={searchText}
                onChange={(e) => {
                  setSearchText(e.target.value);
                  search(e.target.value);
                }}
              />
              <Button
                size="sm"
                id="scanTreeMode"
                active={treeMode}
                className={treeMode ? 'is-on' : ''}
                title="在树形 / 平铺之间切换"
                data-testid="scan-tree-mode"
                onClick={() => act().setTreeMode(!act().treeMode)}
              >
                {treeMode ? '树形' : '平铺'}
              </Button>
              <Button size="sm" id="scanClear" data-testid="scan-clear" onClick={() => void clearTopics()}>
                清空
              </Button>
              <Button size="sm" id="scanExport" data-testid="scan-export" onClick={() => void exportTopics()}>
                导出
              </Button>
            </div>
          </div>

          <div className="wb-tree" id="topicTree" data-testid="topic-tree">
            {rows.length ? (
              rows.map((row) => (
                <TopicRow
                  key={row.node.path}
                  node={row.node}
                  depth={row.depth}
                  subscribed={row.node.leaf ? isCovered(row.node.path) : false}
                  exact={row.node.leaf ? exactFilter(row.node.path) : null}
                  onToggle={(node) => act().toggleCollapsed(node.path)}
                  onSubscribe={(topic, qos) => void subscribeTopic(topic, qos)}
                  onUnsubscribe={(topic) => void unsubscribeTopic(topic)}
                />
              ))
            ) : (
              <Empty>
                {topics.size
                  ? '没有匹配的主题'
                  : '还没有主题。连接后点上面「开始」扫描 broker 上的主题，扫到的主题点一下即可订阅。'}
              </Empty>
            )}
          </div>
        </div>

        {/* 主题栏 / 消息栏之间的竖直分隔条：窄到只剩表格、或者长主题要看全时，比例交给手 */}
        <Resizer api={treeSplit} label="拖动调整主题栏宽度" testId="browser-split" />

        {/* ========================= 右：消息 ========================= */}
        <div className="pane pane--messages">
          <div className="pane__head">
            {/*
              抽屉唤出入口。宽档位里 `only-narrow` 是 display:none ——
              树本来就在左栏，多一个按钮只会挤掉过滤框。
            */}
            <button
              type="button"
              className="btn btn--icon only-narrow"
              id="msgDrawerBtn"
              data-testid="msg-drawer-btn"
              title="主题树"
              aria-expanded={drawerOpen}
              onClick={() => act().setDrawer(!act().drawerOpen)}
            >
              <Icon name="menu" />
            </button>

            <h2 className="pane__title">
              消息
              <span className="chip" id="msgCount" data-testid="msg-count">
                {fmtNumber(messages.length)}
              </span>
              <span className="chip chip--muted whitespace-nowrap" id="msgRate" data-testid="msg-rate">
                {`${rate}/s`}
              </span>
            </h2>

            <div className="pane__actions">
              <input
                id="msgFilter"
                className="input input--sm"
                type="search"
                placeholder="过滤 主题 / 内容"
                spellCheck={false}
                data-testid="msg-filter"
                value={filter}
                onChange={(e) => act().setMessageFilter(e.target.value)}
              />
              <label className="checkbox" title="开启后表格跟随最新报文滚动，右侧详情自动显示最新一条">
                <input
                  id="msgAutoScroll"
                  type="checkbox"
                  data-testid="msg-auto-scroll"
                  checked={autoScroll}
                  onChange={(e) => {
                    setAutoScroll(e.target.checked);
                    api.patchSettings({ autoScroll: e.target.checked }).catch(() => {});
                  }}
                />
                <span>自动滚动</span>
              </label>
              <Button size="sm" id="msgExport" data-testid="msg-export" onClick={() => void exportMessages()}>
                导出
              </Button>
              <Button size="sm" id="msgClear" data-testid="msg-clear" onClick={() => act().clearMessages()}>
                清空
              </Button>
            </div>
          </div>

          <div className="pane__body pane__body--messages" ref={msgBodyRef}>
            <div className="table-wrap" id="msgTableWrap" ref={wrapRef}>
              <table className="table" id="msgTable">
                <thead>
                  <tr>
                    {/* 列宽在 CSS 里（.col-*），这里只声明语义 —— 窄档位要减列 */}
                    <th className="col-time">时间</th>
                    <th className="col-qos">QoS</th>
                    <th className="col-rd">R/D</th>
                    <th className="col-topic">主题</th>
                    <th className="col-len">长度</th>
                    <th className="col-prev">内容预览</th>
                  </tr>
                </thead>
                <tbody id="msgBody" data-testid="msg-body">
                  {/* 上下两个垫片把窗口外的行「占位」出来，滚动条长度才等于真实行数 */}
                  {padTop > 0 && (
                    <tr style={{ height: padTop }}>
                      <td colSpan={6} style={{ height: padTop, padding: 0, border: 0 }} />
                    </tr>
                  )}

                  {items.map((vi) => {
                    const m = visible[vi.index];
                    if (!m) return null;
                    return (
                      <tr
                        key={m.uid}
                        data-uid={m.uid}
                        data-testid="msg-row"
                        className={selected?.uid === m.uid ? 'is-selected' : ''}
                        onClick={() => act().selectMessage(m)}
                      >
                        <td className="col-time cell-time">
                          {fmtTime(m.ts, false)}
                          <span className="cell-time__ms">{fmtMs(m.ts)}</span>
                        </td>
                        <td className="col-qos">{m.qos}</td>
                        <td className="col-rd">{`${m.retain ? 'R' : '-'}${m.dup ? 'D' : '-'}`}</td>
                        <td className="col-topic cell-mono" title={m.topic}>
                          {m.topic}
                        </td>
                        <td className="col-len cell-mono">{fmtBytes(m.bytes)}</td>
                        <td className="col-prev cell-preview" title={preview(m.payload, 400)}>
                          {preview(m.payload)}
                        </td>
                      </tr>
                    );
                  })}

                  {padBottom > 0 && (
                    <tr style={{ height: padBottom }}>
                      <td colSpan={6} style={{ height: padBottom, padding: 0, border: 0 }} />
                    </tr>
                  )}

                  {!visible.length && (
                    <tr>
                      <td className="cell-empty" colSpan={6}>
                        {messages.length
                          ? '没有匹配的消息'
                          : '尚无消息。连接后订阅主题，收到的报文会实时出现在这里。'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* 表格 / 详情之间的横向分隔条：报文长短差异很大，40% 的固定比例总有一边不够 */}
            <Resizer api={detailSplit} label="拖动调整详情面板高度" testId="detail-split" />

            <div className={`msg-detail${detailOpen ? ' is-open' : ''}`} id="msgDetail" ref={detailRef} style={detailSplit.style}>
              {/*
                整个头部都是折叠开关（窄档位才折叠）。头部里的按钮 / 下拉必须
                排除在外 —— 点「复制内容」顺手把面板收了是最容易被骂的交互。
              */}
              <div
                className="msg-detail__head"
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest('button, select, input, label')) return;
                  setDetailOpen((v) => !v);
                }}
              >
                <span className="msg-detail__grip" aria-hidden="true">
                  <Icon name="chevron-down" size={13} />
                </span>
                <span className="msg-detail__topic" id="detailTopic" data-testid="detail-topic">
                  {selected
                    ? `${selected.topic}   ·   ${fmtTime(selected.ts)}   ·   ${fmtBytes(selected.bytes)}   ·   QoS ${selected.qos}`
                    : '未选中消息'}
                </span>

                <div className="msg-detail__actions">
                  <select
                    id="detailEncoding"
                    className="select select--xs"
                    data-testid="detail-encoding"
                    value={detailEncoding}
                    onChange={(e) => act().setDetailEncoding(e.target.value as PayloadEncoding)}
                  >
                    {ENCODINGS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    id="detailFormat"
                    active={detailFormatted}
                    className={detailFormatted ? 'is-on' : ''}
                    data-testid="detail-format"
                    onClick={() => act().setDetailFormatted(!act().detailFormatted)}
                  >
                    格式化 JSON
                  </Button>
                  <Button
                    size="sm"
                    id="detailCopyTopic"
                    data-testid="detail-copy-topic"
                    disabled={!selected}
                    onClick={() => {
                      if (!selected) return;
                      void copyText(selected.topic).then(() => toast('success', '已复制主题', selected.topic));
                    }}
                  >
                    复制主题
                  </Button>
                  <Button
                    size="sm"
                    id="detailCopyPayload"
                    data-testid="detail-copy-payload"
                    disabled={!selected}
                    onClick={() => {
                      if (!selected) return;
                      const text = String(selected.payload);
                      void copyText(text).then(() =>
                        toast('success', '已复制内容', `${text.length} 字符`)
                      );
                    }}
                  >
                    复制内容
                  </Button>
                  <Button
                    size="sm"
                    id="detailUseTopic"
                    data-testid="detail-use-topic"
                    disabled={!selected}
                    onClick={() => {
                      if (!selected) return;
                      act().setPublishDraft({ topic: selected.topic });
                      switchView('publish');
                      toast('info', '已填入发布主题', selected.topic);
                    }}
                  >
                    填入发布
                  </Button>
                </div>
              </div>

              {/* 窄档位折叠的就是这一层；宽档位它只是个撑满的 flex 容器 */}
              <div className="msg-detail__body">
                {detailPretty !== null ? (
                  // highlightJson 内部先 escapeHtml 再插着色标签，插值安全
                  <pre
                    className="code-view"
                    id="detailPayload"
                    data-testid="detail-payload"
                    dangerouslySetInnerHTML={{ __html: highlightJson(detailPretty) }}
                  />
                ) : (
                  <pre className="code-view" id="detailPayload" data-testid="detail-payload">
                    {selected ? detailText || '(空载荷)' : '选择上方任意一条消息查看完整内容。'}
                  </pre>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/** 供类型检查确认 `CollectedTopic` 在只做类型推导时也被引用 */
export type { CollectedTopic };
