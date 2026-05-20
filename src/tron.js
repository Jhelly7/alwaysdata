// alwaysdata/src/tron.js — HD Wallet Derivation
// Extraído de routes/payments.js (EdgeOne) — roda no Node.js completo do AlwaysData.
// tiny-secp256k1 (binário nativo C) funciona aqui sem restrições.

import { mnemonicToSeedSync, validateMnemonic } from 'bip39';
import { BIP32Factory } from 'bip32';
import ecc              from 'tiny-secp256k1';   // FIX: default import directo — evita eccModule.default ?? eccModule que pode devolver Module{} em ESM puro
import { TronWeb }      from 'tronweb';

const bip32 = BIP32Factory(ecc);

function getMnemonic() {
    const plain = process.env.TRON_MNEMONIC;
    if (plain) return plain;
    const b64 = process.env.TRON_MNEMONIC_B64;
    if (b64) return Buffer.from(b64, 'base64').toString('utf8').trim();
    return null;
}

function tronFullNode()  { return process.env.TRON_FULL_NODE || 'https://api.trongrid.io'; }
function tronHeaders()   {
    const h = { 'Content-Type': 'application/json' };
    const k = process.env.TRON_API_KEY;
    if (k) h['TRON-PRO-API-KEY'] = k;
    return h;
}

/**
 * Derives a TRON address at the given HD index.
 * @param {number} index — BIP44 child index (m/44'/195'/0'/0/{index})
 * @returns {{ address: string, index: number }}
 */
export async function deriveAddress(index) {
    const mnemonic = getMnemonic();
    if (!mnemonic) throw new Error('TRON_MNEMONIC is not configured.');
    if (!validateMnemonic(mnemonic)) throw new Error('TRON_MNEMONIC is invalid');

    const seed  = mnemonicToSeedSync(mnemonic);
    const root  = bip32.fromSeed(seed);
    const child = root.derivePath(`m/44'/195'/0'/0/${index}`);
    if (!child.privateKey) throw new Error('HD derivation failed');

    const privateKeyHex = child.privateKey.toString('hex');

    const tronWeb = new TronWeb({
        fullHost:   tronFullNode(),
        headers:    tronHeaders(),
        privateKey: privateKeyHex,
    });

    const address = tronWeb.address.fromPrivateKey(privateKeyHex);

    // Zero out private key from memory
    child.privateKey.fill(0);

    return { address, index };
}