@echo off
chcp 65001 >nul
title Audio2Text — 环境安装

echo ============================================
echo   Audio2Text 依赖安装脚本
echo ============================================
echo.

python --version >nul 2>&1
if errorlevel 1 (
    echo [错误] 未检测到 Python。
    echo.
    echo 请先安装 Python 3.9 或更高版本：
    echo   https://www.python.org/downloads/
    echo.
    echo 安装时请勾选 "Add Python to PATH"
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('python --version 2^>^&1') do set PYVER=%%i
echo [OK] 检测到 %PYVER%
echo.

echo [1/3] 升级 pip...
python -m pip install --upgrade pip --quiet
echo [OK] pip 已是最新版
echo.

echo [2/3] 安装 faster-whisper（语音转文字，约 200MB）...
python -m pip install faster-whisper
if errorlevel 1 (
    echo [错误] faster-whisper 安装失败，请检查网络或手动运行：
    echo   pip install faster-whisper
    pause
    exit /b 1
)
echo [OK] faster-whisper 安装完成
echo.

echo [3/3] 安装 demucs（人声分离，可选，约 100MB）...
python -m pip install demucs
if errorlevel 1 (
    echo [警告] demucs 安装失败（不影响基本转写功能，仅影响"有背景音乐"选项）
) else (
    echo [OK] demucs 安装完成
)
echo.

echo ============================================
echo   安装完成！
echo ============================================
echo.
echo 提示：默认使用 CPU 运行。如需 GPU 加速（NVIDIA 显卡），请运行：
echo.
echo   pip install torch --index-url https://download.pytorch.org/whl/cu121
echo.
echo 现在可以双击 Audio2Text.exe 开始使用。
echo.
pause
