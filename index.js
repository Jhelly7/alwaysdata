// index.js — ponto de entrada único
// Importa os 3 apps, monta-os num único Express na porta do Render.
// Cada ficheiro exporta a sua app/server sem chamar .listen().

import express from 'express';
import { app as polygonApp }    from './server.js';
import { app as dispatcherApp } from './dispatcher.js';
// FIX: proxy.js desligado — Cloudflare redireciona /{jobId}/... directamente
// para a Release pública do GitHub (Single Redirects), sem passar pelo Render.

const PORT = process.env.PORT || '10000';

const CORS_ORIGINS = [
  'https://streamvault-admin.pages.dev',
  'https://pixgo.qzz.io',
  'https://digital.pixgo.frii.site',
];

const main = express();

// /health → dispatcher (tem active_jobs, accounts)
main.options('/health', (req, res) => {
  const origin = req.headers.origin || '';
  if (CORS_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  res.sendStatus(204);
});

main.get('/health', async (req, res) => {
  const origin = req.headers.origin || '';
  if (CORS_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  // Chamar directamente o router do dispatcherApp
  req.url = '/health';
  dispatcherApp(req, res);
});

// Rotas polygon
main.use('/polygon', polygonApp);
main.use('/tron',    polygonApp);

// Rotas dispatcher
main.use('/dispatch', dispatcherApp);
main.use('/webhook',  dispatcherApp);
main.use('/jobs',     dispatcherApp);
main.use('/status',   dispatcherApp);

// Catch-all — proxy desligado, devolve 404 (Cloudflare já não envia tráfego aqui)
main.use('/', (req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

main.listen(PORT, '0.0.0.0', () => {
  console.log(`[index] servidor unificado na porta ${PORT}`);
  console.log(`  /polygon/* /tron/*              → polygon-microservice`);
  console.log(`  /dispatch /webhook /jobs /status → dispatcher`);
  console.log(`  /*                               → 404 (proxy desligado)`);

  // Keep-alive unificado
  if (process.env.RENDER || process.env.KEEP_ALIVE === 'true') {
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
