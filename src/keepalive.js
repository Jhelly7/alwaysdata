// src/keepalive.js — opcional, só necessário se o EdgeOne não fizer chamadas frequentes
// Faz self-ping ao /health a cada 13 minutos (Render dorme após 15 min sem tráfego).
// Activar: importar no server.js  →  import './keepalive.js';
// Desactivar: remover o import. Não tem dependências extra.

const INTERVAL_MS = 13 * 60 * 1000; // 13 minutos

function ping() {
    const host = process.env.RENDER_EXTERNAL_URL; // injetado automaticamente pelo Render
    if (!host) return; // não corre localmente

    fetch(`${host}/health`, { signal: AbortSignal.timeout(5_000) })
        .then(r => { if (!r.ok) console.warn('[keepalive] /health respondeu', r.status); })
        .catch(err => console.warn('[keepalive] ping falhou:', err.message));
}

// Primeiro ping após 1 min (deixa o servidor estabilizar)
setTimeout(() => {
    ping();
    setInterval(ping, INTERVAL_MS);
}, 60_000);