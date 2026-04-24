@echo off
title PA-SAP Bridge
cd /d "%~dp0"
setlocal

echo.
echo  =========================================
echo   PA-SAP Bridge - Demarrage
echo  =========================================
echo.

set "SERVICE_CMD=npm run local:prod"
set "API_HEALTH_URL=http://localhost:3001/api/health"
set "WEB_URL=http://localhost:4173"

rem -- Ouvre un nouveau terminal avec la pile locale stabilisee (build + api + worker + web preview)
start "PA-SAP Bridge - Serveurs" cmd /k "%SERVICE_CMD%"

echo  Attente du demarrage de l'API...

:wait_api
timeout /t 2 /nobreak >nul
powershell -NoProfile -Command ^
  "try { $r = Invoke-WebRequest -UseBasicParsing '%API_HEALTH_URL%' -TimeoutSec 3; if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 400) { exit 0 } else { exit 1 } } catch { exit 1 }"
if %errorlevel% neq 0 goto wait_api

echo  API prete. Attente du front...

:wait_web
timeout /t 2 /nobreak >nul
powershell -NoProfile -Command ^
  "try { $r = Invoke-WebRequest -UseBasicParsing '%WEB_URL%' -TimeoutSec 3; if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 400) { exit 0 } else { exit 1 } } catch { exit 1 }"
if %errorlevel% neq 0 goto wait_web

echo  Front pret. Ouverture du navigateur...
start "" "%WEB_URL%"

echo  Fait. Vous pouvez fermer cette fenetre.
timeout /t 3 /nobreak >nul
