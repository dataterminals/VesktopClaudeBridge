@echo off
rem VesktopClaudeBridge - start the sidecar by hand.
rem
rem An MCP client normally spawns its own sidecar, so you don't need this to use
rem the bridge. Use it when you want one running independently of any session, or
rem when you want to watch the log while debugging.
rem
rem --no-mcp is deliberate: stdio is a console here, not an MCP client, so the MCP
rem server would have nothing to talk to. This runs the websocket the plugin dials
rem plus the HTTP mirror, and nothing else.
rem
rem The window stays put after the sidecar stops and offers to run it again, so
rem the shortcut is somewhere you can work rather than a thing that fires once and
rem vanishes before you have read it.

setlocal
title VesktopClaudeBridge sidecar

rem The sidecar logs UTF-8; a console left on a legacy codepage turns every em
rem dash in a log line into mojibake. Scoped to this window, which then closes.
chcp 65001 >nul

set "SIDECAR=%~dp0..\sidecar"

if not exist "%SIDECAR%\dist\index.js" goto :nobuild

pushd "%SIDECAR%"

:run
node dist\index.js --no-mcp %EXTRA% %*
set "CODE=%ERRORLEVEL%"
set "EXTRA="

echo.
if "%CODE%"=="3" goto :occupied
if "%CODE%"=="0" goto :stopped
goto :failed

rem Exit code 3: another sidecar already serves the bridge and this one stood
rem down. Nothing failed, so this is a choice rather than an error - the log
rem above names the process holding it.
rem 2>nul because `choice` reads the console directly and complains loudly if it
rem is ever handed redirected input. Any failure leaves errorlevel high, which
rem lands on the quit branch below - the safe way to fall over.
:occupied
choice /c RE /n /m "  [R] stop that one and serve from this window   [E] leave it alone and quit   > " 2>nul
if errorlevel 2 goto :done
echo.
set "EXTRA=--takeover"
goto :run

:stopped
echo Sidecar stopped.
choice /c RE /n /m "  [R] start it again   [E] quit   > " 2>nul
if errorlevel 2 goto :done
echo.
goto :run

:failed
echo Sidecar failed with exit code %CODE%.
choice /c RE /n /m "  [R] try again   [E] quit   > " 2>nul
if errorlevel 2 goto :done
echo.
goto :run

:done
popd
exit /b %CODE%

:nobuild
echo Could not find "%SIDECAR%\dist\index.js".
echo.
echo Build it first, from the repo root:
echo     npm run install:sidecar ^&^& npm run build
echo.
pause
exit /b 1
