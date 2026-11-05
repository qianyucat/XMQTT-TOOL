/**
 * Vite 配置
 * ------------------------------------------------------------------
 * 两个不寻常的地方，都是为了迁就本项目的既有约束：
 *
 * 1. `root` 指向 `src/renderer`，而不是项目根。
 *    现有 `index.html` 就在那里，且里面全是相对路径（`styles/app.css`、`js/*.js`）。
 *    把 root 定在那儿，源码目录一个文件都不用挪；产物输出到根下的 `dist/renderer`。
 *
 * 2. `build.target` 锁 `chrome120`。
 *    运行时是 Electron 28.3.3（Chromium 120）。设低了会触发无谓的降级转换
 *    （实测出现过 esbuild 报「解构无法降级到 chrome87」的构建失败），设高了新语法会在旧内核上崩。
 *    **升级 Electron 时必须同步改这个值。**
 *
 * 另外：`base: './'` 是为了产物能被 `app://` 协议以相对路径加载；
 *  `cacheDir` 默认留在项目内，如果构建在 UNC 共享盘上明显变慢，
 *  把它改成本地盘绝对路径即可（实测 UNC 小文件写比本地盘慢约 10 倍）。
 */

import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const PROJECT_ROOT = path.resolve(__dirname);
const RENDERER_ROOT = path.resolve(PROJECT_ROOT, 'src/renderer');
const DIST_ROOT = path.resolve(PROJECT_ROOT, 'dist/renderer');
const DEV_PORT = 5174;

/**
 * dev 模式专用 CSP 放宽。
 *
 * 生产产物沿用 `index.html` 里写死的严格 CSP；但 dev server 要注入内联的
 * React Refresh preamble、并通过 WebSocket 做 HMR，严格 CSP 会直接把它们拦掉。
 * 这个插件只改 dev 返回的 HTML，构建产物不受影响。
 */
function devCspPlugin(): Plugin {
  const devCsp = [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' ws://localhost:${DEV_PORT} ws://127.0.0.1:${DEV_PORT}`,
    "img-src 'self' data:",
    "font-src 'self'",
  ].join('; ');

  return {
    name: 'xmqtt-dev-csp',
    transformIndexHtml(html) {
      return html.replace(/content="[^"]*default-src[^"]*"/, `content="${devCsp}"`);
    },
  };
}

export default defineConfig(({ command }) => {
  const isDev = command === 'serve';

  return {
    root: RENDERER_ROOT,
    base: './',

    plugins: [react(), tailwindcss(), ...(isDev ? [devCspPlugin()] : [])],

    resolve: {
      alias: {
        '@shared': path.resolve(PROJECT_ROOT, 'src/shared'),
        '@renderer': path.resolve(PROJECT_ROOT, 'src/renderer'),
      },
    },

    build: {
      outDir: DIST_ROOT,
      emptyOutDir: true,
      target: 'chrome120',
      sourcemap: false,
      // 桌面端本地加载，资源内联阈值调高可以减少请求数
      assetsInlineLimit: 8192,
    },

    server: {
      port: DEV_PORT,
      strictPort: true,
    },

    // 放项目内即可；UNC 盘构建慢时改成 'R:\\...\\.vite-cache' 之类的本地绝对路径
    cacheDir: path.resolve(PROJECT_ROOT, '.vite-cache'),
  };
});
