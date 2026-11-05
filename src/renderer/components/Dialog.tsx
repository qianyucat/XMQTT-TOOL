/**
 * 弹层宿主（Radix Dialog）
 * ------------------------------------------------------------------
 * 全应用只有这一个弹层实例，由 `lib/dialog.ts` 的 store 驱动。
 * 这样 `prompt / confirm / choose / pickTopic` 仍然是「await 一行拿结果」，
 * 而 Esc 关闭、焦点陷阱、背景滚动锁定、遮罩点击这些细节只实现一次。
 *
 * 为什么用 Radix 而不是手写：焦点陷阱是手写最容易漏的一条 —— 弹层打开后按 Tab
 * 会跑到背后的表格里，键盘用户会当场迷路。这里 Content 自带 focus scope，
 * 关闭后还会把焦点还给触发元素。
 *
 * `.modal` / `.modal__panel` 等类名沿用旧样式，视觉零变化；Radix 只负责行为。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog as RDialog } from 'radix-ui';
import { Button } from './Button';
import { Icon } from './Icon';
import { useDialogStore } from '../lib/dialog';
import { fmtNumber } from '../lib/util';

export function DialogHost() {
  const request = useDialogStore((s) => s.request);
  const close = useDialogStore((s) => s.close);

  const [value, setValue] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // 每次换请求都重置草稿状态：否则上一次输入会漏到下一个弹层里
  useEffect(() => {
    if (!request) return;
    setValue(request.kind === 'prompt' ? request.defaultValue : '');
    setPicked(null);
    setSearch('');
  }, [request]);

  const topics = useMemo(() => {
    if (request?.kind !== 'pick-topic') return [];
    const needle = search.trim().toLowerCase();
    const list = needle ? request.topics.filter((t) => t.toLowerCase().includes(needle)) : request.topics;
    return list.slice(0, 500);
  }, [request, search]);

  /** 当前弹层的「确定」值；返回 `undefined` 表示不允许确认 */
  const confirmValue = (): string | boolean | null | undefined => {
    if (!request) return undefined;
    if (request.kind === 'prompt') return value.trim();
    if (request.kind === 'confirm') return true;
    return picked;
  };

  const submit = () => {
    const result = confirmValue();
    if (result === undefined) return;
    close(result);
  };

  const width = request?.kind === 'pick-topic' ? 620 : 460;

  return (
    <RDialog.Root
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) close(null);
      }}
    >
      <RDialog.Portal>
        <RDialog.Overlay className="modal__backdrop" />
        <div className="modal">
          {request && (
            <RDialog.Content
              className="modal__panel"
              style={{ width: `min(${width}px, 100%)` }}
              aria-describedby={undefined}
              data-testid="dialog"
              onOpenAutoFocus={(event) => {
                // prompt / 主题挑选需要光标直接落在输入框里，否则用户还得先按一次 Tab
                if (request.kind === 'prompt' || request.kind === 'pick-topic') {
                  event.preventDefault();
                  inputRef.current?.focus();
                  inputRef.current?.select();
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.target as HTMLElement).tagName === 'INPUT') {
                  // 主题挑选允许「搜完直接回车」；选择列表则要求先点一项
                  if (request.kind === 'prompt' || (request.kind === 'pick-topic' && picked)) {
                    event.preventDefault();
                    submit();
                  }
                }
              }}
            >
              <div className="modal__head">
                <RDialog.Title asChild>
                  <h3 data-testid="dialog-title">{request.title}</h3>
                </RDialog.Title>
                <Button
                  variant="icon"
                  title="关闭"
                  data-testid="dialog-close"
                  onClick={() => close(null)}
                >
                  <Icon name="x" />
                </Button>
              </div>

              <div className="modal__body">
                {request.message ? (
                  <p className="hint" data-testid="dialog-message" style={{ marginBottom: 12 }}>
                    {request.message}
                  </p>
                ) : null}

                {request.kind === 'prompt' && (
                  <input
                    ref={inputRef}
                    className="input"
                    type="text"
                    data-testid="dialog-input"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                  />
                )}

                {request.kind === 'choose' && (
                  <div className="list" data-testid="dialog-choices">
                    {request.options.map((opt) => (
                      <div
                        key={opt.value}
                        className={`list-item${picked === opt.value ? ' is-selected' : ''}`}
                        data-testid="dialog-choice"
                        data-value={opt.value}
                        onClick={() => setPicked(opt.value)}
                        onDoubleClick={() => {
                          setPicked(opt.value);
                          close(opt.value);
                        }}
                      >
                        <div className="list-item__main">
                          <div className="list-item__title" style={{ fontFamily: 'inherit' }}>
                            {opt.label}
                          </div>
                          {opt.desc ? <div className="list-item__sub">{opt.desc}</div> : null}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {request.kind === 'pick-topic' && (
                  <>
                    <input
                      ref={inputRef}
                      className="input"
                      type="search"
                      placeholder="搜索主题…"
                      spellCheck={false}
                      data-testid="dialog-search"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    <div style={{ height: 10 }} />
                    <div className="list" style={{ maxHeight: 340, overflow: 'auto' }}>
                      {topics.map((topic) => (
                        <div
                          key={topic}
                          className={`list-item${picked === topic ? ' is-selected' : ''}`}
                          data-testid="dialog-choice"
                          data-value={topic}
                          onClick={() => setPicked(topic)}
                          onDoubleClick={() => {
                            setPicked(topic);
                            close(topic);
                          }}
                        >
                          <div className="list-item__main">
                            <div className="list-item__title">{topic}</div>
                          </div>
                        </div>
                      ))}
                      {!topics.length && <div className="list__empty">没有匹配的主题</div>}
                    </div>
                  </>
                )}

                {request.kind === 'pick-topic' && (
                  <p className="hint" style={{ marginTop: 10 }}>
                    共 {fmtNumber(request.topics.length)} 个已收集主题
                  </p>
                )}
              </div>

              <div className="modal__foot">
                <div className="spacer" />
                <Button data-testid="dialog-cancel" onClick={() => close(null)}>
                  取消
                </Button>
                <Button
                  variant={request.kind === 'confirm' && request.danger ? 'danger' : 'primary'}
                  data-testid="dialog-confirm"
                  disabled={
                    (request.kind === 'prompt' && !value.trim()) ||
                    ((request.kind === 'choose' || request.kind === 'pick-topic') && !picked)
                  }
                  onClick={submit}
                >
                  确定
                </Button>
              </div>
            </RDialog.Content>
          )}
        </div>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
