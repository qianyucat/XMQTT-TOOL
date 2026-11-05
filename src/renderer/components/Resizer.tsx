/**
 * 拖动分隔条
 * ------------------------------------------------------------------
 * 纯展示组件：状态、边界、记忆全在 `lib/resize.ts` 的 `useSplitSize()` 里，
 * 这里只负责「长什么样 + 语义是什么」。分开的好处是每个分栏都由自己的 hook
 * 实例持有尺寸，组件不用维护 id 到尺寸的映射表。
 *
 * 三档视觉（见 app.css 的 `.resizer`）：常态一条发丝线 + 居中淡握把，
 * 悬停/聚焦握把亮主色并拉长，拖动中整条线点亮 —— 光有 `cursor` 不够，
 * 用户不把鼠标移上去就不知道这里能拖。
 *
 * 无障碍：`role="separator"` + `aria-orientation` + `tabIndex=0`，
 * 键盘左右/上下键可调，双击复位。
 */

import type { SplitSizeApi } from '../lib/resize';

interface ResizerProps {
  api: SplitSizeApi;
  /** 既作 aria-label 也作 tooltip 的主干 */
  label: string;
  testId?: string;
  className?: string;
}

export function Resizer({ api, label, testId, className }: ResizerProps) {
  const vertical = api.axis === 'x';
  return (
    <div
      className={`resizer resizer--${api.axis}${className ? ` ${className}` : ''}`}
      role="separator"
      // 左右分的是「竖直方向的分隔线」，与 CSS 的 col-resize 对应
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuemin={api.min}
      aria-valuenow={api.size === null ? undefined : Math.round(api.size)}
      tabIndex={0}
      title={`${label} · 双击复位`}
      data-testid={testId}
      onPointerDown={api.beginDrag}
      onDoubleClick={api.reset}
      onKeyDown={api.onKeyDown}
    />
  );
}
