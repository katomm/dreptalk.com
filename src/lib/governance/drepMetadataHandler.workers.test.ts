// Proof-of-control DRep metadata handler tests -- real workerd, real KV/D1,
// real CIP-8 verification using the preprod DRep fixture. The fixture signs a
// fixed payload, so we inject a single-use consumeNonce (same pattern as the
// auth handler tests).
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import vectors from '../auth/__fixtures__/cip8-vectors.json';
import { handleDrepMetadata } from './drepMetadataHandler.js';
import { drepIdFromPubKey } from '../cardano/identity.js';
import { hexToBytes } from '../crypto/hex.js';
import { getDrepMetadata } from '../db/drepMetadata.js';

const drepVector = vectors.vectors.find((v) => v.label === 'drep-key-valid')!;
const stakeVector = vectors.vectors.find((v) => v.label === 'stake-key-valid')!;

// The drepId the fixture key controls (CIP-129), derived from its public key.
const DREP_PUBKEY = 'a1458f6a1e1763fc379d7593b855ea21066cc76b78bfb5860f17315c86b561f6';
const FIXTURE_DREP_ID = drepIdFromPubKey(hexToBytes(DREP_PUBKEY));

const ORIGIN = 'https://dreptalk.com';

function singleUseNonce(kv: KVNamespace, payload: string) {
  const key = `fixture-nonce:${payload}`;
  return async (kvArg: KVNamespace, payloadArg: string): Promise<boolean> => {
    if (payloadArg !== payload) return false;
    if ((await kvArg.get(key)) === null) return false;
    await kvArg.delete(key);
    return true;
  };
}
const preload = (kv: KVNamespace, payload: string) => kv.put(`fixture-nonce:${payload}`, '1');

function baseInput(bodyOverrides: Record<string, unknown> = {}) {
  return {
    body: {
      drepId: FIXTURE_DREP_ID,
      name: 'Fixture DRep',
      bio: 'Proving control of the DRep key.',
      links: ['https://example.com'],
      payload: drepVector.payloadUtf8,
      signatureHex: drepVector.signatureHex,
      keyHex: drepVector.keyHex,
      ...bodyOverrides,
    },
    nonceKv: env.NONCES,
    db: env.DB,
    origin: ORIGIN,
    now: 1_700_000_000_000,
  };
}

describe('handleDrepMetadata: proof of control', () => {
  it('stores the row and returns url+hash when the DRep key controls the submitted drepId', async () => {
    await preload(env.NONCES, drepVector.payloadUtf8);
    const result = await handleDrepMetadata(baseInput(), { consumeNonce: singleUseNonce(env.NONCES, drepVector.payloadUtf8) });

    expect(result.status).toBe(200);
    const json = result.json as { url: string; hash: string };
    expect(json.url).toBe(`${ORIGIN}/drep/${FIXTURE_DREP_ID}/metadata.json`);
    expect(json.hash).toMatch(/^[0-9a-f]{64}$/);

    const row = await getDrepMetadata(env.DB, FIXTURE_DREP_ID);
    expect(row).not.toBeNull();
    expect(row!.hash).toBe(json.hash);
    expect(row!.name).toBe('Fixture DRep');
  });

  it('returns 403 when the submitted drepId does not match the signing key', async () => {
    await preload(env.NONCES, drepVector.payloadUtf8);
    const result = await handleDrepMetadata(
      baseInput({ drepId: 'drep1ygqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq7vlc9n' }),
      { consumeNonce: singleUseNonce(env.NONCES, drepVector.payloadUtf8) },
    );
    expect(result.status).toBe(403);
  });

  it('returns 401 when the signature does not verify', async () => {
    await preload(env.NONCES, drepVector.payloadUtf8);
    const badSig = drepVector.signatureHex.slice(0, -2) + 'ff';
    const result = await handleDrepMetadata(baseInput({ signatureHex: badSig }), {
      consumeNonce: singleUseNonce(env.NONCES, drepVector.payloadUtf8),
    });
    expect(result.status).toBe(401);
  });

  it('returns 401 when the nonce is missing or replayed', async () => {
    await preload(env.NONCES, drepVector.payloadUtf8);
    const consume = singleUseNonce(env.NONCES, drepVector.payloadUtf8);
    const first = await handleDrepMetadata(baseInput(), { consumeNonce: consume });
    expect(first.status).toBe(200);
    const second = await handleDrepMetadata(baseInput(), { consumeNonce: consume });
    expect(second.status).toBe(401);
  });

  it('returns 401 when signed with a non-DRep key (stake key, wrong header)', async () => {
    await preload(env.NONCES, stakeVector.payloadUtf8);
    const result = await handleDrepMetadata(
      {
        body: {
          drepId: FIXTURE_DREP_ID,
          name: 'x',
          bio: 'y',
          links: [],
          payload: stakeVector.payloadUtf8,
          signatureHex: stakeVector.signatureHex,
          keyHex: stakeVector.keyHex,
        },
        nonceKv: env.NONCES,
        db: env.DB,
        origin: ORIGIN,
        now: 1_700_000_000_000,
      },
      { consumeNonce: singleUseNonce(env.NONCES, stakeVector.payloadUtf8) },
    );
    expect(result.status).toBe(401);
  });

  it('returns 400 for a malformed drepId', async () => {
    await preload(env.NONCES, drepVector.payloadUtf8);
    const result = await handleDrepMetadata(baseInput({ drepId: 'nope' }), {
      consumeNonce: singleUseNonce(env.NONCES, drepVector.payloadUtf8),
    });
    expect(result.status).toBe(400);
  });
});
