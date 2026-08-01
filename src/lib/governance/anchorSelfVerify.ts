// Pre-submit self-verification of a just-hosted anchor document.
//
// Our own vote-rationale and DRep-metadata publish paths compute the on-chain
// anchor hash over the exact bytes they store and serve, so hash and document
// agree by construction. This is a defense-in-depth guard for the instant before
// the wallet signs: the anchor hash is committed on-chain irreversibly, so we
// re-fetch the URL we are about to commit and confirm its bytes still hash to
// the hash we are about to sign. A genuine mismatch aborts the submit; a
// transient unavailability (the freshly written document not yet readable at the
// edge) does not block the action, since the server already hashed exactly the
// bytes it stored, so unavailable is not evidence of a bad anchor.
import { blake2b256 } from '@/lib/crypto/blake.js';
import { bytesToHex } from '@/lib/crypto/hex.js';

export type AnchorSelfVerify =
  | 'ok' // fetched bytes hash to the expected anchor hash
  | 'mismatch' // fetched bytes hash to something else: do NOT commit this anchor
  | 'unavailable'; // could not fetch after retries: inconclusive, do not block on it

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Re-fetches a hosted anchor document and checks that its bytes hash to
 * `expectedHash` (the value about to be committed on-chain). A mismatch is
 * returned immediately (content is address-stable, so retrying cannot change
 * it); a fetch failure is retried a few times before giving up as 'unavailable',
 * because a document written moments ago may not be readable at every edge yet.
 */
export async function verifyHostedAnchor(
  url: string,
  expectedHash: string,
  opts: { fetchImpl?: typeof fetch; attempts?: number; timeoutMs?: number; backoffMs?: number } = {},
): Promise<AnchorSelfVerify> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const attempts = Math.max(opts.attempts ?? 3, 1);
  const timeoutMs = opts.timeoutMs ?? 5000;
  const backoffMs = opts.backoffMs ?? 300;
  const want = expectedHash.trim().toLowerCase();

  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } });
      if (res.ok) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        return bytesToHex(blake2b256(bytes)).toLowerCase() === want ? 'ok' : 'mismatch';
      }
      // Non-2xx (e.g. 404/5xx) can be transient read-after-write propagation: retry.
    } catch {
      // Network error or timeout: retry.
    } finally {
      clearTimeout(timer);
    }
    if (attempt < attempts - 1 && backoffMs > 0) await sleep(backoffMs);
  }
  return 'unavailable';
}
