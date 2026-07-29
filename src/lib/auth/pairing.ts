/// <reference types="@cloudflare/workers-types" />
// Device pairing records: a phone starts a pairing, a signed-in desktop approves
// it, the phone redeems it for a session.
//
// D1 rather than KV for the same reason nonce.ts gives: KV has no
// compare-and-delete, so a get-check-write would let two concurrent requests
// both succeed. Approval and redemption are each a single statement with
// RETURNING, which SQLite serializes, so each happens at most once.
//
// pairing_id locates a record, device_secret authenticates it. Keeping the two
// roles separate means the secret is never a lookup key, and the table can be
// keyed properly instead of scanned.

import { toBase64Url } from '../crypto/base64url.js';
import { bytesToHex } from '../crypto/hex.js';
import { generatePairingCode, normalizePairingCode } from './pairingCode.js';
import { normalizeSessionRoles } from './roles.js';

export const PAIRING_TTL_SEC = 600;

export interface PairingStart {
  pairingId: string;
  deviceSecret: string;
  code: string;
  expiresAt: number;
}

export type PollOutcome =
  | { status: 'pending' }
  | { status: 'consumed'; userId: string }
  | { status: 'unknown' };

/** SHA-256 of a UTF-8 string as lowercase hex, same helper shape as session.ts. */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return bytesToHex(new Uint8Array(digest));
}

/** 32 bytes of randomness as base64url, same shape as the session token. */
function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/**
 * Creates a pending pairing and returns its plain values, the only time they are
 * ever emitted. Only hashes are persisted. Expired rows are swept in the same
 * batch, mirroring issueNonce, so the table stays small without a cron.
 */
export async function createPairing(
  db: D1Database,
  opts: { userAgent?: string | null; now?: number },
): Promise<PairingStart> {
  const now = Math.floor(opts.now ?? Date.now() / 1000);
  const expiresAt = now + PAIRING_TTL_SEC;
  const pairingId = randomToken();
  const deviceSecret = randomToken();
  const secretHash = await sha256Hex(deviceSecret);

  // code_hash is UNIQUE. A collision with a live pairing is astronomically
  // unlikely, but retry once with a fresh code rather than failing the request.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const code = generatePairingCode();
    const codeHash = await sha256Hex(code);
    try {
      await db.batch([
        db.prepare('DELETE FROM device_pairings WHERE expires_at <= ?1').bind(now),
        db
          .prepare(
            `INSERT INTO device_pairings
               (pairing_id, code_hash, secret_hash, status, user_agent, created_at, expires_at)
             VALUES (?1, ?2, ?3, 'pending', ?4, ?5, ?6)`,
          )
          .bind(pairingId, codeHash, secretHash, opts.userAgent ?? null, now, expiresAt),
      ]);
      return { pairingId, deviceSecret, code, expiresAt };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Reads a pending pairing for the desktop confirmation step without changing it.
 * Returns null for unknown, already used and expired codes alike.
 */
export async function lookupPairing(
  db: D1Database,
  rawCode: string,
  opts?: { now?: number },
): Promise<{ userAgent: string | null; createdAt: number } | null> {
  const code = normalizePairingCode(rawCode);
  if (!code) return null;
  const now = Math.floor(opts?.now ?? Date.now() / 1000);
  const codeHash = await sha256Hex(code);
  const row = await db
    .prepare(
      `SELECT user_agent, created_at FROM device_pairings
        WHERE code_hash = ?1 AND status = 'pending' AND expires_at > ?2`,
    )
    .bind(codeHash, now)
    .first<{ user_agent: string | null; created_at: number }>();
  return row === null ? null : { userAgent: row.user_agent, createdAt: row.created_at };
}

/**
 * Approves a pending pairing, stamping the approver's user id and their role
 * cap. The cap is the CEILING the device can redeem, not the granted roles:
 * revocation-aware resolution (re-checking the account row against the current
 * allowlist) still happens at redemption, which then intersects that result
 * against this snapshot. Returns false for unknown, already approved and
 * expired codes alike.
 */
export async function approvePairing(
  db: D1Database,
  rawCode: string,
  userId: string,
  approverRoles: string[],
  opts?: { now?: number },
): Promise<boolean> {
  const code = normalizePairingCode(rawCode);
  if (!code) return false;
  const now = Math.floor(opts?.now ?? Date.now() / 1000);
  const codeHash = await sha256Hex(code);
  const approverRolesJson = JSON.stringify(normalizeSessionRoles(approverRoles));
  const row = await db
    .prepare(
      `UPDATE device_pairings
          SET status = 'approved', user_id = ?1, approver_roles = ?2
        WHERE code_hash = ?3 AND status = 'pending' AND expires_at > ?4
        RETURNING pairing_id`,
    )
    .bind(userId, approverRolesJson, codeHash, now)
    .first<{ pairing_id: string }>();
  return row !== null;
}

/**
 * Device-side poll. Reads first and only writes once the record is approved:
 * pending is by far the dominant case (hundreds of polls, one approval), so the
 * cheap path stays a single read.
 *
 * The presented secret is hashed and compared against the stored hash, so the
 * stored value is never itself a usable credential.
 */
export async function pollPairing(
  db: D1Database,
  pairingId: string,
  deviceSecret: string,
  opts?: { now?: number },
): Promise<PollOutcome> {
  const now = Math.floor(opts?.now ?? Date.now() / 1000);
  const secretHash = await sha256Hex(deviceSecret);

  const row = await db
    .prepare(
      `SELECT status, secret_hash FROM device_pairings
        WHERE pairing_id = ?1 AND expires_at > ?2`,
    )
    .bind(pairingId, now)
    .first<{ status: string; secret_hash: string }>();

  // Unknown id, expired record and wrong secret are all one answer to the caller.
  if (row === null || row.secret_hash !== secretHash) return { status: 'unknown' };
  if (row.status === 'pending') return { status: 'pending' };
  if (row.status !== 'approved') return { status: 'unknown' };

  // Single-winner gate: only the request that flips approved to consumed goes on
  // to mint a session, so two concurrent polls can never both succeed.
  const claimed = await db
    .prepare(
      `UPDATE device_pairings SET status = 'consumed'
        WHERE pairing_id = ?1 AND status = 'approved'
        RETURNING user_id`,
    )
    .bind(pairingId)
    .first<{ user_id: string | null }>();

  if (claimed === null || !claimed.user_id) return { status: 'unknown' };
  return { status: 'consumed', userId: claimed.user_id };
}
