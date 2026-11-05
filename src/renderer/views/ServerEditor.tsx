/**
 * 服务器配置编辑弹层
 * ------------------------------------------------------------------
 * 表单密集、字段多，但它只做两件事：把 store 里的配置摊成草稿、把草稿收成
 * 配置交给主进程。所有类型转换都在 `lib/server-draft.ts` 里（纯函数，可单测）。
 *
 * 与旧版的一处行为修正：旧版「保存后重新填充下拉」是靠视图之间互相调用
 * （`servers.renderSelect()`），现在下拉由 store 派生，保存只要 `setServers`，
 * 顶部立刻就是新的 —— 不存在「视图忘了刷新」这种漏点。
 */

import { useEffect, useState } from 'react';
import { Dialog as RDialog } from 'radix-ui';
import type { ServerConfig } from '@shared/models';
import { Button } from '../components/Button';
import { Field } from '../components/Field';
import { Checkbox } from '../components/Toggle';
import { Icon } from '../components/Icon';
import { api } from '../ipc/client';
import { dialog } from '../lib/dialog';
import {
  DEFAULT_PORTS,
  EMPTY_DRAFT,
  buildServerConfig,
  shouldFollowProtocolPort,
  toDraft,
} from '../lib/server-draft';
import type { DraftProtocol, ServerDraft } from '../lib/server-draft';
import { useServerEditor } from '../lib/server-editor';
import { errMsg, toast, uid } from '../lib/util';
import { act } from '../store/appStore';

/** 一张表覆盖所有文本 / 数字 / 布尔字段，键名由 `ServerDraft` 约束 */
type TextKey = {
  [K in keyof ServerDraft]: ServerDraft[K] extends string ? K : never;
}[keyof ServerDraft];

type BoolKey = {
  [K in keyof ServerDraft]: ServerDraft[K] extends boolean ? K : never;
}[keyof ServerDraft];

const TEXT_FIELDS: Array<{ key: TextKey; label: string; id: string; type?: string; placeholder?: string; min?: number; max?: number }> = [
  { key: 'name', label: '配置名称', id: 'fldName', placeholder: '本机测试 Broker' },
  { key: 'host', label: '主机', id: 'fldHost', placeholder: '127.0.0.1' },
  { key: 'port', label: '端口', id: 'fldPort', type: 'number', placeholder: '1883', min: 1, max: 65535 },
  { key: 'clientId', label: 'Client ID', id: 'fldClientId', placeholder: '留空自动生成' },
  { key: 'username', label: '用户名', id: 'fldUsername' },
  { key: 'password', label: '密码', id: 'fldPassword', type: 'password' },
  { key: 'keepalive', label: 'Keep Alive (秒)', id: 'fldKeepalive', type: 'number', min: 5, max: 3600 },
  { key: 'connectTimeout', label: '连接超时 (毫秒)', id: 'fldTimeout', type: 'number', min: 1000, max: 60000 },
  { key: 'reconnectPeriod', label: '重连间隔 (毫秒)', id: 'fldReconnect', type: 'number', min: 0, max: 60000 },
  { key: 'path', label: 'WebSocket 路径', id: 'fldPath', placeholder: '/mqtt' },
  { key: 'willTopic', label: 'Will 主题', id: 'fldWillTopic' },
  { key: 'willPayload', label: 'Will Payload', id: 'fldWillPayload' },
];

export function ServerEditor() {
  const open = useServerEditor((s) => s.open);
  const editingId = useServerEditor((s) => s.editingId);
  const close = useServerEditor((s) => s.close);

  const server: ServerConfig | null = editingId
    ? act().servers.find((s) => s.id === editingId) ?? null
    : null;

  const [draft, setDraft] = useState<ServerDraft>({ ...EMPTY_DRAFT });
  const [saving, setSaving] = useState(false);

  // 每次打开都按当前编辑对象重建草稿；关闭时不清空，避免收起动画里数字跳动
  useEffect(() => {
    if (open) setDraft(toDraft(editingId ? act().servers.find((s) => s.id === editingId) ?? null : null));
    // 只在「打开」这一刻同步：编辑中 store 的 servers 变化不该覆盖用户正在敲的内容
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editingId]);

  const patch = <K extends keyof ServerDraft>(key: K, value: ServerDraft[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const onProtocolChange = (protocol: DraftProtocol) => {
    setDraft((prev) => ({
      ...prev,
      protocol,
      // 端口还是上一个协议的默认值时才跟随，用户手改过的端口不能被覆盖
      port: shouldFollowProtocolPort(prev.port) ? String(DEFAULT_PORTS[protocol] || 1883) : prev.port,
    }));
  };

  const save = async () => {
    if (!draft.host.trim()) {
      toast('error', '保存失败', '主机地址不能为空');
      return;
    }
    setSaving(true);
    try {
      const payload = buildServerConfig(draft, editingId ?? uid('srv'));
      act().setServers(await api.saveServer(payload));
      close();
      toast('success', '已保存', `${payload.name} (${payload.host}:${payload.port})`);
    } catch (err) {
      toast('error', '保存失败', errMsg(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!editingId) return;
    const target = act().servers.find((s) => s.id === editingId);
    const ok = await dialog.confirm(
      '删除配置',
      `确定删除「${target?.name || editingId}」？该操作不可撤销。`,
      true
    );
    if (!ok) return;

    try {
      act().setServers(await api.deleteServer(editingId));
      close();
      toast('info', '已删除', target?.name || '');
    } catch (err) {
      toast('error', '删除失败', errMsg(err));
    }
  };

  return (
    <RDialog.Root open={open} onOpenChange={(next) => !next && close()}>
      <RDialog.Portal>
        <RDialog.Overlay className="modal__backdrop" />
        <div className="modal">
          <RDialog.Content
            className="modal__panel"
            aria-describedby={undefined}
            data-testid="server-editor"
          >
            <div className="modal__head">
              <RDialog.Title asChild>
                <h3>{server ? '编辑服务器配置' : '新建服务器配置'}</h3>
              </RDialog.Title>
              <Button variant="icon" title="关闭" data-testid="server-editor-close" onClick={close}>
                <Icon name="x" />
              </Button>
            </div>

            <div className="modal__body">
              <div className="form-grid">
                <Field label="配置名称">
                  <input
                    id="fldName"
                    className="input"
                    type="text"
                    placeholder="本机测试 Broker"
                    value={draft.name}
                    onChange={(e) => patch('name', e.target.value)}
                  />
                </Field>

                <Field label="协议">
                  <select
                    id="fldProtocol"
                    className="select"
                    value={draft.protocol}
                    onChange={(e) => onProtocolChange(e.target.value as DraftProtocol)}
                  >
                    <option value="mqtt">mqtt:// (TCP)</option>
                    <option value="mqtts">mqtts:// (TLS)</option>
                    <option value="ws">ws:// (WebSocket)</option>
                    <option value="wss">wss:// (WebSocket TLS)</option>
                  </select>
                </Field>

                {/*
                  `name` 必须排除：它已经在上方显式渲染过一次（配了 label 与 placeholder）。
                  之前没排除，弹层里出现两个「配置名称」、且两个 input 的 id 都是 fldName ——
                  重复 id 会让 label 关联与自动化定位都落到第一个上。
                */}
                {TEXT_FIELDS.filter((f) => f.key !== 'name' && f.key !== 'willTopic' && f.key !== 'willPayload').map((f) => (
                  <Field key={f.key} label={f.label}>
                    <input
                      id={f.id}
                      className="input"
                      type={f.type || 'text'}
                      placeholder={f.placeholder}
                      min={f.min}
                      max={f.max}
                      autoComplete={f.key === 'password' ? 'new-password' : undefined}
                      value={draft[f.key]}
                      onChange={(e) => patch(f.key, e.target.value)}
                    />
                  </Field>
                ))}

                <Field label="MQTT 版本">
                  <select
                    id="fldProtocolVersion"
                    className="select"
                    value={draft.protocolVersion}
                    onChange={(e) => patch('protocolVersion', e.target.value)}
                  >
                    <option value="4">3.1.1</option>
                    <option value="5">5.0</option>
                    <option value="3">3.1</option>
                  </select>
                </Field>
              </div>

              <div className="check-row">
                <Checkbox
                  id="fldClean"
                  label="Clean Session / 清理会话"
                  checked={draft.clean}
                  onChange={(e) => patch('clean', e.target.checked)}
                />
                <Checkbox
                  id="fldAutoReconnect"
                  label="自动重连"
                  checked={draft.autoReconnect}
                  onChange={(e) => patch('autoReconnect', e.target.checked)}
                />
                <Checkbox
                  id="fldRejectUnauthorized"
                  label="TLS 校验证书"
                  checked={draft.rejectUnauthorized}
                  onChange={(e) => patch('rejectUnauthorized', e.target.checked)}
                />
              </div>

              <details className="details">
                <summary>遗嘱消息 (Last Will)</summary>
                <div className="form-grid">
                  <Field label="Will 主题">
                    <input
                      id="fldWillTopic"
                      className="input"
                      type="text"
                      value={draft.willTopic}
                      onChange={(e) => patch('willTopic', e.target.value)}
                    />
                  </Field>
                  <Field label="Will QoS">
                    <select
                      id="fldWillQos"
                      className="select"
                      value={draft.willQos}
                      onChange={(e) => patch('willQos', e.target.value)}
                    >
                      <option value="0">0</option>
                      <option value="1">1</option>
                      <option value="2">2</option>
                    </select>
                  </Field>
                  <Field label="Will Payload" variant="span">
                    <textarea
                      id="fldWillPayload"
                      className="textarea"
                      rows={2}
                      spellCheck={false}
                      value={draft.willPayload}
                      onChange={(e) => patch('willPayload', e.target.value)}
                    />
                  </Field>
                </div>
                <Checkbox
                  id="fldWillRetain"
                  label="Will Retain"
                  checked={draft.willRetain}
                  onChange={(e) => patch('willRetain', e.target.checked)}
                />
              </details>
            </div>

            <div className="modal__foot">
              {server && (
                <Button variant="danger" id="fldDelete" data-testid="server-delete" onClick={() => void remove()}>
                  删除
                </Button>
              )}
              <div className="spacer" />
              <Button data-testid="server-cancel" onClick={close}>
                取消
              </Button>
              <Button variant="primary" id="fldSave" data-testid="server-save" disabled={saving} onClick={() => void save()}>
                保存
              </Button>
            </div>
          </RDialog.Content>
        </div>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

/** 供类型检查确认 BoolKey 被用到（表驱动时布尔字段走单独的 Checkbox 区块） */
export type ServerDraftBoolKey = BoolKey;
