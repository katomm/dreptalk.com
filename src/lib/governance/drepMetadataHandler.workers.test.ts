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

const DREP_ID = 'drep1yyqw67szjkwns4vfqvnk0v8r20zy5qmv3hge2qlxm0s3apgsp3qsk6j5t4';
const ORIGIN = 'https://dreptalk.com';

function baseInput(bodyOverrides: Record<string, unknown> = {}) {
  return {
    body: {
      drepId: DREP_ID,
      name: 'Fixture DRep',
      bio: 'Hosting CIP-119 metadata.',
      links: ['https://example.com'],
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
    expect(json.url).toBe(`${ORIGIN}/drep/${DREP_ID}/${json.hash}.json`);

    const row = await getDrepMetadataByHash(env.DB, DREP_ID, json.hash);
    expect(row).not.toBeNull();
    expect(row!.hash).toBe(json.hash);
    expect(row!.name).toBe('Fixture DRep');
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

  it('returns 400 for a malformed drepId', async () => {
    const result = await handleDrepMetadata(baseInput({ drepId: 'nope' }));
    expect(result.status).toBe(400);
  });

  it('returns 400 when drepId is missing', async () => {
    const result = await handleDrepMetadata(baseInput({ drepId: undefined }));
    expect(result.status).toBe(400);
  });
});
