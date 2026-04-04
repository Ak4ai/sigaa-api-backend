#!/bin/bash
set -e

echo "[deploy] Parando servidor..."
pkill -f "node server.js" || true
sleep 1

echo "[deploy] Git pull..."
cd ~/sigaa-api-backend-git
/usr/bin/git pull origin main

echo "[deploy] npm install..."
/usr/bin/npm install --production 2>&1 | tail -3

echo "[deploy] Iniciando servidor..."
cd ~/sigaa-api-backend-git
PORT=8080 nohup /usr/bin/node server.js >> ~/sigaa_server.log 2>&1 &
sleep 2
echo "[deploy] ✅ Deploy completo - servidor rodando"
