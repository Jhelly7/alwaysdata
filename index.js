import { spawn } from 'child_process';
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';

// Guardar e limpar o PORT do Render ANTES de qualquer import
// Assim nenhum serviço consegue escutar na porta pública acidentalmente
const RENDER_PORT = process.env.PORT || '10000';
delete process.env.PORT;

process.on('uncaughtException', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[index] AVISO: porta já em uso — ${err.message}`);
  } else {
    console.error('[index] Erro não capturado:', err);
    process.exit(1);
  }
});

process.env.PORT = '8100';
await import('./server.js');

process.env.PORT = '3002';
await import('./dispatcher.js');

process.env.PORT = '8080';
const proxyProc = spawn('sh', ['./start.sh'], {
  env: { ...process.env },
  stdio: 'inherit',
});
proxyProc.on('exit', (code) => {
  console.error(`[index] start.sh saiu com código ${code}`);
  process.exit(1);
});

process.env.PORT = RENDER_PORT;

const app = express();

const CORS_ORIGINS = [
  'https://streamvault-admin.pages.dev',
  'https://pixgo.qzz.io',
  'https://digital.pixgo.frii.site',
];

function ensureCors(proxyRes, req) {
  const origin = req.headers.origin || '';
  if (CORS_ORIGINS.includes(origin)) {
    proxyRes.headers['access-control-allow-origin'] = origin;
    proxyRes.headers['access-control-allow-methods'] = 'GET, POST, DELETE, OPTIONS';
    proxyRes.headers['access-control-allow-headers'] = 'Content-Type, x-api-key, x-service-key';
  }
}

const toPolygon    = createProxyMiddleware({ target: 'http://localhost:8100', changeOrigin: false, on: { proxyRes: ensureCors } });
const toDispatcher = createProxyMiddleware({ target: 'http://localhost:3002', changeOrigin: false, on: { proxyRes: ensureCors } });
const toProxy      = createProxyMiddleware({ target: 'http://localhost:8080', changeOrigin: false, on: { proxyRes: ensureCors } });

app.options('/health', (req, res) => {
  const origin = req.headers.origin || '';
  if (CORS_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  res.sendStatus(204);
});

app.get('/health', async (req, res) => {
  const origin = req.headers.origin || '';
  if (CORS_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  try {
    const r = await fetch('http://localhost:3002/health');
    const d = await r.json();
    res.json(d);
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
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
});
