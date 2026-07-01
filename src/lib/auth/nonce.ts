/// <reference types="@cloudflare/workers-types" />
// Single-use nonce issuance and consumption for challenge-response auth flows.
//
// Nonces live in D1 (not KV) so that consumption is atomic. KV has no
// compare-and-delete, so a get-check-delete would let two concurrent verifies
// carrying the same signed payload both succeed. In D1 the consume is a single
// DELETE ... RETURNING and SQLite serializes writes, so at most one concurrent
// request gets a row back. Rows carry a 5-minute expiry and are swept on issue.

import { toBase64Url } from '../crypto/base64url.js';

const NONCE_TTL_SEC = 300;
const PAYLOAD_PREFIX = 'dreptalk';

/**
 * Issues a new single-use nonce, stores it in D1, and returns the nonce and
 * its binding payload. Also sweeps expired rows so the table stays small.
 *
 * @param db - The D1 database.
 * @param opts.domain - Domain scope bound into the payload (prevents cross-domain replay).
 * @param opts.now - Override for current time in seconds (defaults to Date.now()/1000).
 */
export async function issueNonce(
  db: D1Database,
  opts: { domain: string; now?: number },
): Promise<{ nonce: string; payload: string }> {
  const issuedAt = Math.floor(opts.now ?? Date.now() / 1000);
  const rawBytes = new Uint8Array(32);
  crypto.getRandomValues(rawBytes);
  const nonce = toBase64Url(rawBytes);
  const payload = `${PAYLOAD_PREFIX}:${opts.domain}:${nonce}:${issuedAt}`;
  const expiresAt = issuedAt + NONCE_TTL_SEC;

  // Sweep expired rows (indexed, cheap) and insert the new nonce in one batch.
  await db.batch([
    db.prepare('DELETE FROM auth_nonces WHERE expires_at <= ?1').bind(issuedAt),
    db
      .prepare('INSERT INTO auth_nonces (nonce, payload, expires_at) VALUES (?1, ?2, ?3)')
      .bind(nonce, payload, expiresAt),
  ]);

  return { nonce, payload };
}

/**
 * Consumes a nonce payload: verifies it is well-formed and within the age
 * window, then atomically deletes it only if the stored nonce AND payload match
 * exactly. Returns true only for the single request that removes the row.
 * Never throws; returns false on any failure.
 *
 * @param db - The D1 database.
 * @param payload - The full payload string from the client (the signed message).
 * @param opts.now - Override for current time in seconds.
 * @param opts.maxAgeSec - Maximum allowed age of the nonce in seconds (default 300).
 */
export async function consumeNonce(
  db: D1Database,
  payload: string,
  opts?: { now?: number; maxAgeSec?: number },
): Promise<boolean> {
  try {
    const maxAge = opts?.maxAgeSec ?? NONCE_TTL_SEC;
    const now = Math.floor(opts?.now ?? Date.now() / 1000);

    // Parse payload shape: "dreptalk:<domain>:<nonce>:<issuedAt>".
    // Nonce is base64url (no colons); issuedAt is a decimal integer.
    // Domain may contain colons, so extract nonce and issuedAt from the ends.
    const [prefix, ...rest] = payload.split(':');
    if (prefix !== PAYLOAD_PREFIX) return false;
    if (rest.length < 3) return false;

    const issuedAtStr = rest[rest.length - 1];
    const nonce = rest[rest.length - 2];

    // Reject non-numeric issuedAt before parsing to prevent parseInt coercion surprises.
    if (!/^\d{1,15}$/.test(issuedAtStr)) return false;
    const issuedAt = parseInt(issuedAtStr, 10);
    if (!Number.isFinite(issuedAt)) return false;
    if (issuedAt > now) return false; // issued in the future
    if (now - issuedAt > maxAge) return false; // too old

    // Atomic single-use: delete only if the nonce AND full payload match. A
    // tampered payload (right nonce, altered domain/issuedAt) matches no row and
    // therefore never burns the stored nonce. RETURNING tells us whether this
    // request is the one that consumed it.
    const row = await db
      .prepare('DELETE FROM auth_nonces WHERE nonce = ?1 AND payload = ?2 RETURNING nonce')
      .bind(nonce, payload)
      .first<{ nonce: string }>();
    return row !== null;
  } catch {
    return false;
  }
}
