@echo off
echo Enviando arquivos para o VPS...
echo.

echo [1/10] server.js
scp C:\Users\PCHOME01\Desktop\squadfutbol\web\server.js root@187.127.27.236:/var/www/squadfutbol/web/server.js

echo [2/10] index.html
scp C:\Users\PCHOME01\Desktop\squadfutbol\web\public\index.html root@187.127.27.236:/var/www/squadfutbol/web/public/index.html

echo [3/10] login.html
scp C:\Users\PCHOME01\Desktop\squadfutbol\web\public\login.html root@187.127.27.236:/var/www/squadfutbol/web/public/login.html

echo [4/10] register.html
scp C:\Users\PCHOME01\Desktop\squadfutbol\web\public\register.html root@187.127.27.236:/var/www/squadfutbol/web/public/register.html

echo [5/10] subscribe.html
scp C:\Users\PCHOME01\Desktop\squadfutbol\web\public\subscribe.html root@187.127.27.236:/var/www/squadfutbol/web/public/subscribe.html

echo [6/10] connect-superbet.html
scp C:\Users\PCHOME01\Desktop\squadfutbol\web\public\connect-superbet.html root@187.127.27.236:/var/www/squadfutbol/web/public/connect-superbet.html

echo [7/10] src/auth/auth.js
scp C:\Users\PCHOME01\Desktop\squadfutbol\src\auth\auth.js root@187.127.27.236:/var/www/squadfutbol/src/auth/auth.js

echo [8/10] src/auth/database.js
scp C:\Users\PCHOME01\Desktop\squadfutbol\src\auth\database.js root@187.127.27.236:/var/www/squadfutbol/src/auth/database.js

echo [9/10] src/scrapers/superbet-placer.js
scp C:\Users\PCHOME01\Desktop\squadfutbol\src\scrapers\superbet-placer.js root@187.127.27.236:/var/www/squadfutbol/src/scrapers/superbet-placer.js

echo [10/11] src/auth/mercadopago.js
scp C:\Users\PCHOME01\Desktop\squadfutbol\src\auth\mercadopago.js root@187.127.27.236:/var/www/squadfutbol/src/auth/mercadopago.js

echo [11/12] Instalando Playwright Chromium (se necessario)...
ssh root@187.127.27.236 "cd /var/www/squadfutbol && npx playwright install chromium --with-deps 2>&1 | tail -5"

echo [12/12] Reiniciando PM2...
ssh root@187.127.27.236 "cd /var/www/squadfutbol && pm2 restart squadfutbol-web"

echo.
echo Deploy concluido!
pause
