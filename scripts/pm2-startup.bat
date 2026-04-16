@echo off
timeout /t 10 /nobreak > nul
cd /d C:\Users\PCHOME01\Desktop\squadfutbol
pm2 resurrect 2>nul
pm2 start ecosystem.config.cjs --update-env 2>nul
pm2 save 2>nul
