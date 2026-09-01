/// <reference types="@cloudflare/workers-types" />
// Shared delegation refresh. Two callers, one module (no request-login logic in
// the cron entry): the auth handler resolves one address after login (fail-soft,
// short-bounded), the gov-sync cron re-resolves due addresses in one bulk call.
import { resolveDelegation } from './resolve.js';
import { delegationStartEpoch } from './delegationStart.js';
import {
  applyResolution,
  captureDelegatedSince,
  getFollow,
  listFollowsMissingSince,
  markBatchError,
  setDelegatedSince,
  type ResolutionOutcome,
  type DelegatorFollowRow,
} from '../db/delegatorFollows.js';
import type { AccountInfo, AccountUpdateHistoryRow } from '../koios/client.js';

export interface KoiosLike {
  accountInfo(stakeAddr: string): Promise<AccountInfo | null>;
  accountInfoBatch(stakeAddrs: string[]): Promise<AccountInfo[]>;
  accountUpdateHistoryBatch(stakeAddresses: string[]): Promise<AccountUpdateHistoryRow[]>;
}

// A missing delegation start is retried at most once a day, so a Koios outage or
// an account Koios has no history for does not re-query on every single login.
export const SINCE_RETRY_SEC = 86_400;
// One bulk pass captures at most this many starts, matching the Koios
// /account_update_history chunk size so the sweep is a single upstream chunk.
export const SINCE_BULK_CAP = 15;
// After this many attempts that produced no start, the page stops promising one.
// The capture paths keep retrying daily regardless (one call, and a start that
// only appears later is still worth having): this is a display threshold, not a
// stop condition. Three daily lookups is long enough that a slow indexer or a
// passing outage has been ruled out, and an account whose delegation certificate
// simply is not in the history it returns will never produce one.
export const SINCE_GIVE_UP_ATTEMPTS = 3;

// Map the transport cases plus the resolver's fail-closed verdict onto a
// resolution outcome. A NULL account (koios returned no row, or a bulk response
// omitted the address) is NOT a confirmed "not delegated": it can equally be a
// not-yet-indexed key, and account_info's semantics give no basis to force
// 'none'. Treat it as a failed resolution (row stays pending, retried, baseline
// untouched). The ONLY 'none' is a FOUND account whose delegated_drep is null
// (resolveDelegation handles that). An invalid delegated_drep or a thrown error
// is likewise a resolution error.
function outcomeFor(info: AccountInfo | null): ResolutionOutcome {
  if (info == null) return { status: 'error' };
  const parsed = resolveDelegation(info);
  return parsed.kind === 'invalid' ? { status: 'error' } : { status: 'resolved', state: parsed.state };
}

const LOGIN_TIMEOUT_MS = 3000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, rej) => {
    timer = setTimeout(() => rej(new Error('timeout')), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Resolve one account's delegation. Fail-soft: any Koios error, timeout, a null
 * (no account row), or an invalid delegated_drep all become an 'error' outcome
 * (row stays pending or keeps its baseline, retried later); only a FOUND account
 * with delegated_drep null resolves to 'none'. Never throws. The follow row must
 * already exist (ensureFollow runs first in the login hook).
 */
export async function resolveFollow(
  db: D1Database,
  koios: KoiosLike,
  userId: string,
  stakeAddr: string,
  now: number,
  opts?: { timeoutMs?: number },
): Promise<void> {
  try {
    let outcome: ResolutionOutcome;
    try {
      const info = await withTimeout(koios.accountInfo(stakeAddr), opts?.timeoutMs ?? LOGIN_TIMEOUT_MS);
      outcome = outcomeFor(info);
    } catch {
      outcome = { status: 'error' };
    }
    const applied = await applyResolution(db, userId, outcome, now);

    // Capture the delegation start when it can have moved (a new baseline or a
    // re-delegation) or when it is still missing and the retry window has passed.
    // An unchanged follow that already has a start never touches the endpoint.
    const fresh = applied === 'created' || applied === 'changed';
    let capture = fresh;
    // The since_checked_at this login observed on the row, used to compare and set
    // on the retry path so a cron capture that happened in between is not undone.
    let observedSince: number | null = null;
    if (!capture) {
      const row = await getFollow(db, userId);
      capture =
        row != null &&
        row.delegated_since_epoch == null &&
        (row.since_checked_at == null || row.since_checked_at < now - SINCE_RETRY_SEC);
      observedSince = row?.since_checked_at ?? null;
    }
    if (capture) {
      let epoch: number | null = null;
      // True only when the lookup itself could not be completed (a throw or a
      // timeout), never for a lookup that ran and simply found nothing: only
      // the latter is a confirmed empty history and counts toward giving up.
      let failed = false;
      try {
        const rows = await withTimeout(
          koios.accountUpdateHistoryBatch([stakeAddr]),
          opts?.timeoutMs ?? LOGIN_TIMEOUT_MS,
        );
        epoch = delegationStartEpoch(rows.filter((r) => r.stake_address === stakeAddr));
      } catch {
        // A failed capture is recorded as a NULL start below, so the attempt is
        // visible and the retry window applies instead of a per-login hammer.
        // It does not count toward the give-up threshold: the lookup never ran
        // to completion, so it confirmed nothing about the account's history.
        failed = true;
      }
      // A fresh baseline owns the start it just captured, so it writes flat. The
      // retry path only writes while the row is still the one it read.
      if (fresh) await setDelegatedSince(db, userId, epoch, now, failed);
      else await captureDelegatedSince(db, userId, epoch, now, observedSince, failed);
    }
  } catch {
    // Never throw: a D1 write failure here must not fail the login. The row
    // stays as-is (pending or its prior baseline); the cron retries later.
  }
}

const BULK_DEFAULT_LIMIT = 200;
const DUE_INTERVAL_SEC = 86_400; // once per day

/**
 * Re-resolve the stalest DUE follows in one bulk Koios call. Due = never attempted
 * or attempted more than a day ago, stalest attempt first (fair, no starvation by
 * never-resolved rows since every attempt advances refresh_attempted_at). An
 * address absent from a successful batch could not be resolved (no account row
 * yet), treated as a failed resolution that stays pending, never a forced 'none'.
 * A total batch failure marks every attempted row errored so it waits the due
 * window and the failure is visible.
 */
export async function refreshBulk(
  db: D1Database,
  koios: KoiosLike,
  now: number,
  limit = BULK_DEFAULT_LIMIT,
): Promise<{ attempted: number; resolved: number; failed: number; changed: number }> {
  const dueBefore = now - DUE_INTERVAL_SEC;
  const { results } = await db
    .prepare(
      `SELECT user_id, stake_addr FROM delegator_follows
        WHERE refresh_attempted_at IS NULL OR refresh_attempted_at <= ?
        ORDER BY COALESCE(refresh_attempted_at, 0), user_id
        LIMIT ?`,
    )
    .bind(dueBefore, limit)
    .all<Pick<DelegatorFollowRow, 'user_id' | 'stake_addr'>>();
  if (results.length === 0) return { attempted: 0, resolved: 0, failed: 0, changed: 0 };

  const byAddr = new Map(results.map((r) => [r.stake_addr, r.user_id]));
  let infos: AccountInfo[];
  try {
    infos = await koios.accountInfoBatch([...byAddr.keys()]);
  } catch {
    await markBatchError(db, [...byAddr.values()], now);
    return { attempted: byAddr.size, resolved: 0, failed: byAddr.size, changed: 0 };
  }
  const infoByAddr = new Map(infos.map((i) => [i.stake_address, i]));

  let resolved = 0, failed = 0, changed = 0;
  for (const [stakeAddr, userId] of byAddr) {
    const outcome = outcomeFor(infoByAddr.get(stakeAddr) ?? null); // absent = could not resolve, stays pending
    try {
      const r = await applyResolution(db, userId, outcome, now);
      if (r === 'error') failed++;
      else { resolved++; if (r === 'changed') changed++; }
    } catch {
      // A per-row DB error must not abort the batch; count it failed and keep going
      // so the remaining rows still get resolved and the returned counts stay meaningful.
      failed++;
    }
  }

  await captureBulkSince(db, koios, [...byAddr.values()], now);
  return { attempted: byAddr.size, resolved, failed, changed };
}

/**
 * Fills in missing delegation starts for the rows of the batch that just ran, in
 * ONE extra Koios call capped at SINCE_BULK_CAP addresses. No sweep beyond the
 * batch: only addresses already being refreshed are touched. Every address in
 * the call gets its attempt recorded, including the ones Koios returned no rows
 * for and, on a total failure, all of them. Every write compares and sets on the
 * since_checked_at observed when the row was listed, so a login capture that ran
 * while the Koios call was in flight is not overwritten. Never throws: the
 * capture is a bonus on top of the refresh, not a reason to fail it.
 *
 * An address with no rows in the response only counts toward the give-up
 * threshold when the call as a whole can be trusted to have reported it
 * honestly: either every requested address came back empty (a plausible, if
 * unlikely, genuine batch of unstarted accounts), or this address's own rows
 * came back. An address missing while OTHER requested addresses in the same
 * batch did come back is a partial drop, not a confirmed empty history, so it
 * is recorded as a failed lookup for that address alone and does not count.
 */
async function captureBulkSince(db: D1Database, koios: KoiosLike, userIds: string[], now: number): Promise<void> {
  try {
    const pending = await listFollowsMissingSince(db, userIds, now - SINCE_RETRY_SEC, SINCE_BULK_CAP);
    if (pending.length === 0) return;

    let rows: AccountUpdateHistoryRow[] = [];
    let batchFailed = false;
    try {
      rows = await koios.accountUpdateHistoryBatch(pending.map((p) => p.stakeAddr));
    } catch {
      // Leave rows empty: every pending address gets a NULL start recorded below,
      // as a failed lookup, so the whole group waits out the retry window
      // instead of retrying at once, without counting toward the give-up total.
      batchFailed = true;
    }
    const byStake = new Map<string, AccountUpdateHistoryRow[]>();
    for (const row of rows) {
      const list = byStake.get(row.stake_address);
      if (list) list.push(row);
      else byStake.set(row.stake_address, [row]);
    }
    const anyAddressResponded = byStake.size > 0;
    for (const { userId, stakeAddr, sinceCheckedAt } of pending) {
      try {
        const responded = byStake.has(stakeAddr);
        // A per-address failure: the whole call threw, or this address has no
        // rows while some other requested address in the batch did come back.
        const failed = batchFailed || (!responded && anyAddressResponded);
        // Compare and set on what the listing observed: a login that captured the
        // start while this bulk call was in flight keeps its value.
        await captureDelegatedSince(
          db,
          userId,
          delegationStartEpoch(byStake.get(stakeAddr) ?? []),
          now,
          sinceCheckedAt,
          failed,
        );
      } catch {
        // A per-row write failure must not abort the rest of the capture.
      }
    }
  } catch {
    // A listing failure leaves every start as it was, picked up by the next run.
  }
}
