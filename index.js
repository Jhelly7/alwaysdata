// index.js — ponto de entrada único
import express from 'express';
import { app as polygonApp }    from './server.js';
import { app as dispatcherApp, accounts } from './dispatcher.js';
import { server as proxyServer } from './proxy.js';

const PORT = process.env.PORT || '10000';

const CORS_ORIGINS = [
  'https://streamvault-admin.pages.dev',
  'https://pixgo.qzz.io',
  'https://digital.pixgo.frii.site',
];

// ── CORS global — antes de tudo ───────────────────────────────────────────────
// O dispatcher.js e o server.js têm CORS próprio mas ao serem montados como
// sub-apps o Express não garante que os seus middlewares corram para OPTIONS
// vindos do main. Por isso gerimos CORS aqui centralmente.
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

// ── GET /health — explícito antes de qualquer sub-app ────────────────────────
// O polygonApp também tem GET /health (retorna {service, network, ...}) e seria
// o primeiro a responder por estar montado antes do dispatcher.
// Esta rota garante que /health retorna SEMPRE o formato do dispatcher:
// { ok, accounts, active_jobs, workflow } — que é o que o index.html verifica.
// Usa o array `accounts` exportado do dispatcher.js para ter active_jobs real.
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

// ── Polygon + Tron (server.js) ────────────────────────────────────────────────
// server.js regista as rotas com o path completo (/polygon/derive, /tron/derive)
// → tem de ser montado na raiz, NÃO em main.use('/polygon', ...)
// que faria strip do prefixo e as rotas nunca seriam encontradas.
main.use(polygonApp);

// ── Dispatcher (dispatcher.js) ────────────────────────────────────────────────
// Mesmo motivo: rotas /dispatch, /webhook, /jobs, /status, /health
// estão registadas com o path completo dentro do dispatcherApp.
main.use(dispatcherApp);

// ── Proxy — catch-all para /{jobId}/... ───────────────────────────────────────
// Deve ficar DEPOIS do dispatcher para não interceptar /health etc.
// O proxy.js exporta um http.Server nativo — emit('request') é a forma
// correcta de o integrar num Express sem o reescrever.
main.use((req, res) => {
  proxyServer.emit('request', req, res);
});

// ── Arranque ──────────────────────────────────────────────────────────────────
main.listen(PORT, '0.0.0.0', () => {
  console.log(`[index] servidor unificado na porta ${PORT}`);
  console.log(`  /polygon/* /tron/*              → polygon-microservice (server.js)`);
  console.log(`  /dispatch /webhook /jobs /status /health → dispatcher (dispatcher.js)`);
  console.log(`  /*                               → proxy (proxy.js)`);

  // Keep-alive — um único ping centralizado (evita os 3 keep-alives paralelos
  // que existiam quando cada ficheiro corria standalone)
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
