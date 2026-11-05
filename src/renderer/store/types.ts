/**
 * 渲染层状态的形状定义
 * ------------------------------------------------------------------
 * 单独成文件是为了打断 `appStore.ts` ↔ `state.ts` 的循环引用：
 * store 需要这份类型，兼容门面需要 store 实例。类型在这里，两边都只依赖它。
 *
 * 字段含义与阶段 1 的 `store/state.ts` 完全一致 —— 这次迁移只换实现（可变对象 → zustand），
 * 不改数据形状，否则视图侧要跟着改一遍，风险与收益不成比例。
 */

import type {
  AppInfo,
  AppSettings,
  CollectedTopic,
  ConnectionState,
  LogEntry,
  MessageTemplate,
  MqttMessage,
  PayloadEncoding,
  PublishHistoryEntry,
  PublishRequest,
  ServerConfig,
} from '@shared/models';

/** 四个主视图，与 `index.html` 的 `section#view-*` 一一对应 */
export type ViewName = 'publish' | 'browser' | 'status' | 'log';

/** 渲染层消息：主进程的 `MqttMessage` 加上本层自增的 `uid` */
export interface UiMessage extends MqttMessage {
  uid: number;
}

/**
 * 渲染层状态的完整形状。
 *
 * 这里刻意**不含**派生值（activeConn / isConnected / selectedServer）：
 * 派生值放在 store 外部做纯函数选择器，React 才能按片订阅，
 * 否则每次 `connections` 变化都会让所有订阅者重渲染。
 */
export interface AppState {
  info: AppInfo | null;
  /**
   * 启动瞬间是空对象，`getSettings()` 回来之后才是完整值。
   * 用 `Partial` 而不是 `AppSettings` 是如实描述这个中间态，视图里读字段必须自带兜底。
   */
  settings: Partial<AppSettings>;
  servers: ServerConfig[];
  templates: MessageTemplate[];
  history: PublishHistoryEntry[];

  /** 当前选中的服务器配置 id（顶部下拉） */
  selectedServerId: string | null;
  /** 当前活动连接 id（已连接的 MQTT 会话） */
  connectionId: string | null;
  /** connectionId -> 主进程上报的连接状态 */
  connections: Map<string, ConnectionState>;

  /** 消息环形缓冲 */
  messages: UiMessage[];
  maxMessages: number;
  messageFilter: string;
  selectedMessage: UiMessage | null;
  detailEncoding: PayloadEncoding;
  detailFormatted: boolean;

  /** 发布表单的当前内容。放在 store 而不是组件里，因为三个视图都要往里写（模板、历史、主题行「填入发布」） */
  publishDraft: PublishRequest;
  /** 主题扫描结果 */
  topics: Map<string, CollectedTopic>;
  /** 扫描框里的搜索词 */
  topicSearch: string;
  treeMode: boolean;
  collapsedPaths: Set<string>;

  logs: LogEntry[];
  maxLogs: number;

  view: ViewName;
  /**
   * 窄档位（≤767px）下主题树抽屉是否展开。
   *
   * 宽档位里这个值恒为 false 且没有任何样式消费它 —— 树本来就是常驻左栏。
   * 放 store 而不是组件本地 state，是因为「点主题行订阅成功后自动收起抽屉」
   * 发生在树组件里，而「点表格头部的 ☰ 打开」发生在另一个组件里，
   * 两者必须共享同一份开关。
   */
  drawerOpen: boolean;
}

export type { PayloadEncoding };
