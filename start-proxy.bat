@echo off
cd /d "%~dp0"
echo Starting EditPro backend on port 3847...
start "EditPro" cmd /c "node server.js"
timeout /t 2 /nobreak >nul
echo Starting Caddy reverse proxy on port 80...
echo Open http://localhost/editpro/
caddy run
