/// <reference types="@cloudflare/workers-types" />
// Testable handler for POST /api/delegation/track: opts a writer who already
// linked a stake wallet (Task 6, users.stake_addr) into ongoing delegation
// tracking. Astro route in src/pages/api/delegation/track.ts is a thin
// wrapper (auth + same-origin + rate-limit + env wiring) over this function,
// mirroring handleLinkStake's convention.
import { getUserById } from '../db/users.js';
import { ensureFollow, getFollow } from '../db/delegatorFollows.js';
import { resolveFollow } from './refresh.js';
import type { AccountInfo } from '../koios/client.js';

interface KoiosLike {
  accountInfo(stakeAddr: string): Promise<AccountInfo | null>;
  accountInfoBatch(stakeAddrs: string[]): Promise<AccountInfo[]>;
}

export interface TrackInput {
  db: D1Database;
  koios: KoiosLike;
  // The AUTHENTICATED session's user id. Never source this from the request
  // body -- the route layer is responsible for that binding.
  userId: string;
  now?: number;
}

export interface TrackResult {
  status: number;
  json: unknown;
}

/**
 * Starts (or re-confirms) delegation tracking for `input.userId`. Requires the
 * account to already have a linked stake wallet (users.stake_addr); returns
 * 400 otherwise. Never throws: unexpected errors are caught and reported as a
 * controlled 500.
 */
export async function handleTrack(input: TrackInput): Promise<TrackResult> {
  try {
    return await handleTrackInternal(input);
  } catch {
    return { status: 500, json: { ok: false, error: 'internal error' } };
  }
}

async function handleTrackInternal(input: TrackInput): Promise<TrackResult> {
  const { db, koios, userId } = input;
  const nowSec = input.now ?? Math.floor(Date.now() / 1000);

  const row = await getUserById(db, userId);
  if (!row?.stake_addr) {
    return { status: 400, json: { ok: false, error: 'no stake wallet linked' } };
  }

  // Idempotent: a repeat call for the same account/address is a no-op past
  // this point. ensureFollow throws on a stake_addr mismatch (a row already
  // tracks a DIFFERENT address for this user_id) -- that is an internal
  // inconsistency, not an upstream error, so it is NOT caught here and
  // surfaces as the 500 above rather than being swallowed fail-soft.
  await ensureFollow(db, userId, row.stake_addr, nowSec);

  // resolveFollow never throws: a Koios failure or timeout leaves the row
  // pending (retried later by the cron), it must never fail this request.
  await resolveFollow(db, koios, userId, row.stake_addr, nowSec);

  const follow = await getFollow(db, userId);
  return {
    status: 200,
    json: {
      ok: true,
      status: follow?.resolution_status ?? 'pending',
      delegationType: follow?.delegation_type ?? null,
      drepId: follow?.drep_id ?? null,
    },
  };
}
