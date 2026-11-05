/**
 * 通用工具（DOM 构建 / 格式化 / 剪贴板 / Toast）
 * ------------------------------------------------------------------
 * 原 `js/util.js` 的 TypeScript 版本：模块语法从「IIFE 挂 window.X」改成真正的
 * ESM `export`，**实现逻辑一行没改**。改的只有类型标注。
 *
 * 两个签名上值得说明的地方：
 *
 * 1. `el()` 保留「属性包」的设计（`class` / `text` / `dataset` / `on*`），
 *    因为六个视图都在用它拼 DOM。返回类型按标签名收窄
 *    （`el('input')` → `HTMLInputElement`），调用点就不用再断言。
 * 2. `$()` 找不到元素时**抛错**而不是返回 null。
 *    `index.html` 是静态骨架，id 缺失属于开发期错误；让它在调用点炸掉，
 *    比让 `null.value` 在某个事件回调里静默失败更好查。
 */

export type ToastKind = 'info' | 'success' | 'warn' | 'error';

/** `el()` 的子节点：字符串会变成文本节点，数字同理，falsy 跳过 */
export type ElChild = Node | string | number | null | undefined | false;

/**
 * `el()` 的属性包。
 *
 * 已知的键给了具体类型，其余走索引签名（`data-*`、`aria-*` 等按 attribute 落）。
 * 事件只显式声明实际用到的四种，好处是箭头函数的参数能拿到上下文类型，
 * 不必在每个回调上手写 `(e: KeyboardEvent)`。
 */
export interface ElProps {
  class?: string;
  text?: string | number;
  style?: string;
  title?: string;
  type?: string;
  value?: string | number;
  placeholder?: string;
  colspan?: string | number;
  dataset?: Record<string, string>;
  checked?: boolean;
  disabled?: boolean;
  hidden?: boolean;
  selected?: boolean;
  onclick?: (e: MouseEvent) => void;
  onchange?: (e: Event) => void;
  oninput?: (e: Event) => void;
  onkeydown?: (e: KeyboardEvent) => void;
  [attr: string]: unknown;
}

/* ------------------------------ DOM ------------------------------ */

/**
 * 单元素查询。找不到直接抛 —— 静态骨架里的 id 缺失是开发期 bug，
 * 静默返回 null 只会把错误推到更远的地方。
 */
export function $<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T {
  const node = root.querySelector<T>(sel);
  if (!node) throw new Error(`[dom] 找不到元素：${sel}`);
  return node;
}

/** 多元素查询，永远返回数组（不是 NodeList） */
export function $$<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll<T>(sel));
}

/**
 * 创建元素。
 * `text` 一律走 textContent —— 消息内容来自网络，绝不允许拼接进 innerHTML。
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: ElProps | null,
  children?: ElChild | ElChild[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = String(v);
      else if (k === 'text') node.textContent = String(v);
      else if (k === 'dataset') Object.assign(node.dataset, v as Record<string, string>);
      else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'selected') {
        // 这几个是「属性 vs IDL 字段」行为不一致的地方，必须走字段赋值而不是 setAttribute
        (node as unknown as Record<string, unknown>)[k] = Boolean(v);
      } else node.setAttribute(k, String(v));
    }
  }

  appendChildren(node, children);
  return node;
}

export function appendChildren(node: Node, children?: ElChild | ElChild[]): void {
  if (children === null || children === undefined) return;
  const list: ElChild[] = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function clear<T extends Element>(node: T): T {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/* ---------------------------- 格式化 ---------------------------- */

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

export function fmtTime(ts: number, withMs = true): string {
  const d = new Date(ts);
  const base = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return withMs ? `${base}.${pad(d.getMilliseconds(), 3)}` : base;
}

/**
 * 毫秒部分（含前导点），单独渲染是为了让窄档位能用 CSS 把它藏掉。
 * 手机档时间列只有 64px，`.123` 占的宽度正好够两三个汉字主题。
 */
export function fmtMs(ts: number): string {
  return `.${pad(new Date(ts).getMilliseconds(), 3)}`;
}

export function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${fmtTime(ts)}`;
}

export function fmtBytes(n: number | null | undefined): string {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function fmtDuration(ms: number | null | undefined): string {
  if (!ms || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${pad(m)}m ${pad(sec)}s`;
  if (m) return `${m}m ${pad(sec)}s`;
  return `${sec}s`;
}

export function fmtNumber(n: number | null | undefined): string {
  return (n || 0).toLocaleString('en-US');
}

/* ---------------------------- 文本处理 ---------------------------- */

export function escapeHtml(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * JSON 高亮。
 * 先整体转义再插入着色标签 —— 顺序不能反，否则消息内容里的标签会被当 HTML 执行。
 */
export function highlightJson(jsonText: string): string {
  const escaped = escapeHtml(jsonText);
  return escaped.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (match: string) => {
      let cls = 'tok-num';
      if (/^"/.test(match)) cls = /:$/.test(match) ? 'tok-key' : 'tok-str';
      else if (/true|false/.test(match)) cls = 'tok-bool';
      else if (/null/.test(match)) cls = 'tok-null';
      return `<span class="${cls}">${match}</span>`;
    }
  );
}

/** 尝试 JSON 美化，失败返回 null（调用方决定回退策略） */
export function tryFormatJson(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}

/** 只取第一行做表格预览，并压掉多余空白 */
export function preview(text: unknown, max = 220): string {
  const oneLine = String(text).replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/* ----------------------------- 剪贴板 ----------------------------- */

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 剪贴板 API 不可用时退回 execCommand
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  }
}

/* ------------------------------ Toast ---------------------------- */

export function toast(type: ToastKind, title: string, body?: string, timeout = 3600): void {
  // 这里刻意不用 `$()`：toast 是错误上报通道，容器缺失时不能反过来抛错
  const host = document.querySelector('#toasts');
  if (!host) return;

  const node = el('div', { class: `toast toast--${type}` }, [
    el('div', { class: 'toast__title', text: title }),
    body ? el('div', { class: 'toast__body', text: body }) : null,
  ]);

  host.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .2s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 220);
  }, timeout);
}

/* --------------------------- 小工具 --------------------------- */

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let t: ReturnType<typeof setTimeout> | null = null;
  return (...args: A) => {
    if (t !== null) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** 订阅主题 → 转成正则，用于判断某主题是否落在某个过滤器下 */
export function topicMatches(filter: string, topic: string): boolean {
  const fp = String(filter).split('/');
  const tp = String(topic).split('/');
  for (let i = 0; i < fp.length; i += 1) {
    const f = fp[i];
    if (f === '#') return true;
    if (i >= tp.length) return false;
    if (f !== '+' && f !== tp[i]) return false;
  }
  return fp.length === tp.length;
}

/**
 * 把 catch 到的 unknown 折成可展示的文案。
 *
 * TS 的 `useUnknownInCatchVariables` 让 `catch (err)` 是 `unknown`，直接读 `.message`
 * 编译不过。与其在每个 catch 里写三元，统一收在这里 —— 顺带保证非 Error 抛出物
 * （字符串、对象）也有可读输出。
 */
export function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
  return '操作失败';
}
