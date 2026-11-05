/**
 * 领域模型 — 主进程与渲染层共用的类型定义（单一来源）
 * ------------------------------------------------------------------
 * 这里的每个接口都对应 `src/main/mqtt-manager.js`、`src/main/store.js` 实际产出的形状，
 * 不是凭空设计的 DTO。改主进程结构时必须同步改这里，否则渲染层的类型就成了谎言。
 *
 * 约定：
 *  - 时间戳统一毫秒数字（`Date.now()`）
 *  - 编码统一小写字面量，与主进程 `decodePayload`/`encodePayload` 的 switch 对齐
 */

/** MQTT 协议族：主进程 PROTOCOL_MAP 会把这些归一到 mqtt / mqtts / ws / wss */
export type MqttProtocol = 'mqtt' | 'tcp' | 'mqtts' | 'ssl' | 'tls' | 'ws' | 'wss';

/** 与 mqtt-manager.js 的 STATUS 常量一一对应 */
export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';

/** 消息载荷的编解码方式 */
export type PayloadEncoding = 'utf8' | 'hex' | 'base64';

/** 日志分级：info 普通 / success 成功 / error 错误 */
export type LogLevel = 'info' | 'success' | 'error';

export type ThemeMode = 'dark' | 'light';

/**
 * 玻璃材质的实现档位，由主进程 `glass.ts` 在创建窗口前定好，渲染层只读不判断。
 *
 *   liquid    原生 NSGlassEffectView（macOS 26+ 且装了可选原生模块）
 *   vibrancy  原生 NSVisualEffectView（macOS 但系统更旧 / 没装模块）
 *   css       页面内 backdrop-filter（Windows / Linux，以及强制降级时）
 */
export type GlassMode = 'liquid' | 'vibrancy' | 'css';

/* ------------------------------------------------------------------ */
/* 连接配置                                                            */
/* ------------------------------------------------------------------ */

export interface WillConfig {
  topic: string;
  payload: string;
  qos: number;
  retain: boolean;
  encoding: PayloadEncoding;
}

/**
 * 服务器连接配置。
 *
 * `id` 是可选的：新建表单还没分配 id，主进程 `connect` 会在缺省时自行生成。
 * 其余字段与 `MqttManager.buildUrl` / `buildOptions` 读取的字段严格一致。
 */
export interface ServerConfig {
  id?: string;
  name?: string;
  protocol?: MqttProtocol;
  host: string;
  port: number;
  path?: string;
  clientId?: string;
  username?: string;
  password?: string;
  keepalive?: number;
  clean?: boolean;
  connectTimeout?: number;
  autoReconnect?: boolean;
  reconnectPeriod?: number;
  /** mqtt 协议版本：3 = 3.1，4 = 3.1.1，5 = 5.0 */
  protocolVersion?: number;
  autoResubscribe?: boolean;
  will?: WillConfig;
  rejectUnauthorized?: boolean;
  ca?: string;
  cert?: string;
  key?: string;
  alpnProtocols?: string;
  createdAt?: number;
  updatedAt?: number;
}

/* ------------------------------------------------------------------ */
/* 连接运行态（MqttManager.serialize 的输出）                           */
/* ------------------------------------------------------------------ */

export interface Subscription {
  topic: string;
  qos: number;
  muted: boolean;
  encoding: PayloadEncoding;
  /** 主题扫描用的旁路订阅，只贡献主题收集，不往消息列表灌数据 */
  isScan: boolean;
  received: number;
  subscribedAt: number;
}

export interface ConnectionStats {
  received: number;
  published: number;
  bytesIn: number;
  bytesOut: number;
  connectedAt: number | null;
}

export interface ScanState {
  active: boolean;
  filter: string | null;
  startedAt: number | null;
  /** 当前已收集的主题总数（只报数量，主题明细走 scan:topics 增量事件） */
  collected: number;
}

export interface ConnectionState {
  id: string;
  name: string;
  url: string;
  status: ConnectionStatus;
  error: string | null;
  /** serialize 时会把 id 补进 config，所以这里比 ServerConfig 多一个必填 id */
  config: ServerConfig & { id: string };
  uptimeMs: number;
  lastMessageAt: number | null;
  stats: ConnectionStats;
  scan: ScanState;
  subscriptions: Subscription[];
}

/* ------------------------------------------------------------------ */
/* 消息 / 主题 / 日志                                                  */
/* ------------------------------------------------------------------ */

/** 一条已解码的消息（主进程 60ms 批量聚合后推上来） */
export interface MqttMessage {
  connectionId: string;
  topic: string;
  /** 已按订阅声明的编码解码成字符串 */
  payload: string;
  bytes: number;
  qos: number;
  retain: boolean;
  dup: boolean;
  ts: number;
}

/** 主题扫描收集到的单个主题 */
export interface CollectedTopic {
  topic: string;
  ts: number;
  count: number;
}

/** scan:topics 事件：只推增量，`reset` 为真时表示清空重来 */
export interface TopicDeltaEvent {
  connectionId: string;
  added: CollectedTopic[];
  total: number;
  reset?: boolean;
}

export interface LogEntry {
  connectionId: string;
  level: LogLevel;
  message: string;
  ts: number;
}

/* ------------------------------------------------------------------ */
/* 持久化实体（store.js）                                              */
/* ------------------------------------------------------------------ */

/** 消息模板。注意字段名是 `name`（不是 title），与 publish.js 的 `tpl.name` 对应 */
export interface MessageTemplate {
  id?: string;
  name: string;
  topic: string;
  payload: string;
  qos: number;
  retain: boolean;
  encoding: PayloadEncoding;
  createdAt?: number;
  updatedAt?: number;
}

/** 发布历史条目（store.pushHistory 原样 unshift） */
export interface PublishHistoryEntry {
  topic: string;
  payload: string;
  qos: number;
  retain: boolean;
  encoding: PayloadEncoding;
  bytes?: number;
  ts: number;
  /**
   * 发布时所用连接。`store.pushHistory` 是整条 unshift，所以这个字段真的会被落盘；
   * 之前类型里漏了它，渲染层传进去要挨一记多余属性检查。
   */
  connectionId?: string;
}

/** 界面设置，与 store.js 的 DEFAULT_DATA.settings 一一对应 */
export interface AppSettings {
  theme: ThemeMode;
  maxMessagesPerSub: number;
  autoScroll: boolean;
  collectorLimit: number;
  showTimestamp: boolean;
  lastServerId: string | null;
}

/* ------------------------------------------------------------------ */
/* 应用 / IPC 载荷                                                     */
/* ------------------------------------------------------------------ */

export interface AppInfo {
  version: string;
  electron: string;
  node: string;
  chrome: string;
  platform: string;
  /** 本机实际生效的玻璃档位（`<html data-glass>` 由 preload 在首帧写好，这里供调试与关于框展示） */
  glass: GlassMode;
  configFile: string;
  /** STATUS 常量表，渲染层用它避免硬编码状态字符串 */
  statuses: Record<string, ConnectionStatus>;
}

/** config:export 的返回结构 */
export interface ConfigExport {
  version: number;
  exportedAt: string;
  servers: ServerConfig[];
  templates: MessageTemplate[];
  settings: AppSettings;
}

/** config:import 的返回结构 */
export interface ConfigImportResult {
  servers: ServerConfig[];
  templates: MessageTemplate[];
  added: number;
}

/* ------------------------------------------------------------------ */
/* 发布 / 订阅入参                                                     */
/* ------------------------------------------------------------------ */

export interface PublishRequest {
  topic: string;
  payload: string;
  qos: number;
  retain: boolean;
  encoding: PayloadEncoding;
}

export interface PublishResult {
  bytes: number;
  ts: number;
}

export interface SubscribeOptions {
  muted?: boolean;
  encoding?: PayloadEncoding;
  isScan?: boolean;
}

/* ------------------------------------------------------------------ */
/* 文件能力                                                            */
/* ------------------------------------------------------------------ */

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface SaveTextRequest {
  title?: string;
  defaultName?: string;
  filters?: FileFilter[];
  content: string;
}

export interface SaveTextResult {
  saved: boolean;
  filePath?: string;
}

export interface ReadTextResult {
  imported: boolean;
  filePath?: string;
  content?: string;
}

/** app:menu 事件载荷（主进程菜单项 → 渲染层动作） */
export type MenuEvent =
  | { action: 'export-config' }
  | { action: 'import-config' }
  | { action: 'theme'; value: ThemeMode };
