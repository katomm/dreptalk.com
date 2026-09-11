import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { getGovActionMetadata, putGovActionMetadata } from './govActionMetadata.js';

describe('govActionMetadata', () => {
  it('stores and reads back a row, deduping on hash', async () => {
    const hash = 'a'.repeat(64);
    expect(await getGovActionMetadata(env.DB, hash)).toBeNull();
    await putGovActionMetadata(env.DB, { hash, cid: 'bafy1', body: '{"x":1}', createdAt: 1 });
    expect((await getGovActionMetadata(env.DB, hash))?.cid).toBe('bafy1');
    // INSERT OR IGNORE: a second put with a different cid does not overwrite.
    await putGovActionMetadata(env.DB, { hash, cid: 'bafy2', body: '{"x":1}', createdAt: 2 });
    expect((await getGovActionMetadata(env.DB, hash))?.cid).toBe('bafy1');
  });
});
