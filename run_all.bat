@echo off
title RotoFox - 1-Click Launch Pad
color 0E

echo ====================================================
echo   RotoFox Developer Space - 1-Click Startup
echo ====================================================
echo.

:: Launch Backend Server
echo [INFO] Starting Backend Server in background...
start "RotoFox Backend Core" cmd /c "cd /d "%~dp0backend" && .venv\Scripts\python main.py"

:: Give backend a couple of seconds to bind to port 8000
timeout /t 2 /nobreak > nul

:: Launch Frontend Client
echo [INFO] Starting Frontend Dev Workspace...
start "RotoFox Frontend Workspace" cmd /c "cd /d "%~dp0frontend" && npm run dev"

echo.
echo [OK] Both processes have been spawned in separate terminal windows.
echo      - Backend Core running at: http://127.0.0.1:8000
echo      - Frontend Client running at: http://localhost:1420
echo.
pause
