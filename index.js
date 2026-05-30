// index.js — arranca os 3 serviços na mesma instância Render
// Nenhum ficheiro original é alterado.

import { spawn } from 'child_process';
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';

const RENDER_PORT = process.env.PORT || '10000';

// Captura erros de porta em uso a nível global
process.on('uncaughtException', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[index] AVISO: porta já em uso — ${err.message}`);
  } else {
    console.error('[index] Erro não capturado:', err);
    process.exit(1);
  }
});

// ── 1. polygon-microservice na porta 8100 ────────────────────────────────────
process.env.PORT = '8100';
await import('./server.js');

// ── 2. streamvault-dispatcher na porta 3002 ──────────────────────────────────
process.env.PORT = '3002';
await import('./dispatcher.js');

// ── 3. streamvault-proxy via start.sh (proxy.js + cloudflared) ───────────────
process.env.PORT = '8080';
const proxyProc = spawn('sh', ['./start.sh'], {
  env: { ...process.env },
  stdio: 'inherit',
});
proxyProc.on('exit', (code) => {
  console.error(`[index] start.sh saiu com código ${code}`);
  process.exit(1);
});

// ── 4. Router na porta pública do Render ─────────────────────────────────────
process.env.PORT = RENDER_PORT;

const app = express();

const toPolygon    = createProxyMiddleware({ target: 'http://localhost:8100', changeOrigin: false });
const toDispatcher = createProxyMiddleware({ target: 'http://localhost:3002', changeOrigin: false });
const toProxy      = createProxyMiddleware({ target: 'http://localhost:8080', changeOrigin: false });

// /health agregado — responde com dados dos 3 serviços
app.get('/health', async (_req, res) => {
  const [polygon, dispatcher] = await Promise.all([
    fetch('http://localhost:8100/health').then(r => r.json()).catch(() => ({ ok: false })),
    fetch('http://localhost:3002/health').then(r => r.json()).catch(() => ({ ok: false })),
  ]);
  res.json({
    ok:          polygon.ok && dispatcher.ok,
    accounts:    dispatcher.accounts    ?? 0,
    active_jobs: dispatcher.active_jobs ?? 0,
    workflow:    dispatcher.workflow    ?? null,
    polygon:     polygon.ok,
    network:     polygon.network        ?? null,
    ts:          new Date().toISOString(),
  });
});

app.use('/polygon',  toPolygon);
app.use('/tron',     toPolygon);
app.use('/dispatch', toDispatcher);
app.use('/webhook',  toDispatcher);
app.use('/jobs',     toDispatcher);
app.use('/status',   toDispatcher);
app.use('/',         toProxy);

app.listen(RENDER_PORT, '0.0.0.0', () => {
  console.log(`[index] router na porta ${RENDER_PORT}`);
  console.log('  /health          → agregado (polygon + dispatcher)');
  console.log('  /polygon/* /tron/* → :8100');
  console.log('  /dispatch /webhook /jobs/* /status → :3002');
  console.log('  /* → :8080 (proxy + cloudflared)');
});
