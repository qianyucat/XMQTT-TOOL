/**
 * 渲染层状态容器（zustand）
 * ------------------------------------------------------------------
 * 阶段 3 把 `state.js` 那个「单个可变对象 + 手写派生函数」换成 zustand。
 * 换的不是数据形状，而是**通知机制**：把可变对象换成不可变更新，React 才能
 * 按片订阅、只在真正相关的字段变化时重渲染。
 *
 * 三条约定，改了会连锁出问题：
 *
 * 1. **所有写操作走 action，禁止 `getState().messages.push(...)`。**
 *    Map / Set / 数组必须换新实例（`new Map(prev)`、`concat`），
 *    否则引用不变，订阅者收不到通知 —— 阶段 3 前期的 badge 不刷新就是这么来的。
 * 2. **派生值不进 store**（`activeConn` / `isConnected` / `selectedServer`）。
 *    它们是本文件底部的纯选择器，进了 store 就得手动同步，
 *    等于把「单一真相」变成两份。
 * 3. **主进程仍是唯一真相源。** 这里只是「主进程推过来的快照 + 纯界面态」，
 *    连接、订阅、主题的真实状态都在 `mqtt-manager.js` 里，渲染层不自作主张。
 */

import { create } from 'zustand';
import type {
  AppInfo,
  AppSettings,
  ConnectionState,
  LogEntry,
  MessageTemplate,
  PayloadEncoding,
  PublishHistoryEntry,
  PublishRequest,
  ServerConfig,
  Subscription,
  TopicDeltaEvent,
} from '@shared/models';
import type { AppState, UiMessage, ViewName } from './types';

/** store 比 `AppState` 多一个 `now`：页面级的「心跳」，用于刷新运行时长这类时间派生值 */
export interface AppStoreState extends AppState {
  now: number;
}

/** 发布表单的初始值：新建草稿与「清空」共用一份，避免两处各写一遍默认值 */
export const EMPTY_DRAFT: PublishRequest = {
  topic: '',
  qos: 0,
  retain: false,
  encoding: 'utf8',
  payload: '',
};

export interface AppActions {
  /* 应用级 */
  setInfo(info: AppInfo | null): void;
  setMaxMessages(limit: number): void;
  /** 只合并、不整体替换 —— 主进程 patchSettings 返回的是完整值，但前端可能先拿到局部 */
  mergeSettings(patch: Partial<AppSettings>): void;
  setSettings(settings: Partial<AppSettings>): void;

  /* 配置数据 */
  setServers(servers: ServerConfig[]): void;
  setTemplates(templates: MessageTemplate[]): void;
  setHistory(history: PublishHistoryEntry[]): void;
  setSelectedServer(id: string | null): void;

  /* 连接 */
  setConnectionId(id: string | null): void;
  upsertConnection(snapshot: ConnectionState): void;

  /* 发布表单 */
  setPublishDraft(patch: Partial<PublishRequest>): void;
  resetPublishDraft(): void;

  /* 消息 */
  pushMessages(batch: UiMessage[]): void;
  clearMessages(): void;
  setMessageFilter(text: string): void;
  selectMessage(message: UiMessage | null): void;
  setDetailEncoding(encoding: PayloadEncoding): void;
  setDetailFormatted(formatted: boolean): void;

  /* 主题 */
  applyTopicDelta(delta: TopicDeltaEvent): void;
  clearTopics(): void;
  setTopicSearch(text: string): void;
  setTreeMode(tree: boolean): void;
  toggleCollapsed(path: string): void;

  /* 日志 */
  pushLog(entry: LogEntry): void;
  clearLogs(): void;

  /* 外壳 */
  setView(view: ViewName): void;
  setDrawer(open: boolean): void;
  heartbeat(): void;
}

export type AppStore = AppStoreState & AppActions;

const INITIAL: AppStoreState = {
  info: null,
  settings: {},
  servers: [],
  templates: [],
  history: [],

  selectedServerId: null,
  connectionId: null,
  connections: new Map(),

  publishDraft: { ...EMPTY_DRAFT },

  messages: [],
  maxMessages: 5000,
  messageFilter: '',
  selectedMessage: null,
  detailEncoding: 'utf8',
  detailFormatted: false,

  topics: new Map(),
  topicSearch: '',
  treeMode: true,
  collapsedPaths: new Set(),

  logs: [],
  maxLogs: 2000,

  view: 'publish',
  drawerOpen: false,
  now: Date.now(),
};

export const useAppStore = create<AppStore>((set) => ({
  ...INITIAL,

  /* ------------------------------ 应用 ------------------------------ */

  setInfo: (info) => set({ info }),
  setMaxMessages: (limit) => set({ maxMessages: Math.max(100, limit) }),
  mergeSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
  setSettings: (settings) => set({ settings }),

  /* ------------------------------ 配置 ------------------------------ */

  setServers: (servers) => set({ servers }),
  setTemplates: (templates) => set({ templates }),
  setHistory: (history) => set({ history }),
  setSelectedServer: (selectedServerId) => set({ selectedServerId }),

  /* ------------------------------ 连接 ------------------------------ */

  setConnectionId: (connectionId) => set({ connectionId }),
  upsertConnection: (snapshot) =>
    set((s) => {
      const connections = new Map(s.connections);
      connections.set(snapshot.id, snapshot);
      return { connections };
    }),

  /* ---------------------------- 发布表单 ---------------------------- */

  setPublishDraft: (patch) => set((s) => ({ publishDraft: { ...s.publishDraft, ...patch } })),
  resetPublishDraft: () => set({ publishDraft: { ...EMPTY_DRAFT } }),

  /* ------------------------------ 消息 ------------------------------ */

  pushMessages: (batch) =>
    set((s) => {
      if (!batch.length) return {};
      const next = s.messages.concat(batch);
      const over = next.length - s.maxMessages;
      return { messages: over > 0 ? next.slice(over) : next };
    }),
  clearMessages: () => set({ messages: [], selectedMessage: null }),
  setMessageFilter: (messageFilter) => set({ messageFilter }),
  selectMessage: (selectedMessage) => set({ selectedMessage }),
  setDetailEncoding: (detailEncoding) => set({ detailEncoding }),
  setDetailFormatted: (detailFormatted) => set({ detailFormatted }),

  /* ------------------------------ 主题 ------------------------------ */

  applyTopicDelta: (delta) =>
    set((s) => {
      if (delta.reset) return { topics: new Map() };
      const added = delta.added;
      if (!added || !added.length) return {};
      // 换新 Map 才能触发订阅者；扫描期这里最多 400ms 一次（主进程已合并），
      // 即使上万主题，复制一次 Map 的成本也远低于重建 DOM。
      const topics = new Map(s.topics);
      for (const t of added) topics.set(t.topic, { topic: t.topic, count: t.count, ts: t.ts });
      return { topics };
    }),
  clearTopics: () => set({ topics: new Map(), collapsedPaths: new Set() }),
  setTopicSearch: (topicSearch) => set({ topicSearch }),
  setTreeMode: (treeMode) => set({ treeMode }),
  toggleCollapsed: (path) =>
    set((s) => {
      const collapsedPaths = new Set(s.collapsedPaths);
      if (collapsedPaths.has(path)) collapsedPaths.delete(path);
      else collapsedPaths.add(path);
      return { collapsedPaths };
    }),

  /* ------------------------------ 日志 ------------------------------ */

  pushLog: (entry) =>
    set((s) => {
      const next = s.logs.concat(entry);
      const over = next.length - s.maxLogs;
      return { logs: over > 0 ? next.slice(over) : next };
    }),
  clearLogs: () => set({ logs: [] }),

  /* ------------------------------ 外壳 ------------------------------ */

  // 切视图顺手收起抽屉：抽屉属于「订阅」这一个视图，
  // 切走时还留着会在别的视图里变成一条遮罩
  setView: (view) => set({ view, drawerOpen: false }),
  setDrawer: (drawerOpen) => set({ drawerOpen }),
  heartbeat: () => set({ now: Date.now() }),
}));

/* ------------------------------------------------------------------ */
/* 选择器                                                              */
/* ------------------------------------------------------------------ */

/**
 * 当前活动连接。
 *
 * 必须写成模块级常量函数：内联箭头函数每次渲染都是新引用，
 * zustand 会认为快照变了从而无限重渲染（React 18 会直接抛 Maximum update depth）。
 */
export const selectActiveConn = (s: AppStore): ConnectionState | null =>
  s.connectionId ? s.connections.get(s.connectionId) ?? null : null;

export const selectSelectedServer = (s: AppStore): ServerConfig | null =>
  s.servers.find((item) => item.id === s.selectedServerId) ?? null;

export const selectIsConnected = (s: AppStore): boolean => {
  const conn = selectActiveConn(s);
  return conn?.status === 'connected';
};

export const selectTopicCount = (s: AppStore): number => s.topics.size;

export const selectLogErrorCount = (s: AppStore): number =>
  s.logs.reduce((n, entry) => (entry.level === 'error' ? n + 1 : n), 0);

/** 用户自己订的（不含扫描用的旁路订阅）—— 状态页、订阅列表、主题行标记都用它 */
export const selectUserSubs = (s: AppStore): Subscription[] => {
  const conn = selectActiveConn(s);
  return conn ? conn.subscriptions.filter((sub) => !sub.isScan) : [];
};

/** 扫描是否进行中 */
export const selectScanning = (s: AppStore): boolean => !!selectActiveConn(s)?.scan?.active;

/* ------------------------------------------------------------------ */
/* 命令式便捷入口（事件回调、非组件代码用）                            */
/* ------------------------------------------------------------------ */

/** 派发一个 action：`act().pushLog(entry)`，省掉到处写 `useAppStore.getState()` */
export const act = (): AppStore => useAppStore.getState();

/** 切换视图 */
export function switchView(view: ViewName): void {
  useAppStore.getState().setView(view);
}
