#!/bin/sh
echo "[start] A iniciar proxy..."
node proxy.js &
NODE_PID=$!

# Aguardar o proxy estar pronto antes de ligar o tunnel
sleep 2

if [ -n "$CLOUDFLARE_TUNNEL_TOKEN" ]; then
  echo "[start] A ligar tunnel cloudflared..."
  cloudflared tunnel --no-autoupdate run \
    --token "$CLOUDFLARE_TUNNEL_TOKEN" \
    --url "http://localhost:${PORT:-8080}" &
  echo "[start] Tunnel iniciado (url: http://localhost:${PORT:-8080})"
else
  echo "[start] CLOUDFLARE_TUNNEL_TOKEN não definido — tunnel ignorado"
fi

wait $NODE_PID