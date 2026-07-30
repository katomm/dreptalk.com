// Workers-runtime tests for handleTrack -- the testable core behind
// POST /api/delegation/track (starts opt-in delegation tracking for the
// authenticated account). Runs in real workerd via
// @cloudflare/vitest-pool-workers against the real D1 binding, with an
// injected fake Koios client (same pattern as refresh.workers.test.ts).
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { handleTrack } from './track.js';
import { getFollow } from '../db/delegatorFollows.js';

const VALID_DREP_A = 'drep1ygqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq7vlc9n';
const acct = (stake: string, drep: string | null) => ({
  stake_address: stake,
  status: 'registered',
  delegated_pool: null,
  delegated_drep: drep,
  total_balance: '1',
});

async function insertUser(id: string, stakeAddr: string | null) {
  await env.DB.prepare(
    `INSERT INTO users (id, stake_addr, is_drep, role, status, created_at, last_verified_at)
     VALUES (?, ?, 0, 'member', 'active', 0, 0)`,
  )
    .bind(id, stakeAddr)
    .run();
}

describe('handleTrack: account has a linked stake wallet', () => {
  it('creates a delegator_follows row and resolves it via the injected koios', async () => {
    const userId = 'writer-track-1';
    const stakeAddr = 'stake_test1rtrack1';
    await insertUser(userId, stakeAddr);
    const koios = { accountInfo: async () => acct(stakeAddr, VALID_DREP_A), accountInfoBatch: async () => [] };

    const result = await handleTrack({ db: env.DB, koios, userId, now: 1_700_000_000 });

    expect(result.status).toBe(200);
    expect((result.json as { ok: boolean }).ok).toBe(true);
    expect((result.json as { status: string }).status).toBe('resolved');
    expect((result.json as { drepId: string | null }).drepId).toBe(VALID_DREP_A);

    const row = await getFollow(env.DB, userId);
    expect(row).not.toBeNull();
    expect(row?.stake_addr).toBe(stakeAddr);
    expect(row?.resolution_status).toBe('resolved');
  });

  it('stays pending when the injected koios throws (fail-soft, still 200)', async () => {
    const userId = 'writer-track-2';
    const stakeAddr = 'stake_test1rtrack2';
    await insertUser(userId, stakeAddr);
    const koios = { accountInfo: async () => { throw new Error('down'); }, accountInfoBatch: async () => [] };

    const result = await handleTrack({ db: env.DB, koios, userId, now: 1_700_000_000 });

    expect(result.status).toBe(200);
    expect((result.json as { ok: boolean }).ok).toBe(true);
    expect((result.json as { status: string }).status).toBe('pending');

    const row = await getFollow(env.DB, userId);
    expect(row?.resolution_status).toBe('pending');
    expect(row?.refresh_error_at).toBe(1_700_000_000);
  });

  it('is idempotent: calling track twice for the same account does not error', async () => {
    const userId = 'writer-track-3';
    const stakeAddr = 'stake_test1rtrack3';
    await insertUser(userId, stakeAddr);
    const koios = { accountInfo: async () => acct(stakeAddr, null), accountInfoBatch: async () => [] };

    const first = await handleTrack({ db: env.DB, koios, userId, now: 1_700_000_000 });
    const second = await handleTrack({ db: env.DB, koios, userId, now: 1_700_000_100 });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const row = await getFollow(env.DB, userId);
    expect(row?.delegation_type).toBe('none');
  });
});

describe('handleTrack: account has no stake wallet linked', () => {
  it('returns 400 without creating a delegator_follows row', async () => {
    const userId = 'writer-track-no-stake';
    await insertUser(userId, null);
    const koios = { accountInfo: async () => null, accountInfoBatch: async () => [] };

    const result = await handleTrack({ db: env.DB, koios, userId, now: 1_700_000_000 });

    expect(result.status).toBe(400);
    expect((result.json as { ok: boolean; error: string }).ok).toBe(false);
    expect((result.json as { error: string }).error).toBe('no stake wallet linked');

    const row = await getFollow(env.DB, userId);
    expect(row).toBeNull();
  });
});

describe('handleTrack: unknown user id', () => {
  it('returns 400 (treated the same as no stake wallet linked)', async () => {
    const koios = { accountInfo: async () => null, accountInfoBatch: async () => [] };
    const result = await handleTrack({ db: env.DB, koios, userId: 'ghost-user', now: 1_700_000_000 });
    expect(result.status).toBe(400);
  });
});
