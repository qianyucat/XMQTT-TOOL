# XMQTT Tool 启动脚本
# ==================================================================
# 三个必须处理的坑（都是本机实测踩出来的）：
#
# 1) ELECTRON_RUN_AS_NODE
#    DSH / Codex 这类宿主的进程环境里会带 ELECTRON_RUN_AS_NODE=1（宿主自己用它把
#    electron 当 node 跑）。被继承下来后，本项目的 electron.exe 会退化成纯 node，
#    main.js 里的 require('electron') 拿不到 app / BrowserWindow，表现是进程一闪而退。
#    启动前必须把它从环境里摘掉。
#
# 2) UNC 工作目录
#    CreateProcess 不接受 UNC 路径作为工作目录。项目若放在网络共享盘
#    （\\fileserver\shared\...），先把 shell 切到本地目录，再用绝对路径启动。
#
# 3) Chromium 沙箱
#    本机是远程/虚拟机会话，Chromium 的 GPU 子进程在受限令牌下起不来：
#    gpu_process_host.cc error_code=18 → FATAL "GPU process isn't usable"，
#    Electron 在窗口出现前就整体退出。加 --no-sandbox 后正常。
#    对本工具而言安全性没有实质损失：界面只加载本地 HTML/CSS/JS，CSP 限制为同源，
#    渲染层 contextIsolation 且无 node 能力，不加载任何远程内容。
#    若在沙箱正常的普通桌面环境使用，可传 -Sandboxed 关掉该参数。
#
# 用法：
#   pwsh -File tools\start.ps1              正常启动
#   pwsh -File tools\start.ps1 -DevTools    带开发者工具启动
#   pwsh -File tools\start.ps1 -Sandboxed   启用 Chromium 沙箱（普通桌面环境）

[CmdletBinding()]
param(
    [switch]$DevTools,
    [switch]$Sandboxed,
    [switch]$Wait
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$electronExe = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'

if (-not (Test-Path $electronExe)) {
    Write-Host "[XMQTT] 未找到 electron.exe：" -ForegroundColor Red
    Write-Host "        $electronExe"
    Write-Host "        请先执行：node tools\assemble-deps.mjs" -ForegroundColor Yellow
    exit 1
}

Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

if ($DevTools) { $env:XMQTT_DEVTOOLS = '1' }

# ---------- 主进程产物（阶段 6 起必需）----------
# package.json 的 main 指向 dist/main/main.js —— 那是 TypeScript 的编译产物，
# 不是源码。缺了它 electron 会直接报找不到入口，窗口一闪而退。
# 这里做增量判断：产物缺失、或 src/{main,preload,shared} 下有 .ts 比产物新，就重建。
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[XMQTT] 未找到 node —— 主进程需要用 esbuild 编译成 dist/main，无法启动。" -ForegroundColor Red
    Write-Host "        请先安装 Node.js 18+。" -ForegroundColor Yellow
    exit 1
}

$mainEntry = Join-Path $projectRoot 'dist\main\main.js'
$needBuildMain = -not (Test-Path $mainEntry)
if (-not $needBuildMain) {
    $mainEntryTime = (Get-Item $mainEntry).LastWriteTime
    $tsSources = @(
        (Join-Path $projectRoot 'src\main'),
        (Join-Path $projectRoot 'src\preload'),
        (Join-Path $projectRoot 'src\shared')
    ) | Where-Object { Test-Path $_ } | ForEach-Object {
        Get-ChildItem -Path $_ -Recurse -File -Filter *.ts -ErrorAction SilentlyContinue
    }
    if ($tsSources | Where-Object { $_.LastWriteTime -gt $mainEntryTime } | Select-Object -First 1) {
        $needBuildMain = $true
    }
}

if ($needBuildMain) {
    Write-Host "[XMQTT] 构建主进程产物（dist/main）……" -ForegroundColor Cyan
    Push-Location $projectRoot
    try {
        & node 'tools\build-main.mjs'
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[XMQTT] 主进程构建失败：请检查 node_modules/esbuild 是否装配完整" -ForegroundColor Red
            exit 1
        }
    }
    finally { Pop-Location }
}

$electronArgs = @($projectRoot, '--disable-gpu')
if (-not $Sandboxed) { $electronArgs += '--no-sandbox' }

Write-Host "[XMQTT] $electronExe" -ForegroundColor Cyan
Write-Host "[XMQTT] 参数: $($electronArgs[1..($electronArgs.Count-1)] -join ' ')" -ForegroundColor DarkGray

# CreateProcess 不接受 UNC 工作目录 —— 先落到本地目录再启动
Push-Location $env:TEMP
try {
    if ($Wait) {
        & $electronExe @electronArgs
        Write-Host "[XMQTT] 已退出，退出码 $LASTEXITCODE" -ForegroundColor DarkGray
    }
    else {
        # 默认分离启动：窗口独立于当前终端，关掉终端不影响应用
        Start-Process -FilePath $electronExe -ArgumentList $electronArgs -WorkingDirectory $env:TEMP | Out-Null
        Write-Host "[XMQTT] 已启动" -ForegroundColor Green
    }
}
finally {
    Pop-Location
}
