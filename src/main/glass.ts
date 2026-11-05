/**
 * 玻璃材质能力分层
 * ------------------------------------------------------------------
 * 「液态玻璃」在三个平台上有三种完全不同的落地方式，这里负责在**创建窗口之前**
 * 决定用哪一种，并把窗口参数一起算出来。渲染层只管把 `data-glass` 属性读出来套样式，
 * 不做任何能力判断 —— 判断只在主进程做一次，避免两边各猜一遍。
 *
 *   liquid    macOS 26+ 且装了可选原生模块 → NSGlassEffectView（真正的液态玻璃）
 *   vibrancy  macOS 但没模块 / 系统更旧    → NSVisualEffectView（Electron 内置原生物料）
 *   css       其它平台                     → 页面内 backdrop-filter（通用玻璃）
 *
 * 为什么不是「一律用原生模块」：
 *   1. `electron-liquid-glass` 只发 darwin 的预编译产物（os 字段锁 darwin），
 *      在 Windows / Linux 上 `npm install` 会直接 EBADPLATFORM 失败。所以它只能进
 *      optionalDependencies，且必须 `require` 包在 try 里 —— Windows 离线机用
 *      `tools/assemble-deps.mjs` 装配，那里根本没有这个包，不能因此起不来。
 *   2. Windows / Linux 分支会 `app.disableHardwareAcceleration()`（见 main.ts 顶部），
 *      软件光栅下窗口透明 + 原生材质合成既慢又不可靠，直接走 CSS 更稳。
 *
 * 覆盖开关：
 *   XMQTT_GLASS=auto|liquid|vibrancy|css          默认 auto
 * 排查「窗口一片黑」时先设 `css`，能立刻区分是材质问题还是渲染问题。
 *
 * ⚠️ 材质层能调的东西几乎没有：`tintColor` 与库里的 `unstable_setVariant`
 * 在 macOS 26.6.2 上实测都是空操作（见 applyLiquidGlass 里的取样数据）。
 * 想把玻璃做得更透 / 更强，改 `styles/tokens.css` 的 --glass-*，别在这里加参数。
 */

import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import type { GlassMode, ThemeMode } from '../shared/models';

export type { GlassMode };

/**
 * 原生模块的最小形状。
 *
 * 只声明真正要用的三个方法：完整类型在 `electron-liquid-glass` 自己的 .d.ts 里，
 * 但那是可选依赖，不能 `import type`（没装包时 tsc 直接报错）。
 * 手写这一份还有个好处 —— 模块哪天改了 API，是这里的调用点先崩，而不是静默降级。
 */
interface LiquidGlassAddon {
  isGlassSupported(): boolean;
  /** 返回 -1 表示当前系统不支持（模块内部会自行退回旧版 macOS 模糊） */
  addView(handle: Buffer, options?: GlassOptions): number;
}

interface GlassOptions {
  cornerRadius?: number;
  tintColor?: string;
  opaque?: boolean;
}

const IS_MAC = process.platform === 'darwin';

/**
 * 载入可选原生模块。任何失败（没装、架构不匹配、dlopen 失败）都返回 null，
 * 由调用方退回 vibrancy —— 这一层不能抛，抛了就是窗口起不来。
 */
function loadAddon(): LiquidGlassAddon | null {
  if (!IS_MAC) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('electron-liquid-glass') as
      | { default?: LiquidGlassAddon }
      | LiquidGlassAddon;
    const addon = (mod as { default?: LiquidGlassAddon }).default ?? (mod as LiquidGlassAddon);
    return typeof addon?.addView === 'function' ? addon : null;
  } catch {
    return null;
  }
}

let resolved: { mode: GlassMode; addon: LiquidGlassAddon | null } | null = null;

/** 本进程的玻璃模式（只算一次：模块加载与系统能力在运行期不会变） */
export function resolveGlass(): { mode: GlassMode; addon: LiquidGlassAddon | null } {
  if (resolved) return resolved;

  const forced = (process.env.XMQTT_GLASS || '').trim().toLowerCase();

  if (!IS_MAC || forced === 'css') {
    resolved = { mode: 'css', addon: null };
    return resolved;
  }

  if (forced === 'vibrancy') {
    resolved = { mode: 'vibrancy', addon: null };
    return resolved;
  }

  const addon = loadAddon();
  let supported = false;
  if (addon) {
    try {
      supported = addon.isGlassSupported() === true;
    } catch {
      supported = false;
    }
  }

  // 没装模块、或系统低于 macOS 26 → 退回 Electron 内置的 NSVisualEffectView。
  // 这仍然是「系统原生材质」（由窗口服务端合成、跟随系统外观），只是不是液态玻璃。
  resolved = addon && supported ? { mode: 'liquid', addon } : { mode: 'vibrancy', addon: null };
  return resolved;
}

/** 供 ipc 层下发给渲染层 / 关于对话框展示 */
export function glassMode(): GlassMode {
  return resolveGlass().mode;
}

/**
 * 玻璃模式下必须让窗口本体透明，材质才会从页面底下透出来。
 *
 * `vibrancy` 与 `transparent` 的区别值得记一笔：
 *   · vibrancy   窗口仍是正常窗口（保留系统圆角与投影），只是背景换成 NSVisualEffectView；
 *   · transparent 关掉不透明位，必须自己保证内容盖住全窗口。
 * 液态玻璃走后者 —— NSGlassEffectView 是挂在 contentView 里的子视图，页面不透明就永远看不见。
 * `hasShadow` 显式打开：透明窗口在 macOS 上默认丢投影，拖动时会「贴」在桌面上。
 */
export function glassWindowOptions(
  mode: GlassMode,
  theme: ThemeMode,
  opaqueBackground: string,
): Pick<
  BrowserWindowConstructorOptions,
  'transparent' | 'backgroundColor' | 'vibrancy' | 'visualEffectState' | 'hasShadow'
> {
  if (mode === 'liquid') {
    return {
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: true,
      // README 明确要求：液态玻璃旁边**不能**再设 vibrancy，否则材质互相覆盖，糊成一片
      vibrancy: undefined,
    };
  }
  if (mode === 'vibrancy') {
    return {
      // 不设 transparent：正常窗口 + 视觉特效视图，圆角与投影都交给系统
      backgroundColor: '#00000000',
      // sidebar 是深浅主题下最中性的物料：比 under-window 克制，比 titlebar 明显
      vibrancy: 'sidebar',
      visualEffectState: 'active',
      hasShadow: true,
    };
  }
  return { backgroundColor: opaqueBackground ?? (theme === 'light' ? '#eef1f7' : '#0f141b') };
}

/**
 * 把 NSGlassEffectView 挂到窗口上。返回 true 表示真的挂上了。
 *
 * 失败时的处理很关键：此时窗口已经是透明的（见上），如果材质没挂上又没有兜底，
 * 用户会看到一块黑色/透明的洞。所以失败要由调用方把渲染层切回 css 模式
 * （页面自己画渐变 + backdrop-filter），而不是干等着。
 */
export function applyLiquidGlass(win: BrowserWindow, theme: ThemeMode): boolean {
  const { mode, addon } = resolveGlass();
  if (mode !== 'liquid' || !addon) return false;
  if (win.isDestroyed()) return false;

  try {
    /*
     * tintColor 是库文档里的「玻璃染色」。**实测在 macOS 26.6.2 上是个空操作**：
     * 把 alpha 从 0x2e 拉到 0x80 四次截图逐点取样完全一致（titlebar 94,146,247 /
     * rail 166,141,82 三组数据一模一样），说明 `setTintColor:` 在这版系统上
     * 不存在、而 layer.backgroundColor 兜底又被材质自身的合成盖掉了。
     * 库里的 `unstable_setVariant` / `unstable_setScrim` 同样试过 clear/regular/off
     * 三档，像素零差异 —— 所以这里**不再指望材质层调参**。
     *
     * 保留这次调用只是为了换一台机器 / 换一版系统时可能生效，参数取中性黑
     * （浅色主题取白）：万一生效，它压的是材质，不会动页面的 wash。
     * 观感上的「透 / 不透」全部由渲染层的 --glass-* 决定，别在这里找。
     */
    const tint = theme === 'light' ? '#ffffff3d' : '#08080a66';
    const id = addon.addView(win.getNativeWindowHandle(), { cornerRadius: 0, tintColor: tint });
    return id >= 0;
  } catch (err) {
    console.warn('[glass] 液态玻璃挂载失败，退回页面内实现:', (err as Error).message);
    return false;
  }
}
