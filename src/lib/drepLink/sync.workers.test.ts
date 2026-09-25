import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { syncDrepHandles } from './sync.js';
import { upsertDrep } from '../db/dreps.js';
import { getPrimaryHandle } from '../db/drepHandles.js';
import { drepArgs, insertHandle, markSeeded } from './__fixtures__/drepHandles.js';

const NOW = 1_800_000_000;
const A = 'drep1phaseaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaqqqqq';
const B = 'drep1phasebbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbqqqqq';

async function twoAlices() {
  await upsertDrep(env.DB, drepArgs(A, 'Alice'));
  await upsertDrep(env.DB, drepArgs(B, 'Alice'));
  await env.DB.prepare('UPDATE dreps SET registered_at = CASE drep_id WHEN ? THEN 1 ELSE 2 END').bind(A).run();
}

describe('syncDrepHandles', () => {
  it('does nothing before the seed marker exists', async () => {
    await twoAlices();
    expect(await syncDrepHandles(env.DB, NOW)).toMatchObject({ seeded: false, assigned: 0 });
    expect(await getPrimaryHandle(env.DB, A, NOW)).toBeNull();
  });
  it('assigns new DReps after the seed and never revisits a decided one', async () => {
    await markSeeded(env.DB);
    await twoAlices();
    expect(await syncDrepHandles(env.DB, NOW)).toMatchObject({ seeded: true, assigned: 1, skipped: 1 });
    expect(await getPrimaryHandle(env.DB, A, NOW)).toBe('alice');
    // A revoked handle is not re-created: delete it, run again.
    await env.DB.prepare('DELETE FROM drep_handles').run();
    expect(await syncDrepHandles(env.DB, NOW + 1)).toMatchObject({ assigned: 0, skipped: 0 });
    expect(await getPrimaryHandle(env.DB, A, NOW + 1)).toBeNull();
  });
  it('does not let a DRep that already claimed a handle block the name for the next one', async () => {
    await markSeeded(env.DB);
    await twoAlices();
    await insertHandle(env.DB, 'custom', A, { source: 'claim' });
    await syncDrepHandles(env.DB, NOW);
    expect(await getPrimaryHandle(env.DB, A, NOW)).toBe('custom');
    expect(await getPrimaryHandle(env.DB, B, NOW)).toBe('alice');
  });
});
