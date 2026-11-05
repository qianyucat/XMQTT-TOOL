/**
 * 分栏尺寸（拖动条的唯一状态源）
 * ------------------------------------------------------------------
 * 全应用所有「可拖动改变模块大小」的地方都走这里，不再各自写一份
 * `pointerdown → pointermove → setState` 的仪式代码。三件事被收拢到一处：
 *
 * 1. **尺寸写成 CSS 变量**，不直接改元素的 inline 宽高。
 *    响应式断点里只是改同一个变量的默认值（`--browser-left-w: clamp(...)`），
 *    「用户拖过」与「没拖过」因此是同一套取值路径 —— 拖动值写 inline（优先级最高），
 *    没拖过就让 CSS 的断点默认值生效。反过来（CSS 直接写 width、JS 再 inline 覆盖）
 *    会在断点切换时出现「拖过一次就永远不跟随响应式」。
 *
 * 2. **上界只在按下时量一次**（拖动期间布局每帧都在变，每帧重量会抖），
 *    中途容器变小（窗口缩放）由 ResizeObserver 兜回来。
 *
 * 3. **尺寸记忆落在 localStorage**。它是「这台机器的这块屏」的偏好，
 *    与 `xmqtt-config.json` 里那些跨设备同步的业务配置不是一类东西：
 *    把 380px 的树宽导出到 13 寸笔记本上只会挤死表格。
 *    读写全部 try/catch —— 存储被禁用时功能照用，只是不记忆。
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';

/** 拖动方向：`x` = 竖直分隔条、左右拖；`y` = 水平分隔条、上下拖 */
export type SplitAxis = 'x' | 'y';

export interface SplitSizeOptions {
  axis: SplitAxis;
  /** 尺寸写进哪个 CSS 变量，如 `--browser-left-w` */
  varName: string;
  /**
   * 被调整尺寸的元素。拖动起点按它**实际渲染尺寸**算，不用 state ——
   * 它可能刚被窗口高度压缩过，拿 state 起算会出现一次「跳一下」。
   * 它的 `parentElement` 同时被当作容器，用来求上界与监听尺寸变化。
   */
  targetRef: RefObject<HTMLElement | null>;
  /** 下界（px） */
  min: number;
  /** 上界；缺省为无穷（下界仍然生效）。面板不可见时应返回 Infinity */
  max?: () => number;
  /** true = 分隔条**后面**那块决定尺寸（详情面板在下方、侧栏在右侧） */
  invert?: boolean;
  /** localStorage 键；不给就不记忆 */
  storageKey?: string;
}

export interface SplitSizeApi {
  axis: SplitAxis;
  /** null = 从未拖过（或已复位），尺寸完全交给 CSS 断点默认值 */
  size: number | null;
  min: number;
  /** 直接铺在容器上的 style（只含那个 CSS 变量） */
  style: CSSProperties;
  beginDrag(e: ReactPointerEvent<HTMLElement>): void;
  reset(): void;
  onKeyDown(e: ReactKeyboardEvent<HTMLElement>): void;
}

/** 拖动期间挂在 body 上，用来锁光标 + 禁止选中文字 */
const BODY_CLASS: Record<SplitAxis, string> = { x: 'is-resizing-x', y: 'is-resizing-y' };

function readStored(key: string | undefined): number | null {
  if (!key) return null;
  try {
    const raw = window.localStorage.getItem(key);
    const value = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function writeStored(key: string | undefined, value: number | null): void {
  if (!key) return;
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, String(Math.round(value)));
  } catch {
    /* 存不了就不存，功能本身不依赖它 */
  }
}

export function useSplitSize(opts: SplitSizeOptions): SplitSizeApi {
  const { axis, varName, targetRef, min, invert = false, storageKey } = opts;

  const [size, setSize] = useState<number | null>(() => readStored(storageKey));

  /** state 的同步镜像：拖动结束要落盘、键盘步进要读当前值，都不能等下一次渲染 */
  const sizeRef = useRef<number | null>(size);

  // `max` 是一个每次渲染都可能换新的闭包（它读的是别的 DOM 尺寸），放在 ref 里
  const maxRef = useRef(opts.max);
  maxRef.current = opts.max;

  const apply = useCallback((next: number | null): void => {
    sizeRef.current = next;
    setSize(next);
  }, []);

  const limit = useCallback((): number => {
    const raw = maxRef.current?.() ?? Number.POSITIVE_INFINITY;
    return Number.isFinite(raw) ? Math.max(min, raw) : Number.POSITIVE_INFINITY;
  }, [min]);

  const clamp = useCallback(
    (value: number, high: number): number => Math.min(Math.max(value, min), high),
    [min]
  );

  /** 当前实际渲染尺寸；元素不在（未挂载 / 面板隐藏）时退回 state */
  const measure = (): number => {
    const el = targetRef.current;
    if (!el) return sizeRef.current ?? min;
    const rect = el.getBoundingClientRect();
    const value = axis === 'x' ? rect.width : rect.height;
    return value > 0 ? value : (sizeRef.current ?? min);
  };

  const beginDrag = (e: ReactPointerEvent<HTMLElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startPos = axis === 'x' ? e.clientX : e.clientY;
    const startSize = measure();
    const high = limit();
    const sign = invert ? -1 : 1;

    const onMove = (ev: PointerEvent): void => {
      // 指针在窗口外松开时收不到 pointerup，用 buttons 兜一下，免得「粘住」继续拖
      if (ev.buttons === 0) {
        onEnd();
        return;
      }
      const pos = axis === 'x' ? ev.clientX : ev.clientY;
      apply(clamp(startSize + sign * (pos - startPos), high));
    };
    const onEnd = (): void => {
      document.body.classList.remove(BODY_CLASS[axis]);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      writeStored(storageKey, sizeRef.current);
    };

    document.body.classList.add(BODY_CLASS[axis]);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
  };

  /** 双击复位：回到 CSS 断点默认值，不是回到某个写死的常量 */
  const reset = (): void => {
    apply(null);
    writeStored(storageKey, null);
  };

  /**
   * 键盘：分隔条聚焦后沿轴方向步进，按住 Shift 走大步。
   * 方向按「分隔条往哪走」定义，再按 invert 折算到尺寸上 ——
   * 详情面板在分隔条下方，所以「向下」就是「面板变矮」。
   */
  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>): void => {
    const step = e.shiftKey ? 40 : 12;
    let move = 0;
    if (axis === 'x') {
      if (e.key === 'ArrowLeft') move = -step;
      else if (e.key === 'ArrowRight') move = step;
    } else if (e.key === 'ArrowUp') move = -step;
    else if (e.key === 'ArrowDown') move = step;
    if (!move) return;
    e.preventDefault();
    const next = clamp((sizeRef.current ?? measure()) + (invert ? -move : move), limit());
    apply(next);
    writeStored(storageKey, next);
  };

  /*
   * 容器变小（窗口缩放、详情面板展开）时把定宽收回来。
   * 没有这一步，上一次拖出来的 600px 会一直占着，隔壁面板被压到没有宽度 ——
   * 表现是「表格突然没了」，而不是报错。
   */
  useEffect(() => {
    const host = targetRef.current?.parentElement;
    if (!host || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (sizeRef.current === null) return;
      const next = clamp(sizeRef.current, limit());
      if (next !== sizeRef.current) apply(next);
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [targetRef, apply, clamp, limit]);

  return {
    axis,
    size,
    min,
    style: (size === null ? {} : { [varName]: `${Math.round(size)}px` }) as CSSProperties,
    beginDrag,
    reset,
    onKeyDown,
  };
}
