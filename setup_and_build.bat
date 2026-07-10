@echo off
title RotoFox - Setup ^& Build
color 0B

echo ====================================================
echo   RotoFox - Full Setup and Build Script
echo ====================================================
echo.

echo [1/4] Thiet lap moi truong Backend (Python)...
cd backend
if not exist ".venv" (
    echo Dang tao Virtual Environment...
    python -m venv .venv
)
call .venv\Scripts\activate

echo Dang cai dat thu vien Python...
pip install -r requirements.txt

echo Dang cai dat kho SAM 2...
python scripts\setup_sam2.py

echo.
echo [2/4] Tai toan bo model AI...
python scripts\setup_models.py

echo.
echo [3/4] Dong goi Backend thanh file doc lap...
python scripts\package_backend.py

echo.
echo [4/4] Thiet lap Frontend va Build Desktop App...
cd ..\frontend
echo Dang cai dat thu vien Node.js...
call npm install

echo Dang build Tauri Desktop App...
call npm run tauri build

echo.
echo ====================================================
echo   HOAN THANH SETUP VA BUILD!
echo   Ban co the tim thay file cai dat (App) tai:
echo   frontend\src-tauri\target\release\
echo ====================================================
pause
