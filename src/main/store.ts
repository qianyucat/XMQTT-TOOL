/**
 * 配置持久化
 * ------------------------------------------------------------------
 * 所有用户数据（服务器配置、消息模板、发布历史、界面设置）落在
 * app.getPath('userData')/xmqtt-config.json（本地盘，避免网络共享盘的写入抖动）。
 *
 * 写入采用「临时文件 + rename」的原子替换，防止异常退出把配置文件截断成半截 JSON。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';
import type {
  AppSettings,
  MessageTemplate,
  PublishHistoryEntry,
  ServerConfig,
} from '../shared/models';

/** 落盘文件的完整形状。缺字段时由 _load 与 DEFAULT_DATA 合并补齐 */
export interface StoredData {
  version: number;
  servers: ServerConfig[];
  templates: MessageTemplate[];
  publishHistory: PublishHistoryEntry[];
  settings: AppSettings;
}

export const DEFAULT_DATA: StoredData = {
  version: 1,
  servers: [],
  templates: [],
  publishHistory: [],
  settings: {
    theme: 'dark',
    maxMessagesPerSub: 5000,
    autoScroll: true,
    collectorLimit: 20000,
    showTimestamp: true,
    lastServerId: null,
  },
};

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export class ConfigStore {
  file: string;
  data: StoredData;
  private _writeTimer: ReturnType<typeof setTimeout> | null;

  constructor(filePath?: string) {
    this.file = filePath || path.join(app.getPath('userData'), 'xmqtt-config.json');
    this.data = this._load();
    this._writeTimer = null;
  }

  private _load(): StoredData {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoredData>;
      // 与默认值合并，保证老配置文件缺少新字段时不会读到 undefined
      return {
        ...clone(DEFAULT_DATA),
        ...parsed,
        settings: { ...DEFAULT_DATA.settings, ...(parsed.settings || {}) },
        servers: Array.isArray(parsed.servers) ? parsed.servers : [],
        templates: Array.isArray(parsed.templates) ? parsed.templates : [],
        publishHistory: Array.isArray(parsed.publishHistory) ? parsed.publishHistory : [],
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        console.error('[store] 配置读取失败，使用默认配置:', (err as Error).message);
        // 保留一份损坏文件，便于事后排查
        try {
          fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
        } catch {
          /* 忽略 */
        }
      }
      return clone(DEFAULT_DATA);
    }
  }

  /** 立即落盘 */
  flush(): void {
    const tmp = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  /** 合并多次修改，200ms 内只写一次盘 */
  private _scheduleFlush(): void {
    if (this._writeTimer) return;
    this._writeTimer = setTimeout(() => {
      this._writeTimer = null;
      try {
        this.flush();
      } catch (err) {
        console.error('[store] 配置写入失败:', (err as Error).message);
      }
    }, 200);
  }

  get settings(): AppSettings {
    return this.data.settings;
  }

  patchSettings(patch: Partial<AppSettings>): AppSettings {
    Object.assign(this.data.settings, patch);
    this._scheduleFlush();
    return this.data.settings;
  }

  /* ---------------- 服务器配置 ---------------- */

  listServers(): ServerConfig[] {
    return this.data.servers;
  }

  getServer(id: string): ServerConfig | null {
    return this.data.servers.find((s) => s.id === id) || null;
  }

  saveServer(server: ServerConfig): ServerConfig[] {
    const now = Date.now();
    const idx = this.data.servers.findIndex((s) => s.id === server.id);
    if (idx >= 0) {
      this.data.servers[idx] = { ...this.data.servers[idx], ...server, updatedAt: now };
    } else {
      this.data.servers.push({ ...server, createdAt: now, updatedAt: now });
    }
    this._scheduleFlush();
    return this.data.servers;
  }

  deleteServer(id: string): ServerConfig[] {
    this.data.servers = this.data.servers.filter((s) => s.id !== id);
    this._scheduleFlush();
    return this.data.servers;
  }

  /* ---------------- 消息模板 ---------------- */

  listTemplates(): MessageTemplate[] {
    return this.data.templates;
  }

  saveTemplate(tpl: MessageTemplate): MessageTemplate[] {
    const now = Date.now();
    const idx = this.data.templates.findIndex((t) => t.id === tpl.id);
    if (idx >= 0) this.data.templates[idx] = { ...this.data.templates[idx], ...tpl, updatedAt: now };
    else this.data.templates.push({ ...tpl, createdAt: now, updatedAt: now });
    this._scheduleFlush();
    return this.data.templates;
  }

  deleteTemplate(id: string): MessageTemplate[] {
    this.data.templates = this.data.templates.filter((t) => t.id !== id);
    this._scheduleFlush();
    return this.data.templates;
  }

  /* ---------------- 发布历史 ---------------- */

  pushHistory(entry: PublishHistoryEntry, limit = 300): PublishHistoryEntry[] {
    this.data.publishHistory.unshift(entry);
    if (this.data.publishHistory.length > limit) {
      this.data.publishHistory.length = limit;
    }
    this._scheduleFlush();
    return this.data.publishHistory;
  }

  clearHistory(): PublishHistoryEntry[] {
    this.data.publishHistory = [];
    this._scheduleFlush();
    return [];
  }
}
