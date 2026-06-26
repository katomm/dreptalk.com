// Node.js tests for offlineLogin.ts -- pure logic, injected fetch, no DOM.
import { describe, it, expect, vi } from 'vitest';
import { parseSignerOutput, requestChallenge, loginOffline } from './offlineLogin.js';

const SIG = 'a'.repeat(128); // 64-byte Ed25519 signature
const PUB = 'b'.repeat(64); //  32-byte Ed25519 public key
const PAYLOAD = 'dreptalk:dreptalk.com:nonce123:1700000000';

describe('parseSignerOutput', () => {
  it('parses cardano-signer --json output ({signature, publicKey})', () => {
    const text = JSON.stringify({ signature: SIG, publicKey: PUB });
    expect(parseSignerOutput(text)).toEqual({ kind: 'raw', signatureHex: SIG, publicKeyHex: PUB });
  });

  it('parses the alternative {signatureHex, publicKeyHex} field names', () => {
    const text = JSON.stringify({ signatureHex: SIG, publicKeyHex: PUB });
    expect(parseSignerOutput(text)).toEqual({ kind: 'raw', signatureHex: SIG, publicKeyHex: PUB });
  });

  it('lowercases hex from JSON', () => {
    const text = JSON.stringify({ signature: SIG.toUpperCase(), publicKey: PUB.toUpperCase() });
    expect(parseSignerOutput(text)).toEqual({ kind: 'raw', signatureHex: SIG, publicKeyHex: PUB });
  });

  it('parses two whitespace-separated hex strings, disambiguated by length', () => {
    expect(parseSignerOutput(`${SIG}\n${PUB}`)).toEqual({ kind: 'raw', signatureHex: SIG, publicKeyHex: PUB });
    // order-independent: pubkey first still resolves correctly
    expect(parseSignerOutput(`${PUB}  ${SIG}`)).toEqual({ kind: 'raw', signatureHex: SIG, publicKeyHex: PUB });
  });

  it('returns null for empty or non-hex input', () => {
    expect(parseSignerOutput('')).toBeNull();
    expect(parseSignerOutput('not a signature')).toBeNull();
  });

  it('returns null when lengths are wrong (guards against pasting the wrong thing)', () => {
    expect(parseSignerOutput(JSON.stringify({ signature: 'ab', publicKey: PUB }))).toBeNull();
    expect(parseSignerOutput(JSON.stringify({ signature: SIG, publicKey: 'cd' }))).toBeNull();
  });

  it('parses cardano-signer --cip30 COSE output ({COSE_Sign1_hex, COSE_Key_hex})', () => {
    // Real cardano-signer v1.35.0 --cip30 --json output, signing
    // "dreptalk-cose-format-check" with a DRep key.
    const COSE_SIGN1 =
      '84582aa201276761646472657373581d22e4569cc95f7744c6d39dfa15384e5283fa2dbb39b6fea279621f504fa166686173686564f4581a6472657074616c6b2d636f73652d666f726d61742d636865636b5840c5c17d1955b5fcf91110ef278e21a468693952889f6f5afc0a04d97be65dfee528e28dcf598d6742842c6337fbe1813704d448db0a49116968e6eccff7a9da09';
    const COSE_KEY = 'a4010103272006215820d89ddbc6b0c05a33e5a42b4d3fa0a8fe8e8bcd77094137f1581e2272c8766fed';
    const text = JSON.stringify({ COSE_Sign1_hex: COSE_SIGN1, COSE_Key_hex: COSE_KEY });
    expect(parseSignerOutput(text)).toEqual({ kind: 'cose', signatureHex: COSE_SIGN1, keyHex: COSE_KEY });
  });

  it('rejects a COSE object with non-hex fields', () => {
    expect(parseSignerOutput(JSON.stringify({ COSE_Sign1_hex: 'zz', COSE_Key_hex: 'a4' }))).toBeNull();
  });
});

function makeFetch(opts: { challenge?: string; verifyOk?: boolean; verifyStatus?: number; verifyError?: string }) {
  return vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
    const u = url.toString();
    if (u.includes('challenge')) {
      return new Response(JSON.stringify({ payload: opts.challenge ?? PAYLOAD }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('verify')) {
      const body = opts.verifyOk
        ? { ok: true, user: { id: 'pool1abc', roles: ['spo'] } }
        : { ok: false, error: opts.verifyError ?? 'not an active SPO' };
      return new Response(JSON.stringify(body), {
        status: opts.verifyStatus ?? (opts.verifyOk ? 200 : 401),
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected URL ${u}`);
  });
}

describe('requestChallenge', () => {
  it('returns the payload on success', async () => {
    const fetchImpl = makeFetch({ challenge: PAYLOAD });
    const result = await requestChallenge({ fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.payload).toBe(PAYLOAD);
  });

  it('returns an error when the challenge request fails', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 }));
    const result = await requestChallenge({ fetchImpl });
    expect(result.ok).toBe(false);
  });
});

describe('loginOffline', () => {
  it('POSTs payload + parsed signature/pubkey and returns the user on success', async () => {
    const fetchImpl = makeFetch({ verifyOk: true });
    const result = await loginOffline(
      { role: 'spo', payload: PAYLOAD, pastedText: JSON.stringify({ signature: SIG, publicKey: PUB }) },
      { fetchImpl },
    );
    expect(result.ok).toBe(true);
    expect(result.user?.roles).toContain('spo');

    const verifyCall = fetchImpl.mock.calls.find((c) => c[0].toString().includes('verify'))!;
    const sentBody = JSON.parse((verifyCall[1] as RequestInit).body as string);
    expect(sentBody).toEqual({ payload: PAYLOAD, signatureHex: SIG, publicKeyHex: PUB, role: 'spo' });
  });

  it('POSTs keyHex (not publicKeyHex) for a cardano-signer --cip30 COSE paste, with scriptDrepId', async () => {
    const fetchImpl = makeFetch({ verifyOk: true });
    const cosePaste = JSON.stringify({ COSE_Sign1_hex: '84aabb', COSE_Key_hex: 'a4ccdd' });
    await loginOffline(
      { role: 'drep', payload: PAYLOAD, pastedText: cosePaste, scriptDrepId: 'drep1yvtest' },
      { fetchImpl },
    );
    const verifyCall = fetchImpl.mock.calls.find((c) => c[0].toString().includes('verify'))!;
    const sentBody = JSON.parse((verifyCall[1] as RequestInit).body as string);
    expect(sentBody).toEqual({
      payload: PAYLOAD,
      signatureHex: '84aabb',
      keyHex: 'a4ccdd',
      role: 'drep',
      scriptDrepId: 'drep1yvtest',
    });
    expect(sentBody.publicKeyHex).toBeUndefined();
  });

  it('rejects a COSE paste for a non-DRep role without POSTing', async () => {
    const fetchImpl = makeFetch({ verifyOk: true });
    const cosePaste = JSON.stringify({ COSE_Sign1_hex: '84aabb', COSE_Key_hex: 'a4ccdd' });
    const result = await loginOffline({ role: 'spo', payload: PAYLOAD, pastedText: cosePaste }, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('only for DRep');
    expect(fetchImpl.mock.calls.some((c) => c[0].toString().includes('verify'))).toBe(false);
  });

  it('surfaces the server error on a rejected verify', async () => {
    const fetchImpl = makeFetch({ verifyOk: false, verifyError: 'not an active SPO' });
    const result = await loginOffline(
      { role: 'spo', payload: PAYLOAD, pastedText: JSON.stringify({ signature: SIG, publicKey: PUB }) },
      { fetchImpl },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not an active SPO');
  });

  it('does not call the server when the pasted text is unparseable', async () => {
    const fetchImpl = makeFetch({ verifyOk: true });
    const result = await loginOffline(
      { role: 'cc', payload: PAYLOAD, pastedText: 'garbage' },
      { fetchImpl },
    );
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts a script DRep membership body for a pasted cardano-signer output', async () => {
    const fetchImpl = makeFetch({ verifyOk: true });
    const pasted = JSON.stringify({ signature: 'ab'.repeat(64), publicKey: 'cd'.repeat(32) });
    const result = await loginOffline(
      { role: 'drep', payload: PAYLOAD, pastedText: pasted, scriptDrepId: 'drep1yscript...' },
      { fetchImpl },
    );
    expect(result.ok).toBe(true);
    const verifyCall = fetchImpl.mock.calls.find((c) => c[0].toString().includes('verify'))!;
    const body = JSON.parse((verifyCall[1] as RequestInit).body as string);
    expect(body.role).toBe('drep');
    expect(body.scriptDrepId).toBe('drep1yscript...');
    expect(body.publicKeyHex).toBe('cd'.repeat(32));
  });
});
