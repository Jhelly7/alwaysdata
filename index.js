// index.js — arranca os 3 serviços na mesma instância Render
// Nenhum ficheiro original é alterado.

import { spawn } from 'child_process';
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';

const RENDER_PORT = process.env.PORT || '10000';

// Captura erros de porta em uso a nível global — evita crash do processo inteiro
// quando o Render reinicia e a porta anterior ainda não foi libertada
process.on('uncaughtException', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[index] AVISO: porta já em uso — ${err.message}`);
    // Não faz process.exit() — deixa os outros serviços continuarem
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

app.use('/health',   toPolygon);
app.use('/polygon',  toPolygon);
app.use('/tron',     toPolygon);
app.use('/dispatch', toDispatcher);
app.use('/webhook',  toDispatcher);
app.use('/jobs',     toDispatcher);
app.use('/status',   toDispatcher);
app.use('/',         toProxy);

app.listen(RENDER_PORT, '0.0.0.0', () => {
  console.log(`[index] router na porta ${RENDER_PORT}`);
  console.log('  /polygon/* /tron/* /health → :8100');
  console.log('  /dispatch /webhook /jobs/* /status → :3002');
  console.log('  /* → :8080 (proxy + cloudflared)');
});
