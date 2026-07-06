@echo off
title RotoFox - Backend Server
color 0A

echo ============================================
echo   RotoFox - Backend Server
echo ============================================
echo.

:: Change to backend directory
cd /d "%~dp0backend"

:: Check if .venv exists
if not exist ".venv\Scripts\python.exe" (
    echo [ERROR] Virtual environment not found at backend\.venv
    echo Please run: python -m venv .venv
    echo Then install dependencies: .venv\Scripts\pip install -r requirements.txt
    echo.
    pause
    exit /b 1
)

echo [OK] Virtual environment found
echo [OK] Starting backend server on http://127.0.0.1:8000
echo.
echo Press Ctrl+C to stop the server.
echo.

:: Run backend
.venv\Scripts\python main.py

echo.
echo [INFO] Server stopped.
pause
