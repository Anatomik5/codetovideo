@echo off
REM Double-click start-app.vbs for a window-free launch; this .bat is the same thing with a console.
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies - first run only...
  call npm install
)
call npm run app
