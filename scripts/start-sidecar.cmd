@echo off
rem VesktopClaudeBridge - start the sidecar by hand.
rem
rem An MCP client normally spawns its own sidecar, so you don't need this to use
rem the bridge. Use it when you want one running independently of any session,
rem or when you want to watch the log while debugging.
rem
rem --no-mcp is deliberate: stdio is a console here, not an MCP client, so the
rem MCP server would have nothing to talk to. This runs the websocket the plugin
rem dials plus the HTTP mirror, and nothing else.

setlocal
title VesktopClaudeBridge sidecar

rem The sidecar logs UTF-8; a console left on a legacy codepage turns every em
rem dash in a log line into mojibake. Scoped to this window, which then closes.
chcp 65001 >nul

set "SIDECAR=%~dp0..\sidecar"

if not exist "%SIDECAR%\dist\index.js" goto :nobuild

pushd "%SIDECAR%"
node dist\index.js --no-mcp %*
set "CODE=%ERRORLEVEL%"
popd

echo.
if "%CODE%"=="0" (echo Sidecar stopped.) else (echo Sidecar failed with exit code %CODE%.)
pause
exit /b %CODE%

:nobuild
echo Could not find "%SIDECAR%\dist\index.js".
echo.
echo Build it first, from the repo root:
echo     npm run install:sidecar ^&^& npm run build
echo.
pause
exit /b 1
