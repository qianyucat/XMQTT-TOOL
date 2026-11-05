/**
 * preload 桥的形状声明 — 主进程 / preload / 渲染层三方共用的契约
 * ------------------------------------------------------------------
 * 这份接口是 `contextBridge.exposeInMainWorld('xmqtt', {...})` 的**唯一**描述：
 *   - `src/preload/preload.ts` 把它当作待实现的类型（少写一个方法直接编译报错）
 *   - `src/renderer/global.d.ts` 把它当作 `window.xmqtt` 的类型
 *
 * 阶段 1 时它住在 `src/renderer/ipc/`（只有渲染层需要）；阶段 6 主进程 TS 化后
 * 移到 shared，让「暴露方」和「消费方」共用同一份定义，契约漂移在编译期就暴露。
 */

import { INVOKE } from './channels';
import type { EventChannel, EventPayloadMap, InvokeMap, IpcResponse } from './channels';

/** 单个 bridge 方法的签名：入参元组 → 带 ok 壳的 Promise */
export type Call<C extends keyof InvokeMap> = (
  ...args: InvokeMap[C][0]
) => Promise<IpcResponse<InvokeMap[C][1]>>;

/** 事件订阅：返回取消订阅函数，与 preload 的返回值一致 */
export type On = <C extends EventChannel>(
  channel: C,
  callback: (payload: EventPayloadMap[C]) => void
) => () => void;

export interface XmqttBridge {
  app: {
    info: Call<typeof INVOKE.appInfo>;
    getSettings: Call<typeof INVOKE.settingsGet>;
    patchSettings: Call<typeof INVOKE.settingsPatch>;
    exportConfig: Call<typeof INVOKE.configExport>;
    importConfig: Call<typeof INVOKE.configImport>;
  };

  servers: {
    list: Call<typeof INVOKE.serversList>;
    save: Call<typeof INVOKE.serversSave>;
    remove: Call<typeof INVOKE.serversDelete>;
  };

  templates: {
    list: Call<typeof INVOKE.templatesList>;
    save: Call<typeof INVOKE.templatesSave>;
    remove: Call<typeof INVOKE.templatesDelete>;
  };

  history: {
    list: Call<typeof INVOKE.historyList>;
    push: Call<typeof INVOKE.historyPush>;
    clear: Call<typeof INVOKE.historyClear>;
  };

  mqtt: {
    connect: Call<typeof INVOKE.mqttConnect>;
    disconnect: Call<typeof INVOKE.mqttDisconnect>;
    remove: Call<typeof INVOKE.mqttRemove>;
    state: Call<typeof INVOKE.mqttState>;
    states: Call<typeof INVOKE.mqttStates>;
    subscribe: Call<typeof INVOKE.mqttSubscribe>;
    unsubscribe: Call<typeof INVOKE.mqttUnsubscribe>;
    setMuted: Call<typeof INVOKE.mqttMute>;
    setEncoding: Call<typeof INVOKE.mqttEncoding>;
    publish: Call<typeof INVOKE.mqttPublish>;
  };

  scan: {
    start: Call<typeof INVOKE.scanStart>;
    stop: Call<typeof INVOKE.scanStop>;
    clear: Call<typeof INVOKE.scanClear>;
    collected: Call<typeof INVOKE.scanCollected>;
  };

  file: {
    saveText: Call<typeof INVOKE.fileSaveText>;
    readText: Call<typeof INVOKE.fileReadText>;
    reveal: Call<typeof INVOKE.fileReveal>;
  };

  on: On;
}
