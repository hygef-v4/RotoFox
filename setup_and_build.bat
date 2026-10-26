@echo off
setlocal enabledelayedexpansion
title RotoFox - Setup and Build
color 0B

REM ============================================================
REM  Fully automated setup and build.
REM
REM  Previously this script used a relative "cd backend" (breaking whenever it
REM  was launched from any directory other than the project root), called
REM  setup_models.py which blocks on input() so the build hung forever, and
REM  never checked errorlevel so a failed pip install carried on silently until
REM  a later step failed with an unrelated message.
REM ============================================================

set "ROOT=%~dp0"
set "BACKEND=%ROOT%backend"
set "FRONTEND=%ROOT%frontend"
set "VENV_PY=%BACKEND%\.venv\Scripts\python.exe"

echo ====================================================
echo   RotoFox - Full Setup and Build
echo ====================================================
echo.

REM ── 1. Python environment ──────────────────────────────────
echo [1/5] Setting up the Python backend environment...
cd /d "%BACKEND%" || (echo [ERROR] backend folder not found at %BACKEND% & goto :fail)

if not exist ".venv\Scripts\python.exe" (
    echo       Creating virtual environment...
    python -m venv .venv
    if errorlevel 1 (echo [ERROR] Could not create the virtual environment. Is Python 3.10+ on PATH? & goto :fail)
)

echo       Upgrading pip...
"%VENV_PY%" -m pip install --upgrade pip --quiet
if errorlevel 1 (echo [ERROR] pip upgrade failed. & goto :fail)

echo       Installing PyTorch with CUDA...
REM Installed first and explicitly: a plain "pip install torch" resolves the
REM CPU-only wheel on Windows, which runs 20-50x slower.
"%VENV_PY%" -m pip install "torch>=2.5.1" "torchvision>=0.20.1" --index-url https://download.pytorch.org/whl/cu126
if errorlevel 1 (
    echo [WARN] CUDA 12.6 build failed. Trying CUDA 12.1...
    "%VENV_PY%" -m pip install "torch>=2.5.1" "torchvision>=0.20.1" --index-url https://download.pytorch.org/whl/cu121
)
if errorlevel 1 (
    echo [WARN] CUDA build failed. Falling back to the CPU build ^(inference will be slow^).
    "%VENV_PY%" -m pip install "torch>=2.5.1" "torchvision>=0.20.1"
    if errorlevel 1 (echo [ERROR] Could not install PyTorch. & goto :fail)
)

echo       Installing the remaining dependencies...
"%VENV_PY%" -m pip install -r requirements-dev.txt
if errorlevel 1 (echo [ERROR] Dependency installation failed. & goto :fail)

REM ── 2. SAM 2 ───────────────────────────────────────────────
echo.
echo [2/5] Installing the SAM 2 framework...
"%VENV_PY%" scripts\setup_sam2.py
if errorlevel 1 (echo [ERROR] SAM 2 setup failed. & goto :fail)

REM ── 3. Model weights ───────────────────────────────────────
echo.
echo [3/5] Downloading AI models ^(recommended variant for this machine^)...
"%VENV_PY%" scripts\setup_models.py --yes
if errorlevel 1 (
    echo [WARN] One or more downloads failed. You can retry from the Model Hub in the app.
)

REM ── 4. Package the backend ─────────────────────────────────
echo.
echo [4/5] Packaging the backend into a standalone sidecar...
"%VENV_PY%" scripts\package_backend.py
if errorlevel 1 (echo [ERROR] Backend packaging failed. & goto :fail)

REM ── 5. Build the desktop app ───────────────────────────────
echo.
echo [5/5] Building the desktop application...
cd /d "%FRONTEND%" || (echo [ERROR] frontend folder not found at %FRONTEND% & goto :fail)

echo       Installing Node dependencies...
call npm install
if errorlevel 1 (echo [ERROR] npm install failed. Is Node.js 18+ installed? & goto :fail)

echo       Building the Tauri bundle...
call npm run tauri build
if errorlevel 1 (echo [ERROR] Tauri build failed. & goto :fail)

echo.
echo ====================================================
echo   BUILD COMPLETE
echo ====================================================
echo.
echo   Installer:
echo   %FRONTEND%\src-tauri\target\release\bundle\nsis\
echo.
echo   Standalone executable:
echo   %FRONTEND%\src-tauri\target\release\
echo.
cd /d "%ROOT%"
pause
exit /b 0

:fail
echo.
echo ====================================================
echo   BUILD FAILED - see the error above
echo ====================================================
cd /d "%ROOT%"
pause
exit /b 1
