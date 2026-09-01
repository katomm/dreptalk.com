/// <reference types="@cloudflare/workers-types" />
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { resolveFollow, refreshBulk } from './refresh.js';
import { ensureFollow, getFollow, setDelegatedSince } from '../db/delegatorFollows.js';

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

// Fake Koios with a recorded call log: every history call is appended so a test
// can assert both that the endpoint was hit and with which addresses.
const histRow = (stake: string, epoch: number, slot: number) =>
  ({ stake_address: stake, action_type: 'delegation_drep', tx_hash: `t${slot}`, epoch_no: epoch, absolute_slot: slot });

function fakeKoios(opts: {
  drep?: string | null;
  history?: (addrs: string[]) => ReturnType<typeof histRow>[];
  historyThrows?: boolean;
}) {
  const historyCalls: string[][] = [];
  return {
    historyCalls,
    koios: {
      accountInfo: async (stake: string) => acct(stake, opts.drep === undefined ? VALID_DREP_A : opts.drep),
      accountInfoBatch: async (addrs: string[]) => addrs.map((a) => acct(a, opts.drep === undefined ? VALID_DREP_A : opts.drep)),
      accountUpdateHistoryBatch: async (addrs: string[]) => {
        historyCalls.push(addrs);
        if (opts.historyThrows) throw new Error('history down');
        return opts.history ? opts.history(addrs) : addrs.map((a) => histRow(a, 640, 100));
      },
    },
  };
}

describe('delegation start capture in resolveFollow', () => {
  it('captures the start when the baseline is created', async () => {
    await ensureFollow(db(), 'c1', 'stake_test1c1', 1000);
    const { koios, historyCalls } = fakeKoios({});
    await resolveFollow(db(), koios as never, 'c1', 'stake_test1c1', 1000);
    expect(historyCalls).toEqual([['stake_test1c1']]);
    const row = await getFollow(db(), 'c1');
    expect(row?.delegated_since_epoch).toBe(640);
    expect(row?.since_checked_at).toBe(1000);
  });

  it('re-captures the start when the delegation changes to another DRep', async () => {
    await ensureFollow(db(), 'c2', 'stake_test1c2', 1000);
    const first = fakeKoios({});
    await resolveFollow(db(), first.koios as never, 'c2', 'stake_test1c2', 1000);
    expect((await getFollow(db(), 'c2'))?.delegated_since_epoch).toBe(640);

    // Re-delegation: a newer delegation_drep event moves the start forward.
    const second = fakeKoios({
      drep: VALID_DREP_B,
      history: (addrs) => addrs.flatMap((a) => [histRow(a, 640, 100), histRow(a, 655, 900)]),
    });
    await resolveFollow(db(), second.koios as never, 'c2', 'stake_test1c2', 2000);
    expect(second.historyCalls).toEqual([['stake_test1c2']]);
    const row = await getFollow(db(), 'c2');
    expect(row?.drep_id).toBe(VALID_DREP_B);
    expect(row?.delegated_since_epoch).toBe(655);
    expect(row?.since_checked_at).toBe(2000);
  });

  it('does not hit the history endpoint for an unchanged follow that already has a start', async () => {
    await ensureFollow(db(), 'c3', 'stake_test1c3', 1000);
    const first = fakeKoios({});
    await resolveFollow(db(), first.koios as never, 'c3', 'stake_test1c3', 1000);

    const again = fakeKoios({});
    await resolveFollow(db(), again.koios as never, 'c3', 'stake_test1c3', 500_000);
    expect(again.historyCalls).toEqual([]);
    const row = await getFollow(db(), 'c3');
    expect(row?.delegated_since_epoch).toBe(640);
    expect(row?.since_checked_at).toBe(1000); // untouched, no new attempt
  });

  it('retries an unchanged follow whose start is missing and whose attempt is a day old', async () => {
    await ensureFollow(db(), 'c4', 'stake_test1c4', 1000);
    const first = fakeKoios({ historyThrows: true });
    await resolveFollow(db(), first.koios as never, 'c4', 'stake_test1c4', 1000);
    expect((await getFollow(db(), 'c4'))?.delegated_since_epoch).toBeNull();

    const later = fakeKoios({});
    await resolveFollow(db(), later.koios as never, 'c4', 'stake_test1c4', 1000 + 86_401);
    expect(later.historyCalls).toEqual([['stake_test1c4']]);
    expect((await getFollow(db(), 'c4'))?.delegated_since_epoch).toBe(640);
  });

  it('records a failed capture as a NULL start and does not retry within a day, without throwing', async () => {
    await ensureFollow(db(), 'c5', 'stake_test1c5', 1000);
    const failing = fakeKoios({ historyThrows: true });
    await expect(resolveFollow(db(), failing.koios as never, 'c5', 'stake_test1c5', 1000)).resolves.toBeUndefined();
    const row = await getFollow(db(), 'c5');
    expect(row?.drep_id).toBe(VALID_DREP_A); // the delegation itself still resolved
    expect(row?.delegated_since_epoch).toBeNull();
    expect(row?.since_checked_at).toBe(1000);

    const soon = fakeKoios({});
    await resolveFollow(db(), soon.koios as never, 'c5', 'stake_test1c5', 1000 + 3600);
    expect(soon.historyCalls).toEqual([]);
    expect((await getFollow(db(), 'c5'))?.since_checked_at).toBe(1000);
  });

  it('records an empty history as a NULL start (account never delegated to a DRep)', async () => {
    await ensureFollow(db(), 'c6', 'stake_test1c6', 1000);
    const { koios, historyCalls } = fakeKoios({ drep: null, history: () => [] });
    await resolveFollow(db(), koios as never, 'c6', 'stake_test1c6', 1000);
    expect(historyCalls).toEqual([['stake_test1c6']]);
    const row = await getFollow(db(), 'c6');
    expect(row?.delegation_type).toBe('none');
    expect(row?.delegated_since_epoch).toBeNull();
    expect(row?.since_checked_at).toBe(1000);
  });
});

describe('delegation start capture in refreshBulk', () => {
  it('caps the capture at 15 addresses and records the attempt for addresses without rows', async () => {
    for (let i = 1; i <= 17; i++) {
      const id = `bs${String(i).padStart(2, '0')}`;
      await ensureFollow(db(), id, `stake_test1${id}`, 0);
    }
    const { koios, historyCalls } = fakeKoios({
      // Only the first address has a delegation_drep event, the rest come back empty.
      history: (addrs) => addrs.filter((a) => a === 'stake_test1bs01').map((a) => histRow(a, 700, 4200)),
    });
    await refreshBulk(db(), koios as never, 900_000, 50);

    expect(historyCalls.length).toBe(1);
    expect(historyCalls[0].length).toBe(15);
    expect(historyCalls[0]).toContain('stake_test1bs01');
    expect(historyCalls[0]).not.toContain('stake_test1bs16');

    const first = await getFollow(db(), 'bs01');
    expect(first?.delegated_since_epoch).toBe(700);
    expect(first?.since_checked_at).toBe(900_000);

    const empty = await getFollow(db(), 'bs15');
    expect(empty?.delegated_since_epoch).toBeNull();
    expect(empty?.since_checked_at).toBe(900_000); // attempt recorded even with no rows

    const untouched = await getFollow(db(), 'bs16');
    expect(untouched?.since_checked_at).toBeNull();
  });

  it('skips follows that already have a start and records a failed bulk capture as an attempt', async () => {
    await ensureFollow(db(), 'bk1', 'stake_test1bk1', 0);
    await ensureFollow(db(), 'bk2', 'stake_test1bk2', 0);
    await setDelegatedSince(db(), 'bk1', 611, 100);

    const { koios, historyCalls } = fakeKoios({ historyThrows: true });
    await refreshBulk(db(), koios as never, 900_000, 50);

    expect(historyCalls).toEqual([['stake_test1bk2']]);
    expect((await getFollow(db(), 'bk1'))?.delegated_since_epoch).toBe(611);
    expect((await getFollow(db(), 'bk1'))?.since_checked_at).toBe(100); // untouched
    const failed = await getFollow(db(), 'bk2');
    expect(failed?.delegated_since_epoch).toBeNull();
    expect(failed?.since_checked_at).toBe(900_000);
  });

  it('re-captures the start of a follow whose delegation changed in the same batch', async () => {
    await ensureFollow(db(), 'bc1', 'stake_test1bc1', 0);
    const first = fakeKoios({});
    await resolveFollow(db(), first.koios as never, 'bc1', 'stake_test1bc1', 0);
    expect((await getFollow(db(), 'bc1'))?.delegated_since_epoch).toBe(640);

    // The cron sees a re-delegation, and the history now carries a newer event.
    const second = fakeKoios({
      drep: VALID_DREP_B,
      history: (addrs) => addrs.flatMap((a) => [histRow(a, 640, 100), histRow(a, 655, 900)]),
    });
    const res = await refreshBulk(db(), second.koios as never, 900_000, 50);

    expect(res.changed).toBe(1);
    expect(second.historyCalls).toEqual([['stake_test1bc1']]);
    const row = await getFollow(db(), 'bc1');
    expect(row?.drep_id).toBe(VALID_DREP_B);
    expect(row?.delegated_since_epoch).toBe(655);
    expect(row?.since_checked_at).toBe(900_000);
  });

  it('does not overwrite a start a login captured while the bulk call was in flight', async () => {
    await ensureFollow(db(), 'race1', 'stake_test1race1', 0);
    const koios = {
      accountInfo: async (stake: string) => acct(stake, VALID_DREP_A),
      accountInfoBatch: async (addrs: string[]) => addrs.map((a) => acct(a, VALID_DREP_A)),
      accountUpdateHistoryBatch: async (addrs: string[]) => {
        // Stands in for a login that captured the start between the listing and
        // the write below, which is exactly the window the compare-and-set covers.
        await setDelegatedSince(db(), 'race1', 700, 899_000);
        return addrs.map((a) => histRow(a, 640, 100));
      },
    };
    await refreshBulk(db(), koios as never, 900_000, 50);

    const row = await getFollow(db(), 'race1');
    expect(row?.delegated_since_epoch).toBe(700);
    expect(row?.since_checked_at).toBe(899_000);
  });
});
