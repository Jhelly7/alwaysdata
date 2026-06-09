// dispatcher.js – StreamVault Dispatcher v3.0
//
// v2 → v3: fila FIFO com MAX_CONCURRENT slots.
// Tudo o resto é idêntico ao v2.
//
// NOVO:
//   • queue[]        — jobs aguardando slot (FIFO)
//   • running        — contador de slots activos
//   • MAX_CONCURRENT — env var (default: 1)
//   • processNext()  — avança fila quando slot é libertado
//
// POST /dispatch  → entra na fila; dispara imediatamente se há slot livre
// POST /webhook   → liberta slot + chama processNext()
// GET  /status    → expõe queue[] além de jobs
// GET  /health    → inclui queued_jobs + max_concurrent
//
// VARS DE AMBIENTE:
//   MAX_CONCURRENT       — slots simultâneos (default: 1)
//   DISPATCHER_PORT      — porta (default: 3002)
//   GH_WORKFLOW_FILE     — nome do workflow (default: StreamVault.yml)
//   GH_WORKFLOW_REF      — branch (default: main)
//   GH_ACCOUNT_N_TOKEN / _OWNER / _REPO

import 'dotenv/config';
import express from 'express';

const app = express();
app.use(express.json({ limit: '1mb' }));

// ── CORS ─────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const allowed = [
    'https://streamvault-admin.pages.dev',
    'https://pixgo.qzz.io',
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

const PORT           = parseInt(process.env.PORT || process.env.DISPATCHER_PORT || '3002');
const WORKFLOW_FILE  = process.env.GH_WORKFLOW_FILE || 'StreamVault.yml';
const WORKFLOW_REF   = process.env.GH_WORKFLOW_REF  || 'main';
const ADMIN_KEY      = process.env.ADMIN_API_KEY    || '';
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '1');

// ── Carregar contas ───────────────────────────────────────────────────────────
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

// ── Round-robin — conta com menos jobs activos, desempate por lastUsed ────────
function selectAccount() {
  return [...accounts].sort((a, b) => {
    if (a.activeJobs !== b.activeJobs) return a.activeJobs - b.activeJobs;
    const at = a.lastUsed ? new Date(a.lastUsed).getTime() : 0;
    const bt = b.lastUsed ? new Date(b.lastUsed).getTime() : 0;
    return at - bt;
  })[0];
}

// ── GitHub API ────────────────────────────────────────────────────────────────
function ghFetch(url, token, opts = {}) {
  return fetch(url, {
    ...opts,
    headers: {
      'Authorization':        `Bearer ${token}`,
      'Accept':               'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent':           'StreamVault-Dispatcher/3.0',
      ...(opts.headers || {}),
    },
  });
}

async function triggerWorkflow(account, inputs) {
  return ghFetch(
    `https://api.github.com/repos/${account.owner}/${account.repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
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

// ── Estado FIFO ───────────────────────────────────────────────────────────────
const jobStore = new Map();
const queue    = [];   // jobs aguardando slot — ordem FIFO
let   running  = 0;    // slots activos no GitHub Actions

// ── processNext — tira o próximo da fila e dispara se há slot livre ───────────
async function processNext() {
  if (running >= MAX_CONCURRENT || queue.length === 0) return;

  const job     = queue.shift();
  const account = selectAccount();

  job.status       = 'dispatching';
  job.accountId    = account.id;
  job.accountOwner = account.owner;

  try {
    const r = await triggerWorkflow(account, job.inputs);
    if (!r.ok) {
      const t = await r.text();
      job.status      = 'dispatch_error';
      job.errorDetail = t.slice(0, 300);
      console.error(`[DISPATCH_ERR] job=${job.jobId} HTTP ${r.status}: ${job.errorDetail}`);
      // slot não foi consumido — tentar o próximo
      processNext();
      return;
    }

    account.activeJobs++;
    account.lastUsed = new Date().toISOString();
    job.status       = 'dispatched';
    job.dispatchedAt = new Date().toISOString();
    running++;

    console.log(`[DISPATCH] job=${job.jobId} → ${account.owner} (running=${running}/${MAX_CONCURRENT} queued=${queue.length})`);
  } catch (e) {
    job.status      = 'dispatch_error';
    job.errorDetail = e.message;
    console.error(`[DISPATCH_ERR] job=${job.jobId}: ${e.message}`);
    processNext();
  }
}

// ── Auth middleware ───────────────────────────────────────────────────────────
function auth(req, res, next) {
  if (!ADMIN_KEY) return next();
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── POST /dispatch ────────────────────────────────────────────────────────────
app.post('/dispatch', auth, async (req, res) => {
  const {
    job_id,
    video_url         = '',
    thumbnail_url     = '',
    seg_duration      = '4',
    max_encode_height = '720',
    warm_concurrency  = '8',
    metadata          = {},
    season_number     = '0',
    episode_number    = '0',
    episode_title     = '',
    file_indices      = '',
  } = req.body;

  if (!job_id) return res.status(400).json({ error: 'job_id obrigatório' });
  if (jobStore.has(job_id)) return res.status(409).json({ error: 'Job já existe' });

  const inputs = {
    job_id,
    video_url,
    thumbnail_url,
    seg_duration:      String(seg_duration),
    max_encode_height: String(max_encode_height),
    warm_concurrency:  String(warm_concurrency),
    metadata:          typeof metadata === 'string' ? metadata : JSON.stringify(metadata),
    season_number:     String(season_number),
    episode_number:    String(episode_number),
    episode_title:     String(episode_title),
    file_indices:      String(file_indices),
  };

  const queuePosition = queue.length;

  const job = {
    jobId:        job_id,
    accountId:    null,
    accountOwner: null,
    status:       'queued',
    createdAt:    new Date().toISOString(),
    dispatchedAt: null,
    completedAt:  null,
    inputs,
  };

  jobStore.set(job_id, job);
  queue.push(job);

  console.log(`[QUEUE] job=${job_id} pos=${queuePosition} (queued=${queue.length} running=${running}/${MAX_CONCURRENT})`);

  // dispara imediatamente se há slot livre — caso contrário fica em queue[]
  processNext();

  res.json({
    ok:             true,
    job_id,
    status:         job.status,
    queue_position: queuePosition,
  });
});

// ── POST /webhook — callback do Actions (step 14b) ────────────────────────────
// Body: { job_id, status: 'done' | 'failed' }
// Liberta o slot e avança a fila — chamado com if:always() no workflow.
app.post('/webhook', async (req, res) => {
  const { job_id, status } = req.body;
  if (!job_id) return res.status(400).json({ error: 'job_id obrigatório' });

  const job = jobStore.get(job_id);
  if (!job) return res.status(404).json({ error: 'Job não encontrado' });

  const wasRunning = job.status === 'dispatched' || job.status === 'dispatching';

  job.status      = status || 'done';
  job.completedAt = new Date().toISOString();
  job.result      = req.body;

  const account = accounts.find(a => a.id === job.accountId);
  if (account && account.activeJobs > 0) account.activeJobs--;

  if (wasRunning && running > 0) {
    running--;
    console.log(`[WEBHOOK] job=${job_id} status=${status} → running=${running}/${MAX_CONCURRENT} queued=${queue.length}`);
    processNext();
  } else {
    console.log(`[WEBHOOK] job=${job_id} status=${status} (não estava running — slot inalterado)`);
  }

  res.json({ ok: true });
});

// ── DELETE /jobs/:jobId — cancelar job ───────────────────────────────────────
app.delete('/jobs/:jobId', auth, async (req, res) => {
  const job = jobStore.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job não encontrado' });

  if (job.status === 'queued') {
    // remove da fila sem tocar em running
    const idx = queue.indexOf(job);
    if (idx !== -1) queue.splice(idx, 1);
    job.status = 'cancelled';
    console.log(`[CANCEL] job=${job.jobId} removido da fila (queued=${queue.length})`);
    return res.json({ ok: true, was_queued: true });
  }

  const account = accounts.find(a => a.id === job.accountId);
  if (account && job.runId) {
    try { await cancelRun(account, job.runId); } catch {}
  }
  if (account && account.activeJobs > 0) account.activeJobs--;
  if (running > 0) { running--; processNext(); }
  job.status = 'cancelled';

  res.json({ ok: true, was_queued: false });
});

// ── GET /status ───────────────────────────────────────────────────────────────
app.get('/status', (_, res) => {
  res.json({
    running,
    max_concurrent: MAX_CONCURRENT,
    queued_jobs:    queue.length,
    accounts: accounts.map(a => ({
      id: a.id, owner: a.owner, repo: a.repo,
      activeJobs: a.activeJobs, lastUsed: a.lastUsed,
    })),
    jobs:  [...jobStore.values()],
    queue: queue.map((j, i) => ({ job_id: j.jobId, position: i, createdAt: j.createdAt })),
  });
});

// ── GET /health ───────────────────────────────────────────────────────────────
app.get('/health', (_, res) => {
  res.json({
    ok:             true,
    accounts:       accounts.length,
    active_jobs:    running,
    queued_jobs:    queue.length,
    max_concurrent: MAX_CONCURRENT,
    workflow:       `${WORKFLOW_FILE}@${WORKFLOW_REF}`,
  });
});

// ── Keep-alive ────────────────────────────────────────────────────────────────
function startKeepAlive(port) {
  const interval    = 14 * 60 * 1000;
  const selfUrl     = process.env.RENDER_EXTERNAL_URL
    ? `${process.env.RENDER_EXTERNAL_URL}/health`
    : `http://localhost:${port}/health`;
  const pipelineUrl = process.env.PIPELINE_API
    ? `${process.env.PIPELINE_API.replace(/\/$/, '')}/health`
    : null;

  setInterval(async () => {
    try {
      const r = await fetch(selfUrl);
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

// ── Export ────────────────────────────────────────────────────────────────────
console.log(`StreamVault Dispatcher v3.0 (MAX_CONCURRENT=${MAX_CONCURRENT})`);
accounts.forEach(a => console.log(`  ✓ Conta ${a.id}: ${a.owner}/${a.repo}`));

export { app, accounts };
