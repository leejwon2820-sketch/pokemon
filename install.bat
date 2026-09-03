@echo off
cd /d "%~dp0server"
echo [1/2] Installing dependencies...
npm install
if errorlevel 1 goto :error
echo [2/2] Validating package...
npm test
if errorlevel 1 goto :error
echo.
echo Ready. Start with: npm start
pause
exit /b 0
:error
echo.
echo Installation or validation failed.
pause
exit /b 1
