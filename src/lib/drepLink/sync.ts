// gov-sync work for drep.link: hand out handles to DReps the seed never saw
// (new registrations, names added later) and run the grace lifecycle. Idle until
// the reviewed launch seed has written its marker row.
import { assignHandles, handleBase } from './assign.js';
import {
  isSeeded, listAutoCandidates, listLiveHandles, insertAutoHandles, runHandleLifecycle,
} from '../db/drepHandles.js';

export interface DrepHandlesSyncResult {
  seeded: boolean;
  assigned: number;
  skipped: number;
  released: number;
  restored: number;
  deleted: number;
}

/** `now` is unix seconds, the unit of every drep_handles timestamp. */
export async function syncDrepHandles(db: D1Database, now: number): Promise<DrepHandlesSyncResult> {
  if (!(await isSeeded(db))) return { seeded: false, assigned: 0, skipped: 0, released: 0, restored: 0, deleted: 0 };

  const candidates = await listAutoCandidates(db);
  let assigned = 0;
  let skipped = 0;
  if (candidates.length > 0) {
    // DReps that already hold a handle (claimed before this run) are only
    // stamped. Letting them into the assignment would reserve a name they
    // cannot receive and push the next DRep with that name out.
    const open = candidates.filter((c) => !c.hasHandle);
    const bases = [...new Set(open.map((c) => (c.name ? handleBase(c.name) : '')).filter(Boolean))];
    const taken = await listLiveHandles(db, bases, now);
    const result = assignHandles(open, taken);
    skipped = result.skipped.length;
    assigned = await insertAutoHandles(db, result.assigned, candidates.map((c) => c.drepId), now);
  }
  const life = await runHandleLifecycle(db, now);
  return { seeded: true, assigned, skipped, ...life };
}
