/**
 * 图标库（自动生成，勿手改 —— 改 tools/gen-icons.mjs 的 ICON_NAMES 后重跑）
 * ------------------------------------------------------------------
 * 数据来自 `lucide-react` 的 iconNode（ISC 许可），这里只取几何数据，
 * 不含任何 React 依赖 —— 命令式视图用 `icon()` 拿 SVGElement，
 * React 外壳用 `<Icon>` 读 `ICON_NODES` 渲染同名图标。
 *
 * 用法：
 *   el('button', { class: 'icon-btn' }, [icon('x')]);
 *   el('button', { class: 'icon-btn' }, [icon('copy', 13)]);
 *   <Icon name="send" size={18} />
 *
 * 颜色走 `currentColor`，所以图标永远跟所在控件的文字色一致，
 * 不需要为每个按钮单独指定图标颜色。
 */

export type IconNode = ReadonlyArray<readonly [string, Readonly<Record<string, string>>]>;

/**
 * 图标几何数据。
 * 命令式的 `icon()` 与 React 的 `<Icon>` 都读这一份 —— 两条渲染路径
 * 共用同一组 path，不会出现「同一图标在两个地方长得不一样」。
 */
export const ICON_NODES = {
  'settings': [
      ['path', {"d":"M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"}],
      ['circle', {"cx":"12","cy":"12","r":"3"}],
  ],
  'plus': [
      ['path', {"d":"M5 12h14"}],
      ['path', {"d":"M12 5v14"}],
  ],
  'sun-moon': [
      ['path', {"d":"M12 8a2.83 2.83 0 0 0 4 4 4 4 0 1 1-4-4"}],
      ['path', {"d":"M12 2v2"}],
      ['path', {"d":"M12 20v2"}],
      ['path', {"d":"m4.9 4.9 1.4 1.4"}],
      ['path', {"d":"m17.7 17.7 1.4 1.4"}],
      ['path', {"d":"M2 12h2"}],
      ['path', {"d":"M20 12h2"}],
      ['path', {"d":"m6.3 17.7-1.4 1.4"}],
      ['path', {"d":"m19.1 4.9-1.4 1.4"}],
  ],
  'send': [
      ['path', {"d":"M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"}],
      ['path', {"d":"m21.854 2.147-10.94 10.939"}],
  ],
  'radio-tower': [
      ['path', {"d":"M4.9 16.1C1 12.2 1 5.8 4.9 1.9"}],
      ['path', {"d":"M7.8 4.7a6.14 6.14 0 0 0-.8 7.5"}],
      ['circle', {"cx":"12","cy":"9","r":"2"}],
      ['path', {"d":"M16.2 4.8c2 2 2.26 5.11.8 7.47"}],
      ['path', {"d":"M19.1 1.9a9.96 9.96 0 0 1 0 14.1"}],
      ['path', {"d":"M9.5 18h5"}],
      ['path', {"d":"m8 22 4-11 4 11"}],
  ],
  'activity': [
      ['path', {"d":"M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"}],
  ],
  'scroll-text': [
      ['path', {"d":"M15 12h-5"}],
      ['path', {"d":"M15 8h-5"}],
      ['path', {"d":"M19 17V5a2 2 0 0 0-2-2H4"}],
      ['path', {"d":"M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"}],
  ],
  'x': [
      ['path', {"d":"M18 6 6 18"}],
      ['path', {"d":"m6 6 12 12"}],
  ],
  'check': [
      ['path', {"d":"M20 6 9 17l-5-5"}],
  ],
  'copy': [
      ['rect', {"width":"14","height":"14","x":"8","y":"8","rx":"2","ry":"2"}],
      ['path', {"d":"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"}],
  ],
  'download': [
      ['path', {"d":"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"}],
      ['polyline', {"points":"7 10 12 15 17 10"}],
      ['line', {"x1":"12","x2":"12","y1":"15","y2":"3"}],
  ],
  'pencil': [
      ['path', {"d":"M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"}],
      ['path', {"d":"m15 5 4 4"}],
  ],
  'rotate-cw': [
      ['path', {"d":"M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"}],
      ['path', {"d":"M21 3v5h-5"}],
  ],
  'volume-2': [
      ['path', {"d":"M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"}],
      ['path', {"d":"M16 9a5 5 0 0 1 0 6"}],
      ['path', {"d":"M19.364 18.364a9 9 0 0 0 0-12.728"}],
  ],
  'volume-x': [
      ['path', {"d":"M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"}],
      ['line', {"x1":"22","x2":"16","y1":"9","y2":"15"}],
      ['line', {"x1":"16","x2":"22","y1":"9","y2":"15"}],
  ],
  'chevron-down': [
      ['path', {"d":"m6 9 6 6 6-6"}],
  ],
  'arrow-up-right': [
      ['path', {"d":"M7 7h10v10"}],
      ['path', {"d":"M7 17 17 7"}],
  ],
  'trash-2': [
      ['path', {"d":"M3 6h18"}],
      ['path', {"d":"M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"}],
      ['path', {"d":"M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"}],
      ['line', {"x1":"10","x2":"10","y1":"11","y2":"17"}],
      ['line', {"x1":"14","x2":"14","y1":"11","y2":"17"}],
  ],
  'menu': [
      ['line', {"x1":"4","x2":"20","y1":"12","y2":"12"}],
      ['line', {"x1":"4","x2":"20","y1":"6","y2":"6"}],
      ['line', {"x1":"4","x2":"20","y1":"18","y2":"18"}],
  ],
} satisfies Record<string, IconNode>;

export type IconName = keyof typeof ICON_NODES;
export type IconNodes = typeof ICON_NODES;

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * 构造一个图标 SVG。
 * @param name  图标名（见下方 NODES 的键）
 * @param size  边长（px），默认 14 —— 与 13px 正文字号对齐
 * @param cls   额外的 class（如 'icon--spin'）
 */
export function icon(name: IconName, size = 14, cls = ''): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('data-icon', name);
  svg.setAttribute('class', cls ? `icon ${cls}` : 'icon');

  for (const [tag, attrs] of ICON_NODES[name]) {
    const child = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) child.setAttribute(k, v);
    svg.appendChild(child);
  }
  return svg;
}

/** 替换掉元素的全部子节点，只留一个图标（图标按钮的常见写法） */
export function setIcon(host: Element, name: IconName, size = 14, cls = ''): void {
  host.replaceChildren(icon(name, size, cls));
}
