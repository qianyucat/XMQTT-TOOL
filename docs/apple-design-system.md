# XMQTT Tool · Apple 设计语言规格（macOS + iOS）

> 配套原型：[`apple-preview.html`](./apple-preview.html) —— 可切 macOS / iOS、浅色 / 深色、
> 窗口焦点态。类名与结构基本对应 `src/renderer`，样式可直接搬进 `app.css`。
>
> 一句话：**外形换苹果，信息架构不动**。技术栈仍是同一份 React 渲染层、
> 同一个 store、同一套 IPC 契约；换的是窗口骨骼、材质、排版刻度与语义色。

---

## 1. 三条 HIG 原则落到这个工具上

| HIG | 通用解释 | 对本工具的含义 |
| --- | --- | --- |
| **Clarity（清晰）** | 文字在任何尺寸下可读，图标精确，负空间有含义 | 13px 是 mac 的正文基准，不是"能不能再小一档"。密度的下限由 SF 的 x-height 决定，不是由"想多塞一行"决定 |
| **Deference（退让）** | UI 让位于内容 | 边框改成 0.5px 分离线（hairline），取消所有浅色卡片描边；选中态用实色 accent 而不是满屏彩色标签 |
| **Depth（层次）** | 用层级与材质传达前后关系 | 侧边栏（半透明 + vibrancy）→ 内容（实色）→ 检查器（浅灰）→ 弹层（阴影）。四层，靠明度与模糊分开 |

现状的问题不是"不够圆"，而是**层次只有一层**：顶栏 / 导航 / 分栏 / 详情全在同一个
灰阶平面上，靠 1px 边框硬切。Apple 的做法是让"壳"和"内容"处在不同材质上。

---

## 2. 语义色

只允许用系统语义色，不自造品牌色。深浅两套的取值就是 Apple 官方值：

| 语义 | 浅色 | 深色 | 本工具用途 |
| --- | --- | --- | --- |
| Accent（systemBlue） | `#007AFF` | `#0A84FF` | 主按钮、选中态、链接、订阅中的主题 |
| Green（systemGreen） | `#34C759` | `#30D158` | 已连接、正常 |
| Orange（systemOrange） | `#FF9500` | `#FF9F0A` | 重连中、QoS 降级、告警级 |
| Red（systemRed） | `#FF3B30` | `#FF453A` | 断开、错误、日志角标 |
| Purple（systemPurple） | `#AF52DE` | `#BF5AF2` | 载荷里的 JSON key（原型的 `hljs` 高亮） |

灰阶不是"同一个灰调透明度"，而是按用途分：

```
mac  内容 #FFFFFF / #232326    侧边栏 rgba(246,246,246,.74) / rgba(42,42,45,.66)
     分离线 rgba(0,0,0,.11)    控件填充 rgba(0,0,0,.055)
iOS  背景 #F2F2F7 / #000000    卡片 #FFFFFF / #1C1C1E
     分隔线 rgba(60,60,67,.16)  填充 rgba(118,118,128,.12)
```

**深色不要用纯黑**（iOS 用 `#000` 是 OLED 特例，mac 用 `#1E1E20`）。
现在项目里的 `--bg: #0b1017` 偏蓝且过深，会让 0.5px 分离线彻底看不见。

---

## 3. 排版

字体栈直接吃系统：`-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC'`。
macOS 上拿到真 SF，不需要打包字体。

| 用途 | macOS | iOS | 字重 |
| --- | --- | --- | --- |
| 窗口/页面标题 | 13 | 33（大标题）/ 17（收起后） | 600 / 700 |
| 正文、列表行 | 13 | 17 | 400 |
| 次级说明 | 11 | 15 | 400 |
| 分组标题 | 11 | 13 | 600 |
| 等宽（主题 / 载荷） | 11（SF Mono） | 15 | 400 |

两条硬规则：

1. **字号不随容器缩水。** 现在 `--text-2xs: 10px` 已经到可读性下限，再往下就是"看起来专业、
   实际看不清"。窄档位靠减列，不靠缩字。
2. **字距**：13px 用 `-0.01em`，11px 用 `0`，大标题用 `-0.02em`。SF 在 13px 以上不收紧会显松。

---

## 4. 空间、圆角、控件高度

| | macOS | iOS |
| --- | --- | --- |
| 栅格 | 4pt | 4pt |
| 控件高度 | 22（小）/ 24（标准）/ 28（大） | 44（列表行）/ 36（搜索框） |
| 圆角 | 6（控件）/ 7（分段）/ 11（窗口） | 10（卡片）/ 9（分段）/ 37（屏） |
| 行高 | 28（表格）/ 24（树） | 44 |
| 分隔线 | 0.5px | 0.5px |

窗口圆角必须用**连续圆角**（squircle），不是 `border-radius` 的圆弧。
在 Electron 里窗口圆角由系统绘制；只有自绘外壳（原型里的 `data-inactive` 态）才需要
`squircle`，用 `clip-path` 或 SVG mask 近似即可，不值得为 1px 上第三方库。

---

## 5. 两端外壳

### macOS：全高侧边栏 + 统一工具栏 + 检查器

这是 macOS 11 之后的标准骨骼（Finder / Mail / Notes / Xcode 都是）：

```
┌──────────────────┬──────────────────────────────────────────┐
│ ● ● ●            │  订阅  128 主题  [全部|已订阅|告警]  连接 │  ← 统一工具栏
│                  ├───────────┬────────────────┬─────────────┤
│  工作区          │  主题     │  消息          │  详情       │
│  ▸ 发布          │  factory  │  时间 主题 内容│  报文       │
│  ▸ 订阅     128  │   line1   │  09:41 ...     │  载荷       │
│  ▸ 状态          │    ...    │  ...           │  操作       │
│  ▸ 日志       3  │           │                │             │
│                  │           │                │             │
│  ● 演示 A        │           │                │             │
└──────────────────┴───────────┴────────────────┴─────────────┘
   ↑ 218px 半透明，红绿灯压在里面     ↑ 三栏，靠 0.5px 分离线分开
```

三个具体决定：

1. **侧边栏贯穿到窗口顶部，红绿灯在它里面。** 这是"苹果味"最重的一笔。
   现在的实现是 40px 顶栏横贯整窗、左侧让出 86px 给红绿灯 —— 看起来永远像个网页套壳。
2. **详情从"底部 40% 面板"改成"右侧检查器"。** 报文详情是**属性**，不是**内容流**，
   检查器（Xcode 的 Inspector、Finder 的"显示简介"）才是它的正确形态。
   顺带解决一个老问题：底部面板会压掉近一半表格高度。
3. **侧边栏 218px，不是 80px。** 现在已有 `rail__label` 文字，直接把竖排图标条拉宽成
   图文列表即可，**React 一行不用改**。

### iOS：大标题 + inset grouped + 底部 Tab

```
┌───────────────────────┐
│  9:41        ⌁ ⌁ ▮    │
│                       │
│  订阅              ⊕  │  ← 大标题 33pt
│  ┌─────────────────┐  │
│  │ 🔍 搜索主题     │  │  ← 填充色 #767680 12%
│  └─────────────────┘  │
│  [已订阅 | 全部 | 告警]│  ← 分段控件
│                       │
│  主题                  │  ← 分组标题 13pt
│  ┌─────────────────┐  │
│  │ ◉ factory/line1/#│ ›│  ← 44pt 行
│  │ ◉ factory/mes/+ │ ›│
│  └─────────────────┘  │
│  ┌─────────────────┐  │
│  │ 自动滚动    [ ●]│  │  ← 原生 Switch
│  └─────────────────┘  │
│  ⌁      ◉      ⌁     │
│ 发布   订阅   状态 日志│  ← 49pt + 安全区
└───────────────────────┘
```

iOS 侧**不要**照搬桌面的三栏：手机上"树 + 表 + 详情"永远是**推入式导航**
（列表 → 报文列表 → 详情），或者详情用 **sheet + grabber**。
用分栏是两个都看不清。

---

## 6. 哪些能照搬，哪些不能

| 规则 | 桌面 | 手机 |
| --- | --- | --- |
| 44pt 触控目标 | **不要**。28px 行高是桌面密度的一部分 | 必须 |
| 大圆角（12–16） | **不要**。窗口 11、控件 6，再大就幼稚 | 卡片 10 可以 |
| 大标题 33pt | **不要**。桌面标题 13pt 就够，浪费垂直空间 | 必须 |
| 半透明材质 | 侧边栏 + 工具栏用 vibrancy | Tab bar + 导航栏用 blur |
| 悬停态 | 必须有（`--hover-wash`） | **不要**，触摸没有 hover |
| 底部 Tab | **不要**。桌面导航在左侧 | 必须 |
| 右侧检查器 | 必须 | 不要（改 sheet） |

一句话：**圆角和字号跟着"输入方式"走，不跟着"屏幕大小"走**。
这条和上一轮《响应式适配设计》里的"密度只看指针能力"是同一条原则的两种说法。

---

## 7. 组件对照：现有 class → Apple 组件

| 现在 | 改成 | 改动量 |
| --- | --- | --- |
| `.rail`（80px 竖条） | macOS **Sidebar**（218px，半透明，分组 + 图文行） | 只改 CSS 宽度与行内布局，组件不动 |
| `.titlebar`（40px 横贯） | macOS **Unified Toolbar**（52px，只在内容列，含分段控件） | index.html 栅格 + CSS |
| `.pane__head` + `.pane` | 同上，加 0.5px 分离线，去掉背景差 | CSS |
| `.msg-detail`（底部 40%） | **Inspector**（右侧 296px，分组 field 列表） | JSX 移一层 + CSS |
| `.table` | macOS **Table View**：28px 行、表头浅灰、选中实色 accent | CSS，列宽已令牌化 |
| `.btn--primary` | **Push Button（Default）**：accent 填充、6px 圆角、无渐变 | CSS |
| `.select` | **Pop-up Button**：24px 高、右侧 chevron、无 1px 边框（用 0.5px） | CSS |
| `.toggle` | iOS **Switch**（51×31）/ mac **Checkbox** | 两套，见下 |
| 四个视图的卡片 | iOS **Inset Grouped**；mac 保持表格/检查器 | 新增 `.ios-card` |

> 开关控件两端形态不同：macOS 用 checkbox / 小开关，iOS 用 51×31 滑块。
> 不要为了"统一"把 iOS 的滑块搬到 mac —— 那是 iOS 应用跑在 Mac 上的样子（Catalyst），
> 不是 macOS 应用。

---

## 8. 结构改动清单（唯一会动 DOM 的地方）

```html
<!-- 现在 -->
<div class="app" style="grid-template-rows:40px 1fr">
  <header class="titlebar" id="titlebar-root"></header>
  <div class="body">
    <nav class="rail" id="rail-root"></nav>
    <main class="content" id="content-root"></main>
  </div>
</div>

<!-- 改后 -->
<div class="app">
  <aside class="sidebar">
    <div class="sidebar__traffic"></div>   <!-- mac 红绿灯让位 56px；其他平台 0 -->
    <nav class="rail" id="rail-root"></nav>
    <div class="sidebar__foot"></div>      <!-- 连接状态，从顶栏搬下来 -->
  </aside>
  <div class="main">
    <header class="titlebar" id="titlebar-root"></header>
    <main class="content" id="content-root"></main>
  </div>
</div>
```

```css
.app  { display: grid; grid-template-columns: var(--sidebar-w) minmax(0,1fr); height: 100vh; }
.main { display: grid; grid-template-rows: var(--toolbar-h) minmax(0,1fr); min-width: 0; }
:root { --sidebar-w: 218px; --toolbar-h: 52px; }
@media (max-width: 900px) { :root { --sidebar-w: 76px; } }  /* 窄窗口退回图标栏 */
```

**三个 portal 挂载点一个都不用改**（`titlebar-root` / `rail-root` / `content-root`），
React 组件树也不动 —— 只换它们所处的栅格位置。
e2e 的 `[data-view]` / `[data-testid]` 全部照旧。

`WorkbenchView` 里唯一的 JSX 改动：把 `<div className="msg-detail">` 从
`.pane__body--messages` 内移到 `.split--browser` 的第三列（id 与 data-testid 保留）。
这一处是为了让详情成为检查器，属于**必须动**的结构变化。

---

## 9. Electron 侧的具体参数

```ts
const win = new BrowserWindow({
  titleBarStyle: 'hiddenInset',
  trafficLightPosition: { x: 18, y: 18 },   // 对齐 218px 侧边栏内的 12px 圆点
  vibrancy: 'sidebar',                       // 仅 macOS：侧边栏毛玻璃
  visualEffectState: 'followWindow',         // 失焦时材质自动变灰
  backgroundColor: '#00000000',              // vibrancy 要求透明底
  // 其他平台
  // backgroundColor: theme === 'dark' ? '#1E1E20' : '#ECECEC'
});
```

要点：

- `vibrancy` 只在 macOS 生效，Windows / Linux 必须回退到实色 `--mac-sidebar`（不透明版），
  否则窗口会变透明重影。
- 开了 vibrancy 后 `backgroundColor` 必须是透明，**同时** `.app` 要有自己的不透明背景，
  否则内容区也会透出桌面。
- `trafficLightPosition` 的 y 从 13 调到 18：侧边栏顶部要给三个圆点留出 56px 的呼吸区，
  现在的 13 会让圆点贴着窗口上沿。
- Windows 的 `titleBarOverlay` 高度从 40 改到 52，与工具栏一致。

---

## 10. 落地顺序

| 阶段 | 内容 | 备注 |
| --- | --- | --- |
| **A** 令牌（半天） | 换语义色与灰阶；0.5px 分离线；字号/字距；圆角 | 纯 CSS，视觉立刻变 |
| **B** 骨骼（半天） | index.html 栅格 + 侧边栏全高 + 工具栏 52px；`trafficLightPosition` 18 | 动结构，但 portal 不变 |
| **C** 检查器（1 天） | `msg-detail` 移到第三列，改成分组 field 列表 | 唯一动 JSX 的地方 |
| **D** 手机壳（1 天） | iOS 大标题 / inset grouped / Tab / sheet | 依赖上一轮的四档断点 |
| **E** 验收（半天） | 见下 | — |

**验收**：mac 的看家本领是"失焦态"，必须专门测 —— 点一下别的窗口，本窗口的选中态、
红绿灯、材质都要正确变灰（原型里右上角有 `窗口失焦态` 按钮可以对照）。
另外深色下检查 0.5px 分离线是否还看得见（这是最容易翻车的一处）。

---

## 11. 三条不建议照搬的地方

1. **不要把 macOS 的"侧边栏 218px"用在 900px 以下的窗口。** 树 + 表 + 检查器已经要 800px，
   再加 218px 侧边栏就只剩 400px 给表格。窄窗口退回 76px 图标栏（正好接上一轮 compact 档）。
2. **不要给桌面加 44pt 行高。** 那是触摸的下限，不是桌面的目标。桌面 28px 行高 +
   悬停高亮已经足够定位，鼠标比手指精确一个数量级。
3. **不要用 iOS 的大圆角做桌面窗口。** 11px 窗口圆角 / 6px 控件圆角是 macOS 的克制，
   再圆就像把 iPad 应用塞进 Mac（Catalyst 的典型观感）。
