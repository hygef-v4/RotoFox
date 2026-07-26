@echo off
title RotoFox - Backend Server
color 0A

REM Development launcher. Authentication is disabled so that a browser at
REM localhost:1420 can connect without the desktop shell injecting a token.
REM The packaged app always runs WITH authentication.

set "ROOT=%~dp0"
cd /d "%ROOT%backend" || (echo [ERROR] backend folder not found. & pause & exit /b 1)

echo ============================================
echo   RotoFox - Backend Server ^(development^)
echo ============================================
echo.

if not exist ".venv\Scripts\python.exe" (
    echo [ERROR] Virtual environment not found at backend\.venv
    echo.
    echo Create it with:
    echo   python -m venv .venv
    echo   .venv\Scripts\pip install -r requirements.txt
    echo.
    echo Or run setup_and_build.bat to do everything automatically.
    echo.
    pause
    exit /b 1
)

echo [OK] Virtual environment found
echo [OK] Starting on http://127.0.0.1:8000
echo.
echo Press Ctrl+C to stop.
echo.

.venv\Scripts\python.exe main.py --no-auth --reload

echo.
echo [INFO] Server stopped.
pause
