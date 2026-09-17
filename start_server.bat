@echo off
title OPS Billing Auto Server
color 0A
cd /d "%~dp0"

echo ===================================================
echo           OPS Billing Auto Server Launcher
echo ===================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH!
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b
)

if not exist "node_modules\" (
    echo [INFO] Installing dependencies...
    call npm install
)

echo [INFO] Starting OPS Billing Server (Auto-Reload enabled)...
echo [INFO] Open http://localhost:3000 in your browser
echo.

timeout /t 2 >nul
start "" http://localhost:3000
node --watch-path=server.js server.js

pause
