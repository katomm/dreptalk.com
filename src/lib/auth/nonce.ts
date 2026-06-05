/// <reference types="@cloudflare/workers-types" />
// Single-use nonce issuance and consumption for challenge-response auth flows.
// Nonces are stored in KV with a 5-minute TTL and deleted on first use.

import { toBase64Url } from '../crypto/base64url.js';

const NONCE_TTL_SEC = 300;
const PAYLOAD_PREFIX = 'dreptalk';

/**
 * Issues a new single-use nonce, stores it in KV, and returns the nonce and
 * its binding payload.
 *
 * @param kv - The KV namespace to store the nonce in.
 * @param opts.domain - Domain scope bound into the payload (prevents cross-domain replay).
 * @param opts.now - Override for current time in seconds (defaults to Date.now()/1000).
 */
export async function issueNonce(
  kv: KVNamespace,
  opts: { domain: string; now?: number },
): Promise<{ nonce: string; payload: string }> {
  const issuedAt = Math.floor(opts.now ?? Date.now() / 1000);
  const rawBytes = new Uint8Array(32);
  crypto.getRandomValues(rawBytes);
  const nonce = toBase64Url(rawBytes);
  const payload = `${PAYLOAD_PREFIX}:${opts.domain}:${nonce}:${issuedAt}`;
  await kv.put(nonce, payload, { expirationTtl: NONCE_TTL_SEC });
  return { nonce, payload };
}

/**
 * Consumes a nonce payload: verifies it exists in KV, matches the stored
 * value exactly, and is within the allowed age window. Deletes the key on
 * success (single-use enforcement). Never throws; returns false on any failure.
 *
 * @param kv - The KV namespace containing stored nonces.
 * @param payload - The full payload string from the client (e.g. the signed message).
 * @param opts.now - Override for current time in seconds.
 * @param opts.maxAgeSec - Maximum allowed age of the nonce in seconds (default 300).
 */
export async function consumeNonce(
  kv: KVNamespace,
  payload: string,
  opts?: { now?: number; maxAgeSec?: number },
): Promise<boolean> {
  try {
    const maxAge = opts?.maxAgeSec ?? NONCE_TTL_SEC;
    const now = Math.floor(opts?.now ?? Date.now() / 1000);

    // Parse and validate payload shape: "dreptalk:<domain>:<nonce>:<issuedAt>"
    const parts = payload.split(':');
    if (parts.length < 4) return false;

    // The nonce itself may contain base64url characters but no colons, so
    // we take index 0, 1, last-1 (nonce), last (issuedAt) -- but domain can
    // contain colons too. Re-split from the right to be robust.
    // Payload: "dreptalk:<domain>:<nonce>:<issuedAt>"
    // Guarantee: nonce is base64url (no colons), issuedAt is a decimal integer.
    // Split off prefix, issuedAt, and nonce from the right; domain is whatever is in the middle.
    const [prefix, ...rest] = payload.split(':');
    if (prefix !== PAYLOAD_PREFIX) return false;
    if (rest.length < 3) return false;

    const issuedAtStr = rest[rest.length - 1];
    const nonce = rest[rest.length - 2];
    // domain = rest[0..rest.length-3] joined by ":"
    // (simple domain strings won't have colons, but this keeps the split logic safe)

    // Reject non-numeric issuedAt before parsing to prevent parseInt coercion surprises.
    if (!/^\d{1,15}$/.test(issuedAtStr)) return false;
    const issuedAt = parseInt(issuedAtStr, 10);
    if (!Number.isFinite(issuedAt)) return false;
    if (issuedAt > now) return false; // issued in the future
    if (now - issuedAt > maxAge) return false; // too old

    // Look up nonce in KV and verify stored payload matches exactly.
    const stored = await kv.get(nonce);
    if (stored === null) return false;
    if (stored !== payload) return false;

    // Single-use: delete before returning success.
    await kv.delete(nonce);
    return true;
  } catch {
    return false;
  }
}
