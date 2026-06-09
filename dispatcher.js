// dispatcher.js – StreamVault Dispatcher v3.2
//
// v3.1 → v3.2: watchdog TTL para jobs que falham sem chamar /webhook.
//
// PROBLEMA v3.1:
//   Se um job falha antes do step 14b (webhook), o slot fica preso
//   indefinidamente — crash do runner, timeout de 340min, Render restart,
//   qualquer falha que impeça o webhook de ser chamado.
//
// SOLUÇÃO:
//   JOB_TTL_MS — tempo máximo de vida de um job (default: 360min > 340min do workflow).
//   Watchdog corre a cada WATCHDOG_INTERVAL_MS e força running-- em jobs
//   que ultrapassaram o TTL sem receberem webhook.
//   No arranque, running=0 sempre (Render restart = estado limpo + watchdog
//   detecta jobs órfãos se o jobStore for persistido; sem persistência, a
//   fila simplesmente recomeça do zero, que é o comportamento correcto).

import 'dotenv/config';
import express from 'express';

const app = express();
app.use(express.json({ limit: '1mb' }));

// ── CORS ──────────────────────────────────────────────────────────────────────
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

const PORT                 = parseInt(process.env.PORT || process.env.DISPATCHER_PORT || '3002');
const WORKFLOW_FILE        = process.env.GH_WORKFLOW_FILE       || 'StreamVault.yml';
const WORKFLOW_REF         = process.env.GH_WORKFLOW_REF        || 'main';
const ADMIN_KEY            = process.env.ADMIN_API_KEY          || '';
const MAX_CONCURRENT       = parseInt(process.env.MAX_CONCURRENT       || '1');
// TTL ligeiramente acima do timeout-minutes do workflow (340min) para não
// cortar jobs legítimos ainda a correr. Ajustar se o workflow mudar.
const JOB_TTL_MS           = parseInt(process.env.JOB_TTL_MS           || String(360 * 60 * 1000));
const WATCHDOG_INTERVAL_MS = parseInt(process.env.WATCHDOG_INTERVAL_MS || String(5  * 60 * 1000));

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

// ── Round-robin ───────────────────────────────────────────────────────────────
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
      'User-Agent':           'StreamVault-Dispatcher/3.2',
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
const queue    = [];
let   running  = 0;

// ── Mutex ─────────────────────────────────────────────────────────────────────
let dispatchLock = false;

async function processNext() {
  if (dispatchLock) return;
  if (running >= MAX_CONCURRENT || queue.length === 0) return;

  dispatchLock = true;
  try {
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
      } else {
        account.activeJobs++;
        account.lastUsed = new Date().toISOString();
        job.status       = 'dispatched';
        job.dispatchedAt = new Date().toISOString();
        running++;
        console.log(`[DISPATCH] job=${job.jobId} → ${account.owner} (running=${running}/${MAX_CONCURRENT} queued=${queue.length})`);
      }
    } catch (e) {
      job.status      = 'dispatch_error';
      job.errorDetail = e.message;
      console.error(`[DISPATCH_ERR] job=${job.jobId}: ${e.message}`);
    }
  } finally {
    dispatchLock = false;
    if (queue.length > 0 && running < MAX_CONCURRENT) {
      processNext().catch(e => console.error('[processNext unexpected]', e.message));
    }
  }
}

// ── Watchdog ──────────────────────────────────────────────────────────────────
// Corre a cada WATCHDOG_INTERVAL_MS. Para cada job 'dispatched' que ultrapassou
// JOB_TTL_MS desde dispatchedAt, força a libertação do slot e avança a fila.
// Isto cobre: crash do runner, timeout do workflow, Render restart (running=0
// no boot, mas jobs em 'dispatched' no store seriam órfãos se o store
// sobrevivesse — neste caso não sobrevive, então o watchdog é sobretudo
// para jobs que ficam presos dentro da mesma sessão do processo).
function startWatchdog() {
  setInterval(() => {
    const now        = Date.now();
    let   expired    = 0;

    for (const job of jobStore.values()) {
      if (job.status !== 'dispatched' && job.status !== 'dispatching') continue;

      const dispatchedAt = job.dispatchedAt ? new Date(job.dispatchedAt).getTime() : 0;
      const age          = now - dispatchedAt;

      if (age < JOB_TTL_MS) continue;

      // Job expirou sem webhook — forçar libertação
      console.warn(`[WATCHDOG] job=${job.jobId} expirou após ${Math.round(age/60000)}min sem webhook → forçando slot livre`);
      job.status      = 'timeout';
      job.completedAt = new Date().toISOString();

      const account = accounts.find(a => a.id === job.accountId);
      if (account && account.activeJobs > 0) account.activeJobs--;

      if (running > 0) {
        running--;
        expired++;
      }
    }

    if (expired > 0) {
      console.log(`[WATCHDOG] ${expired} slot(s) libertado(s) → running=${running}/${MAX_CONCURRENT} queued=${queue.length}`);
      processNext().catch(e => console.error('[processNext unexpected]', e.message));
    }
  }, WATCHDOG_INTERVAL_MS);

  const ttlMin      = Math.round(JOB_TTL_MS / 60000);
  const intervalMin = Math.round(WATCHDOG_INTERVAL_MS / 60000);
  console.log(`  ✓ Watchdog activo — TTL=${ttlMin}min, intervalo=${intervalMin}min`);
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

  processNext().catch(e => console.error('[processNext unexpected]', e.message));

  res.json({
    ok:             true,
    job_id,
    status:         'queued',
    queue_position: queuePosition,
  });
});

// ── POST /webhook ─────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const { job_id, status } = req.body;
  if (!job_id) return res.status(400).json({ error: 'job_id obrigatório' });

  const job = jobStore.get(job_id);
  if (!job) return res.status(404).json({ error: 'Job não encontrado' });

  // Se o watchdog já expirou este job, aceitar o webhook mas não decrementar
  // running de novo (já foi feito pelo watchdog)
  const wasRunning = job.status === 'dispatched' || job.status === 'dispatching';

  job.status      = status || 'done';
  job.completedAt = new Date().toISOString();
  job.result      = req.body;

  const account = accounts.find(a => a.id === job.accountId);
  if (account && account.activeJobs > 0) account.activeJobs--;

  if (wasRunning && running > 0) {
    running--;
    console.log(`[WEBHOOK] job=${job_id} status=${status} → running=${running}/${MAX_CONCURRENT} queued=${queue.length}`);
    processNext().catch(e => console.error('[processNext unexpected]', e.message));
  } else {
    // Pode ser webhook tardio de job já expirado pelo watchdog — ignorar slot
    console.log(`[WEBHOOK] job=${job_id} status=${status} (slot já libertado — watchdog ou cancelamento prévio)`);
  }

  res.json({ ok: true });
});

// ── DELETE /jobs/:jobId ───────────────────────────────────────────────────────
app.delete('/jobs/:jobId', auth, async (req, res) => {
  const job = jobStore.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job não encontrado' });

  if (job.status === 'queued') {
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
  if (running > 0) {
    running--;
    processNext().catch(e => console.error('[processNext unexpected]', e.message));
  }
  job.status = 'cancelled';

  res.json({ ok: true, was_queued: false });
});

// ── GET /status ───────────────────────────────────────────────────────────────
app.get('/status', (_, res) => {
  res.json({
    running,
    max_concurrent:  MAX_CONCURRENT,
    queued_jobs:     queue.length,
    job_ttl_min:     Math.round(JOB_TTL_MS / 60000),
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
    job_ttl_min:    Math.round(JOB_TTL_MS / 60000),
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

// ── Init — chamado pelo index.js após o servidor principal fazer listen ────────
// NÃO chama app.listen() — o dispatcher é montado como sub-router no servidor
// unificado. O index.js chama dispatcherInit(port) no callback do seu listen.
function dispatcherInit(port) {
  console.log(`StreamVault Dispatcher v3.2 (MAX_CONCURRENT=${MAX_CONCURRENT})`);
  accounts.forEach(a => console.log(`  ✓ Conta ${a.id}: ${a.owner}/${a.repo}`));
  startKeepAlive(port);
  startWatchdog();
}

export { app, accounts, dispatcherInit };
