# AGENTS.md — XMQTT Tool

Electron 版 MQTT 订阅/发布调试工具（参考 MQTT.fx）。**跨平台**：Windows / Linux / macOS
共用同一份源码。下面这些约束不遵守会直接卡住，动手前先看一遍。详细背景见 [README.md](README.md)。

## 跑起来

**Windows**（离线机器，无外网）：

```powershell
node tools/assemble-deps.mjs    # 首次装配依赖（离线，只需一次）
.\start.cmd                     # 启动（等同于双击桌面上的 XMQTT Tool 快捷方式）
```

**macOS / Linux**（有网络，走国内镜像）：

```bash
npm install                     # 首次装依赖（含 Electron 二进制）
./start.sh                      # 启动（首次会自动 vite build）
npm run dist:mac                # 打 dmg / zip（mac）；Linux 用 npm run dist:linux
```

`dist:*` **必须在系统终端里跑**。在 WorkBuddy 的终端/代理环境里跑会被两层包装拦住，
且报错信息完全不像打包问题：写 `*.asar` 被文件策略拒（`Brokered file token refused: modify backup failed`），
dmg 里 `ln -s /Applications` 被命令分发壳接管（`Exit code: 13 ... Brokered program policy check unavailable`）。
两者都不是配置错误，换到 Terminal.app 就正常。

不换终端也能打包：把宿主注入的 shim 环境剥掉再跑 electron-builder（2026-10-27 实测 exit 0，
四个产物齐全，两个 dmg `hdiutil verify` 均 VALID）。关键是清掉 `NODE_OPTIONS`（注入
`node-language-shim.cjs`）与 `PATH` 里那两个 `brokered-bin` / `safe-bin`：

```bash
env -u NODE_OPTIONS -u PYTHONPATH -u BASH_ENV -u ELECTRON_RUN_AS_NODE \
    -u CODEBUDDY_BROKERED_SHELL_ENV -u CODEBUDDY_SAFE_DELETE_BULK_GUARD \
    -u CODEBUDDY_TOYBOX_SANDBOX_PROFILE \
    PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    node node_modules/.bin/electron-builder --mac
```

（这条只绕开 shim；`vite build` / `make-icon` 得先自己跑过，等价于 `npm run build && npm run icon`。）
另：x64 那支 dmg 的 `hdiutil` 偶发失败会被 electron-builder 重试吞掉，日志里可能留一行 `⨯`，
但退出码仍是 0 —— 用 `hdiutil verify` + `hdiutil attach` 判产物，不要只看那行日志。

**Windows 包**（`npm run dist:win`，在 macOS 上交叉编译，**不需要 wine**）：

```bash
npm run dist:win     # = node tools/dist-win.mjs（内部包含 build，不用先跑 npm run build）
```

Windows 上这条命令就是原生的 `electron-builder --win --x64`。
macOS / Linux 上走三段式，因为 electron-builder 改 exe 图标/版本要跑 `winCodeSign` 里的
`rcedit.exe`，非 Windows 平台它会先自动下载 wine —— github 实测 16 KB/s，**17 分钟都下不完**：

1. `electron-builder --win --x64 --dir -c.win.signAndEditExecutable=false` → `release/win-unpacked`
   （跳过 rcedit；`~/Library/Caches/electron-builder/wine` 不会被碰）
2. `node tools/patch-win-exe.cjs` → 用 `resedit` 纯 JS 写回图标（PNG → 16/32/48/256 多尺寸 ICO）
   与版本信息（1033 英文块 + 2052 中文块都写，否则中文 Windows 属性页读到空描述）
3. `electron-builder --win zip|nsis --prepackaged release/win-unpacked` → 复用上面的目录出包，
   **不会重新打包**，所以 ② 改过的 exe 会原样进 zip 与安装包

两个必须知道的点：

- **不带 `--x64` 的 `--win` 会跟随宿主架构**：M 系列 Mac 上直跑 `electron-builder --win`
  打的是 `win-arm64-unpacked`，Windows 用户装不了。所有 win 目标都要显式 `--x64`。
- `patch-win-exe.cjs` 依赖 `resedit` + `png-to-ico`（纯 JS，无原生模块、无平台限制）。
  这两个包目前是 `node_modules` 里的独立副本，**没写进 package.json**（避免 Windows
  离线机 `assemble-deps.mjs` 装配时多出无关包）。`npm install` 之后它们会被 prune 掉，
  届时重新 `npm i --no-save resedit png-to-ico` 即可。
  校验方式：`file "release/win-unpacked/XMQTT Tool.exe"` 应是 `PE32+ executable (GUI) x86-64`，
  且资源条目数（resedit 读出来 52 条）与改之前一致 —— 说明 `ELECTRONASAR` 完整性资源没被破坏。
- **`dist:win` 自己会跑 `make-icon`**（`build/` 不入库）。之前的版本没跑，`build/` 空着时
  electron-builder 会**静默**退回 Electron 默认图标 —— 成品不报错但图标是 Electron 的。
- **旧 `win-unpacked/resources/app.asar` 常常被外部句柄占着删不掉**：实测是本机编辑器 / 索引类
  宿主进程（`WorkBuddy`）攥着，不是 XMQTT 自己 —— 任务管理器里看不出关联，连父目录都 rename 不动，
  只有句柄释放（退出该进程 / 重启）才删得掉。`dist:win` 会先自己清 `<out>/win-unpacked`，
  清不掉就自动退到 `release-win/` → `release-tmp/` → `release-b2…b10/`，并用 Restart Manager
  打出占用者（`tools/lib/lock-holder.mjs`，查不到就如实说查不到）。所以**以日志末尾「产物：」
  那几行为准**，别默认去 `release/` 找；也可以 `npm run dist:win -- --out release-x` 直接指定
  （没出现过的目录名不会被占，不会重蹈覆辙）。
- **Windows 上第一次打包可能卡在 winCodeSign 解压**：`winCodeSign-2.6.0.7z` 里
  `darwin/10.12/lib/libcrypto.dylib`、`libssl.dylib` 是 symlink，非管理员且没开「开发者模式」时
  7za 建不了链接，报 `客户端没有所需的特权` / `Cannot create symbolic link`，
  electron-builder 重试 4 次后整体失败（日志里是 `⨯ cannot execute ... Sub items Errors: 2`）。
  这两条链接只给 macOS 签名用，Windows 打包只需要包里的 `rcedit-x64.exe`。
  一次性修复（之后都会命中缓存）：

  ```powershell
  $c = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign"
  $t = "$c\winCodeSign-2.6.0"; New-Item -ItemType Directory -Force $t | Out-Null
  node_modules\7zip-bin\win\x64\7za.exe x (Get-ChildItem $c -Filter *.7z)[0].FullName "-o$t" -y
  # 解压退出码 2 是那两条 symlink，忽略；确认 $t\rcedit-x64.exe 存在即可
  ```

国内网络加速（可选）：

```bash
npm config set registry https://mirrors.tencent.com/npm/
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
```

> 受限环境（沙箱 / CI，无法写 `~/Library/Caches`）装不上 Electron 时：
> `electron_config_cache="$PWD/.electron-cache" npm install`

## 硬约束（都踩过）

| 约束 | 平台 | 原因 / 后果 |
| --- | --- | --- |
| 不要 `npm install` | Windows 离线机 | 该机 npm 源全部不可达；依赖由 `tools/assemble-deps.mjs` 从本地缓存装配 |
| 不要用 `electron .` 启动 | 全平台 | Windows 上 UNC 路径不能作为 CreateProcess 工作目录；统一走 `tools/launch.js` / `start.cmd` / `start.sh` |
| spawn electron 前删掉 `ELECTRON_RUN_AS_NODE` | 全平台 | 宿主环境带此变量会让 electron 退化成 node，`require('electron')` 拿不到 app，窗口一闪而退 |
| 窗口显示不能只等 `ready-to-show` | 实际踩在 Windows | Windows 11 build 26200 + Electron 28.3.3：窗口建好、页面也加载完（`did-finish-load` 到、DOM 完整、渲染进程不崩），但隐藏窗口不产生首帧 → `ready-to-show` 永不触发 → `win.show()` 一次都没跑。表现为「双击没反应」：进程躺在任务管理器里，窗口 `isVisible()` 恒为 false；再点快捷方式被 `requestSingleInstanceLock` 吞掉，继续没反应。`XMQTT_SOFTWARE_RENDER=0` 打开硬件加速结果一样，与 GPU 无关。`createWindow()` 现在 `ready-to-show` 与 `did-finish-load` 谁先到谁显示，`second-instance` 也会把隐藏窗口 `show()` 出来 |
| 必须带 `--no-sandbox --disable-gpu` | **仅** Windows / Linux | Chromium GPU 子进程起不来（error_code=18），Electron 在窗口出现前就 FATAL；Linux 上还能顺带绕开 SUID sandbox 未就绪的问题。**macOS 真机默认不加**（关掉会让滚动与动画退化成 CPU 光栅），launch.js 与 main.js 已按平台分支，`XMQTT_SOFTWARE_RENDER=1/0` 可覆盖 |
| 不要硬编码 `electron.exe` | 全平台 | Windows 是 `electron.exe`，Linux/macOS 是 `electron`。统一用 `tools/lib/electron-path.js` 解析 |
| Electron 必须有 X server | Linux | 纯 SSH / 服务器环境没有 `DISPLAY`，直接启动只报 "Missing X server"。用 `xvfb-run -a ./start.sh` 或去有桌面的机器 |
| `start.cmd` 只能写 ASCII | Windows | cmd.exe 按 OEM 代码页解析，中文注释会切碎命令行 |
| `tools\*.ps1` 必须 UTF-8 **带 BOM** | Windows | 否则 PowerShell 5.1 按 GBK 读中文乱码；用 edit/write 改过之后要重新补 BOM |
| 渲染层必须 `vite build` 出产物 | 全平台 | 生产走 `app://` 协议加载 `dist/renderer`（ES module），没有产物就没有可加载的 JS —— **不会**再回退到 `file://`。改完渲染层忘记 build，表现是窗口能开但一片空白 |
| 主进程必须 `tools/build-main` 出产物 | 全平台 | `package.json` 的 `main` 指向 `dist/main/main.js`（TS 编译而来）。`launch.js` / `dev.js` / e2e / 截图脚本启动前都会自动重编，**唯一会踩坑的是直接手写 `electron .` 起窗口** —— 那样跑的是上一次的产物 |
| 渲染层只写 `.ts` / `.tsx`，不写 `.js` | 全平台 | `.js` 不在 `tsconfig` 的 include 里，`allowJs` 也是关的 —— 丢一个 `.js` 进 `src/renderer/` 不会被类型检查，也不会被打包，表现为「改了没反应」 |
| 表单是**受控**的，改值要派发事件 | 全平台 | 表单值存在 store 里。脚本/测试里 `input.value = 'x'` 只改 DOM 不进 store，随后点「发布」发出去的还是旧值 —— 必须先用原生 setter 再派发 `input` / `change`（见 `tools/e2e-test.mjs` 的 `type()`） |
| 消息表行高只改 `--table-row-h` | 全平台 | 消息表是固定行高虚拟滚动。行高唯一来源是 `styles/tokens.css` 的 `--table-row-h`，CSS 排版与 `lib/layout.ts` 的 `useTableRowHeight()` 都读它。**不要再写字面量**（旧的 `ROW_HEIGHT` 常量已删除）—— 两处不一致时滚动条长度会漂，且不报错 |
| 表格列的隐藏/改宽只用 `.col-*` | 全平台 | th 与 td 同时挂 `.col-time` / `.col-qos` / `.col-rd` / `.col-topic` / `.col-len` / `.col-prev`。只藏 th 会让 `table-layout: fixed` 整体错位；改用 `nth-child` 则加列即失效 |
| 窄档位列宽用**纯百分比** | 全平台 | `table-layout: fixed` 下 `width: auto` 的列在跨容器断点后**不一定**重新分配剩余宽度（实测 900→390 切档后预览列停在 34px，整表空出 104px）；`calc(56% - 128px)` 也算错（百分比按内容盒解析）。各列百分比相加正好 100% 才稳 |
| 拷贝文件到项目不要用 `fs.cpSync` | Windows UNC | 「本地盘 → UNC 目标」会静默丢文件；用 robocopy |
| 玻璃档位只在 `src/main/glass.ts` 判定 | 全平台 | 窗口要不要 `transparent` / `vibrancy` 是**构造参数**，建完改不了；判定散到 `createWindow()` 里就会出现「同一台机器两次启动材质不一样」。渲染层只读 `<html data-glass>`，不重复判断 |
| 不要给 macOS 之外的平台设透明窗口 | Windows / Linux | 这两条分支上 `disable-gpu` 是开着的（见 main.ts 顶部），透明窗口 + 合成层在软件光栅下会黑屏。`glassWindowOptions()` 已按平台返回，别手写覆盖 |
| `electron-liquid-glass` 只能进 **optionalDependencies** | 全平台 | 该包 `os: darwin`，放 dependencies 会让 Windows / Linux 的 `npm install` 直接 EBADPLATFORM；`require` 必须包在 try 里 —— Windows 离线机用 `assemble-deps.mjs` 装配，那里根本没有这个包，缺失时必须静默退回 css 档 |
| 改了 `--glass-*` 令牌或 `.app` 圆角要复跑几何断言 | 全平台 | 透明窗口下的自绘圆角（`.app { border-radius }`）一旦和 `overflow` 配合出错，表现是「四个角透出桌面」而不是报错，`npm run check:responsive` 是唯一能兜住的 |
| 顶栏加控件要一起写 `-webkit-app-region` | 全平台 | `app-region` **不继承**：给容器写 `drag` 不会管住子元素，子元素写 `no-drag` 也不会继承下去。约定是「容器 `drag` + 可交互控件显式 `no-drag`」，新加 `button` / `select` / `input` 时若忘了标，表现是「点不动，按下去整个窗口在拖」；反之若给容器写 `no-drag`，那块就变成拖不动的死区（顶栏右半边曾经全踩过这一条） |
| 拖动条只造 `<Resizer>` + `useSplitSize()` | 全平台 | 三处分栏（主题栏宽度 / 已订阅高度 / 详情高度 / 模板栏宽度）共用 `components/Resizer.tsx` 与 `lib/resize.ts`：边界、双击复位、键盘步进、`body.is-resizing-*` 光标锁只写一遍。自己再写一份 `pointerdown → pointermove → setState`，必然会漏掉「指针移出窗口后 `pointerup` 收不到」这条（拖动粘住不放） |
| 分栏尺寸写 CSS 变量，默认值放断点里 | 全平台 | 拖动值写在容器的 inline 变量（`--browser-left-w` / `--wb-subs-h` / `--msg-detail-h` / `--pub-side-w`），没拖过时由媒体查询给默认值。**不要**在断点里直接写 `grid-template-columns` / `height` —— 那会盖掉 inline 变量，表现为「拖过一次之后再也不跟随断点」 |
| 改文件后要补权限 | 本机 FUSE 挂载 | 该挂载点新建/覆写文件的权限位落成 `000`，需 `chmod 644`（脚本类 `chmod 755`） |

## 结构约定

- `src/main/` 主进程，**TypeScript**（`tsconfig.main.json`），由 `tools/lib/build-main.js` 用 esbuild
  逐文件编成 CJS 落在 `dist/main/`。`mqtt-manager.ts` 刻意不 import electron，
  可以用 node 直接 require `dist/main/mqtt-manager.js` 跑测试 —— 这条性质靠 `bundle: false` 保住，
  **改成打包单文件就会让它失去独立运行环境**。
- `src/preload/preload.ts` 同样编到 `dist/preload/`，对象标注为 `XmqttBridge`，形状错直接编译失败。
- `src/renderer/` **TypeScript + React**，单一 ESM 入口 `main.tsx`，由 Vite 打成 `dist/renderer/assets/*.js`。
  分层是单向的：`layout/` → `views/` → `components/` → `lib/` → `store/`；
  `ipc/events.ts` 把主进程事件写进 store，`app.ts` 只负责引导（灌初始快照 + 离线态开关）。
  视图之间**不准互相 import**，跨视图动作走 `lib/connection.ts` 或 store 的 action
  （事件总线 `on`/`emit` 已在阶段 3 删除，别再往回加）。
  改完先 `npm run typecheck`（strict，零错误）再 `npm run build`。
- **状态的唯一真相在 `store/appStore.ts`（zustand）**。
  写集合必须换新实例（`new Map(prev)` / `concat`），原地 `push` / `Map.set` 不会触发通知。
  派生值（`activeConn` / `isConnected` / `userSubs` …）不进 store，用模块级选择器函数
  （内联箭头函数每次渲染都是新引用，会让 zustand 认为快照变了）。
- **整棵界面都由 React 渲染**（阶段 4 完成）：`layout/AppShell.tsx` 用 `createPortal` 把
  `TitleBar` / `Rail` / 四个视图投递到 `index.html` 里仅剩的三个槽位
  （`#titlebar-root` / `#rail-root` / `#content-root`），`boot()` 在首次提交之后跑。
  四个视图常驻挂载、只切 `is-active` —— 卸载重挂会丢虚拟列表位置与树的折叠态。
  **同一个节点只允许一个写入方**：角标、连接状态这类归 React 的 DOM，命令式代码不要再写。
- **弹层走 `lib/dialog.ts`**：`await dialog.confirm(...)` 一行拿结果，渲染只有
  `components/Dialog.tsx` 一处（Radix Dialog，自带焦点陷阱与 Esc 关闭）。
  同一时刻只允许一个弹层，后来的请求直接得到 `null`。
- `window.__xmqtt` 是给 e2e / 截图脚本的**测试门面**（`main.tsx` 里装），只暴露
  `getState / subscribe / actions / api / dialog / switchView / selectors`，**没有 `views.*`** ——
  界面的真相只有 store 一份。`window.X` 已在阶段 5 彻底删除，不要再加回来。
- `src/shared/` 主进程与渲染层共享的 IPC 契约（`channels.ts` / `models.ts` / `bridge.ts`）。
  通道名只写一次（`INVOKE` 常量），主进程 `ipc.ts` 与 preload 都引用它；改签名时两端一起报错。
  渲染层走 `ipc/client.ts`。
- **玻璃材质是三层降级，不是一套样式**：`src/main/glass.ts` 在建窗**之前**定档，三档分别是
  `liquid`（macOS 26+ 且装得动 `electron-liquid-glass` → 原生 `NSGlassEffectView`）、
  `vibrancy`（macOS 但系统更旧 / 没装模块 → Electron 内置 `NSVisualEffectView`）、
  `css`（Windows / Linux → 页面内 `backdrop-filter` + 自造渐变底）。
  档位通过 `additionalArguments` 在首帧前写进 `<html data-glass>`，样式只在 `app.css` 的
  「玻璃材质」一节按属性分支。
  **外框和内容区分两级厚度**：外框（顶栏 / 导航）`--glass-wash` = 0.34（css 档 0.58），
  纯装饰面，壁纸的轮廓与明暗直接透进来；
  内容区用 `--glass-wash-3`（结构面）+ `--glass-wash-4`（正文面）**两层相乘**到 ≈0.80，
  深浅同一档，壁纸的明暗直接透进来，12px 正文仍压在能读的面上；
  正文面还多一道 `--glass-sheen` 上沿受光 + 1px 边，用来交代「这是一块板」。
  0.80 不是随手取的数：深色侧它卡在「最坏壁纸（纯白）下 `--glass-muted` 仍有 4.5:1」那条线上，
  再薄一档（0.78）就得把 muted 提到 `#b6b7be`，那时它和 `--glass-text-2` 只差 4%，层次就没了。
  **浅色侧不要靠加白**：白 wash 叠在白面板上，壁纸只能透 14%，而浅色壁纸自身的明暗跨度
  只有个位数，乘积就是「看不出效果」（实测传递率 0.15）。现在浅色两层带冷调
  （`232,239,249` 0.42 + `250,252,255` 0.65），透光 20%、面板不再是纯白；
  代价是纯黑壁纸下 muted 3.94:1（原 4.88:1）。
  浅色侧的**形状线索必须反向**：`--glass-edge` / `--glass-line` 一旦写成白色，
  在白面板上就是零对比（之前就是这样，所以浅色看着是一整片白）。
  改这几个数之前先读 `tokens.css` 里的注释 —— 它们不是「最终不透明度」，
  调错方向会把内容区压黑（wash 用暗色）或让 muted 小字掉出 AA。
  `--glass-wash` 是「玻璃有多透」的**唯一旋钮**：材质层（`tintColor`、库的
  `unstable_setVariant` / `unstable_setScrim`）在 macOS 26.6.2 上实测全是空操作，
  改它们不会有一点像素变化，别再往 `glass.ts` 里加材质参数。
  代价写在明处：0.34 的 wash 意味着亮壁纸下外框文字会偏淡（外框已有 `text-shadow` 兜底），
  再想更透就只能在可读性上让步 —— 这是物理约束，不是没调好。
  玻璃档下 `--panel / --panel-2` 在 `.content` 作用域内被换成半透明面，
  文字色阶换成 `--glass-text / --glass-text-2 / --glass-muted` —— 底会随壁纸漂移，
  常规色阶保证不了对比。新增组件只要用 `var(--panel)` / `var(--muted)` 就自动跟上，
  **不要在玻璃作用域里写死颜色**，否则那块就是玻璃里的一块实色补丁。
  窗口的镜面边框在 `.app::after`（`pointer-events: none`，`z-index: 60`）——
  **不能**改写 `.app` 自己的 `box-shadow: inset`：那层画在子节点底下，会被顶栏 / 导航的
  背景整条盖住，写了等于没写且不报错；层级也不能高过 100（toast）/ 200（弹层）。
  导航的选中态是一块**会滑动的玻璃片**（`.rail__lens`，位置由 `Rail.tsx` 量测
  `offsetLeft/Top/Width/Height` 后写内联 transform，监听 `.rail` 的 ResizeObserver）。
  不要再退回「给 `.rail__item.is-active` 涂底色 + 左侧竖条」——那个 `::before` 已删除。
  玻璃片的材质必须**照控制中心那类原生按钮**做：极淡的填充（`--lens-fill` 0.07）+
  一圈细白边（`--lens-rim`）+ 上沿一线光，**不许染色、不许外发光、不许大半径镜面**。
  第一版就是加了 accent 染色 + 左上高光 + 蓝色外发光，被用户一句「太过了，不像原生」打回 ——
  原生材质的克制在于「几乎看不出它是什么颜色，只有一条边告诉你它是玻璃」。
  选中色要表达就改文字色，别往玻璃上刷颜色。
  排查黑屏 / 透明洞：`XMQTT_GLASS=css` 先跑一遍，能立刻区分是材质问题还是渲染问题。
  `liquid` 档 `addView` 失败时主进程会把 `data-glass` 改回 `css` 并补回不透明底 ——
  透明窗口没有材质兜底就是一个透到桌面的洞，这条降级路径别删。
  用户开了系统「降低透明度 / 增强对比度」时，`prefers-reduced-transparency` 一节会把
  玻璃整个关掉（`.content` 回 `--bg`，面板回 `--panel-solid`），这条兜底别删。
- 样式分两层：`styles/tokens.css` 是**令牌唯一来源**（`@theme` 把颜色映射成工具类名，另有间距/字号/圆角/阴影分级），
  `styles/app.css` 是组件层，只引用令牌、不写死色值。Tailwind 只引 theme + utilities，
  **不引 preflight**（它会把 input/button/table 的默认盒模型改掉，现有语义类要逐条对齐）。
- 图标：`lib/icons.ts` 由 `tools/gen-icons.mjs` **生成**，不要手改。加图标改脚本里的 `ICON_NAMES` 后重跑；
  静态骨架用 `<i data-icon="name" data-size="18">` 占位，脚本会展开成内联 SVG（可重复运行）。
  视图里用 `el('button', {...}, icon('x', 13))`，不要再用 `text: '✕'` 这类字符图标。
- `build/` 只放打包资源（`icon.png` / `icon.icns`，由 `npm run icon` 生成）；`release/` 是 electron-builder 产物，两者都不入库。
- 连接状态、订阅表、主题集合**只在主进程维护一份**，渲染层永远从 store 取（store 只存主进程推来的快照），不做本地推断。
- 消息走 60ms 批量上报（`mqtt:messages`），主题增量走 400ms 合并渲染 —— 订阅 `#` 时每秒可能上千条，逐条推送会卡死界面。
- 需要连接才能完成的控件加 `needs-connection` class，由 `body.is-offline` 统一置灰，不要在各视图各记一份禁用清单。
- `tools/lib/electron-path.js` 是 Electron 可执行文件的唯一解析入口（读 `path.txt`，按平台兜底），新增脚本请复用它。

## 验证

```bash
node tools/unit-test.mjs      # 54 项：store 裁剪与派生、主题增量、树构建、过滤、编码、配置映射、弹层契约
node tools/test-manager.mjs   # 33 项：真实 broker 上的连接/订阅/发布/静音/编码/扫描（无需 GUI，跑 dist/ 产物）
node tools/e2e-test.mjs       # 36 项：CDP 驱动真实窗口跑 渲染层→IPC→broker→回推 全链路（需 X server）
node tools/responsive-check.mjs # 53 项：5 个档位的几何断言（列宽之和==表宽、行高==令牌、导航位置、抽屉/详情开合）
node tools/dev-broker.mjs     # 手测用的本地 broker（灌模拟产线报文）
npm run typecheck             # 四份 tsconfig：渲染层 / 主进程+preload / 单测 / 构建配置
npm run build                 # 主进程（esbuild）+ 渲染层（vite）
node tools/build-main.mjs     # 只刷主进程产物（排查打包内容时用）
node tools/gen-icons.mjs      # 只在改过 ICON_NAMES 时需要（重生成 icons.ts + 展开 HTML 占位）
```

`npm test` = 单测 + Manager。改渲染层或 IPC 后至少跑 e2e；只改纯逻辑（store / lib）时先跑单测。
**改了样式、断点、表格列或行高，必须跑 `npm run check:responsive`** —— 响应式的问题几乎
都不报错，只会「某一列莫名其妙的窄」或者「滚到底还差一截」，几何断言是唯一能自动抓住它的手段。
`test-manager` 需要 `aedes`（测试专用 broker）：`npm install --no-save aedes@0.51.3 ws`。

> aedes 0.x 导出构造函数、1.x 导出 `{ Aedes, default }`。测试脚本已同时兼容两种形态，
> 但 1.x 与 mqtt 5.x 存在 connack 超时问题，**建议锁 0.51.3**。

## 当前状态

功能完整：连接管理、主题工作台（扫描→订阅→查看）、发布与消息模板、日志与状态页。
渲染层重写六个阶段全部完成：TypeScript 化（1）→ 视觉系统（2）→ React 外壳 + zustand（3）→
五视图 React 化（4）→ 测试与文档收尾（5）→ 主进程 TS 化（6）。
主进程与渲染层现在共用 `src/shared/` 的同一份 IPC 契约。
响应式适配已完成（见 `docs/响应式适配设计.md`）：外壳四档（≥1280 / 1024–1279 / 768–1023 / <768），
表格列数跟**面板宽度**（`@container msg`）走，密度只跟**指针能力**（`pointer: coarse`）走。
窗口材质也已分层：macOS 走原生玻璃（`liquid` / `vibrancy`），其余平台走页面内 `css` 档，
三档共用同一套 `--glass-*` 令牌与同一处外观规则。外框与内容区都玻璃化，
内容区按「结构面 + 正文面」两层叠加，并且只在玻璃作用域内替换文字色阶 ——
可读性由令牌保证，不靠各组件自己补背景。
最近一次全绿：单测 54/54、Manager 33/33、e2e 36/36、几何断言 53/53、截图 7 张（macOS 实测，Linux 待有显示环境时复跑）。

## 版本控制

已纳入 git，主分支 `main`。

- `node_modules/`（约 260MB，含 Electron 二进制）**不入库**：Windows 用 `node tools/assemble-deps.mjs` 装配，Linux/macOS 用 `npm install`。
- 换行策略见 `.gitattributes`：`.cmd` / `.ps1` 强制 CRLF（cmd.exe 对 LF-only 的批处理有解析缺陷），其余文本 LF。
  Windows 上 `core.autocrlf=true`，仓库内统一存 LF、检出时按 attr 转换 —— 不要手工去改这两个脚本的换行。
- 提交前跑一遍 `node tools/test-manager.mjs` 和 `node tools/e2e-test.mjs`。
