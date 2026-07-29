/// <reference types="@cloudflare/workers-types" />
// Shared delegation refresh. Two callers, one module (no request-login logic in
// the cron entry): the auth handler resolves one address after login (fail-soft,
// short-bounded), the gov-sync cron re-resolves due addresses in one bulk call.
import { resolveDelegation } from './resolve.js';
import { applyResolution, markBatchError, type ResolutionOutcome, type DelegatorFollowRow } from '../db/delegatorFollows.js';
import type { AccountInfo } from '../koios/client.js';

interface KoiosLike {
  accountInfo(stakeAddr: string): Promise<AccountInfo | null>;
  accountInfoBatch(stakeAddrs: string[]): Promise<AccountInfo[]>;
}

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
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
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
  let outcome: ResolutionOutcome;
  try {
    const info = await withTimeout(koios.accountInfo(stakeAddr), opts?.timeoutMs ?? LOGIN_TIMEOUT_MS);
    outcome = outcomeFor(info);
  } catch {
    outcome = { status: 'error' };
  }
  await applyResolution(db, userId, outcome, now);
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
    const r = await applyResolution(db, userId, outcome, now);
    if (r === 'error') failed++;
    else { resolved++; if (r === 'changed') changed++; }
  }
  return { attempted: byAddr.size, resolved, failed, changed };
}
