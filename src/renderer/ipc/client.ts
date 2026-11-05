/**
 * 渲染层 IPC 客户端
 * ------------------------------------------------------------------
 * 主进程统一返回 `{ ok, data }` / `{ ok: false, error }`。这里把它折成
 * 「成功返回 data、失败抛 Error」，业务代码就只处理正常分支，调用点统一 try/catch 弹 toast。
 *
 * 与旧的 `js/api.js` 的差别只有一处：**类型来自 `@shared` 的通道映射，不是手写**。
 * 通道名写错、参数顺序错、返回类型用错，都在编译期报出来。
 */

import type { EventChannel, EventPayloadMap, IpcResponse } from '@shared/channels';
import type {
  AppSettings,
  ConfigExport,
  MessageTemplate,
  PayloadEncoding,
  PublishHistoryEntry,
  PublishRequest,
  SaveTextRequest,
  ServerConfig,
  SubscribeOptions,
} from '@shared/models';

/**
 * 延迟取 bridge 而不是模块顶层解构。
 * 单测里可以塞一个假的 `window.xmqtt`，不必在 import 时就存在真实现。
 */
function bridge() {
  return window.xmqtt;
}

async function unwrap<T>(pending: Promise<IpcResponse<T>>): Promise<T> {
  const res = await pending;
  if (!res.ok) throw new Error(res.error || '操作失败');
  return res.data;
}

/**
 * 订阅主进程推送事件。
 * 通道白名单在 preload 侧（运行时闸门），这里是编译期闸门：传了未登记的通道会直接报错。
 * 返回值是取消订阅函数。
 *
 * 既作为 `api.on` 暴露（与旧 `js/api.js` 的形状一致），也可单独 import。
 */
export function on<C extends EventChannel>(
  channel: C,
  callback: (payload: EventPayloadMap[C]) => void
): () => void {
  return bridge().on(channel, callback);
}

export const api = {
  /* ------------------------------ 应用 ------------------------------ */
  info: () => unwrap(bridge().app.info()),
  getSettings: () => unwrap(bridge().app.getSettings()),
  patchSettings: (patch: Partial<AppSettings>) => unwrap(bridge().app.patchSettings(patch)),
  exportConfig: () => unwrap(bridge().app.exportConfig()),
  importConfig: (payload: ConfigExport | string) => unwrap(bridge().app.importConfig(payload)),

  /* ---------------------------- 连接配置 ---------------------------- */
  listServers: () => unwrap(bridge().servers.list()),
  saveServer: (server: ServerConfig) => unwrap(bridge().servers.save(server)),
  deleteServer: (id: string) => unwrap(bridge().servers.remove(id)),

  /* ---------------------------- 消息模板 ---------------------------- */
  listTemplates: () => unwrap(bridge().templates.list()),
  saveTemplate: (template: MessageTemplate) => unwrap(bridge().templates.save(template)),
  deleteTemplate: (id: string) => unwrap(bridge().templates.remove(id)),

  /* ---------------------------- 发布历史 ---------------------------- */
  listHistory: () => unwrap(bridge().history.list()),
  pushHistory: (entry: PublishHistoryEntry) => unwrap(bridge().history.push(entry)),
  clearHistory: () => unwrap(bridge().history.clear()),

  /* ------------------------------ 连接 ------------------------------ */
  connect: (config: ServerConfig) => unwrap(bridge().mqtt.connect(config)),
  disconnect: (id: string) => unwrap(bridge().mqtt.disconnect(id)),
  removeConnection: (id: string) => unwrap(bridge().mqtt.remove(id)),
  state: (id: string) => unwrap(bridge().mqtt.state(id)),
  states: () => unwrap(bridge().mqtt.states()),

  /* --------------------------- 订阅 / 发布 -------------------------- */
  subscribe: (id: string, topic: string, qos: number, options: SubscribeOptions = {}) =>
    unwrap(bridge().mqtt.subscribe(id, topic, qos, options)),
  unsubscribe: (id: string, topic: string) => unwrap(bridge().mqtt.unsubscribe(id, topic)),
  setMuted: (id: string, topic: string, muted: boolean) =>
    unwrap(bridge().mqtt.setMuted(id, topic, muted)),
  setEncoding: (id: string, topic: string, encoding: PayloadEncoding) =>
    unwrap(bridge().mqtt.setEncoding(id, topic, encoding)),
  publish: (id: string, request: PublishRequest) => unwrap(bridge().mqtt.publish(id, request)),

  /* ---------------------------- 主题扫描 ---------------------------- */
  scanStart: (id: string, filter: string) => unwrap(bridge().scan.start(id, filter)),
  scanStop: (id: string) => unwrap(bridge().scan.stop(id)),
  scanClear: (id: string) => unwrap(bridge().scan.clear(id)),
  scanCollected: (id: string) => unwrap(bridge().scan.collected(id)),

  /* ---------------------------- 文件能力 ---------------------------- */
  saveText: (request: SaveTextRequest) => unwrap(bridge().file.saveText(request)),
  readText: () => unwrap(bridge().file.readText()),
  reveal: (filePath: string) => unwrap(bridge().file.reveal(filePath)),

  /* ---------------------------- 事件订阅 ---------------------------- */
  on,
};
