/**
 * 图标生成器
 * ------------------------------------------------------------------
 * 阶段 2 不引入 React，但需要真正的矢量图标（原本用 `↑ ⌗ ◍ ≡ ⚙ ＋` 这类
 * Unicode 字符充当图标 —— 不同字体的字形、基线、粗细全不一样，永远做不到
 * 「一套图标」的观感）。
 *
 * 做法：直接从已安装的 `lucide-react` 里读 iconNode 数据（纯数据，不含 React），
 * 生成两份产物：
 *
 *   1. `src/renderer/lib/icons.ts` —— 图标几何数据 + 构造 SVGElement 的工厂，
 *      供命令式视图（views/*.ts、ui/modal.ts）使用；`ICON_NODES` 同时被
 *      React 侧的 `<Icon>` 组件消费，两套渲染读的是同一份数据。
 *   2. `src/renderer/index.html` —— 把 `<i data-icon="name" data-size="18">`
 *      占位标记展开成内联 `<svg>`。静态骨架（如服务器编辑弹层）里的图标必须
 *      写死在 HTML 里，生产 CSP 是 `script-src 'self'`，不能靠内联脚本补。
 *
 * 幂等：重复运行时 HTML 里已经展开的 `<svg data-icon="…">` 会被重新展开，
 * 因此改图标只需改 ICONS 表里的名字再跑一次。
 *
 * 用法：node tools/gen-icons.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICON_DIR = path.join(ROOT, 'node_modules/lucide-react/dist/esm/icons');
const TS_OUT = path.join(ROOT, 'src/renderer/lib/icons.ts');
const HTML_PATH = path.join(ROOT, 'src/renderer/index.html');

/** 视图 / 骨架里用到的全部图标。新增图标只改这里。 */
const ICON_NAMES = [
  'settings',
  'plus',
  'sun-moon',
  'send',
  'radio-tower',
  'activity',
  'scroll-text',
  'x',
  'check',
  'copy',
  'download',
  'pencil',
  'rotate-cw',
  'volume-2',
  'volume-x',
  'chevron-down',
  'arrow-up-right',
  'trash-2',
  'menu',
];

/* --------------------------- 读取 iconNode --------------------------- */

/** 从 `<name>.js` 里抠出 createLucideIcon 的第二个参数（是合法 JSON） */
function readIconNode(name) {
  const file = path.join(ICON_DIR, `${name}.js`);
  if (!fs.existsSync(file)) throw new Error(`lucide 没有这个图标：${name}`);

  const src = fs.readFileSync(file, 'utf8');
  const anchor = src.indexOf('createLucideIcon(');
  if (anchor < 0) throw new Error(`${name}.js 结构不认识（没有 createLucideIcon）`);

  const start = src.indexOf('[', anchor);
  let depth = 0;
  let end = -1;
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) throw new Error(`${name}.js 的 iconNode 数组没有闭合`);

  // 注意：lucide 的属性键**没有引号**（`d: "…"`），不是合法 JSON，
  // 只能当 JS 表达式求值。数据来自本地 node_modules，不接受外部输入。
  const raw = src.slice(start, end);
  return new Function(`return ${raw}`)();
}

/* ----------------------------- 生成 TS ----------------------------- */

const camel = (s) =>
  s.replace(/-([a-z])/g, (_, c) => c.toUpperCase()).replace(/^[a-z]/, (c) => c.toUpperCase());

function buildTs(nodes) {
  const entries = Object.entries(nodes)
    .map(([name, node]) => {
      const body = node
        .map(([tag, attrs]) => {
          const clean = Object.fromEntries(Object.entries(attrs).filter(([k]) => k !== 'key'));
          return `      ['${tag}', ${JSON.stringify(clean)}],`;
        })
        .join('\n');
      return `  '${name}': [\n${body}\n  ],`;
    })
    .join('\n');

  return `/**
 * 图标库（自动生成，勿手改 —— 改 tools/gen-icons.mjs 的 ICON_NAMES 后重跑）
 * ------------------------------------------------------------------
 * 数据来自 \`lucide-react\` 的 iconNode（ISC 许可），这里只取几何数据，
 * 不含任何 React 依赖 —— 命令式视图用 \`icon()\` 拿 SVGElement，
 * React 外壳用 \`<Icon>\` 读 \`ICON_NODES\` 渲染同名图标。
 *
 * 用法：
 *   el('button', { class: 'icon-btn' }, [icon('x')]);
 *   el('button', { class: 'icon-btn' }, [icon('copy', 13)]);
 *   <Icon name="send" size={18} />
 *
 * 颜色走 \`currentColor\`，所以图标永远跟所在控件的文字色一致，
 * 不需要为每个按钮单独指定图标颜色。
 */

export type IconNode = ReadonlyArray<readonly [string, Readonly<Record<string, string>>]>;

/**
 * 图标几何数据。
 * 命令式的 \`icon()\` 与 React 的 \`<Icon>\` 都读这一份 —— 两条渲染路径
 * 共用同一组 path，不会出现「同一图标在两个地方长得不一样」。
 */
export const ICON_NODES = {
${entries}
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
  svg.setAttribute('class', cls ? \`icon \${cls}\` : 'icon');

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
`;
}

/* ---------------------------- 展开 HTML ---------------------------- */

function svgMarkup(name, size, cls) {
  const node = ICON_MAP[name];
  if (!node) throw new Error(`HTML 里用了未注册的图标：${name}`);

  const attrs = node
    .map(([tag, a]) => {
      const inner = Object.entries(a)
        .filter(([k]) => k !== 'key')
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ');
      return `<${tag} ${inner}/>`;
    })
    .join('');

  const classAttr = cls ? `icon ${cls}` : 'icon';
  return (
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ` +
    `focusable="false" data-icon="${name}" class="${classAttr}">${attrs}</svg>`
  );
}

const ICON_MAP = Object.fromEntries(ICON_NAMES.map((n) => [n, readIconNode(n)]));

function expandHtml() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');

  // 已经是 <svg data-icon="x"> 的，先退回占位标记，保证可重复运行
  const collapsed = html.replace(/<svg\b[^>]*data-icon="([^"]+)"[^>]*>[\s\S]*?<\/svg>/g, (tag, name) => {
    const sizeMatch = /\bwidth="(\d+)"/.exec(tag);
    const clsMatch = /\bclass="([^"]*)"/.exec(tag);
    const cls = (clsMatch ? clsMatch[1] : '').replace(/\bicon\b\s*/, '').trim();
    const size = sizeMatch ? sizeMatch[1] : '14';
    return `<i data-icon="${name}" data-size="${size}"${cls ? ` class="${cls}"` : ''}></i>`;
  });

  let count = 0;
  const out = collapsed.replace(/<i data-icon="([^"]+)"([^>]*)><\/i>/g, (_, name, rest) => {
    const sizeMatch = /data-size="(\d+)"/.exec(rest);
    const size = sizeMatch ? Number(sizeMatch[1]) : 14;
    const clsMatch = /class="([^"]*)"/.exec(rest);
    const cls = clsMatch ? clsMatch[1] : '';
    count += 1;
    return svgMarkup(name, size, cls);
  });

  fs.writeFileSync(HTML_PATH, out);
  return count;
}

/* ------------------------------- main ------------------------------- */

fs.writeFileSync(TS_OUT, buildTs(ICON_MAP));
const replaced = expandHtml();

console.log(`icons.ts  → ${ICON_NAMES.length} 个图标`);
console.log(`index.html → 展开 ${replaced} 处占位`);
