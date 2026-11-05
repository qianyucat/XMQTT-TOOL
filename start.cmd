@echo off
rem ==================================================================
rem  XMQTT Tool - double-click launcher
rem
rem  The real work is in tools\start.ps1, which deals with three
rem  environment quirks of this machine:
rem    1) ELECTRON_RUN_AS_NODE inherited from the host process env
rem    2) project lives on a UNC share (CreateProcess rejects it as cwd)
rem    3) Chromium GPU sandbox fails in this session (needs --no-sandbox)
rem
rem  IMPORTANT: keep this file ASCII-only.
rem  cmd.exe reads .cmd files using the OEM code page, so UTF-8 Chinese
rem  text here gets mangled into garbage bytes that shred the command
rem  parsing ("'em' is not recognized", "%~dp0start.ps1" split apart...).
rem  Chinese messages belong in start.ps1 (UTF-8 with BOM), which
rem  PowerShell reads correctly.
rem ==================================================================

setlocal

rem The launcher script lives in tools\ (%~dp0 is this file's folder)
set "SCRIPT=%~dp0tools\start.ps1"

if not exist "%SCRIPT%" (
    echo [XMQTT] start.ps1 not found next to this script:
    echo         %SCRIPT%
    pause
    exit /b 1
)

rem Prefer PowerShell 7, fall back to Windows PowerShell 5.1
where pwsh >nul 2>&1
if %errorlevel%==0 (
    pwsh -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
)

if %errorlevel% neq 0 (
    echo.
    echo [XMQTT] Launch failed. See the messages above.
    pause
)

endlocal
