// alwaysdata/src/chain.js — On-Chain Polygon/USDT Payment Verification
// ─────────────────────────────────────────────────────────────────────────────
// Migrado de TRON (TronGrid) para Polygon (Polygonscan API ou JSON-RPC).
//
// Estratégia:
//   1. Busca transferências ERC-20 de USDT para o endereço via Polygonscan API.
//   2. Obtém bloco actual via eth_blockNumber (JSON-RPC) para calcular confirmações.
//   3. Mínimo de confirmações: 128 blocos (~4 min na Polygon ~2s/bloco).
//
// Variáveis de ambiente:
//   POLYGON_RPC_URL      — nó JSON-RPC (ex: https://polygon-rpc.com ou Alchemy/Infura)
//   POLYGONSCAN_API_KEY  — chave da Polygonscan API (gratuita, recomendada)
//   USDT_CONTRACT        — contrato USDT Polygon (padrão: mainnet)
//   POLYGON_CHAIN_ID     — 137 (mainnet) ou 80001 (Mumbai testnet)
// ─────────────────────────────────────────────────────────────────────────────

function polygonRpc()         { return process.env.POLYGON_RPC_URL     || 'https://polygon-rpc.com'; }
function polygonscanApiKey()  { return process.env.POLYGONSCAN_API_KEY || ''; }
function usdtContract()       { return (process.env.USDT_CONTRACT      || '0xc2132D05D31c914a87C6611C10748AEb04B58e8F').toLowerCase(); }
const USDT_DECIMALS = 6; // USDT no Polygon tem 6 casas decimais

/**
 * Lê JSON de uma Response com mensagem de erro legível se o corpo não for JSON.
 * Evita "Unexpected token '<'" quando o RPC devolve HTML (rate limit / downtime).
 */
async function safeJson(resp, label) {
  const ct = resp.headers.get('content-type') || '';
  if (!ct.includes('application/json') && !ct.includes('text/json')) {
    const preview = (await resp.text()).slice(0, 120).replace(/\s+/g, ' ');
    throw new Error(`${label}: resposta não-JSON (${resp.status}) — ${preview}`);
  }
  return resp.json();
}

// ERC-20 Transfer event topic: keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * Obtém o número do bloco actual via JSON-RPC.
 */
async function getCurrentBlock(signal) {
    const resp = await fetch(polygonRpc(), {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
        signal,
    });
    if (!resp.ok) throw new Error(`eth_blockNumber falhou: ${resp.status}`);
    const data = await safeJson(resp, 'eth_blockNumber');
    if (data.error) throw new Error(`eth_blockNumber erro: ${data.error.message}`);
    return parseInt(data.result, 16);
}

/**
 * Busca logs de Transfer ERC-20 recebidos no endereço dado.
 * Usa Polygonscan API se disponível, senão eth_getLogs via JSON-RPC.
 */
async function fetchTransferLogs(address, signal) {
    const apiKey   = polygonscanApiKey();
    const contract = usdtContract();
    const addr     = address.toLowerCase();

    if (apiKey) {
        // Polygonscan API — topic2 = endereço de destino com padding 32 bytes
        const topic2 = '0x' + addr.replace('0x', '').padStart(64, '0');
        const url = `https://api.polygonscan.com/api?module=logs&action=getLogs` +
            `&address=${contract}` +
            `&topic0=${TRANSFER_TOPIC}` +
            `&topic2=${topic2}` +
            `&topic0_2_opr=and` +
            `&page=1&offset=20` +
            `&apikey=${apiKey}`;

        const resp = await fetch(url, { signal });
        if (!resp.ok) throw new Error(`Polygonscan respondeu ${resp.status}`);
        const data = await safeJson(resp, 'Polygonscan');
        // status '0' com result [] = sem resultados — não é erro
        if (data.status !== '1' && Array.isArray(data.result) && data.result.length === 0) return [];
        if (data.status !== '1') throw new Error(`Polygonscan erro: ${data.message}`);
        return data.result || [];
    }

    // Fallback: eth_getLogs JSON-RPC (últimos 10.000 blocos ≈ ~5,5 horas)
    const currentBlock = await getCurrentBlock(signal);
    const fromBlock    = Math.max(0, currentBlock - 10_000);
    const topic2 = '0x' + addr.replace('0x', '').padStart(64, '0');

    const resp = await fetch(polygonRpc(), {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'eth_getLogs',
            params: [{
                fromBlock: '0x' + fromBlock.toString(16),
                toBlock:   'latest',
                address:   contract,
                topics:    [TRANSFER_TOPIC, null, topic2],
            }],
        }),
        signal,
    });
    if (!resp.ok) throw new Error(`eth_getLogs falhou: ${resp.status}`);
    const data = await safeJson(resp, 'eth_getLogs');
    if (data.error) throw new Error(`eth_getLogs erro: ${data.error.message}`);
    return data.result || [];
}

/**
 * Verifica se um pagamento USDT foi recebido e confirmado na Polygon.
 *
 * @param {string} address          — endereço EVM da carteira receptora
 * @param {number} expectedUsdt     — valor esperado em USDT
 * @param {number} minUsdt          — valor mínimo aceite (com margem ±10%)
 * @param {number} minConfirmations — confirmações mínimas (padrão: 128 ~4 min)
 * @returns {Promise<{found, confirmed, confirmations, needed, txHash, usdtValue, sufficient}>}
 */
export async function checkOnChainPayment(address, expectedUsdt, minUsdt, minConfirmations = 128) {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 20_000);

    try {
        const [logs, currentBlock] = await Promise.all([
            fetchTransferLogs(address, controller.signal),
            getCurrentBlock(controller.signal).catch(() => 0),
        ]);

        clearTimeout(timeout);

        for (const log of logs) {
            // Valor: campo `data` do log (uint256 não indexado)
            const rawValue  = log.data || '0x0';
            const usdtValue = Number(BigInt(rawValue)) / Math.pow(10, USDT_DECIMALS);

            if (usdtValue < minUsdt) continue;

            const txBlock       = parseInt(log.blockNumber, 16) || 0;
            const confirmations = currentBlock > 0 && txBlock > 0 ? currentBlock - txBlock : 0;
            const confirmed     = confirmations >= minConfirmations;

            return {
                found:          true,
                confirmed,
                confirmations,
                needed:         minConfirmations,
                txHash:         log.transactionHash || null,
                usdtValue,
                sufficient:     usdtValue >= minUsdt,
                blockNumber:    txBlock,
                blockTimestamp: log.timeStamp ? Number(log.timeStamp) * 1000 : null,
            };
        }

        return { found: false, confirmed: false, confirmations: 0, needed: minConfirmations, usdtValue: 0 };

    } catch (err) {
        clearTimeout(timeout);
        throw new Error(`Polygon chain check falhou: ${err.message}`);
    }
}
