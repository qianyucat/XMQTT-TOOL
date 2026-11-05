/**
 * IPC 通道名与事件载荷映射 — 单一来源
 * ------------------------------------------------------------------
 * 通道名字符串只在这里出现一次。渲染层与主进程（`src/main/ipc.ts`、`src/preload/preload.ts`）
 * 都引用同一份定义，两端手抄字符串导致拼写漂移的问题从根上消失。
 *
 * 事件白名单与 `src/preload/preload.ts` 的 EVENT_CHANNELS 必须保持一致：
 * preload 是运行时闸门，这里是编译期类型闸门，两边同源但职责不同。
 */

import type {
  AppInfo,
  AppSettings,
  ConfigExport,
  ConfigImportResult,
  ConnectionState,
  LogEntry,
  MenuEvent,
  MessageTemplate,
  MqttMessage,
  PayloadEncoding,
  PublishHistoryEntry,
  PublishRequest,
  PublishResult,
  ReadTextResult,
  SaveTextRequest,
  SaveTextResult,
  ServerConfig,
  SubscribeOptions,
  TopicDeltaEvent,
} from './models';

/* ------------------------------------------------------------------ */
/* 请求-响应通道（ipcRenderer.invoke → ipcMain.handle）                 */
/* ------------------------------------------------------------------ */

export const INVOKE = {
  /* 应用 */
  appInfo: 'app:info',
  settingsGet: 'settings:get',
  settingsPatch: 'settings:patch',
  configExport: 'config:export',
  configImport: 'config:import',

  /* 连接配置 */
  serversList: 'servers:list',
  serversSave: 'servers:save',
  serversDelete: 'servers:delete',

  /* 消息模板 */
  templatesList: 'templates:list',
  templatesSave: 'templates:save',
  templatesDelete: 'templates:delete',

  /* 发布历史 */
  historyList: 'history:list',
  historyPush: 'history:push',
  historyClear: 'history:clear',

  /* MQTT */
  mqttConnect: 'mqtt:connect',
  mqttDisconnect: 'mqtt:disconnect',
  mqttRemove: 'mqtt:remove',
  mqttState: 'mqtt:state',
  mqttStates: 'mqtt:states',
  mqttSubscribe: 'mqtt:subscribe',
  mqttUnsubscribe: 'mqtt:unsubscribe',
  mqttMute: 'mqtt:mute',
  mqttEncoding: 'mqtt:encoding',
  mqttPublish: 'mqtt:publish',

  /* 主题扫描 */
  scanStart: 'scan:start',
  scanStop: 'scan:stop',
  scanClear: 'scan:clear',
  scanCollected: 'scan:collected',

  /* 文件 */
  fileSaveText: 'file:save-text',
  fileReadText: 'file:read-text',
  fileReveal: 'file:reveal',
} as const;

export type InvokeChannel = (typeof INVOKE)[keyof typeof INVOKE];

/* ------------------------------------------------------------------ */
/* 事件通道（ipcMain → 渲染层单向推送）                                 */
/* ------------------------------------------------------------------ */

export const EVENTS = {
  /** 消息批量上推，主进程 60ms 聚合一批 */
  messages: 'mqtt:messages',
  /** 连接状态变化（serialize 后的完整快照） */
  status: 'mqtt:status',
  /** 日志单条 */
  log: 'mqtt:log',
  /** 主题扫描增量（400ms 侧由渲染层合并） */
  topics: 'scan:topics',
  /** 连接池全量变化 */
  connections: 'app:connections',
  /** 菜单动作 */
  menu: 'app:menu',
} as const;

export type EventChannel = (typeof EVENTS)[keyof typeof EVENTS];

/** 与 preload.js 的 EVENT_CHANNELS 同序同内容 */
export const EVENT_CHANNELS: readonly EventChannel[] = [
  EVENTS.messages,
  EVENTS.status,
  EVENTS.log,
  EVENTS.topics,
  EVENTS.connections,
  EVENTS.menu,
];

/* ------------------------------------------------------------------ */
/* 请求-响应类型映射                                                    */
/* ------------------------------------------------------------------ */

/**
 * 通道 → [入参元组, 返回类型]。
 *
 * 入参用元组是为了让多参通道（如 mqtt:subscribe）也能精确表达，
 * 而不是退化成 `(...args: unknown[])`。
 */
export interface InvokeMap {
  [INVOKE.appInfo]: [[], AppInfo];
  [INVOKE.settingsGet]: [[], AppSettings];
  [INVOKE.settingsPatch]: [[patch: Partial<AppSettings>], AppSettings];
  [INVOKE.configExport]: [[], ConfigExport];
  [INVOKE.configImport]: [[payload: ConfigExport | string], ConfigImportResult];

  [INVOKE.serversList]: [[], ServerConfig[]];
  [INVOKE.serversSave]: [[server: ServerConfig], ServerConfig[]];
  [INVOKE.serversDelete]: [[id: string], ServerConfig[]];

  [INVOKE.templatesList]: [[], MessageTemplate[]];
  [INVOKE.templatesSave]: [[template: MessageTemplate], MessageTemplate[]];
  [INVOKE.templatesDelete]: [[id: string], MessageTemplate[]];

  [INVOKE.historyList]: [[], PublishHistoryEntry[]];
  [INVOKE.historyPush]: [[entry: PublishHistoryEntry], PublishHistoryEntry[]];
  [INVOKE.historyClear]: [[], PublishHistoryEntry[]];

  [INVOKE.mqttConnect]: [[config: ServerConfig], ConnectionState];
  [INVOKE.mqttDisconnect]: [[id: string], ConnectionState | null];
  [INVOKE.mqttRemove]: [[id: string], true];
  [INVOKE.mqttState]: [[id: string], ConnectionState | null];
  [INVOKE.mqttStates]: [[], ConnectionState[]];
  [INVOKE.mqttSubscribe]: [
    [id: string, topic: string, qos: number, options: SubscribeOptions],
    ConnectionState,
  ];
  [INVOKE.mqttUnsubscribe]: [[id: string, topic: string], ConnectionState];
  [INVOKE.mqttMute]: [[id: string, topic: string, muted: boolean], ConnectionState];
  [INVOKE.mqttEncoding]: [
    [id: string, topic: string, encoding: PayloadEncoding],
    ConnectionState,
  ];
  [INVOKE.mqttPublish]: [[id: string, request: PublishRequest], PublishResult];

  [INVOKE.scanStart]: [[id: string, filter: string], ConnectionState];
  [INVOKE.scanStop]: [[id: string], ConnectionState];
  [INVOKE.scanClear]: [[id: string], ConnectionState];
  [INVOKE.scanCollected]: [[id: string], Array<{ topic: string; count: number; ts: number }>];

  [INVOKE.fileSaveText]: [[request: SaveTextRequest], SaveTextResult];
  [INVOKE.fileReadText]: [[], ReadTextResult];
  [INVOKE.fileReveal]: [[filePath: string], true];
}

/* ------------------------------------------------------------------ */
/* 事件载荷映射                                                        */
/* ------------------------------------------------------------------ */

export interface EventPayloadMap {
  [EVENTS.messages]: MqttMessage[];
  [EVENTS.status]: ConnectionState;
  [EVENTS.log]: LogEntry;
  [EVENTS.topics]: TopicDeltaEvent;
  [EVENTS.connections]: ConnectionState[];
  [EVENTS.menu]: MenuEvent;
}

/* ------------------------------------------------------------------ */
/* 主进程统一返回壳                                                     */
/* ------------------------------------------------------------------ */

/** ipc.js 的 handle() 统一包成这个形状，渲染层只判断 ok */
export type IpcResponse<T> = { ok: true; data: T } | { ok: false; error: string };

/** 未在 InvokeMap 里登记时的兜底（自定义通道用） */
export type UnknownChannelPayload = unknown;

/** 编译期辅助：取某个通道的入参元组 / 返回类型 */
export type InvokeArgsOf<C extends InvokeChannel> = InvokeMap[C][0];
export type InvokeResultOf<C extends InvokeChannel> = InvokeMap[C][1];
