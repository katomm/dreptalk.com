// CIP-8 / CIP-30 signData signature verifier.
// Verifies COSE_Sign1 structures produced by Cardano wallets.
import { decode, encode } from 'cborg';
import { blake2b224, blake2b256 } from '../crypto/blake.js';
import { hexToBytes } from '../crypto/hex.js';
import { bytesEqual } from '../crypto/bytes.js';
import { keyHashMatchesAddress } from '../cardano/identity.js';

export interface Cip8VerifyResult {
  ok: boolean;
  reason?: string; // why it failed (for logging, NOT leaked to clients)
  pubKey?: Uint8Array; // 32-byte Ed25519 pubkey (present when signature math validates)
  addressBytes?: Uint8Array; // raw address bytes from the protected header
}

// COSE algorithm label for EdDSA (-8 in CBOR integer space).
const ALG_EDDSA = -8;
// COSE key type for OKP (1).
const KTY_OKP = 1;
// COSE curve label for Ed25519 (6).
const CRV_ED25519 = 6;

/** Verifies a CIP-8 signData COSE_Sign1 structure against an expected payload. */
export async function verifyCip8(input: {
  signatureHex: string; // COSE_Sign1, hex
  keyHex: string; // COSE_Key, hex
  expectedPayload: string; // the exact server-issued payload string the user should have signed
}): Promise<Cip8VerifyResult> {
  try {
    return await verifyCip8Internal(input);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `internal error: ${reason}` };
  }
}

async function verifyCip8Internal(input: {
  signatureHex: string;
  keyHex: string;
  expectedPayload: string;
}): Promise<Cip8VerifyResult> {
  const { signatureHex, keyHex, expectedPayload } = input;

  // Step 1: Decode COSE_Sign1 array.
  let sigBytes: Uint8Array;
  try {
    sigBytes = hexToBytes(signatureHex);
  } catch {
    return { ok: false, reason: 'signatureHex is not valid hex' };
  }
  if (sigBytes.length === 0) {
    return { ok: false, reason: 'signatureHex is empty' };
  }

  let coseSign1: unknown;
  try {
    coseSign1 = decode(sigBytes, { useMaps: true });
  } catch (err: unknown) {
    return { ok: false, reason: `COSE_Sign1 CBOR decode failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!Array.isArray(coseSign1) || coseSign1.length !== 4) {
    return { ok: false, reason: `COSE_Sign1 must be a 4-element array, got ${Array.isArray(coseSign1) ? coseSign1.length : typeof coseSign1}` };
  }

  const [protectedBstr, unprotectedHeader, payloadBstr, sigBstr] = coseSign1;

  if (!(protectedBstr instanceof Uint8Array)) {
    return { ok: false, reason: 'COSE_Sign1[0] (protected) must be a bstr' };
  }
  if (payloadBstr !== null && !(payloadBstr instanceof Uint8Array)) {
    return { ok: false, reason: 'COSE_Sign1[2] (payload) must be a bstr or null' };
  }
  if (!(sigBstr instanceof Uint8Array)) {
    return { ok: false, reason: 'COSE_Sign1[3] (signature) must be a bstr' };
  }
  if (payloadBstr === null) {
    return { ok: false, reason: 'detached payload not supported' };
  }

  // Step 2: Decode COSE_Key and extract pubkey.
  let keyBytes: Uint8Array;
  try {
    keyBytes = hexToBytes(keyHex);
  } catch {
    return { ok: false, reason: 'keyHex is not valid hex' };
  }

  let coseKey: unknown;
  try {
    coseKey = decode(keyBytes, { useMaps: true });
  } catch (err: unknown) {
    return { ok: false, reason: `COSE_Key CBOR decode failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!(coseKey instanceof Map)) {
    return { ok: false, reason: 'COSE_Key must be a CBOR map' };
  }

  const kty = coseKey.get(1);
  const alg = coseKey.get(3);
  const crv = coseKey.get(-1);
  const pubKey = coseKey.get(-2);

  if (kty !== KTY_OKP) {
    return { ok: false, reason: `COSE_Key kty must be OKP (1), got ${kty}` };
  }
  if (alg !== ALG_EDDSA) {
    return { ok: false, reason: `COSE_Key alg must be EdDSA (-8), got ${alg}` };
  }
  if (crv !== CRV_ED25519) {
    return { ok: false, reason: `COSE_Key crv must be Ed25519 (6), got ${crv}` };
  }
  if (!(pubKey instanceof Uint8Array) || pubKey.length !== 32) {
    return { ok: false, reason: `COSE_Key x (-2) must be a 32-byte bstr, got ${pubKey instanceof Uint8Array ? pubKey.length + ' bytes' : typeof pubKey}` };
  }

  // Step 3: Decode protected header (double-encoded CBOR bstr).
  let protectedHeader: unknown;
  try {
    protectedHeader = decode(protectedBstr, { useMaps: true });
  } catch (err: unknown) {
    return { ok: false, reason: `protected header CBOR decode failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!(protectedHeader instanceof Map)) {
    return { ok: false, reason: 'protected header must be a CBOR map' };
  }

  const protectedAlg = protectedHeader.get(1);
  if (protectedAlg !== ALG_EDDSA) {
    return { ok: false, reason: `protected header alg must be EdDSA (-8), got ${protectedAlg}` };
  }

  const addressBytes = protectedHeader.get('address');
  if (!(addressBytes instanceof Uint8Array)) {
    return { ok: false, reason: 'protected header missing or invalid "address" field' };
  }

  // Step 4: Payload check.
  // Read hashed flag from unprotected header (default false).
  let hashed = false;
  if (unprotectedHeader instanceof Map) {
    const hashedFlag = unprotectedHeader.get('hashed');
    if (typeof hashedFlag === 'boolean') {
      hashed = hashedFlag;
    }
  } else if (typeof unprotectedHeader === 'object' && unprotectedHeader !== null) {
    const hashedFlag = (unprotectedHeader as Record<string, unknown>)['hashed'];
    if (typeof hashedFlag === 'boolean') {
      hashed = hashedFlag;
    }
  }

  const expectedPayloadBytes = new TextEncoder().encode(expectedPayload);

  if (!hashed) {
    if (!bytesEqual(payloadBstr, expectedPayloadBytes)) {
      return { ok: false, reason: 'payload does not match expected payload' };
    }
  } else {
    // TODO: verify hash variant with a hardware wallet; Blake2b-224 is used here but
    // different wallets may use Blake2b-256. Our browser fixtures use hashed=false so
    // this path is presently unexercised.
    const hashedPayload224 = blake2b224(expectedPayloadBytes);
    const hashedPayload256 = blake2b256(expectedPayloadBytes);
    if (!bytesEqual(payloadBstr, hashedPayload224) && !bytesEqual(payloadBstr, hashedPayload256)) {
      return { ok: false, reason: 'hashed payload does not match expected payload (tried Blake2b-224 and Blake2b-256)' };
    }
  }

  // Step 5: Build Sig_structure and encode.
  const sigStructure = ['Signature1', protectedBstr, new Uint8Array(0), payloadBstr];
  const toBeSigned = encode(sigStructure);

  // Step 6: Verify Ed25519 signature.
  const sigValid = await verifyEd25519(sigBstr, toBeSigned, pubKey);
  if (!sigValid.ok) {
    return { ok: false, reason: sigValid.reason };
  }

  // Step 7: Bind signature to address.
  if (!keyHashMatchesAddress(pubKey, addressBytes)) {
    return { ok: false, reason: 'pubkey hash does not match address in protected header' };
  }

  // Step 8: All checks passed.
  return { ok: true, pubKey, addressBytes };
}

/** Attempts Ed25519 signature verification, trying WebCrypto then noble/curves fallback. */
async function verifyEd25519(
  sig: Uint8Array,
  msg: Uint8Array,
  pubKey: Uint8Array,
): Promise<{ ok: boolean; reason?: string }> {
  // Ensure all buffers are backed by a plain ArrayBuffer (not SharedArrayBuffer),
  // which is required by the WebCrypto BufferSource type.
  const pubKeyBuf: Uint8Array<ArrayBuffer> = new Uint8Array(pubKey);
  const sigBuf: Uint8Array<ArrayBuffer> = new Uint8Array(sig);
  const msgBuf: Uint8Array<ArrayBuffer> = new Uint8Array(msg);

  // Try WebCrypto 'Ed25519' first.
  try {
    const key = await crypto.subtle.importKey('raw', pubKeyBuf, 'Ed25519', false, ['verify']);
    const valid = await crypto.subtle.verify('Ed25519', key, sigBuf, msgBuf);
    return valid ? { ok: true } : { ok: false, reason: 'Ed25519 signature verification failed (WebCrypto)' };
  } catch (webcryptoErr: unknown) {
    const webcryptoMsg = webcryptoErr instanceof Error ? webcryptoErr.message : String(webcryptoErr);
    // WebCrypto 'Ed25519' unavailable; try 'NODE-ED25519'.
    try {
      const key = await crypto.subtle.importKey(
        'raw',
        pubKeyBuf,
        { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' } as AlgorithmIdentifier,
        false,
        ['verify'],
      );
      const valid = await crypto.subtle.verify('NODE-ED25519', key, sigBuf, msgBuf);
      return valid ? { ok: true } : { ok: false, reason: 'Ed25519 signature verification failed (NODE-ED25519)' };
    } catch {
      // Both WebCrypto paths failed; fall back to @noble/curves.
      try {
        const { ed25519 } = await import('@noble/curves/ed25519.js');
        const valid = ed25519.verify(sig, msg, pubKey);
        return valid
          ? { ok: true }
          : { ok: false, reason: 'Ed25519 signature verification failed (@noble/curves fallback)' };
      } catch (nobleErr: unknown) {
        const nobleMsg = nobleErr instanceof Error ? nobleErr.message : String(nobleErr);
        return {
          ok: false,
          reason: `Ed25519 verification unavailable. WebCrypto: ${webcryptoMsg}; noble/curves: ${nobleMsg}`,
        };
      }
    }
  }
}

