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
): Promise<{ purged: number; reconciled: number; skipped: number; failed: number }> {
  // A deleted post is never reconciled back into existence. Two independent
  // guards hold that: the candidate query excludes deleted posts and topics,
  // and the reconciler reads the scope rule fresh for every post it is handed.
  // Either one alone is sufficient. Sweeping before reconciling is defence in
  // depth on top of them, not the thing that makes it safe.
  await stampMissingDeletedAt(db, opts.now);
  const purged = await purgeDeletedDocs(db, opts.now);

  const ids = await findStalePostIds(db, opts.now - EDIT_GRACE_MS, opts.limit);
  let reconciled = 0;
  let skipped = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      const res = await reconcilePostDocs(db, id, { origin: opts.origin, network: opts.network, now: opts.now });
      if (res.status === 'created' || res.status === 'unchanged') reconciled++;
      // Counted and logged, not swallowed: a batch that is all skips would
      // otherwise read as "nothing to do" while no post gets a document.
      else if (res.status === 'skipped') skipped++;
      else if (res.status === 'conflict') failed++;
    } catch {
      failed++;
    }
  }
  return { purged, reconciled, skipped, failed };
}
