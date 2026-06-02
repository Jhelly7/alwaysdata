#!/bin/sh
APP_PORT="${PORT:-10000}"

echo "[start] A iniciar servidor unificado (porta ${APP_PORT})..."
node index.js &
NODE_PID=$!

# Aguardar a porta estar realmente activa (até 30s) — elimina race condition
echo "[start] A aguardar porta ${APP_PORT}..."
i=0
while [ $i -lt 30 ]; do
  nc -z 127.0.0.1 "$APP_PORT" 2>/dev/null && break
  sleep 1
  i=$((i + 1))
done

if ! nc -z 127.0.0.1 "$APP_PORT" 2>/dev/null; then
  echo "[start] ERRO: servidor não abriu porta ${APP_PORT} em 30s — a abortar"
  kill "$NODE_PID" 2>/dev/null
  exit 1
fi
echo "[start] Porta ${APP_PORT} activa."

if [ -n "$CLOUDFLARE_TUNNEL_TOKEN" ]; then
  echo "[start] A ligar tunnel cloudflared → http://localhost:${APP_PORT}..."
  cloudflared tunnel --no-autoupdate run \
    --token "$CLOUDFLARE_TUNNEL_TOKEN" \
    --url "http://localhost:${APP_PORT}" &
  echo "[start] Tunnel iniciado."
else
  echo "[start] CLOUDFLARE_TUNNEL_TOKEN não definido — tunnel ignorado"
fi

wait $NODE_PID
