/**
 * 布局尺寸的唯一真相源
 * ------------------------------------------------------------------
 * 消息表是虚拟滚动的：滚动条长度、上下垫片高度都由 TS 侧的一个数字算出来，
 * 而屏幕上行有多高由 CSS 决定。这两份真相一旦分叉，症状是「滚到底还差一截」，
 * 而且不报错、不崩溃 —— 只在手机档把行高抬到 44px 时才会出现。
 *
 * 所以行高只在这一个地方定义：`:root { --table-row-h }`（`styles/tokens.css`）。
 * CSS 用它排版，这里读它算虚拟列表。改行高只改一行 CSS。
 *
 * 为什么不顺便监听窗口宽度：
 * 行高属于「密度」，只随指针能力变（触屏 44px / 鼠标 28px）。
 * 桌面窗口拖到 900px 时行高必须还是 28px，否则就是拿桌面体验去换手机适配。
 */

import { useEffect, useState } from 'react';

/** CSS 变量读不到时的兜底值，必须与 tokens.css 的默认值一致 */
const FALLBACK_ROW_H = 28;

function readRowHeight(): number {
  if (typeof document === 'undefined') return FALLBACK_ROW_H;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--table-row-h');
  const value = parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : FALLBACK_ROW_H;
}

/**
 * 当前生效的表格行高（px）。
 *
 * 只有 `(pointer: coarse)` 会让它变化，所以只需要订阅这一个查询；
 * 窗口缩放、主题切换都不影响它。
 */
export function useTableRowHeight(): number {
  const [rowHeight, setRowHeight] = useState(readRowHeight);

  useEffect(() => {
    const mq = window.matchMedia('(pointer: coarse)');
    const sync = () => setRowHeight(readRowHeight());
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  return rowHeight;
}
