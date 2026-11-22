@echo off
chcp 65001 >nul
title Locat Monitor - Local Desktop App
echo ========================================================
echo   Locat Monitor - تشغيل التطبيق محلياً بدون استضافة
echo ========================================================
echo.
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo [!] Node.js غير مثبت على جهازك. يرجى تثبيت Node.js LTS من https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules (
  echo [*] جاري تثبيت الحزم المطلوبة لأول مرة فقط...
  call npm install
)
echo [*] جاري تشغيل محرك التطبيق والواتساب محلياً على المنفذ 3000...
start "" cmd /c "timeout /t 4 /nobreak >nul && (start msedge --app=http://localhost:3000 || start chrome --app=http://localhost:3000 || start http://localhost:3000)"
call npm run dev
pause
