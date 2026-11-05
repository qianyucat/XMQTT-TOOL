/**
 * 预加载脚本
 * ------------------------------------------------------------------
 * 渲染层跑在 contextIsolation 下，没有 node 能力，只能看到这里显式暴露的 window.xmqtt。
 *
 * 事件订阅采用白名单：渲染层无法自行 ipcRenderer.on 任意通道，
 * 既收窄了攻击面，也让「主进程会推哪些事件」在一处可见。
 *
 * 形状由 `src/shared/bridge.ts` 的 XmqttBridge 约束 —— 少实现一个方法、
 * 或把通道名写错（通道名一律取 INVOKE 常量），编译期就报错。
 */

import { contextBridge, ipcRenderer } from 'electron';
import { EVENT_CHANNELS, INVOKE } from '../shared/channels';
import type {
  EventChannel,
  InvokeArgsOf,
  InvokeChannel,
  InvokeResultOf,
  IpcResponse,
} from '../shared/channels';
import type { On, XmqttBridge } from '../shared/bridge';

/*
 * ipcRenderer.invoke 自身是无类型的（`Promise<any>`），
 * 这里按通道把入参元组与返回类型从 InvokeMap 推导出来，
 * 于是 `call(INVOKE.serversSave, 123)` 这种写错参数的调用会直接编译失败。
 *
 * `& unknown[]` 是为了让 TS 把泛型实参认成数组 —— 否则 rest 参数收不了元组。
 */
const call = <C extends InvokeChannel>(
  channel: C,
  ...args: InvokeArgsOf<C> & unknown[]
): Promise<IpcResponse<InvokeResultOf<C>>> => ipcRenderer.invoke(channel, ...args);

/*
 * 平台标识与玻璃档位尽早写到 <html> 上。
 * 目的不是给 JS 判断用（那有 app.info().platform），而是让 CSS 在首帧就按平台
 * 排好版 —— macOS 的红绿灯按钮压在左上角，顶栏要让出位置；Windows 则是右侧的
 * 最小化/最大化/关闭。晚一帧写就会看到内容先闪一下再跳位。
 *
 * 玻璃档位同理，而且更要紧：液态玻璃要求窗口是透明的，样式晚一帧生效就会先看到
 * 一块没有底色的空白。档位由主进程通过 additionalArguments 传进来，不走 IPC ——
 * IPC 是异步的，等它回来首帧已经画完了。
 */
const GLASS_FLAG = '--xmqtt-glass=';
const GLASS_MODES = ['liquid', 'vibrancy', 'css'] as const;

function readGlassMode(): string {
  const hit = process.argv.find((arg) => arg.startsWith(GLASS_FLAG));
  const value = hit ? hit.slice(GLASS_FLAG.length) : '';
  // 白名单校验：这个值会被写进 DOM 属性，不接受任何没见过的字符串
  return (GLASS_MODES as readonly string[]).includes(value) ? value : 'css';
}

(function markShell(): void {
  const root = document.documentElement;
  if (root) {
    root.dataset.platform = process.platform;
    root.dataset.glass = readGlassMode();
    return;
  }
  document.addEventListener('DOMContentLoaded', markShell, { once: true });
})();

const on: On = (channel: EventChannel, callback: (payload: never) => void) => {
  if (!EVENT_CHANNELS.includes(channel)) {
    throw new Error(`不允许订阅的事件通道: ${channel}`);
  }
  const listener = (_evt: unknown, payload: unknown) => {
    try {
      (callback as (p: unknown) => void)(payload);
    } catch (err) {
      console.error(`[preload] ${channel} 处理异常:`, err);
    }
  };
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
};

const bridge: XmqttBridge = {
  /* ------------------------------ 应用 ------------------------------ */
  app: {
    info: () => call(INVOKE.appInfo),
    getSettings: () => call(INVOKE.settingsGet),
    patchSettings: (patch) => call(INVOKE.settingsPatch, patch),
    exportConfig: () => call(INVOKE.configExport),
    importConfig: (payload) => call(INVOKE.configImport, payload),
  },

  /* ------------------------------ 连接 ------------------------------ */
  servers: {
    list: () => call(INVOKE.serversList),
    save: (server) => call(INVOKE.serversSave, server),
    remove: (id) => call(INVOKE.serversDelete, id),
  },

  /* ------------------------------ 模板 ------------------------------ */
  templates: {
    list: () => call(INVOKE.templatesList),
    save: (tpl) => call(INVOKE.templatesSave, tpl),
    remove: (id) => call(INVOKE.templatesDelete, id),
  },

  /* ------------------------------ 历史 ------------------------------ */
  history: {
    list: () => call(INVOKE.historyList),
    push: (entry) => call(INVOKE.historyPush, entry),
    clear: () => call(INVOKE.historyClear),
  },

  /* ------------------------------ MQTT ------------------------------ */
  mqtt: {
    connect: (cfg) => call(INVOKE.mqttConnect, cfg),
    disconnect: (id) => call(INVOKE.mqttDisconnect, id),
    remove: (id) => call(INVOKE.mqttRemove, id),
    state: (id) => call(INVOKE.mqttState, id),
    states: () => call(INVOKE.mqttStates),
    subscribe: (id, topic, qos, opts) => call(INVOKE.mqttSubscribe, id, topic, qos, opts),
    unsubscribe: (id, topic) => call(INVOKE.mqttUnsubscribe, id, topic),
    setMuted: (id, topic, muted) => call(INVOKE.mqttMute, id, topic, muted),
    setEncoding: (id, topic, encoding) => call(INVOKE.mqttEncoding, id, topic, encoding),
    publish: (id, payload) => call(INVOKE.mqttPublish, id, payload),
  },

  /* ---------------------------- 主题扫描 ---------------------------- */
  scan: {
    start: (id, filter) => call(INVOKE.scanStart, id, filter),
    stop: (id) => call(INVOKE.scanStop, id),
    clear: (id) => call(INVOKE.scanClear, id),
    collected: (id) => call(INVOKE.scanCollected, id),
  },

  /* ---------------------------- 文件能力 ---------------------------- */
  file: {
    saveText: (payload) => call(INVOKE.fileSaveText, payload),
    readText: () => call(INVOKE.fileReadText),
    reveal: (filePath) => call(INVOKE.fileReveal, filePath),
  },

  /* ---------------------------- 事件订阅 ---------------------------- */
  on,
};

contextBridge.exposeInMainWorld('xmqtt', bridge);
