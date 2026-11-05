#!/usr/bin/env bash
# ==================================================================
#  XMQTT Tool —— Linux / macOS 启动脚本
# ------------------------------------------------------------------
#  Windows 上走 start.cmd -> tools\start.ps1（那套逻辑要处理 UNC 路径、
#  cmd.exe 代码页等问题）。在 Linux / macOS 上这些坑都不存在，直接用
#  tools/launch.js 即可 —— 它本来就已经跨平台了。
#
#  这个脚本只负责：
#    1) 校验 Node 与依赖是否就绪，缺什么就给出确切的修复命令
#    2) 无图形环境（纯 SSH / 服务器）时给出明确提示，而不是让 Electron
#       抛一句 "Missing X server or $DISPLAY" 让人摸不着头脑
#    3) 把参数原样透传给 launch.js
#
#  用法：
#    ./start.sh               启动
#    ./start.sh --devtools    带开发者工具
#    ./start.sh --sandboxed   保留 Chromium 沙箱
# ==================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

info()  { printf '\033[36m[XMQTT]\033[0m %s\n' "$*"; }
warn()  { printf '\033[33m[XMQTT]\033[0m %s\n' "$*"; }
die()   { printf '\033[31m[XMQTT]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- 1. Node ----------
if ! command -v node >/dev/null 2>&1; then
  die "未找到 node。请先安装 Node.js 18+（推荐 20/22 LTS）。"
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  die "Node.js 版本过低（当前 $(node -v)），本项目要求 18+。"
fi

# ---------- 2. 依赖 ----------
if [ ! -d node_modules ]; then
  warn "node_modules 不存在，正在安装依赖……"
  if [ -n "${XMQTT_NPM_REGISTRY:-}" ]; then
    npm install --registry "$XMQTT_NPM_REGISTRY" --no-audit --no-fund
  else
    npm install --no-audit --no-fund
  fi
fi

# ---------- 3. 渲染层产物 ----------
# 生产环境走 app:// 协议加载 dist/renderer（ES module + CSP），所以没有产物
# 就没法启动 —— 早先的 file:// 回退只能加载源码里的经典脚本，现已不可用。
# 这里做一次增量判断：产物缺失、或源码比产物新，就重建。
NEED_BUILD=0
if [ ! -f dist/renderer/index.html ]; then
  NEED_BUILD=1
elif [ -n "$(find src/renderer src/shared vite.config.ts package.json \
        -newer dist/renderer/index.html -type f -print -quit 2>/dev/null)" ]; then
  NEED_BUILD=1
fi

if [ "$NEED_BUILD" = "1" ]; then
  info "构建渲染层产物（dist/renderer）……"
  npm run build
fi

# ---------- 4. Electron 二进制 ----------
if ! node -e "
const { resolveElectronExe } = require('./tools/lib/electron-path.js');
process.exit(resolveElectronExe(process.cwd()).found ? 0 : 1);
"; then
  die "Electron 二进制缺失。请重新执行： npm install
        （国内网络建议先配镜像：npm config set registry https://mirrors.tencent.com/npm/
          并设 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/）
        若报 ENOENT .../Library/Caches/electron（受限环境无法写家目录缓存），改用：
          electron_config_cache=\"\$PWD/.electron-cache\" npm install"
fi

# ---------- 5. 图形环境 ----------
# Electron 必须有 X server（Wayland 会话下 XWayland 亦可）。纯服务器 / 纯 SSH
# 环境下直接启动只会得到 "Missing X server or \$DISPLAY"。
if [ "$(uname -s)" = "Linux" ] && [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  cat >&2 <<'EOF'
[XMQTT] 当前没有可用的图形环境（DISPLAY / WAYLAND_DISPLAY 均未设置）。

  Electron 是 GUI 程序，必须有 X server 才能开窗口。可选方案：

  1) 在带桌面的机器上运行（推荐）
  2) 无头服务器 + Xvfb 虚拟显示：
       sudo apt install -y xvfb libnss3 libatk-bridge2.0-0 libgbm1 libasound2
       xvfb-run -a ./start.sh
  3) SSH X11 转发：ssh -X 你的主机，然后重试

  只想验证 MQTT 核心逻辑（不需要窗口）：
       node tools/test-manager.mjs
EOF
  exit 1
fi

# ---------- 6. 启动 ----------
info "项目目录: $ROOT"
exec node tools/launch.js "$@"
