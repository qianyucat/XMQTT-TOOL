/**
 * 服务器配置的表单草稿
 * ------------------------------------------------------------------
 * 表单里每个输入框的值都是字符串（含 `type=number` 的输入框：清空后就是 ''），
 * 直接塞进 `ServerConfig` 会得到 `port: NaN` 这种「看着是数字其实是坑」的值。
 * 所以中间加一层 `ServerDraft`：**字段全是字符串**，只在提交时统一解析。
 *
 * 拆成纯函数还有一个实际收益：旧实现靠 `key.startsWith('will')` + `slice(4)` 做
 * 字符串手术，字段名拼错要等运行时才发现。这里两张表都由 `keyof` 约束。
 */

import type { MqttProtocol, PayloadEncoding, ServerConfig } from '@shared/models';

export const DEFAULT_PORTS: Record<string, number> = {
  mqtt: 1883,
  mqtts: 8883,
  ws: 8083,
  wss: 8084,
};

export type DraftProtocol = 'mqtt' | 'mqtts' | 'ws' | 'wss';

export interface ServerDraft {
  name: string;
  protocol: DraftProtocol;
  host: string;
  port: string;
  clientId: string;
  username: string;
  password: string;
  protocolVersion: string;
  keepalive: string;
  connectTimeout: string;
  reconnectPeriod: string;
  path: string;
  clean: boolean;
  autoReconnect: boolean;
  rejectUnauthorized: boolean;
  willTopic: string;
  willQos: string;
  willPayload: string;
  willRetain: boolean;
}

/** 「新建」时的默认值，也是「重置」的基准 */
export const EMPTY_DRAFT: ServerDraft = {
  name: '',
  protocol: 'mqtt',
  host: '127.0.0.1',
  port: '1883',
  clientId: '',
  username: '',
  password: '',
  protocolVersion: '4',
  keepalive: '60',
  connectTimeout: '8000',
  reconnectPeriod: '3000',
  path: '',
  clean: true,
  autoReconnect: true,
  rejectUnauthorized: true,
  willTopic: '',
  willQos: '0',
  willPayload: '',
  willRetain: false,
};

const asText = (value: unknown): string => (value === undefined || value === null ? '' : String(value));

/** ServerConfig → 表单草稿 */
export function toDraft(server: ServerConfig | null): ServerDraft {
  if (!server) return { ...EMPTY_DRAFT };

  return {
    name: asText(server.name),
    protocol: (server.protocol as DraftProtocol) || 'mqtt',
    host: asText(server.host),
    port: asText(server.port),
    clientId: asText(server.clientId),
    username: asText(server.username),
    password: asText(server.password),
    protocolVersion: asText(server.protocolVersion ?? 4),
    keepalive: asText(server.keepalive ?? 60),
    connectTimeout: asText(server.connectTimeout ?? 8000),
    reconnectPeriod: asText(server.reconnectPeriod ?? 3000),
    path: asText(server.path),
    clean: server.clean !== false,
    autoReconnect: server.autoReconnect !== false,
    rejectUnauthorized: server.rejectUnauthorized !== false,
    willTopic: asText(server.will?.topic),
    willQos: asText(server.will?.qos ?? 0),
    willPayload: asText(server.will?.payload),
    willRetain: server.will?.retain === true,
  };
}

/** 数字输入框的容错：空串 / 非数字一律回落到给定默认值 */
function num(text: string, fallback: number): number {
  const parsed = Number(text);
  return Number.isFinite(parsed) && text.trim() !== '' ? parsed : fallback;
}

/**
 * 表单草稿 → 可提交的配置。
 *
 * 三条兜底逻辑与旧版一致，不要小看它们：
 * - 名称留空 → 用 `host:port`，否则列表里会出现一堆空白项
 * - 端口非法 → 回落到该协议的默认端口
 * - 遗嘱主题为空 → `will: null`（= 未启用遗嘱），避免存出半截配置
 */
export function buildServerConfig(draft: ServerDraft, editingId: string | null): ServerConfig {
  const protocol = draft.protocol;
  const port = num(draft.port, DEFAULT_PORTS[protocol] || 1883);
  const host = draft.host.trim();

  const config: ServerConfig = {
    id: editingId ?? undefined,
    name: draft.name.trim() || `${host}:${port}`,
    protocol: protocol as MqttProtocol,
    host,
    port,
    clientId: draft.clientId.trim(),
    username: draft.username.trim(),
    password: draft.password,
    protocolVersion: num(draft.protocolVersion, 4),
    keepalive: num(draft.keepalive, 60),
    connectTimeout: num(draft.connectTimeout, 8000),
    reconnectPeriod: num(draft.reconnectPeriod, 3000),
    path: draft.path.trim(),
    clean: draft.clean,
    autoReconnect: draft.autoReconnect,
    rejectUnauthorized: draft.rejectUnauthorized,
    will: draft.willTopic.trim()
      ? {
          topic: draft.willTopic.trim(),
          payload: draft.willPayload,
          qos: num(draft.willQos, 0),
          retain: draft.willRetain,
          encoding: 'utf8' as PayloadEncoding,
        }
      : undefined,
  };

  return config;
}

/** 切换协议时端口是否该跟着走：只有「空」或「上一个协议的默认端口」才自动换 */
export function shouldFollowProtocolPort(portText: string): boolean {
  const value = Number(portText);
  if (!portText.trim() || !Number.isFinite(value) || value === 0) return true;
  return Object.values(DEFAULT_PORTS).includes(value);
}
