@echo off
title PA-SAP Bridge
cd /d "%~dp0"

echo.
echo  =========================================
echo   PA-SAP Bridge - Demarrage
echo  =========================================
echo.

rem -- Ouvre un nouveau terminal avec les serveurs (API + worker + web)
start "PA-SAP Bridge - Serveurs" cmd /k "npm run local:dev"

echo  Attente du demarrage de l'API...

:wait
timeout /t 2 /nobreak >nul
curl -s http://localhost:3001/api/health >nul 2>&1
if %errorlevel% neq 0 goto wait

echo  API prete. Ouverture du navigateur...
start http://localhost:5173

echo  Fait. Vous pouvez fermer cette fenetre.
timeout /t 3 /nobreak >nul
