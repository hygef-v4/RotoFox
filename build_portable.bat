@echo off
title RotoFox - Portable Distribution Builder
color 0B

echo ====================================================
echo   RotoFox Portable Distribution Builder
echo ====================================================
echo.

set "PROJECT_ROOT=%~dp0"
set "DIST_DIR=%PROJECT_ROOT%dist\RotoFox-Portable"
set "BACKEND_DIST=%PROJECT_ROOT%backend\dist\rotofox-backend"
set "FRONTEND_DIR=%PROJECT_ROOT%frontend"
set "TAURI_RELEASE=%FRONTEND_DIR%\src-tauri\target\release"
set "CHECKPOINTS_SRC=%PROJECT_ROOT%backend\checkpoints"

:: ============================================================
:: Step 1: Build Tauri Desktop App (lightweight, no heavy resources)
:: ============================================================
echo [1/4] Building Tauri Desktop App...
cd /d "%FRONTEND_DIR%"
call npm run tauri build
if errorlevel 1 (
    echo [ERROR] Tauri build failed!
    pause
    exit /b 1
)

:: ============================================================
:: Step 2: Assemble Portable Folder
:: ============================================================
echo.
echo [2/4] Assembling portable distribution...

:: Clean old dist
if exist "%DIST_DIR%" (
    echo Cleaning old portable dist...
    rmdir /s /q "%DIST_DIR%"
)
mkdir "%DIST_DIR%"

:: Copy the Tauri app exe (the productName becomes the exe name)
echo Copying RotoFox.exe...
copy /y "%TAURI_RELEASE%\frontend.exe" "%DIST_DIR%\RotoFox.exe" >nul

:: Copy the sidecar exe (Tauri looks for this specific name)
echo Copying sidecar backend...
copy /y "%TAURI_RELEASE%\rotofox-backend.exe" "%DIST_DIR%\rotofox-backend-x86_64-pc-windows-msvc.exe" >nul

:: Copy _internal folder (PyTorch, CUDA DLLs, all Python dependencies)
echo Copying backend runtime (_internal)... This may take a few minutes...
xcopy /e /i /h /y "%BACKEND_DIST%\_internal" "%DIST_DIR%\_internal" >nul

:: ============================================================
:: Step 3: Copy AI Model Checkpoints
:: ============================================================
echo.
echo [3/4] Copying AI model checkpoints...

mkdir "%DIST_DIR%\checkpoints" 2>nul

if exist "%CHECKPOINTS_SRC%\matanyone2.pth" (
    echo   - matanyone2.pth
    copy /y "%CHECKPOINTS_SRC%\matanyone2.pth" "%DIST_DIR%\checkpoints\" >nul
)

:: Copy all SAM 2 models that exist
for %%f in (sam2.1_hiera_tiny.pt sam2.1_hiera_small.pt sam2.1_hiera_base_plus.pt sam2.1_hiera_large.pt) do (
    if exist "%CHECKPOINTS_SRC%\%%f" (
        echo   - %%f
        copy /y "%CHECKPOINTS_SRC%\%%f" "%DIST_DIR%\checkpoints\" >nul
    )
)

:: Copy SAM 2 config files (needed by SAM 2 at runtime)
if exist "%PROJECT_ROOT%backend\sam2_src\sam2\configs" (
    echo   - SAM 2 config files
    xcopy /e /i /h /y "%PROJECT_ROOT%backend\sam2_src\sam2\configs" "%DIST_DIR%\configs" >nul
)

:: Create a default config pointing to the local checkpoints dir
echo {"checkpoints_dir": null} > "%DIST_DIR%\rotofox_config.json"

:: ============================================================
:: Step 4: Create Launcher
:: ============================================================
echo.
echo [4/4] Creating launcher...

(
echo @echo off
echo title RotoFox
echo echo Starting RotoFox...
echo echo.
echo cd /d "%%~dp0"
echo start "" "RotoFox.exe"
) > "%DIST_DIR%\Start RotoFox.bat"

:: ============================================================
:: Summary
:: ============================================================
echo.
echo ====================================================
echo   BUILD COMPLETE!
echo ====================================================
echo.
echo   Portable distribution created at:
echo   %DIST_DIR%
echo.
echo   Contents:
echo   - RotoFox.exe              (Desktop App)
echo   - rotofox-backend-*.exe    (AI Backend Sidecar)
echo   - _internal\               (Python + PyTorch + CUDA runtime)
echo   - checkpoints\             (AI Models)
echo   - Start RotoFox.bat        (Launcher)
echo.
echo   To distribute:
echo   1. Compress the "RotoFox-Portable" folder with 7-Zip
echo   2. Share the .7z archive
echo   3. Users extract and double-click "Start RotoFox.bat"
echo.
echo ====================================================
pause
