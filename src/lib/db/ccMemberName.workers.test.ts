import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { upsertCcMemberName, getAllCcMemberNames } from './ccMemberName.js';

const db = () => env.DB;

describe('cc_member_name access', () => {
  it('keeps the newest vote by source_block_time, ignoring ingest order, lower-cases the key', async () => {
    await upsertCcMemberName(db(), { hotKeyHex: 'HOT1', name: 'First', sourceGaId: 'ga1', sourceBlockTime: 100, now: 1 });
    await upsertCcMemberName(db(), { hotKeyHex: 'hot1', name: 'Older', sourceGaId: 'ga0', sourceBlockTime: 50, now: 2 }); // older, ignored
    await upsertCcMemberName(db(), { hotKeyHex: 'hot1', name: 'Newer', sourceGaId: 'ga2', sourceBlockTime: 200, now: 3 });
    expect(await getAllCcMemberNames(db())).toEqual([{ hotKeyHex: 'hot1', name: 'Newer', sourceBlockTime: 200 }]);
  });
});
