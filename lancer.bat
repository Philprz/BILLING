@echo off
title PA-SAP Bridge
cd /d "%~dp0"
setlocal

echo.
echo  =========================================
echo   PA-SAP Bridge - Demarrage
echo  =========================================
echo.

set "API_HEALTH_URL=http://localhost:3002/api/health"
set "WEB_URL=http://localhost:4173"

rem -- Build packages partages (prerequis)
echo  [1/6] Build packages/shared...
call npm run build -w packages/shared
if %errorlevel% neq 0 (
  echo.
  echo  ERREUR : Build packages/shared echoue ^(code %errorlevel%^).
  pause
  exit /b 1
)

echo  [2/6] Build packages/database...
call npm run build -w packages/database
if %errorlevel% neq 0 (
  echo.
  echo  ERREUR : Build packages/database echoue ^(code %errorlevel%^).
  pause
  exit /b 1
)

rem -- Build applications
echo  [3/6] Build API...
call npm run build -w apps/api
if %errorlevel% neq 0 (
  echo.
  echo  ERREUR : Build API echoue ^(code %errorlevel%^).
  pause
  exit /b 1
)

echo  [4/6] Build Worker...
call npm run build -w apps/worker
if %errorlevel% neq 0 (
  echo.
  echo  ERREUR : Build Worker echoue ^(code %errorlevel%^).
  pause
  exit /b 1
)

echo  [5/6] Build Web...
call npm run build -w apps/web
if %errorlevel% neq 0 (
  echo.
  echo  ERREUR : Build Web echoue ^(code %errorlevel%^).
  pause
  exit /b 1
)

rem -- Arret propre puis redemarrage PM2
echo  [6/6] Demarrage PM2...
call pm2 delete billing-api billing-worker billing-web >nul 2>&1
call pm2 start ecosystem.config.js
if %errorlevel% neq 0 (
  echo.
  echo  ERREUR : PM2 n'a pas pu demarrer ^(code %errorlevel%^).
  call pm2 logs --lines 20 --nostream
  pause
  exit /b 1
)

rem -- Attente API (max 60s)
echo.
echo  Attente de l'API...
set /a TRIES=0
:wait_api
set /a TRIES+=1
if %TRIES% gtr 30 (
  echo.
  echo  ERREUR : L'API ne repond pas apres 60s.
  call pm2 logs billing-api --lines 30 --nostream
  pause
  exit /b 1
)
timeout /t 2 /nobreak >nul
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing '%API_HEALTH_URL%' -TimeoutSec 3; if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 400) { exit 0 } else { exit 1 } } catch { exit 1 }"
if %errorlevel% neq 0 goto wait_api

rem -- Attente Web (max 30s)
echo  API prete. Attente du front...
set /a TRIES=0
:wait_web
set /a TRIES+=1
if %TRIES% gtr 15 (
  echo.
  echo  ERREUR : Le frontend ne repond pas apres 30s.
  call pm2 logs billing-web --lines 30 --nostream
  pause
  exit /b 1
)
timeout /t 2 /nobreak >nul
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing '%WEB_URL%' -TimeoutSec 3; if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 400) { exit 0 } else { exit 1 } } catch { exit 1 }"
if %errorlevel% neq 0 goto wait_web

echo.
echo  =========================================
echo   Tous les services sont demarres.
echo  =========================================
echo.
call pm2 status
echo.
echo  Acces local : %WEB_URL%
echo.
start "" "%WEB_URL%"
pause
