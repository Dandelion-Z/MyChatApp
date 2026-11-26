#!/usr/bin/env bash
set -u
cd /e/MyChatApp

powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force }" >/dev/null 2>&1
sleep 2

cd /e/MyChatApp/server
DATABASE_URL='postgresql://mychatapp_user:333@localhost:5432/mychatapp_qa' npx tsx src/index.ts > ../.qa-server.log 2>&1 &
for _ in $(seq 1 40); do
  sleep 0.5
  if curl -s --max-time 1 http://127.0.0.1:3000/health | grep -q '"status":"ok"'; then
    echo "SERVER_READY"
    exit 0
  fi
done
echo "SERVER_FAILED"
tail -5 ../.qa-server.log
exit 1
