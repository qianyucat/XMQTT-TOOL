/**
 * 发布视图（React）
 * ------------------------------------------------------------------
 * 左边是完整发布表单，右边是「消息模板 / 发布历史」两个列表。
 * 模板用于沉淀常发的报文格式 —— 这是 MQTT.fx 里最常用的调试习惯。
 *
 * 与旧实现（`views/publish.ts`，命令式）的关键差别：
 *
 * 1. **表单值只在 store 里**（`publishDraft`）。旧版每个输入框都是 DOM 自己存值，
 *    「从模板载入」「从历史载入」「主题行填入发布」三个入口要各自手写一遍回填 +
 *    手动调 `updateSize()`。现在这三个入口都只是 `setPublishDraft`，输入框跟着重渲染。
 * 2. **列表由 store 派生**，不再有 `renderTemplates()` 这种「谁改数据谁记得调用」的
 *    刷新函数 —— 保存模板后列表没刷新这类漏洞从此不存在。
 * 3. 草稿是受控组件：e2e 里直接改 `.value` 不再生效，必须先派发 input 事件
 *    （见 `tools/e2e-test.mjs` 的 `type()`）。这是受控输入换来的代价，也是它的定义。
 */

import { useMemo, useRef, useState } from 'react';
import type { PayloadEncoding, PublishRequest } from '@shared/models';
import { Button } from '../components/Button';
import { Empty } from '../components/Empty';
import { Field } from '../components/Field';
import { Icon } from '../components/Icon';
import { Resizer } from '../components/Resizer';
import { api } from '../ipc/client';
import { dialog } from '../lib/dialog';
import { byteLength } from '../lib/payload';
import { useSplitSize } from '../lib/resize';
import { errMsg, fmtBytes, fmtTime, preview, toast, tryFormatJson, uid } from '../lib/util';
import { act, selectIsConnected, useAppStore } from '../store/appStore';

const QOS_OPTIONS = [
  { value: '0', label: '0 · 至多一次' },
  { value: '1', label: '1 · 至少一次' },
  { value: '2', label: '2 · 仅一次' },
];

const ENCODINGS: Array<{ value: PayloadEncoding; label: string }> = [
  { value: 'utf8', label: 'UTF-8 文本' },
  { value: 'hex', label: 'HEX 字节' },
  { value: 'base64', label: 'Base64' },
];

/** 模板 / 历史侧栏的宽度下限：再窄就放不下「标题 + 一行摘要」 */
const SIDE_MIN_W = 240;
/** 左侧表单的下限，拖动条的上界由它反推 */
const FORM_MIN_W = 420;

/** 模板 / 历史条目都是发布请求的超集，统一按字段子集回填 */
function toDraft(data: Partial<PublishRequest>): PublishRequest {
  return {
    topic: data.topic ?? '',
    qos: data.qos ?? 0,
    retain: !!data.retain,
    encoding: data.encoding ?? 'utf8',
    payload: data.payload ?? '',
  };
}

export function PublishView({ active }: { active: boolean }) {
  const draft = useAppStore((s) => s.publishDraft);
  const templates = useAppStore((s) => s.templates);
  const history = useAppStore((s) => s.history);
  const connected = useAppStore(selectIsConnected);
  const hasConn = useAppStore((s) => s.connectionId !== null);
  const topics = useAppStore((s) => s.topics);

  const [tab, setTab] = useState<'tpl' | 'hist'>('tpl');
  const topicRef = useRef<HTMLInputElement>(null);

  /*
   * 表单 / 模板侧栏的宽度分配。
   * 模板名往往很长（`protocol/trackless/robot/control` 这种），
   * 320px 的固定侧栏会把标题截成「protocol/trackl...」，所以让它可拖。
   */
  const splitRef = useRef<HTMLDivElement>(null);
  const sideRef = useRef<HTMLDivElement>(null);
  const sideSplit = useSplitSize({
    axis: 'x',
    varName: '--pub-side-w',
    targetRef: sideRef,
    min: SIDE_MIN_W,
    max: () => {
      const host = splitRef.current;
      return host ? host.clientWidth - FORM_MIN_W : Number.POSITIVE_INFINITY;
    },
    // 分隔条在侧栏左侧：往左拖 = 侧栏变宽
    invert: true,
    storageKey: 'xmqtt.split.publishSide',
  });

  const size = useMemo(() => byteLength(draft.payload), [draft.payload]);

  const patch = (next: Partial<PublishRequest>) => act().setPublishDraft(next);
  const load = (data: Partial<PublishRequest>) => act().setPublishDraft(toDraft(data));

  const hint = connected
    ? ''
    : hasConn
      ? '连接已断开，无法发布。'
      : '尚未连接 Broker —— 请先在顶部选择服务器并连接。';

  /**
   * 发布。
   * `override` 用于「模板直接发」「历史重发」：先回填表单再发同一份数据，
   * 避免「回填 → 等一次重渲染 → 再读 store」这条绕路。
   */
  const send = async (override?: Partial<PublishRequest>): Promise<void> => {
    const data = toDraft({ ...act().publishDraft, ...override });
    const topic = data.topic.trim();

    if (!topic) {
      toast('warn', '主题为空', '请填写要发布的主题');
      topicRef.current?.focus();
      return;
    }

    const connId = act().connectionId;
    if (!connId) {
      toast('warn', '未连接', '请先连接 Broker');
      return;
    }

    try {
      const res = await api.publish(connId, { ...data, topic });
      // 只有用户主动点发布才写历史；重发历史时不再重复记录
      act().setHistory(
        await api.pushHistory({ ...data, topic, ts: res.ts, bytes: res.bytes, connectionId: connId })
      );
    } catch (err) {
      toast('error', '发布失败', errMsg(err));
    }
  };

  const formatJson = (): void => {
    const pretty = tryFormatJson(draft.payload);
    if (pretty === null) {
      toast('warn', '不是合法 JSON', '格式化仅适用于 JSON 文本');
      return;
    }
    patch({ payload: pretty });
  };

  const saveAsTemplate = async (): Promise<void> => {
    const data = toDraft(act().publishDraft);
    if (!data.topic.trim()) {
      toast('warn', '无法保存', '至少需要填写主题');
      return;
    }
    const name = await dialog.prompt('保存为模板', data.topic, '模板名称');
    if (name === null) return;

    try {
      act().setTemplates(
        await api.saveTemplate({ id: uid('tpl'), name: name || data.topic, ...data })
      );
      toast('success', '已保存模板', name || data.topic);
    } catch (err) {
      toast('error', '保存失败', errMsg(err));
    }
  };

  const renameTemplate = async (id: string, current: string, fallback: string): Promise<void> => {
    const name = await dialog.prompt('重命名模板', current);
    if (name === null) return;
    const tpl = act().templates.find((t) => t.id === id);
    if (!tpl) return;
    act().setTemplates(await api.saveTemplate({ ...tpl, name: name || fallback }));
  };

  const deleteTemplate = async (id: string, label: string): Promise<void> => {
    const ok = await dialog.confirm('删除模板', `确定删除「${label}」？`);
    if (!ok) return;
    act().setTemplates(await api.deleteTemplate(id));
  };

  const pickTopic = async (): Promise<void> => {
    const picked = await dialog.pickTopic([...act().topics.keys()]);
    if (picked) patch({ topic: picked });
  };

  return (
    <section className={`view${active ? ' is-active' : ''}`} id="view-publish">
      <div className="split split--publish" ref={splitRef} style={sideSplit.style}>
        <div className="pane">
          <div className="pane__head">
            <h2 className="pane__title">发布消息</h2>
            <div className="pane__actions">
              <Button size="sm" data-testid="pub-clear" onClick={() => act().resetPublishDraft()}>
                清空
              </Button>
            </div>
          </div>

          <div className="pane__body">
            <Field label="主题 Topic" row>
              <input
                id="pubTopic"
                ref={topicRef}
                className="input"
                type="text"
                placeholder="例如 factory/line1/robot/cmd"
                spellCheck={false}
                autoComplete="off"
                data-testid="pub-topic"
                value={draft.topic}
                onChange={(e) => patch({ topic: e.target.value })}
              />
              <Button
                size="sm"
                title={`从扫描到的 ${topics.size} 个主题中选择`}
                data-testid="pub-pick-topic"
                onClick={() => void pickTopic()}
              >
                选
              </Button>
            </Field>

            <div className="field-row">
              <Field label="QoS" variant="inline">
                <select
                  id="pubQos"
                  className="select select--sm"
                  data-testid="pub-qos"
                  value={String(draft.qos)}
                  onChange={(e) => patch({ qos: Number(e.target.value) || 0 })}
                >
                  {QOS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="编码" variant="inline">
                <select
                  id="pubEncoding"
                  className="select select--sm"
                  data-testid="pub-encoding"
                  value={draft.encoding}
                  onChange={(e) => patch({ encoding: e.target.value as PayloadEncoding })}
                >
                  {ENCODINGS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Field>

              <label className="switch" title="保留消息：新订阅者会立即收到最后一条">
                <input
                  id="pubRetain"
                  type="checkbox"
                  data-testid="pub-retain"
                  checked={draft.retain}
                  onChange={(e) => patch({ retain: e.target.checked })}
                />
                <span className="switch__track">
                  <span className="switch__thumb" />
                </span>
                <span className="switch__text">Retain</span>
              </label>
            </div>

            <Field label="Payload" variant="grow" hint={<span id="pubSize">{fmtBytes(size)}</span>}>
              <textarea
                id="pubPayload"
                className="textarea textarea--code"
                spellCheck={false}
                placeholder='{ "cmd": "start" }'
                data-testid="pub-payload"
                value={draft.payload}
                onChange={(e) => patch({ payload: e.target.value })}
                onKeyDown={(e) => {
                  // Ctrl+Enter / Cmd+Enter 快捷发布
                  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
            </Field>

            <div className="btn-row">
              <Button
                variant="primary"
                wide
                id="pubSend"
                className="needs-connection"
                disabled={!connected}
                data-testid="pub-send"
                onClick={() => void send()}
              >
                发布
              </Button>
              <Button title="格式化 JSON" data-testid="pub-format" onClick={formatJson}>
                格式化
              </Button>
              <Button
                title="把当前消息保存为模板"
                data-testid="pub-save-template"
                onClick={() => void saveAsTemplate()}
              >
                存为模板
              </Button>
            </div>

            <p className="hint" id="pubHint" data-testid="pub-hint">
              {hint}
            </p>
          </div>
        </div>

        <Resizer api={sideSplit} label="拖动调整模板栏宽度" testId="publish-split" />

        <div className="pane pane--side" ref={sideRef}>
          <div className="tabs tabs--side">
            <button
              type="button"
              className={`tabs__item${tab === 'tpl' ? ' is-active' : ''}`}
              data-tab="tpl"
              data-testid="tab-templates"
              onClick={() => setTab('tpl')}
            >
              消息模板
            </button>
            <button
              type="button"
              className={`tabs__item${tab === 'hist' ? ' is-active' : ''}`}
              data-tab="hist"
              data-testid="tab-history"
              onClick={() => setTab('hist')}
            >
              发布历史
            </button>
          </div>

          <div className="pane__body pane__body--list">
            <div className={`list-panel${tab === 'tpl' ? ' is-active' : ''}`} id="panel-tpl">
              <div className="list" id="templateList" data-testid="template-list">
                {templates.length ? (
                  templates.map((tpl) => {
                    const label = tpl.name || tpl.topic;
                    return (
                      <div
                        key={tpl.id ?? label}
                        className="list-item"
                        data-testid="template-item"
                        onClick={() => {
                          load(tpl);
                          toast('info', '已载入模板', label);
                        }}
                      >
                        <div className="list-item__main">
                          <div className="list-item__title">{label}</div>
                          <div className="list-item__sub">
                            {`${tpl.topic || '(无主题)'} · QoS ${tpl.qos ?? 0}${
                              tpl.retain ? ' · retain' : ''
                            } · ${preview(tpl.payload || '', 60)}`}
                          </div>
                        </div>

                        <div className="list-item__actions">
                          <Button
                            variant="icon"
                            title="载入到发布表单"
                            data-testid="template-load"
                            onClick={(e) => {
                              e.stopPropagation();
                              load(tpl);
                              toast('info', '已载入模板', label);
                            }}
                          >
                            <Icon name="download" size={13} />
                          </Button>
                          <Button
                            variant="icon"
                            title={connected ? '直接用此模板发布' : '未连接，无法发布'}
                            disabled={!connected}
                            data-testid="template-send"
                            onClick={(e) => {
                              e.stopPropagation();
                              load(tpl);
                              void send(tpl);
                            }}
                          >
                            <Icon name="send" size={13} />
                          </Button>
                          <Button
                            variant="icon"
                            title="重命名"
                            data-testid="template-rename"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (tpl.id) void renameTemplate(tpl.id, label, tpl.topic);
                            }}
                          >
                            <Icon name="pencil" size={13} />
                          </Button>
                          <Button
                            variant="icon"
                            title="删除模板"
                            data-testid="template-delete"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (tpl.id) void deleteTemplate(tpl.id, label);
                            }}
                          >
                            <Icon name="trash-2" size={13} />
                          </Button>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <Empty>还没有模板。填好主题与报文体后点「存为模板」沉淀下来。</Empty>
                )}
              </div>
            </div>

            <div className={`list-panel${tab === 'hist' ? ' is-active' : ''}`} id="panel-hist">
              <div className="list" id="historyList" data-testid="history-list">
                {history.length ? (
                  history.map((h, i) => (
                    <div
                      key={`${h.ts}-${i}`}
                      className="list-item"
                      data-testid="history-item"
                      onClick={() => load(h)}
                    >
                      <div className="list-item__main">
                        <div className="list-item__title">{h.topic}</div>
                        <div className="list-item__sub">
                          {`${fmtTime(h.ts)} · QoS ${h.qos ?? 0}${h.retain ? ' · retain' : ''} · ${fmtBytes(
                            h.bytes || 0
                          )}`}
                        </div>
                      </div>

                      <div className="list-item__actions">
                        <Button
                          variant="icon"
                          title={connected ? '重发' : '未连接，无法重发'}
                          disabled={!connected}
                          data-testid="history-resend"
                          onClick={(e) => {
                            e.stopPropagation();
                            void (async () => {
                              const connId = act().connectionId;
                              if (!connId) {
                                toast('warn', '未连接', '请先连接 Broker');
                                return;
                              }
                              try {
                                await api.publish(connId, toDraft(h));
                                toast('success', '已重发', h.topic);
                              } catch (err) {
                                toast('error', '重发失败', errMsg(err));
                              }
                            })();
                          }}
                        >
                          <Icon name="rotate-cw" size={13} />
                        </Button>
                        <Button
                          variant="icon"
                          title="载入到表单"
                          data-testid="history-load"
                          onClick={(e) => {
                            e.stopPropagation();
                            load(h);
                          }}
                        >
                          <Icon name="download" size={13} />
                        </Button>
                      </div>
                    </div>
                  ))
                ) : (
                  <Empty>暂无发布记录。</Empty>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
