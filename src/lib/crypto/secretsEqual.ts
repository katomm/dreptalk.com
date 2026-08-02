/**
 * Constant-time string comparison for secret material (webhook tokens, API
 * keys). Both inputs are SHA-256 hashed first, so the byte-wise comparison
 * runs over fixed-length, attacker-unpredictable digests: a timing signal on
 * the digest bytes cannot be steered back to the secret. Portable across the
 * Workers and Node runtimes (no crypto.subtle.timingSafeEqual dependency).
 */
export async function secretsEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}
