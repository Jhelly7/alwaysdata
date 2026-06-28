// index.js — ponto de entrada único
// Importa os 3 apps, monta-os num único Express na porta do Render.
// Cada ficheiro exporta a sua app/server sem chamar .listen().

import express from 'express';
import { app as polygonApp }    from './server.js';
import { app as dispatcherApp } from './dispatcher.js';
// FIX: proxy.js desligado — Cloudflare redireciona /{jobId}/... directamente
// para a Release pública do GitHub (Single Redirects), sem passar pelo Render.

const PORT = process.env.PORT || '10000';

const main = express();

// CORS é tratado dentro de cada sub-app (dispatcherApp já tem o seu próprio
// middleware). Não duplicar aqui para evitar headers conflitantes.

// Rotas polygon — montadas SEM prefixo, pela mesma razão do dispatcher:
// polygonApp já define internamente /polygon/derive, /tron/derive, etc.
// Se usarmos main.use('/polygon', polygonApp), o Express remove '/polygon'
// antes de entrar na sub-app e as rotas internas nunca batem (404).
main.use(polygonApp);

// Rotas dispatcher — montadas SEM prefixo, porque dispatcherApp já define
// os paths completos internamente (app.post('/dispatch', ...), etc).
// FIX: usar main.use('/dispatch', dispatcherApp) removia o prefixo /dispatch
// antes de entrar no sub-app, fazendo a rota interna nunca bater (404).
main.use(dispatcherApp);

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
