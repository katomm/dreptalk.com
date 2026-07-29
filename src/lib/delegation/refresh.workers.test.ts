/// <reference types="@cloudflare/workers-types" />
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { resolveFollow, refreshBulk } from './refresh.js';
import { ensureFollow, getFollow } from '../db/delegatorFollows.js';

const db = () => env.DB as D1Database;
// Real bech32-valid drep ids (parseDrepId-accepted), so resolveDelegation
// treats them as resolved 'drep' states rather than 'invalid'.
const VALID_DREP_A = 'drep1ygqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq7vlc9n';
const VALID_DREP_B = 'drep1ygqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgweajrn';
// The fake batch MUST echo each queried stake_address (v1 bug fixed: a fixed
// stake_address:'s' would silently break the byAddr-keyed matchup).
const acct = (stake: string, drep: string | null) => ({ stake_address: stake, status: 'registered', delegated_pool: null, delegated_drep: drep, total_balance: '1' });

describe('resolveFollow (fail-soft)', () => {
  it('records error when koios throws, without throwing', async () => {
    await ensureFollow(db(), 'r1', 'stake_test1r1', 1000);
    const koios = { accountInfo: async () => { throw new Error('down'); }, accountInfoBatch: async () => [] };
    await expect(resolveFollow(db(), koios as never, 'r1', 'stake_test1r1', 1000)).resolves.toBeUndefined();
    const row = await getFollow(db(), 'r1');
    expect(row?.resolution_status).toBe('pending');
    expect(row?.refresh_error_at).toBe(1000);
  });

  it('keeps a koios null (no account row) as pending and records the error, not none', async () => {
    await ensureFollow(db(), 'r2', 'stake_test1r2', 1000);
    const koios = { accountInfo: async () => null, accountInfoBatch: async () => [] };
    await resolveFollow(db(), koios as never, 'r2', 'stake_test1r2', 1000);
    const row = await getFollow(db(), 'r2');
    expect(row?.resolution_status).toBe('pending');
    expect(row?.refresh_error_at).toBe(1000);
  });

  it('maps a FOUND account with delegated_drep null to a resolved none', async () => {
    await ensureFollow(db(), 'r2b', 'stake_test1r2b', 1000);
    const koios = { accountInfo: async () => acct('stake_test1r2b', null), accountInfoBatch: async () => [] };
    await resolveFollow(db(), koios as never, 'r2b', 'stake_test1r2b', 1000);
    expect((await getFollow(db(), 'r2b'))?.delegation_type).toBe('none');
  });

  it('resolves a real drep', async () => {
    await ensureFollow(db(), 'r3', 'stake_test1r3', 1000);
    const koios = { accountInfo: async () => acct('stake_test1r3', VALID_DREP_A), accountInfoBatch: async () => [] };
    await resolveFollow(db(), koios as never, 'r3', 'stake_test1r3', 1000);
    expect((await getFollow(db(), 'r3'))?.drep_id).toBe(VALID_DREP_A);
  });

  it('never throws even when the D1 write inside applyResolution fails', async () => {
    const koios = { accountInfo: async () => acct('stake_test1r4', VALID_DREP_A), accountInfoBatch: async () => [] };
    const brokenDb = { prepare: () => { throw new Error('D1 write failed'); } };
    await expect(resolveFollow(brokenDb as never, koios as never, 'r4', 'stake_test1r4', 1000)).resolves.toBeUndefined();
  });
});

describe('refreshBulk', () => {
  it('re-resolves due follows and counts changes; a batch that echoes addresses works', async () => {
    await ensureFollow(db(), 'b1', 'stake_test1b1', 0);
    const koiosBaseline = { accountInfo: async () => acct('stake_test1b1', VALID_DREP_A), accountInfoBatch: async () => [] };
    await resolveFollow(db(), koiosBaseline as never, 'b1', 'stake_test1b1', 0); // baseline drep A at attempted=0

    const nowSec = 200_000; // far past the 1-day due window from attempted=0
    const koios = {
      accountInfo: async () => null,
      accountInfoBatch: async (addrs: string[]) => addrs.map((a) => acct(a, VALID_DREP_B)),
    };
    const res = await refreshBulk(db(), koios as never, nowSec, 50);
    expect(res.changed).toBe(1);
    expect((await getFollow(db(), 'b1'))?.drep_id).toBe(VALID_DREP_B);
  });

  it('a total batch failure marks every attempted row as errored (no starvation)', async () => {
    await ensureFollow(db(), 'b2', 'stake_test1b2', 0);
    const koios = { accountInfo: async () => null, accountInfoBatch: async () => { throw new Error('down'); } };
    const res = await refreshBulk(db(), koios as never, 300_000, 50);
    expect(res.failed).toBeGreaterThanOrEqual(1);
    const row = await getFollow(db(), 'b2');
    expect(row?.refresh_error_at).toBe(300_000);
    expect(row?.refresh_attempted_at).toBe(300_000); // advanced, so it is not re-picked immediately
  });
});
