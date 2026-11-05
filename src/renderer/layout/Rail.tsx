/**
 * 左侧导航
 * ------------------------------------------------------------------
 * 阶段 3 起由 React 渲染：选中态、主题角标、错误角标全部从 store 派生。
 * 之前这三个状态散在 `app.ts` 的 `switchView`（改 class）与两处手写 DOM 里
 * （`scheduleTopicRender` 写主题角标、`log.updateBadge` 写错误数）。
 *
 * 选中态从「给按钮换底色」改成「一片会滑动的液态玻璃」（`.rail__lens`）：
 * 玻璃片是 `.rail` 的绝对定位子节点，位置靠量测当前选中按钮的
 * offsetLeft / offsetTop / offsetWidth / offsetHeight 得到，写成 transform 与宽高。
 * 切页时它从上一项滑到下一项 —— 选中面是一块连续的材质，而不是两块各自闪一下的色块。
 *
 * 为什么量测而不是按序号算：导航在窄档（≤ 640px）会变成**底部横排**，
 * 项高、内边距、圆角全变（见 app.css 的媒体查询）。按序号算就要在 JS 里
 * 复刻一遍断点逻辑，两处一旦不同步，玻璃片就会错位；量测则天然跟随 CSS。
 *
 * DOM 形状与 class 名保持原样 —— 内容区仍是旧视图的静态骨架，
 * `switchView` 还要按 `data-view` 找到对应视图，e2e 也直接点它。
 */

import { useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import type { IconName } from '../lib/icons';
import {
  selectLogErrorCount,
  selectTopicCount,
  switchView,
  useAppStore,
} from '../store/appStore';
import type { ViewName } from '../store/types';

interface RailItem {
  view: ViewName;
  label: string;
  icon: IconName;
}

const ITEMS: RailItem[] = [
  { view: 'publish', label: '发布', icon: 'send' },
  { view: 'browser', label: '订阅', icon: 'radio-tower' },
  { view: 'status', label: '状态', icon: 'activity' },
  { view: 'log', label: '日志', icon: 'scroll-text' },
];

interface LensBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

const cap = (n: number, limit: number): string => (n > limit ? `${limit}+` : String(n));

const sameBox = (a: LensBox | null, b: LensBox): boolean =>
  !!a && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

export function Rail() {
  const view = useAppStore((s) => s.view);
  const topicCount = useAppStore(selectTopicCount);
  const logErrors = useAppStore(selectLogErrorCount);

  const itemRefs = useRef(new Map<ViewName, HTMLButtonElement>());
  const [lens, setLens] = useState<LensBox | null>(null);
  // 首帧到位之前禁用过渡，否则玻璃片会从 (0,0) 滑进第一项
  const [placed, setPlaced] = useState(false);

  useLayoutEffect(() => {
    const measure = () => {
      const btn = itemRefs.current.get(view);
      if (!btn) return;
      const next: LensBox = {
        x: btn.offsetLeft,
        y: btn.offsetTop,
        w: btn.offsetWidth,
        h: btn.offsetHeight,
      };
      setLens((prev) => (sameBox(prev, next) ? prev : next));
    };

    measure();

    /*
     * 断点切换（竖排 ↔ 底部横排）只改 CSS，不会触发 React 重渲染 ——
     * 不监听尺寸的话，玻璃片会停在旧位置上，直到下一次切页才对。
     * 观察 .rail 本身：它的宽高变化覆盖了「窗口变窄」与「项变高」两种情况。
     */
    const host = itemRefs.current.get(view)?.parentElement;
    if (!host) return;
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, [view]);

  useLayoutEffect(() => {
    if (!lens || placed) return;
    const id = requestAnimationFrame(() => setPlaced(true));
    return () => cancelAnimationFrame(id);
  }, [lens, placed]);

  return (
    <>
      {/* 选中玻璃片：纯装饰，位置由上面的量测驱动 */}
      <span
        className="rail__lens"
        aria-hidden="true"
        data-ready={lens ? 'true' : 'false'}
        data-placed={placed ? 'true' : 'false'}
        style={
          lens
            ? {
                transform: `translate(${lens.x}px, ${lens.y}px)`,
                width: `${lens.w}px`,
                height: `${lens.h}px`,
              }
            : undefined
        }
      />

      {ITEMS.map((item) => (
        <button
          key={item.view}
          type="button"
          className={item.view === view ? 'rail__item is-active' : 'rail__item'}
          data-view={item.view}
          ref={(el) => {
            if (el) itemRefs.current.set(item.view, el);
            else itemRefs.current.delete(item.view);
          }}
          onClick={() => switchView(item.view)}
        >
          <span className="rail__icon">
            <Icon name={item.icon} size={18} />
          </span>
          <span className="rail__label">{item.label}</span>

          {/*
            两个角标的语义不同：订阅页是「扫到多少主题」（进度），
            日志页是「多少条错误」（告警）—— 所以只有日志那个用告警色。
            计数为 0 时保留元素但置 hidden，切页时不会因为节点增删而跳动。
          */}
          {item.view === 'browser' && (
            <span className="rail__badge" id="railTopicCount" hidden={topicCount === 0}>
              {cap(topicCount, 999)}
            </span>
          )}
          {item.view === 'log' && (
            <span
              className="rail__badge rail__badge--alert"
              id="railLogCount"
              hidden={logErrors === 0}
            >
              {cap(logErrors, 99)}
            </span>
          )}
        </button>
      ))}
    </>
  );
}
