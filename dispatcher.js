// dispatcher.js – StreamVault Dispatcher v2.1
//
// Gere 2 contas GitHub Actions em round-robin.
// Substitui apenas o processQueue/processJob do server.js —
// todas as rotas e lógica do server.js ficam intactas.
//
// FIX v2.1:
//   • Removido `warm_concurrency` do payload de /dispatch. O process.yml
//     deixou de declarar esse input (o step de aquecimento de cache do
//     Worker foi removido — storage passou a ser servido directamente por
//     raw.githubusercontent.com, sem CDN/Worker no caminho). A API de
//     workflow_dispatch do GitHub rejeita com 422 "Unexpected inputs
//     provided" quando o payload contém uma chave que o workflow não
//     declara — todo dispatch estava a falhar por causa deste único campo.
//   • Novo endpoint POST /shard-delete: dispara shard-delete.yml (mesmo
//     mecanismo de round-robin do /dispatch) para remover um job_id de um
//     shard de storage. Chamado pelo backend EdgeOne (lib/edgeone.js,
//     deleteContent) via DISPATCHER_URL + ADMIN_API_KEY — o EdgeOne nunca
//     fala directamente com a API do GitHub, só este serviço tem as contas.
//   • REQUISITO DE DEPLOY: shard-delete.yml precisa de existir no repo de
//     AMBAS as contas (GH_ACCOUNT_1_REPO e GH_ACCOUNT_2_REPO), com o secret
//     STORAGE_GITHUB_TOKEN/STORAGE_GITHUB_OWNER configurado em cada uma —
//     porque o round-robin pode escolher qualquer uma das duas para correr
//     o delete, independentemente de qual conta processou o job original.
//
// FIX v2.2:
//   • Adicionada a origem do worker que serve o ingest.html
//     (streamvault-ingest, ver cold-brook-4c20.sheltonnaem.workers.dev)
//     à lista de CORS. Sem isso, o browser bloqueava GET /health e
//     GET /status com CORS error, e o front-end ficava preso no loop
//     de retry ("a acordar...") achando que o Render estava a dormir —
//     quando na verdade a resposta nem chegava a ser lida pelo browser.
//
// VARS DE AMBIENTE (.env — mesmo ficheiro do server.js):
//   DISPATCHER_PORT      — porta do dispatcher (default: 3002)
//   GH_WORKFLOW_FILE     — nome do workflow (default: process.yml)
//   GH_UPLOADER_FILE     — nome do workflow uploader (default: uploader.yml)
//   GH_SHARD_DELETE_FILE — nome do workflow de shard delete (default: shard-delete.yml)
//   GH_WORKFLOW_REF      — branch (default: main)
//
//   Conta 1:
//   GH_ACCOUNT_1_TOKEN   — PAT (scope: repo, workflow)
//   GH_ACCOUNT_1_OWNER   — username
//   GH_ACCOUNT_1_REPO    — repo com o process.yml
//
//   Conta 2:
//   GH_ACCOUNT_2_TOKEN
//   GH_ACCOUNT_2_OWNER
//   GH_ACCOUNT_2_REPO

import 'dotenv/config';
import express from 'express';

const app = express();
app.use(express.json({ limit: '1mb' }));

// ── CORS — permite chamadas do painel admin (pages.dev, worker de ingest
// e domínio próprio) ─────────────────────────────────────────────────────
app.use((req, res, next) => {
  const allowed = [
    'https://streamvault-admin.pages.dev',
    'https://pixgo.qzz.io',
    'https://digital.pixgo.frii.site',
    'https://cold-brook-4c20.sheltonnaem.workers.dev',
  ];
  const origin = req.headers.origin || '';
  if (allowed.includes(origin) || !origin) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const PORT              = parseInt(process.env.PORT || process.env.DISPATCHER_PORT || '3002');
const WORKFLOW_FILE     = process.env.GH_WORKFLOW_FILE     || 'process.yml';
const UPLOADER_FILE     = process.env.GH_UPLOADER_FILE     || 'uploader.yml';
const SHARD_DELETE_FILE = process.env.GH_SHARD_DELETE_FILE || 'shard-delete.yml';
const WORKFLOW_REF      = process.env.GH_WORKFLOW_REF      || 'main';
const ADMIN_KEY         = process.env.ADMIN_API_KEY        || '';

// ── Carregar contas ──────────────────────────────────────────────────────────
function loadAccounts() {
  const accounts = [];
  let n = 1;
  while (true) {
    const token = process.env[`GH_ACCOUNT_${n}_TOKEN`];
    const owner = process.env[`GH_ACCOUNT_${n}_OWNER`];
    const repo  = process.env[`GH_ACCOUNT_${n}_REPO`];
    if (!token || !owner || !repo) break;
    accounts.push({ id: n, token, owner, repo, activeJobs: 0, lastUsed: null });
    n++;
  }
  return accounts;
}

const accounts = loadAccounts();
if (accounts.length === 0) {
  console.error('ERRO: Nenhuma conta GitHub configurada.');
  process.exit(1);
}

// ── Round-robin — conta com menos jobs activos, desempate por lastUsed ───────
function selectAccount() {
  return [...accounts].sort((a, b) => {
    if (a.activeJobs !== b.activeJobs) return a.activeJobs - b.activeJobs;
    const at = a.lastUsed ? new Date(a.lastUsed).getTime() : 0;
    const bt = b.lastUsed ? new Date(b.lastUsed).getTime() : 0;
    return at - bt;
  })[0];
}

// ── GitHub API ───────────────────────────────────────────────────────────────
function ghFetch(url, token, opts = {}) {
  return fetch(url, {
    ...opts,
    headers: {
      'Authorization':        `Bearer ${token}`,
      'Accept':               'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent':           'StreamVault-Dispatcher/2.1',
      ...(opts.headers || {}),
    },
  });
}

/**
 * Detecta se o job é um uploader baseado nos inputs.
 * Uploaders têm: video_url vazio + metadata.is_uploader = true
 * OU file_indices começando com "uploader:"
 */
function isUploaderJob(inputs) {
  // Método 1: metadata contém flag is_uploader
  try {
    const meta = typeof inputs.metadata === 'string'
      ? JSON.parse(inputs.metadata)
      : inputs.metadata;
    if (meta?.is_uploader === true) return true;
  } catch {}

  // Método 2: video_url vazio + file_indices = uploader:N
  if (!inputs.video_url && typeof inputs.file_indices === 'string' && inputs.file_indices.startsWith('uploader:')) {
    return true;
  }

  return false;
}

async function triggerWorkflow(account, workflowFile, inputs) {
  console.log(`[DISPATCH] job=${inputs.job_id} → workflow=${workflowFile} conta=${account.owner}`);

  return ghFetch(
    `https://api.github.com/repos/${account.owner}/${account.repo}/actions/workflows/${workflowFile}/dispatches`,
    account.token,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ref: WORKFLOW_REF, inputs }),
    }
  );
}

async function cancelRun(account, runId) {
  return ghFetch(
    `https://api.github.com/repos/${account.owner}/${account.repo}/actions/runs/${runId}/cancel`,
    account.token,
    { method: 'POST' }
  );
}

// ── Job store ────────────────────────────────────────────────────────────────
const jobStore = new Map();

// Limpeza periódica de jobs antigos (mais de 24h)
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobStore) {
    const dispatchedAt = job.dispatchedAt ? new Date(job.dispatchedAt).getTime() : 0;
    if (now - dispatchedAt > 24 * 60 * 60 * 1000) {
      jobStore.delete(id);
      console.log(`[CLEANUP] Job expirado removido: ${id}`);
    }
  }
}, 60 * 60 * 1000); // A cada hora

// ── Auth middleware ──────────────────────────────────────────────────────────
function auth(req, res, next) {
  if (!ADMIN_KEY) return next();
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── POST /dispatch ───────────────────────────────────────────────────────────
app.post('/dispatch', auth, async (req, res) => {
  const {
    job_id,
    video_url         = '',
    thumbnail_url     = '',
    seg_duration      = '4',
    max_encode_height = '720',
    metadata          = {},
    season_number     = '0',
    episode_number    = '0',
    episode_title     = '',
    file_indices      = '',
  } = req.body;

  if (!job_id) return res.status(400).json({ error: 'job_id obrigatório' });

  // Verificar se job já existe e ainda está ativo
  if (jobStore.has(job_id)) {
    const existing = jobStore.get(job_id);
    const isActive = existing.status === 'dispatched' || existing.status === 'running';
    if (isActive) {
      return res.status(409).json({
        error: 'Job já existe e está ativo',
        job_id,
        status: existing.status,
        dispatchedAt: existing.dispatchedAt,
      });
    }
    // Se job anterior falhou/completou, permite re-disparar
    console.log(`[DISPATCH] Job ${job_id} re-disparado (status anterior: ${existing.status})`);
    jobStore.delete(job_id);
  }

  const account = selectAccount();

  const inputs = {
    job_id,
    video_url,
    thumbnail_url,
    seg_duration:      String(seg_duration),
    max_encode_height: String(max_encode_height),
    metadata: typeof metadata === 'string' ? metadata : JSON.stringify(metadata),
    season_number:     String(season_number),
    episode_number:    String(episode_number),
    episode_title,
    file_indices,
  };

  // Seleciona o workflow correto baseado no tipo de job
  const isUploader   = isUploaderJob(inputs);
  const workflowFile = isUploader ? UPLOADER_FILE : WORKFLOW_FILE;

  try {
    const r = await triggerWorkflow(account, workflowFile, inputs);

    if (!r.ok) {
      const t = await r.text();
      console.error(`[DISPATCH] GitHub API error ${r.status}: ${t.slice(0, 300)}`);
      return res.status(502).json({
        error: `GitHub dispatch falhou (${r.status})`,
        details: t.slice(0, 300),
      });
    }

    account.activeJobs++;
    account.lastUsed = new Date().toISOString();

    jobStore.set(job_id, {
      jobId:        job_id,
      accountId:    account.id,
      accountOwner: account.owner,
      status:       'dispatched',
      dispatchedAt: new Date().toISOString(),
      isUploader,
      inputs,
    });

    console.log(`[DISPATCH] ✓ job=${job_id} → ${account.owner}/${account.repo} (active=${account.activeJobs}) uploader=${isUploader} thumb=${thumbnail_url ? '✓' : '—'}`);

    res.json({
      ok: true,
      job_id,
      account: account.owner,
      account_id: account.id,
      is_uploader: isUploader,
      workflow: workflowFile,
    });

  } catch (e) {
    console.error(`[DISPATCH] Erro: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /shard-delete ────────────────────────────────────────────────────────
// Chamado pelo backend EdgeOne (lib/edgeone.js → deleteContent) quando um
// conteúdo é apagado do catálogo. Dispara shard-delete.yml numa das 2 contas
// (round-robin, igual ao /dispatch) — não importa qual das duas corre o
// workflow, já que ele autentica no shard de storage via STORAGE_GITHUB_TOKEN
// (secret configurado no repo da conta, independente de qual das duas é).
app.post('/shard-delete', auth, async (req, res) => {
  const { job_id, shard_repo } = req.body;

  if (!job_id || !shard_repo) {
    return res.status(400).json({ error: 'job_id e shard_repo são obrigatórios' });
  }

  const account = selectAccount();
  const inputs  = { job_id, shard_repo };

  try {
    const r = await triggerWorkflow(account, SHARD_DELETE_FILE, inputs);

    if (!r.ok) {
      const t = await r.text();
      console.error(`[SHARD-DELETE] GitHub API error ${r.status}: ${t.slice(0, 300)}`);
      return res.status(502).json({
        error: `GitHub dispatch falhou (${r.status})`,
        details: t.slice(0, 300),
      });
    }

    console.log(`[SHARD-DELETE] ✓ job_id=${job_id} shard=${shard_repo} → conta=${account.owner}`);
    res.json({ ok: true, job_id, shard_repo, account: account.owner });

  } catch (e) {
    console.error(`[SHARD-DELETE] Erro: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /webhook — callback do Actions quando job termina ───────────────────
app.post('/webhook', async (req, res) => {
  const { job_id, status, parent_job } = req.body;

  if (!job_id) return res.status(400).json({ error: 'job_id obrigatório' });

  const job = jobStore.get(job_id);

  if (!job) {
    // Pode ser um uploader filho que não estava no jobStore
    console.log(`[WEBHOOK] Job ${job_id} não encontrado no store (uploader filho?)`);
    return res.status(404).json({ error: 'Job não encontrado', job_id });
  }

  job.status      = status || 'done';
  job.completedAt = new Date().toISOString();
  job.result      = req.body;

  const account = accounts.find(a => a.id === job.accountId);
  if (account && account.activeJobs > 0) {
    account.activeJobs--;
  }

  // Se for uploader, também atualiza o contador do job pai
  if (parent_job && jobStore.has(parent_job)) {
    const parent = jobStore.get(parent_job);
    if (!parent.uploaderResults) parent.uploaderResults = {};
    parent.uploaderResults[job_id] = status || 'done';

    // Verificar se todos os uploaders terminaram
    const totalUploaders = parent.inputs?.metadata
      ? (() => {
          try {
            const m = JSON.parse(parent.inputs.metadata);
            return m.batch_count || 0;
          } catch { return 0; }
        })()
      : 0;

    const completedUploaders = Object.values(parent.uploaderResults).filter(s => s === 'done').length;

    console.log(`[WEBHOOK] Uploader ${job_id} → ${status} (parent: ${parent_job} ${completedUploaders}/${totalUploaders})`);
  }

  console.log(`[WEBHOOK] job=${job_id} status=${status} conta=${account?.owner} active=${account?.activeJobs}`);
  res.json({ ok: true });
});

// ── DELETE /jobs/:jobId — cancelar job ───────────────────────────────────────
app.delete('/jobs/:jobId', auth, async (req, res) => {
  const job = jobStore.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job não encontrado' });

  const account = accounts.find(a => a.id === job.accountId);
  if (account && job.runId) {
    try {
      await cancelRun(account, job.runId);
      console.log(`[CANCEL] Run ${job.runId} cancelado`);
    } catch (e) {
      console.warn(`[CANCEL] Erro ao cancelar run: ${e.message}`);
    }
  }

  job.status = 'cancelled';
  if (account && account.activeJobs > 0) account.activeJobs--;
  res.json({ ok: true, job_id: req.params.jobId });
});

// ── GET /status ──────────────────────────────────────────────────────────────
app.get('/status', auth, (_, res) => {
  const jobs = [...jobStore.values()].map(j => ({
    jobId: j.jobId,
    status: j.status,
    accountOwner: j.accountOwner,
    isUploader: j.isUploader || false,
    dispatchedAt: j.dispatchedAt,
    completedAt: j.completedAt || null,
    uploaderResults: j.uploaderResults || null,
  }));

  res.json({
    accounts: accounts.map(a => ({
      id: a.id,
      owner: a.owner,
      repo: a.repo,
      activeJobs: a.activeJobs,
      lastUsed: a.lastUsed,
    })),
    jobs,
    total_active: accounts.reduce((s, a) => s + a.activeJobs, 0),
    total_jobs: jobStore.size,
    workflows: {
      process: WORKFLOW_FILE,
      uploader: UPLOADER_FILE,
      shard_delete: SHARD_DELETE_FILE,
      ref: WORKFLOW_REF,
    },
  });
});

// ── GET /health ──────────────────────────────────────────────────────────────
app.get('/health', (_, res) => {
  res.json({
    ok: true,
    accounts: accounts.length,
    active_jobs: accounts.reduce((s, a) => s + a.activeJobs, 0),
    workflow: `${WORKFLOW_FILE}@${WORKFLOW_REF}`,
    uploader: `${UPLOADER_FILE}@${WORKFLOW_REF}`,
    shard_delete: `${SHARD_DELETE_FILE}@${WORKFLOW_REF}`,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ── Keep-alive — evita que o Render (free tier) adormeça ────────────────────
function startKeepAlive(port) {
  const interval  = 14 * 60 * 1000; // 14 minutos
  const selfUrl   = process.env.RENDER_EXTERNAL_URL
    ? `${process.env.RENDER_EXTERNAL_URL}/health`
    : `http://localhost:${port}/health`;
  const pipelineUrl = process.env.PIPELINE_API
    ? `${process.env.PIPELINE_API.replace(/\/$/, '')}/health`
    : null;

  setInterval(async () => {
    try {
      const r = await fetch(selfUrl, { signal: AbortSignal.timeout(10000) });
      console.log(`[keep-alive] dispatcher → ${r.status} (${new Date().toISOString()})`);
    } catch (e) {
      console.warn(`[keep-alive] dispatcher ping falhou: ${e.message}`);
    }

    if (pipelineUrl) {
      try {
        const r = await fetch(pipelineUrl, { signal: AbortSignal.timeout(10000) });
        console.log(`[keep-alive] pipeline → ${r.status}`);
      } catch (e) {
        console.warn(`[keep-alive] pipeline ping falhou: ${e.message}`);
      }
    }
  }, interval);

  console.log(`  ✓ Keep-alive activo — ping cada 14min → ${selfUrl}`);
  if (pipelineUrl) console.log(`  ✓ Keep-alive pipeline → ${pipelineUrl}`);
}

// ── Start ────────────────────────────────────────────────────────────────────
console.log(`StreamVault Dispatcher v2.1`);
console.log(`  Accounts: ${accounts.length}`);
accounts.forEach(a => console.log(`    ${a.id}: ${a.owner}/${a.repo}`));
console.log(`  Workflows:`);
console.log(`    Process:      ${WORKFLOW_FILE}@${WORKFLOW_REF}`);
console.log(`    Uploader:     ${UPLOADER_FILE}@${WORKFLOW_REF}`);
console.log(`    Shard Delete: ${SHARD_DELETE_FILE}@${WORKFLOW_REF}`);

// Export para uso com index.js (servidor unificado)
export { app };

// Start standalone se executado diretamente
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, ''))) {
  app.listen(PORT, () => {
    console.log(`\n  ✓ Dispatcher running on http://localhost:${PORT}`);
    startKeepAlive(PORT);
  });
}
