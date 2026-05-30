// alwaysdata/src/qr.js — QR Code Generation (Polygon / EVM)
// ─────────────────────────────────────────────────────────────────────────────
// Gera QR code EIP-681 para transferência de ERC-20 (USDT Polygon).
// URI format: ethereum:<token_address>@<chainId>/transfer?address=<recipient>&uint256=<amount_in_wei>
//
// Polygon Mainnet chainId: 137
// USDT no Polygon (PoS): 0xc2132D05D31c914a87C6611C10748AEb04B58e8F
// ─────────────────────────────────────────────────────────────────────────────

import QRCode from 'qrcode';

function usdtContract() {
    return process.env.USDT_CONTRACT || '0xc2132D05D31c914a87C6611C10748AEb04B58e8F';
}

function chainId() {
    return parseInt(process.env.POLYGON_CHAIN_ID || '137', 10);
}

/**
 * Converte valor USDT (6 decimais no Polygon) para uint256 string.
 * Usa arredondamento para evitar imprecisão de float.
 */
function usdtToWei(amountUsdt) {
    return BigInt(Math.round(amountUsdt * 1_000_000)).toString();
}

/**
 * Gera QR code EIP-681 para pagamento USDT no Polygon.
 *
 * @param {string} address    — endereço EVM da carteira receptora
 * @param {number} amountUsdt — valor em USDT
 * @returns {Promise<string>} base64 data URL do QR
 */
export async function generateQRCode(address, amountUsdt) {
    const contract = usdtContract();
    const cid      = chainId();
    const amount   = usdtToWei(amountUsdt);

    // EIP-681: ethereum:<contract>@<chainId>/transfer?address=<recipient>&uint256=<amount>
    const uri = `ethereum:${contract}@${cid}/transfer?address=${address}&uint256=${amount}`;

    return QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', width: 256 });
}