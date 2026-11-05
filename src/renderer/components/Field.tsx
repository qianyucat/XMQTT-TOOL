/**
 * 表单字段
 * ------------------------------------------------------------------
 * 只是把「标签 + 控件」这套重复结构收成一处。修饰类与既有 CSS 一一对应
 * （`field--inline` / `field--grow` / `field--span`），样式一行没变。
 *
 * `row` 用于「输入框 + 按钮并排」—— 那层 `.field__row` 是 flex 容器，
 * 没有它按钮会掉到下一行，这正是旧 HTML 里到处手写 div 的原因。
 */

import type { ReactNode } from 'react';

export interface FieldProps {
  label: ReactNode;
  /** 标签右侧的浅色补充说明（如 payload 字节数） */
  hint?: ReactNode;
  variant?: 'inline' | 'grow' | 'span';
  row?: boolean;
  children: ReactNode;
}

export function Field({ label, hint, variant, row, children }: FieldProps) {
  const className = `field${variant ? ` field--${variant}` : ''}`;
  return (
    <label className={className}>
      <span className="field__label">
        {label}
        {hint !== undefined && hint !== null ? <span className="field__hint">{hint}</span> : null}
      </span>
      {row ? <div className="field__row">{children}</div> : children}
    </label>
  );
}
