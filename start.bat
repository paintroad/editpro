@echo off
cd /d "%~dp0"
echo Starting EditPro...
echo Direct URL:  http://localhost:3847/editpro/
echo Proxy URL:   http://localhost/editpro/  (requires: caddy run)
node server.js
