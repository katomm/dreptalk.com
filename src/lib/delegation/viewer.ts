/// <reference types="@cloudflare/workers-types" />
// The viewer state the delegation dialog needs, read once per page render.
// locals.user carries no stake_addr, so this is a users read, and the dialog
// only learns WHETHER a stake wallet is linked, never which one: a delegator
// account id is its own stake address and must not reach a page.
import { getUserById } from '../db/users.js';
import type { TrackingViewer } from './trackingOffer.js';

export async function loadTrackingViewer(
  db: D1Database | undefined,
  userId: string | null,
): Promise<TrackingViewer> {
  if (!userId) return { signedIn: false, hasStakeAddr: false };
  if (!db) return { signedIn: true, hasStakeAddr: false };
  const row = await getUserById(db, userId);
  return { signedIn: true, hasStakeAddr: !!row?.stake_addr };
}
