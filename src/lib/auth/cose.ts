// CIP-8 / CIP-30 signData signature verifier.
// Verifies COSE_Sign1 structures produced by Cardano wallets.
import { decode, encode } from 'cborg';
import { blake2b224, blake2b256 } from '../crypto/blake.js';
import { hexToBytes } from '../crypto/hex.js';
import { bytesEqual } from '../crypto/bytes.js';
import { verifyEd25519 } from '../crypto/ed25519.js';
import { keyHashMatchesAddress } from '../cardano/identity.js';

export interface Cip8VerifyResult extends CoseSign1VerifyResult {
  pubKey?: Uint8Array; // 32-byte Ed25519 pubkey (present when signature math validates)
}

// COSE algorithm label for EdDSA (-8 in CBOR integer space).
const ALG_EDDSA = -8;
// COSE key type for OKP (1).
const KTY_OKP = 1;
// COSE curve label for Ed25519 (6).
const CRV_ED25519 = 6;

/** Result of verifying a COSE_Sign1 structure's math + payload against a raw pubkey. */
export interface CoseSign1VerifyResult {
  ok: boolean;
  reason?: string;
  addressBytes?: Uint8Array; // raw address bytes from the protected header
}

/**
 * Verifies a COSE_Sign1 structure's signature math and payload against a RAW
 * (already-extracted) Ed25519 public key. This is the CIP-0008 core shared by:
 *  - `verifyCip8` below (decodes a wallet COSE_Key first, then calls this with
 *    `allowHashed: true` to tolerate hardware-wallet Blake2b payload hashing);
 *  - the CIP-108 author-witness verifiers in `src/lib/governance/authorWitness.ts`
 *    (which supply a raw pubkey directly, no COSE_Key involved).
 *
 * Does not bind the key to the address; callers that need that binding (e.g.
 * `verifyCip8`) must do it themselves using the returned `addressBytes`.
 */
export async function verifyCoseSign1(input: {
  signatureHex: string; // COSE_Sign1, hex
  publicKey: Uint8Array; // raw 32-byte Ed25519 public key
  expectedPayloadBytes: Uint8Array; // the exact bytes the signer should have signed
  allowHashed?: boolean; // tolerate hashed=true (Blake2b-224/256 of expectedPayloadBytes); default false
}): Promise<CoseSign1VerifyResult> {
  try {
    return await verifyCoseSign1Internal(input);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `internal error: ${reason}` };
  }
}

async function verifyCoseSign1Internal(input: {
  signatureHex: string;
  publicKey: Uint8Array;
  expectedPayloadBytes: Uint8Array;
  allowHashed?: boolean;
}): Promise<CoseSign1VerifyResult> {
  const { signatureHex, publicKey, expectedPayloadBytes, allowHashed = false } = input;

  if (publicKey.length !== 32) {
    return { ok: false, reason: `publicKey must be 32 bytes, got ${publicKey.length}` };
  }

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

  // Step 2: Decode protected header (double-encoded CBOR bstr).
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

  // Step 3: Payload check.
  // Read hashed flag from unprotected header (default false).
  let hashed = false;
  if (unprotectedHeader instanceof Map) {
    const hashedFlag = unprotectedHeader.get('hashed');
    if (typeof hashedFlag === 'boolean') {
      hashed = hashedFlag;
    }
  } else if (typeof unprotectedHeader === 'object' && unprotectedHeader !== null) {
    const hashedFlag = (unprotectedHeader as Record<string, unknown>).hashed;
    if (typeof hashedFlag === 'boolean') {
      hashed = hashedFlag;
    }
  }

  if (hashed && !allowHashed) {
    return { ok: false, reason: 'hashed=true not supported for this verification path' };
  }

  if (!hashed) {
    if (!bytesEqual(payloadBstr, expectedPayloadBytes)) {
      return { ok: false, reason: 'payload does not match expected payload' };
    }
  } else {
    // Hardware wallets (e.g. Ledger) sign a Blake2b hash of the payload and set
    // hashed=true; this path is production-proven by real hardware-wallet logins.
    // Wallets differ in digest size, so both Blake2b-224 and Blake2b-256 are accepted.
    const hashedPayload224 = blake2b224(expectedPayloadBytes);
    const hashedPayload256 = blake2b256(expectedPayloadBytes);
    if (!bytesEqual(payloadBstr, hashedPayload224) && !bytesEqual(payloadBstr, hashedPayload256)) {
      return { ok: false, reason: 'hashed payload does not match expected payload (tried Blake2b-224 and Blake2b-256)' };
    }
  }

  // Step 4: Build Sig_structure and encode.
  const sigStructure = ['Signature1', protectedBstr, new Uint8Array(0), payloadBstr];
  const toBeSigned = encode(sigStructure);

  // Step 5: Verify Ed25519 signature.
  const sigValid = await verifyEd25519(sigBstr, toBeSigned, publicKey);
  if (!sigValid.ok) {
    return { ok: false, reason: sigValid.reason };
  }

  // Step 6: All checks passed.
  return { ok: true, addressBytes };
}

/**
 * Decodes a wallet CIP-30 signData COSE_Key (hex CBOR) to its raw 32-byte
 * Ed25519 public key, validating kty=OKP, alg=EdDSA, crv=Ed25519. Shared by the
 * login path (`verifyCip8`) and the CIP-108 author-witness path so both enforce
 * the same COSE_Key policy.
 */
export function decodeCoseKeyPubKey(
  keyHex: string,
): { ok: true; pubKey: Uint8Array } | { ok: false; reason: string } {
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
    return { ok: false, reason: `COSE_Key x (-2) must be a 32-byte bstr, got ${pubKey instanceof Uint8Array ? `${pubKey.length} bytes` : typeof pubKey}` };
  }

  return { ok: true, pubKey };
}

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

  // Step 1: Decode + validate the wallet COSE_Key, extracting the raw pubkey.
  const decoded = decodeCoseKeyPubKey(keyHex);
  if (!decoded.ok) {
    return { ok: false, reason: decoded.reason };
  }
  const pubKey = decoded.pubKey;

  // Step 2: Verify the COSE_Sign1 math + payload via the shared Sign1 core.
  // allowHashed: true tolerates hardware-wallet Blake2b payload hashing, matched
  // against the UTF-8 bytes of expectedPayload (a plain login-nonce string).
  const res = await verifyCoseSign1({
    signatureHex,
    publicKey: pubKey,
    expectedPayloadBytes: new TextEncoder().encode(expectedPayload),
    allowHashed: true,
  });
  if (!res.ok || !res.addressBytes) {
    return { ok: false, reason: res.reason };
  }

  // Step 3: Bind signature to address.
  if (!keyHashMatchesAddress(pubKey, res.addressBytes)) {
    return { ok: false, reason: 'pubkey hash does not match address in protected header' };
  }

  // Step 4: All checks passed.
  return { ok: true, pubKey, addressBytes: res.addressBytes };
}

