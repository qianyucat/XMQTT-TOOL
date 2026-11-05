/**
 * MQTT 连接池 / 消息中枢
 * ------------------------------------------------------------------
 * 主进程持有全部 mqtt.Client 实例，渲染层只通过 IPC 收发指令与事件。
 *
 * 三个关键设计：
 *  1. **消息批量上报**：高吞吐 broker（订阅 `#` 时每秒可达成千上万条）如果逐条 send 到渲染层，
 *     IPC 与 DOM 都会被压垮。这里在 60ms 窗口内聚合为一批，一次 send 一个数组。
 *  2. **主题收集（扫描主题）**：用一条独立订阅（默认 `#`）旁路收集 broker 上真实存在的主题，
 *     维护成去重集合，增量推给渲染层。它只是普通订阅的一种，可随时停止且不影响用户自己的订阅。
 *  3. **状态单一事实源**：每个连接的状态机、订阅表、统计量都只在这里维护一份，
 *     渲染层永远从 `getState()` 拉取，不做本地推断。
 *
 * ⚠️ 本文件**刻意不 import electron**（只用 node:events + mqtt）。
 * `tools/test-manager.mjs` 靠这一点在纯 node 环境直接跑 33 项测试，不必启动 GUI。
 * 新增依赖前先确认它能在裸 node 里跑通。
 */

import { EventEmitter } from 'node:events';
import { connect as mqttConnect } from 'mqtt';
import type { IClientOptions, IPublishPacket, MqttClient } from 'mqtt';
import type {
  CollectedTopic,
  ConnectionState,
  ConnectionStats,
  ConnectionStatus,
  LogLevel,
  MqttMessage,
  PayloadEncoding,
  PublishRequest,
  PublishResult,
  ServerConfig,
  SubscribeOptions,
  Subscription,
  TopicDeltaEvent,
} from '../shared/models';

/** mqtt.js 认的四种 scheme，其余别名在 PROTOCOL_MAP 里归一到这四种 */
type ConnectScheme = 'mqtt' | 'mqtts' | 'ws' | 'wss';

/** mqtt.js 的 QoS 是字面量联合，业务侧传的是 number，转换处统一用 toQos */
type Qos = 0 | 1 | 2;

export const PROTOCOL_MAP: Record<string, ConnectScheme> = {
  mqtt: 'mqtt',
  tcp: 'mqtt',
  mqtts: 'mqtts',
  ssl: 'mqtts',
  tls: 'mqtts',
  ws: 'ws',
  wss: 'wss',
};

export const STATUS = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  ERROR: 'error',
} as const satisfies Record<string, ConnectionStatus>;

/** 运行时保持 `Number(v) || 0` 的原样传递，只对类型系统声明成 QoS 字面量联合 */
const toQos = (v: unknown): Qos => (Number(v) || 0) as Qos;

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}`;
}

/** 按声明编码把 Buffer 解成字符串（渲染层展示用） */
export function decodePayload(buf: Buffer | null | undefined, encoding: PayloadEncoding | string): string {
  if (!buf) return '';
  switch (encoding) {
    case 'hex':
      return buf.toString('hex').replace(/(..)(?=.)/g, '$1 ');
    case 'base64':
      return buf.toString('base64');
    case 'utf8':
    default:
      return buf.toString('utf8');
  }
}

/**
 * MQTT 通配符匹配（MQTT 3.1.1 规范 §4.7）。
 *
 * `+` 匹配单层，`#` 匹配剩余所有层级（只能出现在末尾，且 `a/#` 同时匹配 `a` 本身）。
 * 订阅表存的是过滤器，消息带的是真实主题，两者必须用这张规则对齐。
 */
export function topicMatches(filter: string, topic: string): boolean {
  const fp = String(filter).split('/');
  const tp = String(topic).split('/');

  for (let i = 0; i < fp.length; i += 1) {
    if (fp[i] === '#') return true;
    if (i >= tp.length) return false;
    if (fp[i] !== '+' && fp[i] !== tp[i]) return false;
  }
  return fp.length === tp.length;
}

/** 发布时把字符串编码成 Buffer */
export function encodePayload(text: string, encoding: PayloadEncoding | string): Buffer {
  switch (encoding) {
    case 'hex':
      return Buffer.from(String(text).replace(/[^0-9a-fA-F]/g, ''), 'hex');
    case 'base64':
      return Buffer.from(String(text), 'base64');
    case 'utf8':
    default:
      return Buffer.from(String(text ?? ''), 'utf8');
  }
}

/** 扫描/连接共用的子状态 */
interface ScanCtx {
  active: boolean;
  filter: string | null;
  startedAt: number | null;
}

/** 一个连接的完整内部状态。对外只经 serialize 变成 ConnectionState */
interface ConnectionCtx {
  id: string;
  name: string;
  config: ServerConfig & { id: string };
  url: string;
  client: MqttClient | null;
  status: ConnectionStatus;
  error: string | null;
  subscriptions: Map<string, Subscription>;
  collectedTopics: Map<string, CollectedTopic>;
  scan: ScanCtx;
  stats: ConnectionStats;
  lastMessageAt: number | null;
}

export class MqttManager extends EventEmitter {
  /** connectionId -> 连接上下文 */
  connections: Map<string, ConnectionCtx>;
  private _pending: MqttMessage[];
  private _flushTimer: ReturnType<typeof setTimeout> | null;
  private _batchWindowMs: number;
  /*
   * 收消息会改 stats / sub.received / lastMessageAt，这些也要反映到状态页。
   * 但不能每条消息都 _emitStatus —— 高吞吐订阅 `#` 时会把 IPC 与渲染层刷爆。
   * 这里按连接记「脏标记」，最短 500ms 合并推一次状态。
   */
  private _statusDirty: Set<string>;
  private _statusTimer: ReturnType<typeof setTimeout> | null;

  constructor() {
    super();
    this.connections = new Map();
    this._pending = [];
    this._flushTimer = null;
    this._batchWindowMs = 60;
    this._statusDirty = new Set();
    this._statusTimer = null;
  }

  /* ------------------------------------------------------------------ */
  /* 连接                                                                */
  /* ------------------------------------------------------------------ */

  static buildUrl(cfg: ServerConfig): string {
    const scheme = PROTOCOL_MAP[String(cfg.protocol || 'mqtt').toLowerCase()] || 'mqtt';
    const host = String(cfg.host || '127.0.0.1').trim();
    const port = Number(cfg.port) || (scheme === 'mqtts' ? 8883 : scheme === 'mqtt' ? 1883 : 8083);
    const p = cfg.path ? (String(cfg.path).startsWith('/') ? cfg.path : `/${cfg.path}`) : '';
    return `${scheme}://${host}:${port}${p}`;
  }

  static buildOptions(cfg: ServerConfig): IClientOptions {
    const opts: IClientOptions = {
      clientId:
        cfg.clientId && cfg.clientId.trim()
          ? cfg.clientId.trim()
          : `xmqtt_${Math.random().toString(16).slice(2, 10)}`,
      keepalive: Number(cfg.keepalive) || 60,
      clean: cfg.clean !== false,
      connectTimeout: Number(cfg.connectTimeout) || 8000,
      reconnectPeriod: cfg.autoReconnect === false ? 0 : Number(cfg.reconnectPeriod) || 3000,
      protocolVersion: (Number(cfg.protocolVersion) || 4) as 3 | 4 | 5,
      resubscribe: cfg.autoResubscribe !== false,
    };

    if (cfg.username) opts.username = cfg.username;
    if (cfg.password) opts.password = cfg.password;

    if (cfg.will && cfg.will.topic) {
      opts.will = {
        topic: cfg.will.topic,
        payload: encodePayload(cfg.will.payload || '', cfg.will.encoding || 'utf8'),
        qos: toQos(cfg.will.qos),
        retain: !!cfg.will.retain,
      };
    }

    // TLS / WebSocket 高级项
    if (cfg.rejectUnauthorized === false) opts.rejectUnauthorized = false;
    if (cfg.ca) opts.ca = cfg.ca;
    if (cfg.cert) opts.cert = cfg.cert;
    if (cfg.key) opts.key = cfg.key;
    /*
     * alpnProtocols 在 electron 的类型里没有对应字段（mqtt.js 内部读的是 ALPNProtocols），
     * 但这里是「用户填了原样透传」的历史行为，不能因为类型缺失就悄悄丢掉。
     */
    if (cfg.alpnProtocols) (opts as Record<string, unknown>).alpnProtocols = cfg.alpnProtocols;

    return opts;
  }

  connect(cfg: ServerConfig): ConnectionState {
    const id = cfg.id || nextId('conn');

    // 同一 id 重复连接：先彻底释放旧实例，避免句柄泄漏
    if (this.connections.has(id)) this.disconnect(id);

    const url = MqttManager.buildUrl(cfg);
    const ctx: ConnectionCtx = {
      id,
      name: cfg.name || `${cfg.host}:${cfg.port}`,
      config: { ...cfg, id },
      url,
      client: null,
      status: STATUS.CONNECTING,
      error: null,
      subscriptions: new Map(),
      collectedTopics: new Map(),
      scan: { active: false, filter: null, startedAt: null },
      stats: { received: 0, published: 0, bytesIn: 0, bytesOut: 0, connectedAt: null },
      lastMessageAt: null,
    };

    this.connections.set(id, ctx);
    this._log(id, 'info', `连接中 ${url}`);

    let client: MqttClient;
    try {
      client = mqttConnect(url, MqttManager.buildOptions(cfg));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.status = STATUS.ERROR;
      ctx.error = message;
      this._log(id, 'error', `创建客户端失败: ${message}`);
      this._emitStatus(ctx);
      return MqttManager.serialize(ctx);
    }

    ctx.client = client;
    this._bindEvents(ctx);

    this._emitStatus(ctx);
    return MqttManager.serialize(ctx);
  }

  private _bindEvents(ctx: ConnectionCtx): void {
    const { client, id } = ctx;
    if (!client) return;

    client.on('connect', (packet) => {
      ctx.status = STATUS.CONNECTED;
      ctx.error = null;
      ctx.stats.connectedAt = Date.now();
      this._log(id, 'success', `已连接 ${ctx.url}${packet?.sessionPresent ? '（恢复会话）' : ''}`);

      // 断线重连后自动补订阅
      if (ctx.config.autoResubscribe !== false) {
        for (const sub of ctx.subscriptions.values()) {
          client.subscribe(sub.topic, { qos: toQos(sub.qos) }, (err) => {
            if (err) this._log(id, 'error', `恢复订阅失败 ${sub.topic}: ${err.message}`);
          });
        }
      }
      this._emitStatus(ctx);
    });

    client.on('reconnect', () => {
      ctx.status = STATUS.RECONNECTING;
      this._emitStatus(ctx);
    });

    client.on('close', () => {
      if (ctx.status !== STATUS.ERROR) {
        ctx.status = ctx.client?.reconnecting ? STATUS.RECONNECTING : STATUS.DISCONNECTED;
      }
      this._emitStatus(ctx);
    });

    client.on('offline', () => {
      ctx.status = STATUS.RECONNECTING;
      this._emitStatus(ctx);
    });

    client.on('error', (err) => {
      ctx.status = STATUS.ERROR;
      ctx.error = err.message;
      this._log(id, 'error', err.message);
      this._emitStatus(ctx);
    });

    client.on('message', (topic, payload, packet: IPublishPacket) => {
      const now = Date.now();
      ctx.stats.received += 1;
      ctx.stats.bytesIn += payload.length;
      ctx.lastMessageAt = now;
      this._touchStatus(ctx);

      // 主题收集：只在扫描激活时记录
      if (ctx.scan.active) {
        this._collectTopic(ctx, topic, now);
      }

      /*
       * 订阅表以「过滤器」为键（sensor/+/temp、factory/#），而消息带的是「实际主题」
       * （sensor/a/temp）。直接 get(topic) 永远匹配不上通配符订阅 —— 表现为静音无效、
       * 每个订阅的计数恒为 0、HEX/Base64 解码设置不生效。必须按通配符语义逐条匹配。
       *
       * 扫描订阅（isScan）只贡献主题收集，不往消息列表里灌数据，否则开着扫描时
       * 消息列表会被全量流量淹没。
       */
      let encoding: PayloadEncoding = 'utf8';
      let visible = false;

      for (const sub of ctx.subscriptions.values()) {
        if (!topicMatches(sub.topic, topic)) continue;
        sub.received += 1;
        if (sub.isScan) continue;
        encoding = sub.encoding || 'utf8';
        if (!sub.muted) visible = true;
      }

      if (!visible) return;

      this._pending.push({
        connectionId: id,
        topic,
        payload: decodePayload(payload, encoding),
        bytes: payload.length,
        qos: packet.qos,
        retain: !!packet.retain,
        dup: !!packet.dup,
        ts: now,
      });
      this._scheduleFlush();
    });
  }

  private _collectTopic(ctx: ConnectionCtx, topic: string, ts: number): void {
    const existing = ctx.collectedTopics.get(topic);
    if (existing) {
      existing.count += 1;
      existing.ts = ts;
      return;
    }
    // 新主题：只把增量推给渲染层，避免每次全量重传
    const entry: CollectedTopic = { topic, ts, count: 1 };
    ctx.collectedTopics.set(topic, entry);
    const event: TopicDeltaEvent = {
      connectionId: ctx.id,
      added: [{ topic, ts, count: 1 }],
      total: ctx.collectedTopics.size,
    };
    this.emit('topics', event);
  }

  disconnect(id: string, { silent = false }: { silent?: boolean } = {}): ConnectionState | null {
    const ctx = this.connections.get(id);
    if (!ctx) return null;

    if (ctx.client) {
      try {
        ctx.client.removeAllListeners();
        ctx.client.end(true);
      } catch {
        /* 忽略关闭期异常 */
      }
    }
    ctx.status = STATUS.DISCONNECTED;
    ctx.client = null;
    ctx.stats.connectedAt = null;

    /*
     * 断开即视为扫描结束。
     * 已收集到的主题刻意保留（现场排查经常要留着跟前一次对照），
     * 但 active 必须复位 —— 否则界面会一直挂着「扫描中」，而背后早就没有订阅在收数据了。
     */
    ctx.scan = { active: false, filter: null, startedAt: null };

    if (!silent) {
      this._log(id, 'info', '已断开连接');
      this._emitStatus(ctx);
    }
    return MqttManager.serialize(ctx);
  }

  remove(id: string): void {
    this.disconnect(id, { silent: true });
    this.connections.delete(id);
    this.emit('connections', this.listStates());
  }

  /* ------------------------------------------------------------------ */
  /* 订阅 / 发布                                                         */
  /* ------------------------------------------------------------------ */

  subscribe(
    id: string,
    topic: string,
    qos = 0,
    opts: SubscribeOptions = {},
  ): Promise<ConnectionState> {
    const ctx = this.connections.get(id);
    if (!ctx || !ctx.client) throw new Error('连接不存在或未建立');
    if (!topic || !topic.trim()) throw new Error('主题不能为空');

    const client = ctx.client;
    const key = topic.trim();
    const existing = ctx.subscriptions.get(key);
    if (existing) {
      /*
       * 重复订阅在用户视角是错误，但扫描订阅是幂等的：扫描过滤器可能正好等于已订阅的主题，
       * 这时不该报错，直接视为成功。
       */
      if (!opts.isScan) throw new Error(`已订阅该主题: ${key}`);
      return Promise.resolve(MqttManager.serialize(ctx));
    }

    ctx.subscriptions.set(key, {
      topic: key,
      qos: toQos(qos),
      muted: !!opts.muted,
      encoding: opts.encoding || 'utf8',
      isScan: !!opts.isScan,
      received: 0,
      subscribedAt: Date.now(),
    });

    return new Promise((resolve, reject) => {
      client.subscribe(key, { qos: toQos(qos) }, (err, granted) => {
        if (err) {
          ctx.subscriptions.delete(key);
          this._log(id, 'error', `订阅失败 ${key}: ${err.message}`);
          reject(err);
          return;
        }
        const code = granted && granted[0] ? granted[0].qos : qos;
        this._log(id, 'success', `已订阅 ${key} (QoS ${code})`);
        this._emitStatus(ctx);
        resolve(MqttManager.serialize(ctx));
      });
    });
  }

  unsubscribe(id: string, topic: string): Promise<ConnectionState> {
    const ctx = this.connections.get(id);
    if (!ctx || !ctx.client) throw new Error('连接不存在或未建立');

    const client = ctx.client;
    const key = String(topic).trim();
    if (!ctx.subscriptions.has(key)) throw new Error(`未订阅该主题: ${key}`);

    ctx.subscriptions.delete(key);
    return new Promise((resolve, reject) => {
      client.unsubscribe(key, (err) => {
        if (err) {
          this._log(id, 'error', `取消订阅失败 ${key}: ${err.message}`);
          reject(err);
          return;
        }
        this._log(id, 'info', `已取消订阅 ${key}`);
        this._emitStatus(ctx);
        resolve(MqttManager.serialize(ctx));
      });
    });
  }

  setSubscriptionMuted(id: string, topic: string, muted: boolean): ConnectionState {
    const ctx = this.connections.get(id);
    if (!ctx) throw new Error('连接不存在');
    const sub = ctx.subscriptions.get(topic);
    if (sub) sub.muted = !!muted;
    this._emitStatus(ctx);
    return MqttManager.serialize(ctx);
  }

  setSubscriptionEncoding(id: string, topic: string, encoding: PayloadEncoding): ConnectionState {
    const ctx = this.connections.get(id);
    if (!ctx) throw new Error('连接不存在');
    const sub = ctx.subscriptions.get(topic);
    if (sub) sub.encoding = encoding;
    return MqttManager.serialize(ctx);
  }

  publish(id: string, { topic, payload, qos = 0, retain = false, encoding = 'utf8' }: PublishRequest): Promise<PublishResult> {
    const ctx = this.connections.get(id);
    if (!ctx || !ctx.client) throw new Error('连接不存在或未建立');
    if (!topic || !topic.trim()) throw new Error('主题不能为空');

    const client = ctx.client;
    const buf = encodePayload(payload, encoding);
    return new Promise((resolve, reject) => {
      client.publish(
        topic.trim(),
        buf,
        { qos: toQos(qos), retain: !!retain },
        (err) => {
          if (err) {
            this._log(id, 'error', `发布失败 ${topic}: ${err.message}`);
            reject(err);
            return;
          }
          ctx.stats.published += 1;
          ctx.stats.bytesOut += buf.length;
          this._log(
            id,
            'success',
            `已发布 ${topic} (${buf.length} B, QoS ${qos}${retain ? ', retain' : ''})`,
          );
          this._emitStatus(ctx);
          resolve({ bytes: buf.length, ts: Date.now() });
        }
      );
    });
  }

  /* ------------------------------------------------------------------ */
  /* 主题扫描（Topics Collector）                                        */
  /* ------------------------------------------------------------------ */

  async startScan(id: string, filter = '#'): Promise<ConnectionState> {
    const ctx = this.connections.get(id);
    if (!ctx) throw new Error('连接不存在');
    if (ctx.scan.active) throw new Error('扫描已在进行中');

    ctx.scan = { active: true, filter, startedAt: Date.now() };
    await this.subscribe(id, filter, 0, { isScan: true, encoding: 'utf8' });
    this._log(id, 'info', `开始扫描主题: ${filter}`);
    this._emitStatus(ctx);
    return MqttManager.serialize(ctx);
  }

  async stopScan(id: string): Promise<ConnectionState> {
    const ctx = this.connections.get(id);
    if (!ctx) throw new Error('连接不存在');
    if (!ctx.scan.active) return MqttManager.serialize(ctx);

    const filter = ctx.scan.filter;
    ctx.scan = { active: false, filter: null, startedAt: null };
    try {
      if (filter && ctx.subscriptions.has(filter)) await this.unsubscribe(id, filter);
    } catch {
      /* 订阅可能已随断线消失 */
    }
    this._log(id, 'info', `停止扫描（累计 ${ctx.collectedTopics.size} 个主题）`);
    this._emitStatus(ctx);
    return MqttManager.serialize(ctx);
  }

  clearCollected(id: string): ConnectionState {
    const ctx = this.connections.get(id);
    if (!ctx) throw new Error('连接不存在');
    ctx.collectedTopics.clear();
    const event: TopicDeltaEvent = { connectionId: id, added: [], reset: true, total: 0 };
    this.emit('topics', event);
    return MqttManager.serialize(ctx);
  }

  getCollected(id: string): CollectedTopic[] {
    const ctx = this.connections.get(id);
    if (!ctx) return [];
    return [...ctx.collectedTopics.entries()]
      .map(([topic, v]) => ({ topic, count: v.count, ts: v.ts }))
      .sort((a, b) => a.topic.localeCompare(b.topic));
  }

  /* ------------------------------------------------------------------ */
  /* 状态导出                                                            */
  /* ------------------------------------------------------------------ */

  getState(id: string): ConnectionState | null {
    const ctx = this.connections.get(id);
    if (!ctx) return null;
    return MqttManager.serialize(ctx);
  }

  listStates(): ConnectionState[] {
    return [...this.connections.values()].map(MqttManager.serialize);
  }

  static serialize(ctx: ConnectionCtx): ConnectionState {
    const now = Date.now();
    return {
      id: ctx.id,
      name: ctx.name,
      url: ctx.url,
      status: ctx.status,
      error: ctx.error,
      config: ctx.config,
      uptimeMs: ctx.stats.connectedAt ? now - ctx.stats.connectedAt : 0,
      lastMessageAt: ctx.lastMessageAt,
      stats: { ...ctx.stats },
      scan: { ...ctx.scan, collected: ctx.collectedTopics.size },
      subscriptions: [...ctx.subscriptions.values()].map((s) => ({ ...s })),
    };
  }

  /* ------------------------------------------------------------------ */
  /* 内部：批量上报 / 状态广播 / 日志                                     */
  /* ------------------------------------------------------------------ */

  private _scheduleFlush(): void {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      if (!this._pending.length) return;
      const batch = this._pending;
      this._pending = [];
      this.emit('messages', batch);
    }, this._batchWindowMs);
  }

  private _emitStatus(ctx: ConnectionCtx): void {
    this.emit('status', MqttManager.serialize(ctx));
  }

  /**
   * 收消息侧的状态推送：只记脏标记，节流合并（最短 500ms 一批）。
   * 立即型状态变化（连接/订阅/断开等）仍走 `_emitStatus` 原样即时推。
   */
  private _touchStatus(ctx: ConnectionCtx): void {
    this._statusDirty.add(ctx.id);
    if (this._statusTimer) return;
    this._statusTimer = setTimeout(() => {
      this._statusTimer = null;
      const dirty = [...this._statusDirty];
      this._statusDirty.clear();
      for (const id of dirty) {
        const current = this.connections.get(id);
        if (current) this._emitStatus(current);
      }
    }, 500);
  }

  private _log(connectionId: string, level: LogLevel, message: string): void {
    this.emit('log', { connectionId, level, message, ts: Date.now() });
  }

  /** 应用退出时统一清理，避免残留 TCP 连接 */
  shutdown(): void {
    if (this._statusTimer) {
      clearTimeout(this._statusTimer);
      this._statusTimer = null;
    }
    this._statusDirty.clear();
    for (const id of [...this.connections.keys()]) {
      this.disconnect(id, { silent: true });
    }
    this.connections.clear();
  }
}
