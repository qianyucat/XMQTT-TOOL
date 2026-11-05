/**
 * 品牌标（界面内）
 * ------------------------------------------------------------------
 * 桌面图标 `build/icon.png` 的 24px 降级版。
 *
 * 为什么不直接放一张 PNG：标题栏这个位置只有 24px，图标原稿是六层同心菱形，
 * 等比缩下来每层不到 2px，等于一条渐变 —— 一个「发光的点」，看不出是菱形。
 * 我把四个候选按真实 24px 渲染再放大 8 倍看过，结论是**层数不重要，层差重要**：
 * 六层塌掉是因为相邻层明度只差 12，缩到 24px 后抗锯齿把它们混成一色。
 *
 * 所以这里只留三层，明度差拉到 40+：
 *   外圈 #35619f（L 42）→ 中层 #4c94ff（L 65）→ 核心 #eef4ff（L 96）
 *
 * 外圈试过更深一档的 #2f5695（更贴近图标原稿的 l1），但在实底深色标题栏
 * 上它与底的对比只有 2.4:1，24px 时那圈糊进背景，只看得见中间的蓝和一点白
 * —— 三层退化成两层，分层就白做了。#35619f 把这个比值抬到 2.7:1，
 * 深色下外圈重新成立；浅底（#f4f6fa）上仍有 5.9:1。
 *
 * 另外刻意**不带底板**：图标原稿的底色是 #182642→#0e1626，和深色标题栏
 * 几乎同色，24px 时那点砖块面积上什么也看不出来 —— 试过，几乎是空的。
 * 标题栏本身就是底，标只出图形，这也和「图形标」这个定位一致。
 *
 * 颜色写死不用主题变量：品牌色不该跟着深浅主题漂移。深浅两版都在真窗口里
 * 截图核过（XMQTT_GLASS=css 拿实底，vibrancy 模式下 capturePage 拍不到
 * 系统材质，顶栏会被补成灰的，不能拿来判断颜色）。
 */

/** 菱形（顶点朝上下左右），坐标以画布中心为原点 */
const dia = (r: number) => `M0 ${-r}L${r} 0L0 ${r}L${-r} 0Z`;

/* 半径取自图标原稿的比值，按 3 层重排：330 / 214 / 106 */
const OUTER = dia(330);
const MID = dia(214);
const CORE = dia(106);

export interface BrandMarkProps {
  /** 渲染边长（px），默认 24；标题栏窄屏会经 CSS 降到 22 */
  size?: number;
  className?: string;
}

export function BrandMark({ size = 24, className }: BrandMarkProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="-350 -350 700 700"
      // 纯装饰：旁边的 brand-name 已经给出了名字，读屏不必再念一遍
      aria-hidden="true"
      focusable="false"
    >
      <path d={OUTER} fill="#35619f" />
      <path d={MID} fill="#4c94ff" />
      <path d={CORE} fill="#eef4ff" />
    </svg>
  );
}
