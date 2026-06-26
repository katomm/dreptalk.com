// Pure, dependency-injected logic for the offline (paste) login flow used by
// SPOs (Calidus key) and CC members. No DOM imports; fully testable in Node.js
// with an injected fetch.
//
// The user signs the server's challenge offline with cardano-signer:
//   cardano-signer sign --data "<payload>" --secret-key calidus.skey --json
// which prints { "signature": "<hex>", "publicKey": "<hex>" }. They paste that
// output back; we parse it, then POST the raw signature + public key to verify.

import { isHex, isHexExact, MAX_KEY_HEX_LEN, MAX_SIG_HEX_LEN, RAW_SIG_HEX_LEN, RAW_PUBKEY_HEX_LEN } from '../validation/input.js';

export type OfflineRole = 'spo' | 'cc' | 'drep';

// cardano-signer prints two shapes depending on the flags used:
//   plain  (--data-hex):  { signature, publicKey }            -> raw Ed25519
//   CIP-30 (--cip30):     { COSE_Sign1_hex, COSE_Key_hex }    -> COSE_Sign1 + COSE_Key
// The raw pair routes to the raw verifier; the COSE pair reuses the wallet's
// CIP-8 verifier (the same COSE structure a CIP-30 wallet produces). COSE only
// applies to DRep sign-in: a single key cannot COSE-sign for a script address,
// and SPO/CC are never offered a --cip30 command.
export type SignerOutput =
  | { kind: 'raw'; signatureHex: string; publicKeyHex: string }
  | { kind: 'cose'; signatureHex: string; keyHex: string };

export interface LoginResult {
  ok: boolean;
  user?: { id: string; roles: string[] };
  error?: string;
}

interface Deps {
  fetchImpl?: typeof fetch;
}

/**
 * Extracts the signer material from whatever the user pasted. Accepts:
 *  - cardano-signer plain JSON ({signature, publicKey} or {signatureHex,
 *    publicKeyHex}) -> a raw Ed25519 pair;
 *  - cardano-signer --cip30 JSON ({COSE_Sign1_hex, COSE_Key_hex}) -> a COSE pair;
 *  - two bare hex strings in any order (disambiguated by length) -> raw.
 * Returns null if nothing valid is found, so the caller never sends junk.
 */
export function parseSignerOutput(text: string): SignerOutput | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // JSON output from cardano-signer --json.
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      // Plain raw output: { signature, publicKey }.
      const sig = firstString(obj.signature, obj.signatureHex);
      const pub = firstString(obj.publicKey, obj.publicKeyHex, obj.pubKey);
      if (sig && pub) {
        const out = { signatureHex: sig.toLowerCase(), publicKeyHex: pub.toLowerCase() };
        return isValidRawPair(out) ? { kind: 'raw', ...out } : null;
      }
      // CIP-30 COSE output (cardano-signer --cip30): { COSE_Sign1_hex, COSE_Key_hex }.
      const coseSig = firstString(obj.COSE_Sign1_hex, obj.cose_sign1_hex);
      const coseKey = firstString(obj.COSE_Key_hex, obj.cose_key_hex);
      if (coseSig && coseKey) {
        const signatureHex = coseSig.toLowerCase();
        const keyHex = coseKey.toLowerCase();
        if (isHex(signatureHex, MAX_SIG_HEX_LEN) && isHex(keyHex, MAX_KEY_HEX_LEN)) {
          return { kind: 'cose', signatureHex, keyHex };
        }
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
    return isValidRawPair(out) ? { kind: 'raw', ...out } : null;
  }
  return null;
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function isValidRawPair(out: { signatureHex: string; publicKeyHex: string }): boolean {
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
  args: { role: OfflineRole; payload: string; pastedText: string; scriptDrepId?: string },
  deps?: Deps,
): Promise<LoginResult> {
  const fetchFn = deps?.fetchImpl ?? fetch;
  const parsed = parseSignerOutput(args.pastedText);
  if (!parsed) {
    return {
      ok: false,
      error:
        'Could not read a signature from what you pasted. Paste the full JSON output of cardano-signer: either the plain {"signature", "publicKey"} or, with --cip30, {"COSE_Sign1_hex", "COSE_Key_hex"}.',
    };
  }

  // COSE (--cip30) only applies to DRep sign-in. SPOs and CC members must use the
  // plain command; a single key cannot COSE-sign for those, and they are never
  // shown a --cip30 command.
  if (parsed.kind === 'cose' && args.role !== 'drep') {
    return {
      ok: false,
      error: 'The --cip30 (COSE) output is only for DRep sign-in. SPOs and CC members use the plain command, without --cip30.',
    };
  }

  // raw -> {signatureHex, publicKeyHex} (raw verifier); cose -> {signatureHex,
  // keyHex} (the wallet CIP-8 verifier). The server dispatches on keyHex.
  const sigFields =
    parsed.kind === 'cose'
      ? { signatureHex: parsed.signatureHex, keyHex: parsed.keyHex }
      : { signatureHex: parsed.signatureHex, publicKeyHex: parsed.publicKeyHex };

  try {
    const res = await fetchFn('/api/auth/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        payload: args.payload,
        ...sigFields,
        role: args.role,
        ...(args.scriptDrepId ? { scriptDrepId: args.scriptDrepId } : {}),
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
