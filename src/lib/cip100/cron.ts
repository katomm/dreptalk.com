/// <reference types="@cloudflare/workers-types" />
// src/lib/cip100/cron.ts
// The gov-sync phase. Does the erasure sweep, then reconciles a bounded batch
// of posts whose documents are missing or behind. Reusing the existing cron
// keeps this free of new infrastructure, and it makes the backfill a permanent
// repair loop rather than a one-off script.
import { EDIT_GRACE_MS } from '../forum/editPolicy.js';
import { findStalePostIds, purgeDeletedDocs, stampMissingDeletedAt } from '../db/cip100.js';
import { reconcilePostDocs } from './reconcile.js';
import type { Cip100Network } from './origin.js';

export interface Cip100SyncOptions {
  origin: string;
  network: Cip100Network;
  now: number;
  limit: number;
}

export async function runCip100Sync(
  db: D1Database,
  opts: Cip100SyncOptions,
): Promise<{ purged: number; reconciled: number; failed: number }> {
  // Erasure first: a deleted post must never be reconciled back into existence
  // by the same run.
  await stampMissingDeletedAt(db, opts.now);
  const purged = await purgeDeletedDocs(db, opts.now);

  const ids = await findStalePostIds(db, opts.now - EDIT_GRACE_MS, opts.limit);
  let reconciled = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      const res = await reconcilePostDocs(db, id, { origin: opts.origin, network: opts.network, now: opts.now });
      if (res.status === 'created' || res.status === 'unchanged') reconciled++;
      else if (res.status === 'conflict') failed++;
    } catch {
      failed++;
    }
  }
  return { purged, reconciled, failed };
}
