/**
 * IPC 路由
 * ------------------------------------------------------------------
 * 约定：所有通道走 invoke/handle，统一返回 { ok, data } 或 { ok:false, error }。
 * 渲染层只判断 ok，不需要 try/catch 包住每个 await —— 主进程侧的 mqtt 异常
 * （订阅失败、发布失败、连接不存在）都是正常业务分支，不该让渲染层堆防御代码。
 *
 * 通道名不再手写：一律取 `src/shared/channels.ts` 的 INVOKE 常量，参数与返回类型
 * 由 InvokeMap 推导。改签名时这一侧和渲染层同时报错 —— 这正是阶段 6 的目的。
 */

import { app, dialog, ipcMain, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import * as fs from 'node:fs';
import { INVOKE } from '../shared/channels';
import type { InvokeArgsOf, InvokeChannel, InvokeResultOf } from '../shared/channels';
import type { ConfigExport, ConfigImportResult, ThemeMode } from '../shared/models';
import { STATUS } from './mqtt-manager';
import type { MqttManager } from './mqtt-manager';
import { glassMode } from './glass';
import type { ConfigStore } from './store';

export interface IpcDeps {
  store: ConfigStore;
  manager: MqttManager;
  getWindow: () => BrowserWindow | null;
  applyTitleBarTheme: (theme: ThemeMode) => void;
}

/**
 * 把「通道名 + 业务函数」注册成 IPC handler。
 *
 * 泛型 C 让每个调用点拿到该通道精确的入参元组与返回类型；
 * 运行时那一侧统一按 unknown[] 收参数，异常转成 `{ ok:false, error }`，
 * 保证渲染层永远不会看到被 reject 的 invoke。
 */
function makeHandle(): <C extends InvokeChannel>(
  channel: C,
  fn: (...args: InvokeArgsOf<C>) => InvokeResultOf<C> | Promise<InvokeResultOf<C>>,
) => void {
  return (channel, fn) => {
    ipcMain.handle(channel, async (_evt, ...args: unknown[]) => {
      try {
        const data = await (fn as (...a: unknown[]) => unknown)(...args);
        return { ok: true, data };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
  };
}

export function registerIpc({ store, manager, getWindow, applyTitleBarTheme }: IpcDeps) {
  const handle = makeHandle();

  /* ------------------------------ 应用 ------------------------------ */

  handle(INVOKE.appInfo, () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: process.platform,
    glass: glassMode(),
    configFile: store.file,
    statuses: STATUS,
  }));

  handle(INVOKE.settingsGet, () => store.settings);

  handle(INVOKE.settingsPatch, (patch) => {
    const next = store.patchSettings(patch || {});
    if (patch && patch.theme) applyTitleBarTheme(patch.theme);
    return next;
  });

  /* --------------------------- 连接配置 ---------------------------- */

  handle(INVOKE.serversList, () => store.listServers());
  handle(INVOKE.serversSave, (server) => store.saveServer(server));
  handle(INVOKE.serversDelete, (id) => store.deleteServer(id));

  /* --------------------------- 消息模板 ---------------------------- */

  handle(INVOKE.templatesList, () => store.listTemplates());
  handle(INVOKE.templatesSave, (tpl) => store.saveTemplate(tpl));
  handle(INVOKE.templatesDelete, (id) => store.deleteTemplate(id));

  /* --------------------------- 发布历史 ---------------------------- */

  handle(INVOKE.historyList, () => store.data.publishHistory);
  handle(INVOKE.historyPush, (entry) => store.pushHistory(entry));
  handle(INVOKE.historyClear, () => store.clearHistory());

  /* ----------------------------- 连接 ------------------------------ */

  handle(INVOKE.mqttConnect, (cfg) => manager.connect(cfg));
  handle(INVOKE.mqttDisconnect, (id) => manager.disconnect(id));
  handle(INVOKE.mqttRemove, (id) => {
    manager.remove(id);
    return true;
  });
  handle(INVOKE.mqttState, (id) => manager.getState(id));
  handle(INVOKE.mqttStates, () => manager.listStates());

  /* --------------------------- 订阅 / 发布 -------------------------- */

  handle(INVOKE.mqttSubscribe, (id, topic, qos, opts) =>
    manager.subscribe(id, topic, qos, opts || {}),
  );
  handle(INVOKE.mqttUnsubscribe, (id, topic) => manager.unsubscribe(id, topic));
  handle(INVOKE.mqttMute, (id, topic, muted) => manager.setSubscriptionMuted(id, topic, muted));
  handle(INVOKE.mqttEncoding, (id, topic, encoding) =>
    manager.setSubscriptionEncoding(id, topic, encoding),
  );
  handle(INVOKE.mqttPublish, (id, payload) => manager.publish(id, payload));

  /* ---------------------------- 主题扫描 ---------------------------- */

  handle(INVOKE.scanStart, (id, filter) => manager.startScan(id, filter || '#'));
  handle(INVOKE.scanStop, (id) => manager.stopScan(id));
  handle(INVOKE.scanClear, (id) => manager.clearCollected(id));
  handle(INVOKE.scanCollected, (id) => manager.getCollected(id));

  /* ---------------------------- 文件导出 ---------------------------- */

  handle(INVOKE.fileSaveText, async (payload) => {
    const { canceled, filePath } = await dialog.showSaveDialog(getWindow() as BrowserWindow, {
      title: payload?.title || '导出',
      defaultPath: payload?.defaultName || 'export.txt',
      filters: payload?.filters || [
        { name: '文本', extensions: ['txt'] },
        { name: 'JSON', extensions: ['json'] },
        { name: 'CSV', extensions: ['csv'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    });
    if (canceled || !filePath) return { saved: false };
    fs.writeFileSync(filePath, payload.content, 'utf8');
    return { saved: true, filePath };
  });

  handle(INVOKE.fileReadText, async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(getWindow() as BrowserWindow, {
      title: '导入配置',
      properties: ['openFile'],
      filters: [
        { name: 'JSON', extensions: ['json'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    });
    if (canceled || !filePaths.length) return { imported: false };
    const raw = fs.readFileSync(filePaths[0], 'utf8');
    return { imported: true, filePath: filePaths[0], content: raw };
  });

  handle(INVOKE.fileReveal, (filePath) => {
    shell.showItemInFolder(filePath || store.file);
    return true;
  });

  /** 导出完整配置（连接 + 模板）用于迁移 */
  handle(INVOKE.configExport, () => ({
    version: store.data.version,
    exportedAt: new Date().toISOString(),
    servers: store.data.servers,
    templates: store.data.templates,
    settings: store.settings,
  }));

  handle(INVOKE.configImport, (payload) => {
    let parsed: ConfigExport;
    if (typeof payload === 'string') parsed = JSON.parse(payload) as ConfigExport;
    else parsed = payload;

    let added = 0;
    for (const s of parsed.servers || []) {
      // 导入的连接一律分配新 id，避免与现有配置冲突
      const id = `srv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      store.saveServer({ ...s, id });
      added += 1;
    }
    for (const t of parsed.templates || []) {
      const id = `tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      store.saveTemplate({ ...t, id });
    }
    store.flush();
    const result: ConfigImportResult = {
      servers: store.listServers(),
      templates: store.listTemplates(),
      added,
    };
    return result;
  });

  return { handle };
}
