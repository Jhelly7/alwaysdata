// index.js — ponto de entrada único
import express from 'express';
import { app as polygonApp }                        from './server.js';
import { app as dispatcherApp, accounts, dispatcherInit } from './dispatcher.js';
import { server as proxyServer }                    from './proxy.js';

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

  // ── Inicializar dispatcher (watchdog + keep-alive) ──────────────────────────
  // CRÍTICO: sem esta chamada o watchdog nunca arranca e a fila fica presa
  // após qualquer reinício do Render (running=0 mas webhook nunca chega).
  dispatcherInit(PORT);
});
