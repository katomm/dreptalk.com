/// <reference types="@cloudflare/workers-types" />
// One-time codes that tie a "Connect Telegram" click to the /start message the
// bot later receives. Stored in the existing SESSIONS KV namespace under a
// tglink: prefix with a short TTL; consuming a code deletes it, so each code
// links at most one chat.

import { toBase64Url } from '../crypto/base64url.js';

export const LINK_CODE_TTL_SECONDS = 900; // 15 minutes

const keyFor = (code: string) => `tglink:${code}`;

/** Issues a fresh single-use code for the user and stores it with a 15-minute TTL. */
export async function issueLinkCode(kv: KVNamespace, userId: string): Promise<string> {
  // 32 random bytes -> 43 base64url chars, comfortably inside Telegram's
  // 64-char limit for the /start payload.
  const code = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  await kv.put(keyFor(code), userId, { expirationTtl: LINK_CODE_TTL_SECONDS });
  return code;
}

/** Resolves a code to its user id and burns it; null for unknown or already-used codes. */
export async function consumeLinkCode(kv: KVNamespace, code: string): Promise<string | null> {
  const key = keyFor(code);
  const userId = await kv.get(key);
  if (userId === null) return null;
  await kv.delete(key);
  return userId;
}
