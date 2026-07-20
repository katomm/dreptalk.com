/// <reference types="@cloudflare/workers-types" />
// Opaque KV session storage with sliding TTL and per-user revocation.
// Tokens are stored hashed so a KV dump never yields usable bearer tokens.

import { toBase64Url } from '../crypto/base64url.js';
import { bytesToHex } from '../crypto/hex.js';

const SESSION_TTL_SEC = 2_592_000; // 30 days
const SLIDING_WINDOW_SEC = 21_600; // 6 hours
const SESSION_COOKIE_NAME = 'dreptalk_session';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionRecord {
  userId: string;
  roles: string[];
  /**
   * The user's own drep_id, cached on the session so callers can resolve the
   * logged-in DRep without a per-request D1 read. It is immutable for the
   * session lifetime (drep_id is written once via COALESCE). null means the
   * user has no drep_id; undefined means a legacy session minted before this
   * field existed (callers fall back to a DB read for those).
   */
  drepId?: string | null;
  createdAt: number;
  lastSeen: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns the SHA-256 digest of a UTF-8 string as a lowercase hex string. */
async function sha256hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return bytesToHex(new Uint8Array(digest));
}

/** KV key for a session record, derived from the token hash. */
function sessKey(keyHash: string): string {
  return `sess:${keyHash}`;
}

/** KV key for the per-user session index. */
function usessKey(userId: string): string {
  return `usess:${userId}`;
}

/**
 * Reads the per-user session hash index from KV.
 * Returns an empty array if the key is absent or the stored value is corrupt JSON.
 */
async function readHashIndex(kv: KVNamespace, userId: string): Promise<string[]> {
  const raw = await kv.get(usessKey(userId));
  if (raw === null) return [];
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/**
 * Creates a new session for a user. Returns the opaque bearer token.
 * The token itself is never stored; only its SHA-256 hash is used as a KV key.
 *
 * @param kv - The SESSIONS KV namespace.
 * @param user - User identity.
 * @param opts.now - Override for current Unix time in seconds.
 */
export async function createSession(
  kv: KVNamespace,
  user: { id: string; roles: string[]; drepId?: string | null },
  opts?: { now?: number },
): Promise<string> {
  const now = Math.floor(opts?.now ?? Date.now() / 1000);
  const rawBytes = new Uint8Array(32);
  crypto.getRandomValues(rawBytes);
  const token = toBase64Url(rawBytes);
  const keyHash = await sha256hex(token);

  const record: SessionRecord = {
    userId: user.id,
    roles: user.roles,
    // Store the field explicitly (null when absent) so getSelfDrepId can tell a
    // known "no drep_id" from a legacy session that predates this field.
    drepId: user.drepId ?? null,
    createdAt: now,
    lastSeen: now,
  };

  // Store session record and read per-user index concurrently (different keys).
  const [, hashes] = await Promise.all([
    kv.put(sessKey(keyHash), JSON.stringify(record), { expirationTtl: SESSION_TTL_SEC }),
    readHashIndex(kv, user.id),
  ]);

  // Append new hash and write updated index.
  hashes.push(keyHash);
  await kv.put(usessKey(user.id), JSON.stringify(hashes), { expirationTtl: SESSION_TTL_SEC });

  return token;
}

/**
 * Retrieves a session record by token. Returns null if the token is unknown.
 * Lazily refreshes lastSeen (and resets the TTL) at most once per 6 hours.
 *
 * @param kv - The SESSIONS KV namespace.
 * @param token - The opaque bearer token.
 * @param opts.now - Override for current Unix time in seconds.
 */
export async function getSession(
  kv: KVNamespace,
  token: string,
  opts?: { now?: number },
): Promise<SessionRecord | null> {
  try {
    const now = Math.floor(opts?.now ?? Date.now() / 1000);
    const keyHash = await sha256hex(token);
    const raw = await kv.get(sessKey(keyHash));
    if (raw === null) return null;

    const record: SessionRecord = JSON.parse(raw) as SessionRecord;

    // Lazy sliding renewal: refresh at most once per 6-hour window.
    if (now - record.lastSeen > SLIDING_WINDOW_SEC) {
      record.lastSeen = now;
      // Session re-put and index read are independent (different keys): run concurrently.
      const [, indexRaw] = await Promise.all([
        kv.put(sessKey(keyHash), JSON.stringify(record), { expirationTtl: SESSION_TTL_SEC }),
        kv.get(usessKey(record.userId)),
      ]);
      // Also refresh the per-user index TTL so it never expires before live sessions.
      if (indexRaw !== null) {
        await kv.put(usessKey(record.userId), indexRaw, { expirationTtl: SESSION_TTL_SEC });
      }
    }

    return record;
  } catch {
    return null;
  }
}

/**
 * Revokes a single session by deleting its KV record and removing the hash
 * from the per-user index to prevent unbounded index growth.
 *
 * @param kv - The SESSIONS KV namespace.
 * @param token - The opaque bearer token to revoke.
 */
export async function revokeSession(kv: KVNamespace, token: string): Promise<void> {
  const keyHash = await sha256hex(token);
  // Read the record first so we know which user's index to prune.
  const raw = await kv.get(sessKey(keyHash));
  await kv.delete(sessKey(keyHash));
  if (raw !== null) {
    try {
      const record = JSON.parse(raw) as SessionRecord;
      const hashes = await readHashIndex(kv, record.userId);
      const pruned = hashes.filter(h => h !== keyHash);
      if (pruned.length > 0) {
        await kv.put(usessKey(record.userId), JSON.stringify(pruned), {
          expirationTtl: SESSION_TTL_SEC,
        });
      } else {
        await kv.delete(usessKey(record.userId));
      }
    } catch {
      // If we cannot parse the record the session key is already deleted; nothing more to do.
    }
  }
}

/**
 * Revokes all sessions for a user by reading their index and deleting every
 * session record, then removing the index itself.
 *
 * Note: the read-modify-write on the per-user index is not atomic. A concurrent
 * createSession during revokeAllForUser may result in the new session surviving
 * or the index entry being lost. This is an acceptable race for the use-case
 * (logout-all; the new session was created after the logout intent).
 *
 * @param kv - The SESSIONS KV namespace.
 * @param userId - The user whose sessions should all be revoked.
 */
export async function revokeAllForUser(kv: KVNamespace, userId: string): Promise<void> {
  const raw = await kv.get(usessKey(userId));
  if (!raw) return;
  // On corrupt index: delete the index key and return; nothing safely revocable.
  let hashes: string[];
  try {
    hashes = JSON.parse(raw) as string[];
  } catch {
    await kv.delete(usessKey(userId));
    return;
  }
  await Promise.all(hashes.map(h => kv.delete(sessKey(h))));
  await kv.delete(usessKey(userId));
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

/**
 * Builds a Set-Cookie header value for the session token.
 * Flags: HttpOnly, SameSite=Lax, Path=/, Max-Age=30d, and Secure by default.
 * The caller passes secure:false for local http dev so the session cookie is set over http://localhost.
 */
export function buildSessionCookie(token: string, opts?: { secure?: boolean }): string {
  const secureFlag = opts?.secure !== false ? '; Secure' : '';
  return `${SESSION_COOKIE_NAME}=${token}; HttpOnly${secureFlag}; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SEC}`;
}

/**
 * Builds a Set-Cookie header value that clears the session cookie.
 */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/**
 * Parses the session token from a Cookie header value.
 * Returns null if the cookie is absent or the header is null.
 *
 * @param cookieHeader - The raw Cookie header string (e.g. from request.headers.get('Cookie')).
 */
export function parseSessionToken(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...valueParts] = part.trim().split('=');
    if (name.trim() === SESSION_COOKIE_NAME) {
      return valueParts.join('=').trim() || null;
    }
  }
  return null;
}
