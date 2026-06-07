// Pure, dependency-injected logic for the offline (paste) login flow used by
// SPOs (Calidus key) and CC members. No DOM imports; fully testable in Node.js
// with an injected fetch.
//
// The user signs the server's challenge offline with cardano-signer:
//   cardano-signer sign --data "<payload>" --secret-key calidus.skey --json
// which prints { "signature": "<hex>", "publicKey": "<hex>" }. They paste that
// output back; we parse it, then POST the raw signature + public key to verify.

import { isHexExact, RAW_SIG_HEX_LEN, RAW_PUBKEY_HEX_LEN } from '../validation/input.js';

export type OfflineRole = 'spo' | 'cc';

export interface SignerOutput {
  signatureHex: string;
  publicKeyHex: string;
}

export interface LoginResult {
  ok: boolean;
  user?: { id: string; roles: string[] };
  error?: string;
}

interface Deps {
  fetchImpl?: typeof fetch;
}

/**
 * Extracts a raw Ed25519 signature (64 bytes) and public key (32 bytes) from
 * whatever the user pasted. Accepts cardano-signer's JSON output
 * ({signature, publicKey} or {signatureHex, publicKeyHex}) or two bare hex
 * strings in any order (disambiguated by length). Returns null if a valid pair
 * cannot be found, so the caller never sends junk to the server.
 */
export function parseSignerOutput(text: string): SignerOutput | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // JSON output from cardano-signer --json.
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const sig = firstString(obj.signature, obj.signatureHex);
      const pub = firstString(obj.publicKey, obj.publicKeyHex, obj.pubKey);
      if (sig && pub) {
        const out = { signatureHex: sig.toLowerCase(), publicKeyHex: pub.toLowerCase() };
        return isValidPair(out) ? out : null;
      }
      return null;
    } catch {
      return null;
    }
  }

  // Freeform: pick the hex run of signature length and the one of pubkey length.
  const runs = trimmed.toLowerCase().match(/[0-9a-f]+/g) ?? [];
  const sig = runs.find((r) => r.length === RAW_SIG_HEX_LEN);
  const pub = runs.find((r) => r.length === RAW_PUBKEY_HEX_LEN);
  if (sig && pub) {
    const out = { signatureHex: sig, publicKeyHex: pub };
    return isValidPair(out) ? out : null;
  }
  return null;
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function isValidPair(out: SignerOutput): boolean {
  return isHexExact(out.signatureHex, RAW_SIG_HEX_LEN) && isHexExact(out.publicKeyHex, RAW_PUBKEY_HEX_LEN);
}

/** Requests a fresh login challenge payload from the server. */
export async function requestChallenge(
  deps?: Deps,
): Promise<{ ok: boolean; payload?: string; error?: string }> {
  const fetchFn = deps?.fetchImpl ?? fetch;
  try {
    const res = await fetchFn('/api/auth/challenge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) return { ok: false, error: 'challenge request failed' };
    const { payload } = (await res.json()) as { payload: string };
    return { ok: true, payload };
  } catch {
    return { ok: false, error: 'network error' };
  }
}

/**
 * Completes an offline login: parses the pasted signer output, then POSTs the
 * raw signature and public key with the original challenge payload. Never throws;
 * all failures are returned as { ok: false, error }.
 */
export async function loginOffline(
  args: { role: OfflineRole; payload: string; pastedText: string },
  deps?: Deps,
): Promise<LoginResult> {
  const fetchFn = deps?.fetchImpl ?? fetch;
  const parsed = parseSignerOutput(args.pastedText);
  if (!parsed) {
    return {
      ok: false,
      error: 'Could not read a signature and public key from what you pasted. Paste the full JSON output of cardano-signer.',
    };
  }

  try {
    const res = await fetchFn('/api/auth/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        payload: args.payload,
        signatureHex: parsed.signatureHex,
        publicKeyHex: parsed.publicKeyHex,
        role: args.role,
      }),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, error: body?.error || `login failed (HTTP ${res.status})` };
    }

    const data = (await res.json()) as { ok: boolean; user?: { id: string; roles: string[] } };
    return { ok: true, user: data.user };
  } catch {
    return { ok: false, error: 'network error' };
  }
}
