// alwaysdata/src/server.js — Polygon Microservice
// ─────────────────────────────────────────────────────────────────────────────
// Full Node.js (AlwaysData) — sem restrições serverless.
// Responsabilidades:
//   POST /polygon/derive  → deriva endereço HD Polygon + gera QR code
//   POST /polygon/qr      → gera QR code para endereço existente
//   POST /polygon/check   → verifica pagamento on-chain USDT Polygon
//
// Stateless — não persiste nada. Toda a persistência é no EdgeOne KV.
// Protegido por X-Service-Key header (POLYGON_SERVICE_SECRET env var).
//
// Mantém rotas /tron/* como aliases para compatibilidade durante transição.
// ─────────────────────────────────────────────────────────────────────────────

import express    from 'express';
import { deriveAddress }       from './polygon.js';
import { generateQRCode }      from './qr.js';
import { checkOnChainPayment } from './chain.js';

const PORT   = process.env.PORT                   || 8100;
const SECRET = process.env.POLYGON_SERVICE_SECRET || process.env.TRON_SERVICE_SECRET || '';

// ── Auth middleware ───────────────────────────────────────────────────────────

function requireSecret(req, res, next) {
    if (!SECRET) return next(); // sem secret configurado → aberto (dev)
    const key = req.headers['x-service-key'];
    if (!key || key !== SECRET) return res.status(401).json({ error: 'Unauthorized' });
    next();
}

// ── App ───────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Health
app.get('/health', (_req, res) => res.json({
    ok: true,
    service: 'polygon-microservice',
    network: 'polygon',
    chain_id: parseInt(process.env.POLYGON_CHAIN_ID || '137', 10),
    ts: new Date().toISOString(),
}));

// ── Handler: derive address + QR ─────────────────────────────────────────────
// Body: { hdIndex: number, amountUsdt: number }
// Returns: { address: string, qr_code: string (data URL) }
async function handleDerive(req, res) {
    try {
        const { hdIndex, amountUsdt } = req.body;
        if (hdIndex === undefined || amountUsdt === undefined) {
            return res.status(400).json({ error: 'hdIndex e amountUsdt são obrigatórios' });
        }
        const { address } = await deriveAddress(Number(hdIndex));
        const qr_code     = await generateQRCode(address, Number(amountUsdt));
        res.json({ address, qr_code, network: 'polygon' });
    } catch (err) {
        console.error('[/derive]', err.message);
        res.status(500).json({ error: 'Derivação falhou', message: err.message });
    }
}

// ── Handler: QR only ─────────────────────────────────────────────────────────
// Body: { address: string, amountUsdt: number }
// Returns: { qr_code: string (data URL) }
async function handleQR(req, res) {
    try {
        const { address, amountUsdt } = req.body;
        if (!address || amountUsdt === undefined) {
            return res.status(400).json({ error: 'address e amountUsdt são obrigatórios' });
        }
        const qr_code = await generateQRCode(address, Number(amountUsdt));
        res.json({ qr_code, network: 'polygon' });
    } catch (err) {
        console.error('[/qr]', err.message);
        res.status(500).json({ error: 'Geração de QR falhou', message: err.message });
    }
}

// ── Handler: check on-chain ───────────────────────────────────────────────────
// Body: { address, expectedUsdt, minUsdt, minConfirmations }
// Returns: { found, confirmed, confirmations, needed, txHash, usdtValue, sufficient }
async function handleCheck(req, res) {
    try {
        const { address, expectedUsdt, minUsdt, minConfirmations } = req.body;
        if (!address) return res.status(400).json({ error: 'address é obrigatório' });
        const result = await checkOnChainPayment(address, expectedUsdt, minUsdt, minConfirmations);
        res.json({ ...result, network: 'polygon' });
    } catch (err) {
        console.error('[/check]', err.message);
        res.status(500).json({ error: 'Verificação on-chain falhou', message: err.message });
    }
}

// ── Rotas Polygon (novas) ─────────────────────────────────────────────────────
app.post('/polygon/derive', requireSecret, handleDerive);
app.post('/polygon/qr',     requireSecret, handleQR);
app.post('/polygon/check',  requireSecret, handleCheck);

// ── Rotas /tron/* — aliases de compatibilidade (redireccionam para Polygon) ──
// Permitem transição gradual sem quebrar o EdgeOne que ainda usa /tron/*
app.post('/tron/derive', requireSecret, handleDerive);
app.post('/tron/qr',     requireSecret, handleQR);
app.post('/tron/check',  requireSecret, handleCheck);

// 404
app.use((_req, res) => res.status(404).json({ error: 'Not Found' }));

// ── Export (para index.js) ────────────────────────────────────────────────────
if (!process.env.WALLET_MNEMONIC && !process.env.WALLET_MNEMONIC_B64 &&
    !process.env.TRON_MNEMONIC  && !process.env.TRON_MNEMONIC_B64) {
    console.error('[polygon-service] CRÍTICO: WALLET_MNEMONIC ou WALLET_MNEMONIC_B64 não definido');
}
if (!process.env.POLYGON_RPC_URL) {
    console.warn('[polygon-service] AVISO: POLYGON_RPC_URL não definido — a usar polygon-rpc.com (público, limite de taxa)');
}
if (!process.env.POLYGONSCAN_API_KEY) {
    console.warn('[polygon-service] AVISO: POLYGONSCAN_API_KEY não definido — usando eth_getLogs como fallback');
}
if (!SECRET) {
    console.warn('[polygon-service] AVISO: POLYGON_SERVICE_SECRET não definido — endpoint aberto');
}

export { app };
