// index.js — arranca os 3 serviços na mesma instância Render
//
// Nenhum ficheiro original é alterado.
//
// Estratégia:
//   - polygon + dispatcher: importados directamente (só têm server.js/dispatcher.js)
//   - proxy: arrancado via start.sh (que inicia proxy.js + cloudflared tunnel)
//   - Cada import lê process.env.PORT no momento do import — definimos antes de cada um

import { spawn } from 'child_process';

const RENDER_PORT = process.env.PORT || '10000';

// ── 1. polygon-microservice na porta 8100 ────────────────────────────────────
process.env.PORT = '8100';
await import('./server.js');

// ── 2. streamvault-dispatcher na porta 3002 ──────────────────────────────────
process.env.PORT = '3002';
await import('./dispatcher.js');

// ── 3. streamvault-proxy via start.sh (proxy.js + cloudflared) ───────────────
process.env.PORT = '8080';
const proxyProc = spawn('sh', ['./start.sh'], {
  env: { ...process.env },   // herda todas as env vars incluindo CLOUDFLARE_TUNNEL_TOKEN
  stdio: 'inherit',          // logs do proxy aparecem no mesmo stdout do Render
});
proxyProc.on('exit', (code) => {
  console.error(`[index] start.sh saiu com código ${code} — a reiniciar...`);
  process.exit(1); // Render reinicia o serviço automaticamente
});

// ── 4. Router na porta pública do Render ─────────────────────────────────────
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';

process.env.PORT = RENDER_PORT;

const app = express();

const toPolygon    = createProxyMiddleware({ target: 'http://localhost:8100', changeOrigin: false });
const toDispatcher = createProxyMiddleware({ target: 'http://localhost:3002', changeOrigin: false });
const toProxy      = createProxyMiddleware({ target: 'http://localhost:8080', changeOrigin: false });

app.use('/health',   toPolygon);
app.use('/polygon',  toPolygon);
app.use('/tron',     toPolygon);
app.use('/dispatch', toDispatcher);
app.use('/webhook',  toDispatcher);
app.use('/jobs',     toDispatcher);
app.use('/status',   toDispatcher);
app.use('/',         toProxy);   // /{jobId}/... apanhado pelo proxy

app.listen(RENDER_PORT, '0.0.0.0', () => {
  console.log(`[index] router na porta ${RENDER_PORT}`);
  console.log('  /polygon/* /tron/* /health → :8100');
  console.log('  /dispatch /webhook /jobs/* /status → :3002');
  console.log('  /* → :8080 (proxy + cloudflared)');
});