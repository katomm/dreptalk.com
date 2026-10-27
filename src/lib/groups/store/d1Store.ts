/// <reference types="@cloudflare/workers-types" />
// The library's Store over D1: reads, the commit and the recovery steps of this directory.
import type {
  ChangeSet,
  CursorUpdate,
  DecodedEvent,
  EventRef,
  Frontiers,
  Keys,
  Pos,
  ReadyCredential,
  Recovery,
  Store,
  StoredLabelTx,
  View,
} from 'drep-groups';
import { commit } from './commit.js';
import { finishRecovery, openRecovery, resetStep, truncateStep } from './recovery.js';
import { frontiers, load, nextLabelTxs, pendingRecovery, queuedJoins, readyCredentials } from './reads.js';

export class D1Store implements Store {
  constructor(readonly db: D1Database) {}

  load(keys: Keys, overlay: ChangeSet[]): Promise<View> {
    return load(this.db, keys, overlay);
  }
  commit(units: Array<{ change: ChangeSet; cursor: CursorUpdate }>, lease: string): Promise<void> {
    return commit(this.db, units, lease);
  }
  nextLabelTxs(after: Pos, L: number, maxTxs: number, maxBytes: number): Promise<{ txs: StoredLabelTx[]; done: boolean }> {
    return nextLabelTxs(this.db, after, L, maxTxs, maxBytes);
  }
  queuedJoins(refs: EventRef[], overlay: ChangeSet[]): Promise<Map<string, DecodedEvent | 'ignored'>> {
    return queuedJoins(this.db, refs, overlay);
  }
  readyCredentials(maxUnits: number, maxInputs: number, upTo: { G: Pos; R: number | null }): Promise<ReadyCredential[]> {
    return readyCredentials(this.db, maxUnits, maxInputs, upTo);
  }
  frontiers(): Promise<Frontiers> {
    return frontiers(this.db);
  }
  pendingRecovery(): Promise<Recovery | null> {
    return pendingRecovery(this.db);
  }
  /** Without a cut time: the truncation falls back to the ledger time at its cut. */
  openRecovery(r: Recovery, lease: string): Promise<void> {
    return openRecovery(this.db, r, lease);
  }
  finishRecovery(done: Recovery, lease: string): Promise<void> {
    return finishRecovery(this.db, done, lease);
  }
  truncateStep(above: number, budget: number, lease: string): Promise<'more' | 'done'> {
    return truncateStep(this.db, above, budget, lease);
  }
  resetStep(mode: 'rebuild' | 'fork', budget: number, lease: string): Promise<'more' | 'done'> {
    return resetStep(this.db, mode, budget, lease);
  }
}
