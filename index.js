// index.js — ponto de entrada único
import express from 'express';
import { app as polygonApp }              from './server.js';
import { app as dispatcherApp, accounts } from './dispatcher.js';
import { server as proxyServer }          from './proxy.js';

const PORT = process.env.PORT || '10000';

const CORS_ORIGINS = [
  'https://streamvault-admin.pages.dev',
  'https://pixgo.qzz.io',
  'https://digital.pixgo.frii.site',
];

function cors(req, res, next) {
  const origin = req.headers.origin || '';
  if (CORS_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, x-service-key');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

const main = express();
main.use(cors);
main.use(express.json({ limit: '1mb' }));

// ── GET /health — retorna formato do dispatcher (o que o index.html espera) ──
main.get('/health', (_req, res) => {
  const WORKFLOW_FILE = process.env.GH_WORKFLOW_FILE || 'process.yml';
  const WORKFLOW_REF  = process.env.GH_WORKFLOW_REF  || 'main';
  res.json({
    ok:          true,
    accounts:    accounts.length,
    active_jobs: accounts.reduce((s, a) => s + a.activeJobs, 0),
    workflow:    `${WORKFLOW_FILE}@${WORKFLOW_REF}`,
  });
});

// ── Dispatcher — antes do polygonApp porque polygonApp tem catch-all 404 ─────
main.use(dispatcherApp);

// ── Polygon + Tron — depois do dispatcher, restringido aos seus prefixos ──────
// O polygonApp tem `app.use((_req, res) => res.status(404).json({error:'Not Found'}))`
// no fim — se montado na raiz engole tudo. Montar apenas em /polygon e /tron.
// req.originalUrl preserva o path completo para as rotas internas funcionarem.
main.use(['/polygon', '/tron'], (req, res, next) => {
  req.url = req.originalUrl;
  polygonApp(req, res, next);
});

// ── Proxy — catch-all /{jobId}/... ───────────────────────────────────────────
main.use((req, res) => {
  proxyServer.emit('request', req, res);
});

main.listen(PORT, '0.0.0.0', () => {
  console.log(`[index] servidor unificado na porta ${PORT}`);
  console.log(`  /health                          → dispatcher health`);
  console.log(`  /dispatch /webhook /jobs /status → dispatcher`);
  console.log(`  /polygon/* /tron/*               → polygon-microservice`);
  console.log(`  /*                               → proxy`);

  if (process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE === 'true') {
    const selfUrl = process.env.RENDER_EXTERNAL_URL
      ? `${process.env.RENDER_EXTERNAL_URL}/health`
      : `http://localhost:${PORT}/health`;

    setInterval(async () => {
      try {
        await fetch(selfUrl, { signal: AbortSignal.timeout(5000) });
        console.log(`[keep-alive] ping → ${new Date().toISOString()}`);
      } catch (e) {
        console.warn(`[keep-alive] falhou: ${e.message}`);
      }
    }, 13 * 60 * 1000);

    console.log(`  keep-alive → ${selfUrl}`);
  }
});
