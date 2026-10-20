@echo off
rem Double-click to start FlowCut. A video path can be passed too: FlowCut.cmd "C:\Videos\recording.mp4"
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo First start: installing FlowCut's dependencies...
  call npm install --no-audit --no-fund || (echo npm install failed & pause & exit /b 1)
)
start "" "node_modules\electron\dist\electron.exe" . %*
