@echo off
title RotoFox - Developer Launcher
color 0E

set "ROOT=%~dp0"

echo ====================================================
echo   RotoFox - Developer Launcher
echo ====================================================
echo.

if not exist "%ROOT%backend\.venv\Scripts\python.exe" (
    echo [ERROR] Backend virtual environment not found.
    echo         Run setup_and_build.bat first.
    echo.
    pause
    exit /b 1
)

if not exist "%ROOT%frontend\node_modules" (
    echo [ERROR] Frontend dependencies not installed.
    echo         Run "npm install" in the frontend folder, or setup_and_build.bat.
    echo.
    pause
    exit /b 1
)

echo [INFO] Starting the backend...
REM --no-auth: the browser dev server has no way to receive a session token,
REM which only the packaged desktop shell can inject.
start "RotoFox Backend" cmd /c "cd /d "%ROOT%backend" && .venv\Scripts\python.exe main.py --no-auth --reload"

echo [INFO] Waiting for the backend to bind...
timeout /t 3 /nobreak > nul

echo [INFO] Starting the frontend dev server...
start "RotoFox Frontend" cmd /c "cd /d "%ROOT%frontend" && npm run dev"

echo.
echo [OK] Both processes launched in separate windows.
echo      Backend : http://127.0.0.1:8000
echo      Frontend: http://localhost:1420
echo.
echo Close those windows to stop the servers.
echo.
pause
