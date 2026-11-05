/**
 * 列表空态
 * ------------------------------------------------------------------
 * 六处 `list__empty` 文案原本散在视图里各写一遍 `el('div', {class:'list__empty'})`，
 * 收敛成组件只是少写几个字符，但它同时保证「空态一律居中、一律用 muted 色」。
 */

import type { ReactNode } from 'react';

export function Empty({ children }: { children: ReactNode }) {
  return <div className="list__empty">{children}</div>;
}
