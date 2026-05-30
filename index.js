import { spawn } from 'child_process';
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';

const RENDER_PORT = process.env.PORT || '10000';

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

const toPolygon    = createProxyMiddleware({ target: 'http://localhost:8100', changeOrigin: false });
const toDispatcher = createProxyMiddleware({ target: 'http://localhost:3002', changeOrigin: false });
const toProxy      = createProxyMiddleware({ target: 'http://localhost:8080', changeOrigin: false });

// /health → dispatcher (:3002) com CORS
// O painel lê active_jobs e accounts que vêm do dispatcher/health
const CORS_ORIGINS = ['https://streamvault-admin.pages.dev', 'https://pixgo.qzz.io'];

function setCors(req, res) {
  const origin = req.headers.origin || '';
  if (CORS_ORIGINS.includes(origin) || !origin)
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
}

app.options('/health', (req, res) => { setCors(req, res); res.sendStatus(204); });
app.get('/health', async (req, res) => {
  setCors(req, res);
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
