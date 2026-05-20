// alwaysdata/src/polygon.js — HD Wallet Derivation for Polygon (EVM)
// ─────────────────────────────────────────────────────────────────────────────
// Substitui tron.js. Mesma lógica de derivação BIP32/BIP39, mas:
//   • BIP44 coin type 60 (Ethereum/Polygon):  m/44'/60'/0'/0/{index}
//   • endereço é EVM (0x...) — derivado com ethers.js ou secp256k1 puro
//   • sem dependência de tronweb
// ─────────────────────────────────────────────────────────────────────────────

import { mnemonicToSeedSync, validateMnemonic } from 'bip39';
import { BIP32Factory } from 'bip32';
import * as eccModule from 'tiny-secp256k1';
// tiny-secp256k1 pode exportar como default ou como named exports consoante o bundler/runtime.
// Esta forma é compatível com ESM puro (Node ≥18) e com CJS interop.
const ecc = eccModule.default ?? eccModule;
import { keccak256 } from 'ethereum-cryptography/keccak.js';

const bip32 = BIP32Factory(ecc);

function getMnemonic() {
    const plain = process.env.WALLET_MNEMONIC || process.env.TRON_MNEMONIC;
    if (plain) return plain;
    const b64 = process.env.WALLET_MNEMONIC_B64 || process.env.TRON_MNEMONIC_B64;
    if (b64) return Buffer.from(b64, 'base64').toString('utf8').trim();
    return null;
}

/**
 * Converte uma chave pública comprimida (33 bytes) para endereço EVM (0x...).
 * Usa Keccak-256 nos últimos 64 bytes da chave pública não-comprimida.
 */
function publicKeyToEVMAddress(compressedPublicKey) {
    // ecc.pointCompress(point, compressed=false) descomprime uma chave pública existente (33→65 bytes).
    // ATENÇÃO: ecc.pointFromScalar() espera uma chave PRIVADA (escalar) — NÃO usar aqui,
    //          causaria TypeError: Expected Private em runtime e zero endereços seriam derivados.
    const uncompressed = ecc.pointCompress(compressedPublicKey, false);
    if (!uncompressed) throw new Error('Falha ao descomprimir chave pública');

    // Keccak-256 dos bytes 1–64 (ignora o prefixo 0x04)
    const pubKeyBytes = uncompressed.slice(1); // 64 bytes
    const hash = keccak256(pubKeyBytes);        // 32 bytes

    // Endereço = últimos 20 bytes do hash
    const addressBytes = hash.slice(-20);
    const hex = Buffer.from(addressBytes).toString('hex');

    // EIP-55 checksum
    return toChecksumAddress('0x' + hex);
}

/**
 * EIP-55 checksum address.
 */
function toChecksumAddress(address) {
    const lower = address.toLowerCase().replace('0x', '');
    const hashBytes = keccak256(Buffer.from(lower, 'utf8'));
    const hash = Buffer.from(hashBytes).toString('hex');
    let result = '0x';
    for (let i = 0; i < lower.length; i++) {
        result += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
    }
    return result;
}

/**
 * Deriva um endereço Polygon/EVM no índice HD dado.
 * Caminho BIP44: m/44'/60'/0'/0/{index}
 *
 * @param {number} index — índice filho BIP44
 * @returns {{ address: string, index: number }}
 */
export async function deriveAddress(index) {
    const mnemonic = getMnemonic();
    if (!mnemonic) throw new Error('WALLET_MNEMONIC não está configurado.');
    if (!validateMnemonic(mnemonic)) throw new Error('WALLET_MNEMONIC é inválido');

    const seed  = mnemonicToSeedSync(mnemonic);
    const root  = bip32.fromSeed(seed);
    const child = root.derivePath(`m/44'/60'/0'/0/${index}`);
    if (!child.publicKey) throw new Error('Falha na derivação HD');

    const address = publicKeyToEVMAddress(child.publicKey);

    return { address, index };
}