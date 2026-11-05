/**
 * 图标组件（React）
 * ------------------------------------------------------------------
 * 数据源与命令式视图共用 `lib/icons.ts` 里的 `ICON_NODES` —— 同一个图标在
 * React 外壳和旧视图里不会是两套 path。
 *
 * 为什么不直接用 `lucide-react` 的组件：那会把整个图标库打进产物（tree-shaking
 * 之后虽然只留用到的，但两套实现意味着同一份几何数据在源码里存在两次）。
 * 这里只是把纯数据渲染成 `<svg>`，一共十几行。
 */

import { createElement } from 'react';
import { ICON_NODES } from '../lib/icons';
import type { IconName } from '../lib/icons';

export interface IconProps {
  name: IconName;
  /** 边长（px）。13 正文字号用 14，导航用 18 */
  size?: number;
  className?: string;
}

export function Icon({ name, size = 14, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-icon={name}
      className={className ? `icon ${className}` : 'icon'}
    >
      {ICON_NODES[name].map(([tag, attrs], i) =>
        // lucide 的 iconNode 是 [标签名, 属性表]，全是 SVG 原生属性名（d / cx / r …）
        createElement(tag, { key: `${name}-${i}`, ...attrs })
      )}
    </svg>
  );
}
