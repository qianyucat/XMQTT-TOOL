/**
 * Electron 主进程入口
 * ------------------------------------------------------------------
 * 窗口采用「隐藏系统标题栏 + titleBarOverlay」方案：保留 Windows 原生的最小化/最大化/关闭
 * 按钮（可用、可拖动、支持 Win11 贴靠布局），同时把标题栏区域交给渲染层自绘，
 * 这样能做出 MQTT.fx 那种一整条深色顶栏的连续观感，而不用自己实现窗口控制逻辑。
 *
 * 路径基准变了（阶段 6）：本文件编译后落在 `dist/main/main.js`，
 * 因此 `__dirname` 是 `<root>/dist/main`，而不是 `<root>/src/main`。
 * 下面三处路径（渲染产物 / 渲染源码 / preload）都已按新基准调整，改动前先确认。
 */

import { app, BrowserWindow, Menu, dialog, nativeTheme, net, protocol, screen, shell } from 'electron';
import type { BrowserWindowConstructorOptions, MenuItemConstructorOptions } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EVENTS } from '../shared/channels';
import type { EventChannel } from '../shared/channels';
import type { ThemeMode } from '../shared/models';
import { registerIpc } from './ipc';
import { applyLiquidGlass, glassMode, glassWindowOptions, resolveGlass } from './glass';
import { MqttManager } from './mqtt-manager';
import { ConfigStore } from './store';

/*
 * 必须放在 app ready 之前。
 *
 * Windows 那台是远程/虚拟机会话，Chromium 的 GPU 进程在受限令牌下起不来
 * （gpu_process_host.cc error_code=18），Electron 会在 ready 之前直接 FATAL 退出，
 * 表现就是「双击没反应」；Linux 无头服务器同理。
 *
 * 但 macOS 真机不存在这个问题：反过来强行关掉 GPU 会让滚动、弹层动画退化成
 * CPU 光栅，既慢又费电。所以按平台区分：
 *   darwin  → 默认保留 GPU，需要时可设 XMQTT_SOFTWARE_RENDER=1 强制降级
 *   其它    → 默认禁用（现场环境优先保证「能起来」），设 XMQTT_SOFTWARE_RENDER=0 可关闭
 *
 * 本工具全是 2D 表单与表格，没有 WebGL/3D/视频合成，禁用硬件加速对功能零影响。
 */
const IS_MAC = process.platform === 'darwin';
const SOFTWARE_RENDER = process.env.XMQTT_SOFTWARE_RENDER
  ? process.env.XMQTT_SOFTWARE_RENDER !== '0'
  : !IS_MAC;

if (SOFTWARE_RENDER) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-software-rasterizer');
}

app.setName('XMQTT Tool');

/*
 * 渲染层加载方式
 * ------------------------------------------------------------------
 * 为什么不继续用 loadFile（file://）：
 *   渲染层打进产物后是 ES module，而 file:// 页面加载 module script 会被 Chromium
 *   的 CORS 校验拦掉（origin 为 null）。注册一个 privileged 自定义协议后页面有了正常
 *   origin，`script-src 'self'` 也能正常生效，webSecurity 不必关掉。
 *
 * 三种加载模式按优先级：
 *   1. 有 VITE_DEV_SERVER_URL          → 加载 Vite dev server（开发态，带 HMR）
 *   2. dist/renderer 已构建            → 加载 app://bundle/index.html
 *   3. 两者都没准备好                  → 回退 file:// 加载源码目录
 *
 * ⚠️ 第 3 档在阶段 3/4 之后其实已经**不完整**：`src/renderer/index.html` 现在只挂
 * `main.tsx`（ES module），而 `file://` 下 Chromium 会拦掉 module script。留着这一档
 * 只是为了「没构建时窗口仍能打开、能看主进程侧的报错」，界面上会是空白。
 * 正常使用请先 `npm run build`（主进程 + 渲染层一起）。
 *
 * 注意基准：编译产物在 dist/main/，所以要 `..` 两次才回到项目根。
 */
const RENDERER_DIST = path.join(__dirname, '..', '..', 'dist', 'renderer');
const RENDERER_SRC = path.join(__dirname, '..', '..', 'src', 'renderer');
const APP_SCHEME = 'app';
const APP_ORIGIN = 'app://bundle';

// 必须在 app ready 之前注册：standard + secure 让它拥有正常 origin 与 secure context
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

/**
 * 把 app://bundle/<相对路径> 映射到 dist/renderer 下的真实文件。
 *
 * URL 来自渲染进程，是这里唯一的外部输入，越界请求一律 403，
 * 避免 `app://bundle/../../x` 这类路径穿越。
 */
function registerAppProtocol(): void {
  protocol.handle(APP_SCHEME, (request) => {
    const { pathname } = new URL(request.url);
    let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    if (!rel || rel.endsWith('/')) rel = `${rel}index.html`;

    const target = path.resolve(RENDERER_DIST, rel);
    const relative = path.relative(RENDERER_DIST, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return new Response('Forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(target).toString());
  });
}

/** 按文件头说的三种模式挑一种加载 */
function loadRenderer(win: BrowserWindow): void {
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    win.loadURL(devUrl);
    return;
  }
  if (fs.existsSync(path.join(RENDERER_DIST, 'index.html'))) {
    win.loadURL(`${APP_ORIGIN}/index.html`);
    return;
  }
  win.loadFile(path.join(RENDERER_SRC, 'index.html'));
}

/*
 * 数据目录覆盖（便携模式 / 自动化测试）。
 * 默认落在 %APPDATA%\XMQTT Tool；设了 XMQTT_USER_DATA 就整体搬到指定目录，
 * 便于把配置和证书跟程序放在一起随身带走，也让端到端测试能跑在隔离目录里、
 * 不去动用户的真实配置。
 */
if (process.env.XMQTT_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.XMQTT_USER_DATA));
}

const store = new ConfigStore();
const manager = new MqttManager();

let mainWindow: BrowserWindow | null = null;

/*
 * 原生材质是否真的挂上了。液态玻璃要求窗口本体透明（否则材质被页面底色盖死），
 * 一旦 addView 失败而窗口仍是透明的，界面就会出现「一块透到桌面的洞」。
 * 这个标志只有在这种失败时才是 false —— 那时把渲染层切回 css 模式并补一层不透明底。
 */
let glassActive = false;

const TITLEBAR: Record<ThemeMode, { color: string; symbolColor: string }> = {
  dark: { color: '#0f141b', symbolColor: '#c8d4e2' },
  light: { color: '#eef1f7', symbolColor: '#41506b' },
};

function broadcast(channel: EventChannel, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function applyTitleBarTheme(theme: ThemeMode): void {
  // macOS 没有 titleBarOverlay：红绿灯是系统绘制的独立控件，颜色跟随系统外观，
  // 这里只把窗口外观（浅/深）同步给系统，避免红绿灯与自绘顶栏对比度打架。
  if (IS_MAC) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      /*
       * 玻璃模式下这一层必须保持全透明：窗口背景色是盖在原生材质**上面**的一层，
       * 设成实色就把 NSGlassEffectView / NSVisualEffectView 整块盖死了，
       * 表现为「切主题之后玻璃突然消失」。
       */
      mainWindow.setBackgroundColor(glassActive ? '#00000000' : theme === 'light' ? '#eef1f7' : '#0f141b');

      /*
       * 原生材质跟随的是**系统**外观，而本工具的主题是应用内设置 —— 两者不一致时
       * 会出现「浅色界面 + 深色玻璃」这种组合，正文直接变成深底深字。
       * 所以玻璃档下把原生外观钉到应用主题上（红绿灯、原生弹窗也会一起变，
       * 这本来就是应用级外观该有的行为）。css 档没有原生物料，不必干预系统设置。
       */
      if (glassActive) nativeTheme.themeSource = theme;
    } catch {
      /* 忽略 */
    }
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const t = TITLEBAR[theme] || TITLEBAR.dark;
  try {
    mainWindow.setTitleBarOverlay({ ...t, height: 40 });
  } catch {
    /* 平台不支持时静默降级 */
  }
}

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */

function createWindow(): void {
  const theme = store.settings.theme || 'dark';

  /*
   * 玻璃档位必须在建窗**之前**定好：它决定窗口要不要透明、要不要带 vibrancy，
   * 这些是构造参数，建完就改不了了（transparent 尤其）。
   * 判定逻辑与平台差异全部收在 glass.ts，这里只消费结果。
   */
  const glass = resolveGlass();
  const windowBackground = theme === 'light' ? '#eef1f7' : '#0f141b';

  /*
   * 窗口外框按平台分开：
   *  - Windows / Linux：hidden + titleBarOverlay，自绘顶栏的同时保留原生最小化/最大化/关闭，
   *    还能吃到 Win11 的贴靠布局；overlay 占位由 CSS 的 padding-right:138px 让出。
   *  - macOS：hiddenInset + trafficLightPosition。mac 不支持 titleBarOverlay（传了也无效），
   *    红绿灯是系统控件，只能靠 trafficLightPosition 微调，左侧留白由
   *    CSS 的 html[data-platform='darwin'] .titlebar 负责。
   */
  const chrome: BrowserWindowConstructorOptions = IS_MAC
    ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 13 } }
    : {
        titleBarStyle: 'hidden',
        titleBarOverlay: { ...(TITLEBAR[theme] || TITLEBAR.dark), height: 40 },
      };

  /*
   * 1500×940 是给 Windows 大屏定的默认值；MacBook 的逻辑分辨率常见 1440×900，
   * 940 会顶到菜单栏并溢出屏幕底部。按主显示器的可用工作区收一下 ——
   * macOS 的菜单栏与 Dock 已经含在 workArea 里，不用再自己减。
   */
  const { workAreaSize } = screen.getPrimaryDisplay();
  const winWidth = Math.min(1500, Math.max(1080, workAreaSize.width - 80));
  const winHeight = Math.min(940, Math.max(680, workAreaSize.height - 60));

  // 用 const 局部变量持有窗口：各回调里 mainWindow 可能已被置空，靠局部变量避免竞态
  const win = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    /*
     * 900 是「紧凑档」的下界，不是随手取的值：
     *   · ≥1024 桌面档（树 380，六列全显）
     *   · 900–1023 紧凑档（树 300，表格减两列）—— 小屏笔记本与
     *     「工具窗口 + 文档并排」的排障姿势都落在这里，能放下
     *   · <768 是手机档，只给 Web / 移动壳用，桌面窗口拖不到
     * 再往下压就会掉进「树和表都看不清」的中间态，不如直接不允许。
     */
    minWidth: 900,
    minHeight: 680,
    show: false,
    backgroundColor: windowBackground,
    ...chrome,
    /* 玻璃参数放在 chrome 之后：它会覆盖 backgroundColor，并为 liquid 追加 transparent */
    ...glassWindowOptions(glass.mode, theme, windowBackground),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
      /*
       * 档位通过启动参数交给 preload，而不是等 IPC 回来再写 —— preload 在首帧之前
       * 就能写进 <html data-glass>，玻璃样式与骨架同帧生效。走 IPC 的话会先渲染一帧
       * 实色背景再跳成透明，那一下闪烁比什么都显眼（和 data-platform 同一个理由）。
       */
      additionalArguments: [`--xmqtt-glass=${glass.mode}`],
    },
  });

  mainWindow = win;

  /*
   * 原生材质在窗口存在之后、加载页面之前挂上去：越早越好，
   * 否则会先看到一帧透明窗口，再「长出」玻璃。
   *
   * 注意 liquid 档的失败路径 —— 窗口构造时已经按透明建好了，材质挂不上就是一块
   * 透到桌面的洞。此时必须把渲染层切回 css（页面自带渐变底）并补回不透明背景色，
   * 让降级看起来像「没开玻璃」，而不是像「程序坏了」。
   */
  glassActive = glass.mode === 'vibrancy';
  if (glass.mode === 'liquid') {
    glassActive = applyLiquidGlass(win, theme);
    if (!glassActive) {
      try {
        win.setBackgroundColor(windowBackground);
      } catch {
        /* 忽略：透明窗口在极老系统上不接受实色背景 */
      }
      win.webContents.once('did-finish-load', () => {
        void win.webContents
          .executeJavaScript("document.documentElement.dataset.glass = 'css'", true)
          .catch(() => {});
      });
    }
  }

  loadRenderer(win);

  /*
   * 显示窗口：谁先到谁触发。
   * ------------------------------------------------------------------
   * 不能只等 ready-to-show。实测 Windows 11 build 26200 + Electron 28.3.3：
   * 窗口建好、页面也加载完了（did-finish-load 已到、DOM 完整、渲染进程不崩），
   * 但首帧迟迟不产生 → ready-to-show 永远不触发 → win.show() 一次都没跑到。
   * 现象就是「双击没反应」：进程在任务管理器里躺着，窗口 isVisible() 一直是 false；
   * 再点快捷方式只会被 requestSingleInstanceLock 吞掉，继续没反应。
   * 关掉/打开硬件加速结果一样，所以不是 GPU 起不来的问题，是首帧信号本身不可靠。
   *
   * 兜底放在 did-finish-load（此时 bundle 已执行完），再让出一拍给合成器，
   * 避免把「还没画」的窗口直接亮出来。ready-to-show 先到就按它走，闪白更少。
   */
  let shown = false;
  const showWindow = (): void => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    win.show();
    applyTitleBarTheme(store.settings.theme);
    if (process.env.XMQTT_DEVTOOLS === '1') {
      win.webContents.openDevTools({ mode: 'detach' });
    }
  };
  win.once('ready-to-show', showWindow);
  win.webContents.once('did-finish-load', () => {
    setTimeout(showWindow, 50);
  });

  win.on('closed', () => {
    mainWindow = null;
  });

  // 外部链接交给系统浏览器，不在应用内开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

/* ------------------------------------------------------------------ */
/* 菜单                                                                */
/* ------------------------------------------------------------------ */

/** 打开配置所在目录：文件还没写出来时（首次启动）退化成打开目录 */
function openConfigDir(): void {
  if (fs.existsSync(store.file)) shell.showItemInFolder(store.file);
  else shell.openPath(path.dirname(store.file));
}

function buildMenu(): void {
  const aboutItem: MenuItemConstructorOptions = {
    label: '关于',
    click: () =>
      dialog.showMessageBox(mainWindow as BrowserWindow, {
        type: 'info',
        title: '关于 XMQTT Tool',
        message: `XMQTT Tool ${app.getVersion()}`,
        detail: `Electron ${process.versions.electron} / Node ${process.versions.node}\n配置文件：${store.file}\n玻璃材质：${glassMode()}`,
        buttons: ['关闭'],
      }),
  };

  /*
   * macOS 的菜单约定与 Windows 差别很大：
   *  - 第一项必须是「应用菜单」，关于/服务/隐藏/退出都在里面 —— 否则 ⌘Q、⌘H 这些
   *    系统级快捷键不生效，Dock 菜单也会是空的。
   *  - 「退出」不放在文件菜单里（放两处会让人困惑）。
   *  - 右侧多一栏「窗口」，⌘M 最小化、⌘W 关闭窗口才有标准行为。
   *
   * 平台相关的片段单独声明成 MenuItemConstructorOptions[]，
   * 这样展开（...）进场时仍保留字面量的上下文类型，role 才能被校验。
   */
  const macAppMenu: MenuItemConstructorOptions[] = IS_MAC
    ? [
        {
          label: app.name,
          submenu: [
            { role: 'about', label: `关于 ${app.name}` },
            { type: 'separator' },
            { role: 'services', label: '服务' },
            { type: 'separator' },
            { role: 'hide', label: `隐藏 ${app.name}` },
            { role: 'hideOthers', label: '隐藏其他' },
            { role: 'unhide', label: '全部显示' },
            { type: 'separator' },
            { role: 'quit', label: `退出 ${app.name}` },
          ],
        },
      ]
    : [];
  const macWindowMenu: MenuItemConstructorOptions[] = IS_MAC
    ? [{ role: 'windowMenu', label: '窗口' }]
    : [];
  const nonMacQuit: MenuItemConstructorOptions[] = IS_MAC
    ? []
    : [{ type: 'separator' }, { role: 'quit', label: '退出' }];
  const nonMacAbout: MenuItemConstructorOptions[] = IS_MAC ? [] : [aboutItem];

  const template: MenuItemConstructorOptions[] = [
    ...macAppMenu,
    {
      label: '文件',
      submenu: [
        {
          label: '导出连接配置…',
          click: () => mainWindow?.webContents.send(EVENTS.menu, { action: 'export-config' }),
        },
        {
          label: '导入连接配置…',
          click: () => mainWindow?.webContents.send(EVENTS.menu, { action: 'import-config' }),
        },
        { type: 'separator' },
        { label: '打开配置目录', click: openConfigDir },
        ...nonMacQuit,
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        {
          label: '深色主题',
          click: () => mainWindow?.webContents.send(EVENTS.menu, { action: 'theme', value: 'dark' }),
        },
        {
          label: '浅色主题',
          click: () =>
            mainWindow?.webContents.send(EVENTS.menu, { action: 'theme', value: 'light' }),
        },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
      ],
    },
    ...macWindowMenu,
    {
      label: '帮助',
      submenu: [
        {
          label: 'MQTT 协议速查',
          click: () =>
            dialog.showMessageBox(mainWindow as BrowserWindow, {
              type: 'info',
              title: 'MQTT 速查',
              message: '通配符与常用端口',
              detail:
                '＋  单层通配符，如  sensor/+/temp\n' +
                '＃  多层通配符（只能放末尾），如  factory/#\n' +
                '$SYS/ 以 $ 开头的主题不会被 # 匹配\n\n' +
                'TTL  常用端口：1883 (mqtt) / 8883 (mqtts) / 8083 (ws) / 8084 (wss)\n' +
                'QoS  0 至多一次 / 1 至少一次 / 2 仅一次\n' +
                'Retain  保留消息，新订阅者立即收到最后一条',
              buttons: ['知道了'],
            }),
        },
        ...nonMacAbout,
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      // 窗口还是隐藏的就说明首帧没来（见 createWindow 里那段说明），
      // 只 focus() 是叫不出来的 —— 用户看到的就是「再点一次还是没反应」。
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    registerAppProtocol();
    buildMenu();

    registerIpc({
      store,
      manager,
      getWindow: () => mainWindow,
      applyTitleBarTheme,
    });

    // mqtt-manager 的事件统一转发到渲染层
    manager.on('messages', (batch) => broadcast(EVENTS.messages, batch));
    manager.on('status', (state) => broadcast(EVENTS.status, state));
    manager.on('log', (entry) => broadcast(EVENTS.log, entry));
    manager.on('topics', (payload) => broadcast(EVENTS.topics, payload));
    manager.on('connections', (list) => broadcast(EVENTS.connections, list));

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    try {
      manager.shutdown();
      store.flush();
    } catch (err) {
      console.error('[main] 退出清理异常:', (err as Error).message);
    }
  });
}
