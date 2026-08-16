// DRep metadata hosting handler tests -- real workerd, real D1.
//
// Hosting is unauthenticated: authenticity is bound on-chain (syncDreps verifies
// blake2b-256(body) == the DRep's on-chain anchor hash), and storage is content-
// addressed so a write can never clobber another document. These tests cover the
// build + store + content-addressed URL, idempotency, and input validation.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { handleDrepMetadata } from './drepMetadataHandler.js';
import { buildDrepMetadata } from './drepMetadata.js';
import { getDrepMetadataByHash } from '../db/drepMetadata.js';
import { fetchAnchorMetadata } from './metadata.js';

const DREP_ID = 'drep1yyqw67szjkwns4vfqvnk0v8r20zy5qmv3hge2qlxm0s3apgsp3qsk6j5t4';
const ORIGIN = 'https://dreptalk.com';

function baseInput(bodyOverrides: Record<string, unknown> = {}) {
  return {
    body: {
      drepId: DREP_ID,
      name: 'Fixture DRep',
      bio: 'Hosting CIP-119 metadata.',
      links: [{ uri: 'https://example.com' }],
      ...bodyOverrides,
    },
    db: env.DB,
    origin: ORIGIN,
    now: 1_700_000_000_000,
  };
}

describe('handleDrepMetadata: content-addressed hosting', () => {
  it('stores the row and returns a content-addressed url + hash', async () => {
    const result = await handleDrepMetadata(baseInput());

    expect(result.status).toBe(200);
    const json = result.json as { url: string; hash: string };
    expect(json.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(json.url).toBe(`${ORIGIN}/drep/${json.hash}.json`);

    const row = await getDrepMetadataByHash(env.DB, json.hash);
    expect(row).not.toBeNull();
    expect(row!.hash).toBe(json.hash);
    expect(row!.name).toBe('Fixture DRep');

    // Roundtrip: the hosted document must verify against the returned hash
    // through the same anchor resolver syncDreps uses. The URL is on our own
    // zone, so the resolver reads the stored body from D1 (never HTTP), exactly
    // as in production. This guards that our own registration can never commit
    // a hash/format mismatch.
    const verified = await fetchAnchorMetadata(json.url, json.hash, { db: env.DB });
    expect(verified.status).toBe('ok');
  });

  it('returns an anchor url within the on-chain 128-character limit', async () => {
    // The on-chain anchor url field is bounded to 128 chars (CIP-100). The drep
    // id (~63 chars) plus a 64-char hash would overflow, so the id is not in the url.
    const result = await handleDrepMetadata(baseInput());
    const json = result.json as { url: string };
    expect(json.url.length).toBeLessThanOrEqual(128);
  });

  it('returns the same hash as buildDrepMetadata over the same inputs', async () => {
    const result = await handleDrepMetadata(baseInput({ name: 'Same', bio: 'Inputs', links: [] }));
    const json = result.json as { hash: string };
    const built = buildDrepMetadata({ name: 'Same', bio: 'Inputs', links: [] });
    expect(json.hash).toBe(built.hash);
  });

  it('is idempotent: posting identical content twice keeps a single row, same url', async () => {
    const a = await handleDrepMetadata(baseInput({ drepId: `${DREP_ID}`, name: 'Idem', bio: 'x', links: [] }));
    const b = await handleDrepMetadata(baseInput({ drepId: `${DREP_ID}`, name: 'Idem', bio: 'x', links: [] }));
    expect((a.json as { url: string }).url).toBe((b.json as { url: string }).url);
  });

  it('passes a valid image through to the hosted document', async () => {
    const image = { url: `https://dreptalk.com/api/avatar/${'ab'.repeat(32)}`, sha256: 'ab'.repeat(32) };
    const result = await handleDrepMetadata(baseInput({ image }));

    expect(result.status).toBe(200);
    const json = result.json as { hash: string };
    const row = await getDrepMetadataByHash(env.DB, json.hash);
    expect(JSON.parse(row!.body).body.image).toEqual({
      '@type': 'ImageObject',
      contentUrl: image.url,
      sha256: image.sha256,
    });
  });

  it('returns 400 for a malformed image object', async () => {
    const result = await handleDrepMetadata(baseInput({ image: { url: 42 } }));
    expect(result.status).toBe(400);
  });

  it('returns 400 for a malformed drepId', async () => {
    const result = await handleDrepMetadata(baseInput({ drepId: 'nope' }));
    expect(result.status).toBe(400);
  });

  it('returns 400 when drepId is missing', async () => {
    const result = await handleDrepMetadata(baseInput({ drepId: undefined }));
    expect(result.status).toBe(400);
  });

  it('hosts labeled links and the advanced fields', async () => {
    const addr = `addr_test1qz${'a'.repeat(40)}`;
    const res = await handleDrepMetadata(baseInput({
      links: [{ uri: 'https://example.com', label: 'Site' }],
      motivations: 'M', qualifications: 'Q', paymentAddress: addr, doNotList: true,
    }));
    expect(res.status).toBe(200);
    const stored = await getDrepMetadataByHash(env.DB, (res.json as { hash: string }).hash);
    const body = JSON.parse(stored!.body).body;
    expect(body.references[0]).toEqual({ '@type': 'Link', label: 'Site', uri: 'https://example.com' });
    expect(body.motivations).toBe('M');
    expect(body.paymentAddress).toBe(addr);
    expect(body.doNotList).toBe(true);
  });
});
