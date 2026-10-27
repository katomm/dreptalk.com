/// <reference types="@cloudflare/workers-types" />
// Recovery slots and the bounded recovery steps of the DRep groups store. Only the phase name is
// kept between calls: every page selects its rows with an indexed predicate that a processed row
// no longer matches, so a step restarted anywhere deletes nothing twice and misses nothing.
import type { EventRef, Pos, Recovery, RecoveryState } from 'drep-groups';
import { comparePos, endOf, mergeRecovery } from 'drep-groups';
import { chunked, D1_MAX_BINDS } from '../../db/sql.js';
import { posFromRow } from '../codec.js';
import { CHANGES_PER_ROW } from '../constants.js';
import { anchorDueBatch } from './commit.js';
import { guardedBatch, writeBatch } from './lease.js';
import {
  COMMIT,
  COMMIT_WIDTH,
  type PagedPart,
  PHASE_ORDER,
  PHASE_PARTS,
  partPage,
  partProbe,
  phaseAdvance,
  phaseProbes,
  Q,
  REC_KEYED,
  REC_KEYED_WIDTH,
  type RecoveryMode,
} from './queries.js';

type Row = Record<string, unknown>;

export type RecoveryPhase = 'jobs' | 'raw' | 'state' | 'undo' | 'versions' | 'credentials' | 'flags' | 'markers' | 'cursors' | 'done';

/** Both recovery slots with the cut time of each truncation, null when unknown. */
export type Slots = RecoveryState & { firstTime: number | null; thenTime: number | null };

/** Guard insert and delete plus the meta row write of one page batch. */
const BATCH_OVERHEAD = 3;

/** One statement per chunk of items, each at or below the bind limit, with trailing binds after the rows. */
export function keyedStatements<T>(
  db: D1Database,
  build: (n: number) => string,
  width: number,
  items: T[],
  binds: (x: T) => readonly unknown[],
  trailing: readonly unknown[] = [],
): D1PreparedStatement[] {
  const size = Math.floor((D1_MAX_BINDS - trailing.length) / width);
  return chunked(items, size).map((c) => db.prepare(build(c.length)).bind(...c.flatMap(binds), ...trailing));
}

export async function readMeta(db: D1Database): Promise<Row> {
  const r = await db.prepare(Q.metaRow.sql).first<Row>();
  if (!r) throw new Error('drep group meta row missing');
  return r;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function firstSlot(r: Row): Recovery | null {
  switch (r.rec_first_kind) {
    case null:
      return null;
    case 'truncate':
      return { kind: 'truncate', above: Number(r.rec_first_above) };
    case 'rebuild':
      return { kind: 'rebuild' };
    case 'fork':
      return { kind: 'fork' };
    default:
      throw new Error(`bad recovery kind ${String(r.rec_first_kind)}`);
  }
}

export function slotsFromMeta(r: Row): Slots {
  const first = firstSlot(r);
  const thenAbove = num(r.rec_then_above);
  return {
    first,
    // biome-ignore lint/suspicious/noThenProperty: the library's RecoveryState names its second slot then
    then: thenAbove === null ? null : { kind: 'truncate', above: thenAbove },
    firstTime: num(r.rec_first_time),
    thenTime: num(r.rec_then_time),
  };
}

const firstPhase = (r: Recovery): RecoveryPhase => (r.kind === 'truncate' ? 'jobs' : 'state');

const sameRecovery = (a: Recovery | null, b: Recovery | null): boolean =>
  a === null || b === null
    ? a === b
    : a.kind === b.kind && (a.kind !== 'truncate' || a.above === (b as { above: number }).above);

/**
 * The slots after `r` is opened. The library's merge decides the slots, a merged truncation keeps
 * the time of the lower cut (of equal cuts the earlier known time).
 */
export function mergeSlots(cur: Slots, r: Recovery, cutTime: number | null): Slots {
  // biome-ignore lint/suspicious/noThenProperty: the library's RecoveryState names its second slot then
  const next = mergeRecovery({ first: cur.first, then: cur.then }, r);
  const cands: Array<{ above: number; time: number | null }> = [];
  if (cur.first?.kind === 'truncate') cands.push({ above: cur.first.above, time: cur.firstTime });
  if (cur.then) cands.push({ above: cur.then.above, time: cur.thenTime });
  if (r.kind === 'truncate') cands.push({ above: r.above, time: cutTime });
  const timeFor = (above: number): number | null => {
    const ts = cands.filter((c) => c.above === above && c.time !== null).map((c) => c.time as number);
    return ts.length === 0 ? null : Math.min(...ts);
  };
  return {
    first: next.first,
    // biome-ignore lint/suspicious/noThenProperty: the library's RecoveryState names its second slot then
    then: next.then,
    firstTime: next.first?.kind === 'truncate' ? timeFor(next.first.above) : null,
    thenTime: next.then ? timeFor(next.then.above) : null,
  };
}

/**
 * The meta write from `before` to `after`. A changed first slot, or `restart`, sets the phase to
 * the first phase of the new first slot. A rebuild that becomes first sets rebuilding, a fork that
 * replaces a rebuild clears it. Nothing changed writes nothing.
 */
export function slotStatements(db: D1Database, before: Slots, after: Slots, restart = false): D1PreparedStatement[] {
  const changed = !sameRecovery(before.first, after.first);
  const phase = (changed || restart) && after.first !== null ? firstPhase(after.first) : null;
  const rebuilding =
    after.first?.kind === 'rebuild' && before.first?.kind !== 'rebuild'
      ? 1
      : after.first?.kind === 'fork' && before.first?.kind === 'rebuild'
        ? 0
        : null;
  const same =
    !changed &&
    phase === null &&
    before.firstTime === after.firstTime &&
    sameRecovery(before.then, after.then) &&
    before.thenTime === after.thenTime;
  if (same) return [];
  return [
    db
      .prepare(Q.recoverySlots.sql)
      .bind(
        after.first?.kind ?? null,
        after.first?.kind === 'truncate' ? after.first.above : null,
        after.firstTime,
        after.then?.above ?? null,
        after.thenTime,
        phase === null ? 0 : 1,
        phase,
        rebuilding,
      ),
  ];
}

/** Pure, for one batch with other writes. Resets rec_phase when the merge changes the first slot. */
export function openRecoveryStatements(
  db: D1Database,
  current: RecoveryState & { firstTime: number | null; thenTime: number | null },
  r: Recovery,
  cutTime: number | null,
): D1PreparedStatement[] {
  return slotStatements(db, current, mergeSlots(current, r, cutTime));
}

export async function openRecovery(db: D1Database, r: Recovery, lease: string, cutTime: number | null = null): Promise<void> {
  const meta = await readMeta(db);
  await writeBatch(db, lease, openRecoveryStatements(db, slotsFromMeta(meta), r, cutTime));
}

/** Pops only a matching first slot, promotes the second slot to first and resets the phase. */
export async function finishRecovery(db: D1Database, done: Recovery, lease: string): Promise<void> {
  const s = slotsFromMeta(await readMeta(db));
  if (!sameRecovery(s.first, done) || s.first === null) {
    await writeBatch(db, lease, []);
    return;
  }
  const first: Recovery | null = s.then;
  const stmt = db
    .prepare(Q.recoverySlots.sql)
    .bind(first?.kind ?? null, first?.above ?? null, first ? s.thenTime : null, null, null, 1, first ? 'jobs' : null, null);
  await writeBatch(db, lease, [stmt]);
}

export async function truncateStep(db: D1Database, above: number, budget: number, lease: string): Promise<'more' | 'done'> {
  return step(db, 'truncate', above, budget, lease);
}

export async function resetStep(db: D1Database, mode: 'rebuild' | 'fork', budget: number, lease: string): Promise<'more' | 'done'> {
  return step(db, mode, -1, budget, lease);
}

type CostKey = keyof typeof CHANGES_PER_ROW;

/** rows_written of a batch, every statement included. */
function written(res: D1Result[], estimate: number): number {
  let n = 0;
  for (const r of res) {
    const w = (r.meta as { rows_written?: number } | undefined)?.rows_written;
    if (w === undefined) return estimate;
    n += w;
  }
  return n;
}

async function probe(db: D1Database, sql: string, binds: unknown[]): Promise<boolean> {
  return (await db.prepare(sql).bind(...binds).first()) !== null;
}

function pageStatements(db: D1Database, p: PagedPart, cut: number, limit: number): D1PreparedStatement[] {
  const page = partPage(p);
  return p.stmts.map((s) =>
    db.prepare(s.sql(page)).bind(...Array.from({ length: s.lead ?? 0 }, () => cut), ...(p.cut ? [cut] : []), limit),
  );
}

/** Groups above the cut, each restored to its latest remaining version or deleted with its due rows. */
async function versionsStatements(db: D1Database, cut: number, limit: number): Promise<D1PreparedStatement[]> {
  const rows = (await db.prepare(Q.recVersionsPage.sql).bind(cut, cut, limit).all<Row>()).results ?? [];
  const group = (r: Row): EventRef => ({ txHash: String(r.k_gtx), index: Number(r.k_gix) });
  const key = (r: Row): [string, number] => [String(r.k_gtx), Number(r.k_gix)];
  const kept = rows.filter((r) => r.group_tx !== null);
  const gone = rows.filter((r) => r.group_tx === null);
  const str = (v: unknown): string | null => (v === null ? null : String(v));
  return [
    ...keyedStatements(
      db,
      REC_KEYED.restoreGroups,
      REC_KEYED_WIDTH.restoreGroups,
      kept,
      (r) => [...key(r), r.at_h, r.at_ti, r.at_ph, r.at_ix],
      Array.from({ length: 6 }, () => cut),
    ),
    ...keyedStatements(db, REC_KEYED.recomputeJobs, REC_KEYED_WIDTH.recomputeJobs, kept, key),
    ...anchorDueBatch(
      db,
      kept.map((r) => ({
        group: group(r),
        before: { url: str(r.g_url), hash: str(r.g_hash) },
        after: { url: str(r.profile_url), hash: str(r.profile_hash) },
      })),
      Date.now(),
    ),
    ...keyedStatements(db, COMMIT.deleteAllDue, COMMIT_WIDTH.deleteAllDue, gone, key, [null]),
    ...keyedStatements(db, REC_KEYED.deleteTrimDue, REC_KEYED_WIDTH.deleteTrimDue, gone, key),
    ...keyedStatements(db, REC_KEYED.deleteGroups, REC_KEYED_WIDTH.deleteGroups, gone, key),
  ];
}

async function cursorStatement(db: D1Database, mode: RecoveryMode, cut: number): Promise<D1PreparedStatement> {
  if (mode === 'rebuild') return db.prepare(Q.recRebuildCursors.sql);
  if (mode === 'fork') return db.prepare(Q.recForkCursors.sql);
  const meta = await readMeta(db);
  const G = posFromRow(meta, 'G');
  const end = endOf(cut);
  const g: Pos = comparePos(G, end) <= 0 ? G : end;
  const L = Number(meta.L);
  const R = num(meta.R);
  let time = num(meta.rec_first_time);
  if (time === null) {
    const r = await db.prepare(Q.recLedgerTime.sql).bind(cut).first<Row>();
    time = r ? Number(r.block_time) : 0;
  }
  // The reader only moves back: rows between its position and the cut are not read yet.
  const regTime = num(meta.reg_time);
  return db
    .prepare(Q.recTruncateCursors.sql)
    .bind(
      g.blockHeight,
      g.txIndex,
      g.phase,
      g.index,
      g.txHash,
      Math.min(L, cut),
      L > cut ? null : meta.L_hash,
      R === null ? null : Math.min(R, cut),
      regTime === null ? null : Math.min(regTime, time),
    );
}

/**
 * Runs the phases of `mode` from the stored one. A call writes at most `budget` rows plus
 * RECOVERY_STEP_OVERHEAD: the first page of a call takes at least one row, every later page and
 * phase only what the budget has left after its own batch overhead.
 */
async function step(db: D1Database, mode: RecoveryMode, cut: number, budget: number, lease: string): Promise<'more' | 'done'> {
  const order = PHASE_ORDER[mode];
  const stored = (await readMeta(db)).rec_phase as RecoveryPhase | null;
  let i = stored === 'done' ? order.length : Math.max(0, order.indexOf(stored ?? order[0]));
  if (i >= order.length) {
    await writeBatch(db, lease, []);
    return 'done';
  }
  let left = budget;
  let wrote = false;
  for (; i < order.length; i++) {
    const phase = order[i] as RecoveryPhase;
    if (phase === 'cursors') {
      if (wrote && left < BATCH_OVERHEAD) return 'more';
      await writeBatch(db, lease, [await cursorStatement(db, mode, cut)]);
      return 'done';
    }
    const cost = CHANGES_PER_ROW[phase as CostKey];
    const advance = db
      .prepare(phaseAdvance(mode, phase))
      .bind(...phaseProbes(mode, phase).flatMap((p) => (p.cut ? [cut] : [])), phase, order[i + 1]);
    const pages: Array<{ probe: () => Promise<boolean>; stmts: (limit: number) => Promise<D1PreparedStatement[]> }> =
      mode === 'truncate' && phase === 'versions'
        ? [{ probe: () => probe(db, Q.recVersionsProbe.sql, [cut]), stmts: (n) => versionsStatements(db, cut, n) }]
        : (PHASE_PARTS[mode][phase] ?? []).map((p) => ({
            probe: () => probe(db, partProbe(p), p.cut ? [cut] : []),
            stmts: async (n) => pageStatements(db, p, cut, n),
          }));
    for (const part of pages) {
      while (await part.probe()) {
        const limit = wrote ? Math.floor((left - BATCH_OVERHEAD) / cost) : Math.max(1, Math.floor(left / cost));
        if (limit < 1) return 'more';
        const res = await guardedBatch(db, lease, [...(await part.stmts(limit)), advance]);
        left -= written(res, limit * cost + BATCH_OVERHEAD);
        wrote = true;
      }
    }
  }
  return 'more';
}

