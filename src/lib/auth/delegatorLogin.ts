/// <reference types="@cloudflare/workers-types" />
// Delegator login account resolution: prove-wallet-only sign-in with no
// governance role. Routes to an account that already owns the stake address
// (e.g. a writer who linked this stake wallet) so a later delegator sign-in
// never mints a duplicate account; otherwise creates a member-only account.
import {
  getUserByStakeAddr,
  touchUserVerification,
  upsertUserFromAuth,
  type User,
} from '../db/users.js';

export async function resolveDelegatorAccount(
  db: D1Database,
  stakeAddr: string,
  now: number,
): Promise<User> {
  const existing = await getUserByStakeAddr(db, stakeAddr);
  if (existing) return touchUserVerification(db, existing.id, now);

  try {
    // roles: [] yields the 'member' fallback in rolesFromUser and sets no writer
    // flags; id becomes the stake address.
    return await upsertUserFromAuth(db, { stakeAddr, roles: [], now });
  } catch (error) {
    // A concurrent request may have claimed this stake address under a different
    // account id (writer-link) between our lookup and insert, tripping the
    // users.stake_addr unique index. Re-read: only treat it as the expected race
    // if the address now exists; otherwise rethrow the real error.
    const raced = await getUserByStakeAddr(db, stakeAddr);
    if (raced) return touchUserVerification(db, raced.id, now);
    throw error;
  }
}
