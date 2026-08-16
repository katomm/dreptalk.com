/// <reference types="@cloudflare/workers-types" />
// src/lib/cip100/cron.ts
// The gov-sync phase. Reconciles a bounded batch of posts whose documents are
// missing or behind. Reusing the existing cron keeps this free of new
// infrastructure, and it makes the backfill a permanent repair loop rather than
// a one-off script.
import { EDIT_GRACE_MS } from '../forum/editPolicy.js';
import { findStalePostIds } from '../db/cip100.js';
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
): Promise<{ reconciled: number; skipped: number; failed: number }> {
  // A deleted post is never reconciled back into existence. Two independent
  // guards hold that: the candidate query excludes deleted posts and topics,
  // and the reconciler reads the scope rule fresh for every post it is handed.
  // Either one alone is sufficient. Erasing the bytes of an already deleted
  // post is a separate concern and belongs to the post-erasure phase, which
  // runs before this one.

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
      else if (res.status === 'conflict') {
        failed++;
        // A conflict survives two attempts only under sustained concurrent
        // writes to one post. Named here so it is visible if it ever becomes
        // the norm rather than the exception.
        console.warn(`[cip100] gave up on post ${id} after a version conflict`);
      }
    } catch (err) {
      failed++;
      console.error(`[cip100] reconcile failed for post ${id}:`, err);
    }
  }
  return { reconciled, skipped, failed };
}
