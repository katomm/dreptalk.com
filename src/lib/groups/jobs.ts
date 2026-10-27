/// <reference types="@cloudflare/workers-types" />
// Bounded background jobs that keep DRepTalk's projection of the engine state: lazy dissolve and
// retirement closes, repairs and recomputes after a truncation, verdict trimming, the power change
// scan and the member power sum. Every page is one lease checked batch within its row and query
// limits. Jobs are restartable, never resumable across a change: a page whose group or credential
// moved to another generation since the job started begins again at page 0.
import type { EventRef, Pos, StoredInstance } from 'drep-groups';
import { comparePos, effectiveClose, RETENTION_FLOOR, refKey } from 'drep-groups';
import { chunked, D1_MAX_BINDS } from '../db/sql.js';
import type { Allowance } from '../sync/queryBudget.js';
import { bytesFromCol, hashBytes, instanceFromRow, posBinds, posOrNull, refBinds, refFromCols } from './codec.js';
import { JOB_MAX_QUERIES, POWER_SCAN_PAGE, RETENTION_KEEP_APPLIED, RETENTION_KEEP_NOT_APPLIED } from './constants.js';
import { certPos, type Counted, countedAs, type MemberChange, memberPublishBatch, memberPublishStatements } from './store/commit.js';
import { writeBatch } from './store/lease.js';
import { COMMIT, COMMIT_WIDTH, JOB, JOB_TRAILING, JOB_WIDTH, Q } from './store/queries.js';
import { keyedStatements } from './store/recovery.js';

type JobKind = 'dissolve' | 'retire' | 'repair' | 'recompute' | 'trim' | 'power' | 'power-scan';

export interface JobReport {
  pages: number;
  rows: number;
  finished: number;
  more: boolean;
  skipped: 'recovery' | 'budget' | null;
}

// A job of an earlier kind runs before any page of a later one.
const PRIORITY: readonly JobKind[] = ['recompute', 'repair', 'dissolve', 'retire', 'trim', 'power-scan', 'power'];

type Row = Record<string, unknown>;
/** The order columns of a position, the keyset of a pass. */
type Key = [number, number, number, number];
const START: Key = [-1, -1, -1, -1];
const NULL_POS = [null, null, null, null, null] as const;
const keyOf = (p: Pos): Key => [p.blockHeight, p.txIndex, p.phase, p.index];

interface Page {
  db: D1Database;
  lease: string;
  maxRows: number;
  now: number;
  /** Queries this page has issued, its selection included. */
  reads: number;
}
interface Done {
  rows: number;
  finished: boolean;
}

async function read(p: Page, sql: string, binds: unknown[]): Promise<Row[]> {
  p.reads++;
  return (await p.db.prepare(sql).bind(...binds).all<Row>()).results ?? [];
}

const stmt = (p: Page, sql: string, ...binds: unknown[]): D1PreparedStatement => p.db.prepare(sql).bind(...binds);

/** Writes the page batch. A page never issues more than JOB_MAX_QUERIES queries. */
async function write(p: Page, stmts: D1PreparedStatement[]): Promise<void> {
  if (p.reads + stmts.length + 2 > JOB_MAX_QUERIES) throw new Error('a job page exceeds JOB_MAX_QUERIES');
  await writeBatch(p.db, p.lease, stmts);
}

/** The largest prefix of a page of `n` rows whose batch fits the page's query limit. */
function fitPage(p: Page, n: number, build: (k: number) => D1PreparedStatement[]): D1PreparedStatement[] {
  for (let k = n; ; k = Math.floor(k / 2)) {
    const stmts = build(k);
    if (p.reads + stmts.length + 2 <= JOB_MAX_QUERIES || k <= 1) return stmts;
  }
}

/**
 * Runs job pages, oldest job first by kind priority and id, while the allowance covers a whole
 * page, the selection included. Nothing runs while a recovery slot is open.
 */
export async function runJobs(
  db: D1Database,
  lease: string,
  opts: { maxRows: number; budget: Allowance; now: number },
): Promise<JobReport> {
  const report: JobReport = { pages: 0, rows: 0, finished: 0, more: false, skipped: null };
  for (;;) {
    // Without room for the selection nothing is known about the jobs left.
    if (!opts.budget.covers(1)) return { ...report, more: true, skipped: 'budget' };
    const pick = await db.prepare(Q.jobPick.sql).first<Row>();
    if (!pick) throw new Error('drep group meta row missing');
    const kind = PRIORITY.find((k) => picked(pick, k)) ?? null;
    if (pick.recovery !== null) return { ...report, more: kind !== null, skipped: 'recovery' };
    if (kind === null) return report;
    // The selection is the first query of the page.
    if (!opts.budget.covers(JOB_MAX_QUERIES - 1)) return { ...report, more: true, skipped: 'budget' };
    const p: Page = { db, lease, maxRows: opts.maxRows, now: opts.now, reads: 1 };
    const r =
      kind === 'trim'
        ? await trimPage(p, refFromCols(pick.trim_gtx, pick.trim_gix), Number(pick.L) - RETENTION_FLOOR)
        : kind === 'power-scan'
          ? await powerScanPage(p)
          : await jobPage(p, kind, Number(pick[kind]));
    report.pages++;
    report.rows += r.rows;
    if (r.finished) report.finished++;
  }
}

const picked = (pick: Row, k: JobKind): boolean => (k === 'trim' ? pick.trim_gtx : pick[k]) != null;

/** Whether any job of the kinds is waiting, trims due below the floor included. One query. */
export async function jobsPending(db: D1Database, kinds: JobKind[]): Promise<boolean> {
  const pick = await db.prepare(Q.jobPick.sql).first<Row>();
  return pick !== null && kinds.some((k) => picked(pick, k));
}

/** Enqueues the power scan when a power change is queued: one read, and a batch only when it hits. */
export async function enqueuePowerScan(db: D1Database, lease: string): Promise<boolean> {
  if ((await db.prepare(Q.powerQueued.sql).first()) === null) return false;
  await writeBatch(db, lease, [db.prepare(Q.powerScanEnqueue.sql)]);
  return true;
}

interface Job {
  id: number;
  row: Row;
  /** The generation of the job's group or credential, the start_gen of this page. */
  gen: number;
  restart: boolean;
  cursor: { pass?: string; after?: Key | null } | null;
}

async function jobPage(p: Page, kind: Exclude<JobKind, 'trim' | 'power-scan'>, id: number): Promise<Done> {
  const [row] = await read(p, Q.jobRow.sql, [id]);
  if (!row) throw new Error(`job ${id} vanished`);
  const gen = kind === 'retire' || kind === 'repair' ? row.t_gen : row.g_gen;
  if (gen === null || gen === undefined) {
    // The group or credential is gone, and with it the job's work.
    await write(p, [stmt(p, Q.jobDelete.sql, id)]);
    return { rows: 0, finished: true };
  }
  const restart = row.start_gen === null || Number(row.start_gen) !== Number(gen);
  const job: Job = { id, row, gen: Number(gen), restart, cursor: restart || row.cursor_json === null ? null : JSON.parse(String(row.cursor_json)) };
  if (kind === 'dissolve') return dissolvePage(p, job);
  if (kind === 'retire' || kind === 'repair') return credentialPage(p, job);
  if (kind === 'recompute') return recomputePage(p, job);
  return powerPage(p, job);
}

interface Derived {
  inst: StoredInstance;
  eff: ReturnType<typeof effectiveClose>;
  counted: Counted;
  prev: Counted;
  changed: boolean;
  /** The stored members counter of the instance's group, null when the group is gone. */
  members: number | null;
}

const samePos = (a: Pos | null, b: Pos | null): boolean =>
  a === null || b === null ? a === b : comparePos(a, b) === 0 && a.txHash === b.txHash;

/** Caches of a page's instances derived from the current state, by join position. */
function derive(rows: Row[]): Derived[] {
  return rows
    .map((r) => {
      const inst = instanceFromRow(r);
      const eff = effectiveClose(inst, posOrNull(r, 'dis'), r.u_h === null ? null : certPos(r));
      const counted = countedAs(inst, eff);
      const reason = r.eff_reason === null ? null : String(r.eff_reason);
      return {
        inst,
        eff,
        counted,
        prev: r.counted_as as Counted,
        changed: counted !== r.counted_as || (eff?.reason ?? null) !== reason || !samePos(eff?.at ?? null, posOrNull(r, 'eff')),
        members: r.g_tx === null ? null : Number(r.g_members),
      };
    })
    .sort((a, b) => comparePos(a.inst.joinedAt, b.inst.joinedAt));
}

type Delta = { group: EventRef; members: number; open: number; pending: number; former: number; openIn: boolean; openOut: boolean };

/** Counter deltas per group of the changed instances, groups that are gone left out. */
function deltas(items: Derived[]): Delta[] {
  const out = new Map<string, Delta>();
  for (const d of items) {
    if (!d.changed || d.prev === d.counted || d.members === null) continue;
    const k = refKey(d.inst.group);
    const x = out.get(k) ?? { group: d.inst.group, members: d.members, open: 0, pending: 0, former: 0, openIn: false, openOut: false };
    x[d.prev] -= 1;
    x[d.counted] += 1;
    if (d.prev === 'open') x.openOut = true;
    if (d.counted === 'open') x.openIn = true;
    out.set(k, x);
  }
  return [...out.values()];
}

const memberChanges = (ds: Delta[]): MemberChange[] =>
  ds
    .filter((d) => d.openIn || d.openOut)
    .map((d) => ({ group: d.group, before: { members: d.members, open: d.openOut }, after: { members: d.members + d.open, open: d.openIn } }));

/** Cache writes and pending and former deltas of a page, guarded by the group generation (null accepts any). */
function cacheStatements(p: Page, items: Derived[], ds: Delta[], gen: number | null): D1PreparedStatement[] {
  return [
    ...keyedStatements(
      p.db,
      JOB.writeCaches,
      JOB_WIDTH.writeCaches,
      items.filter((d) => d.changed),
      (d) => [...refBinds(d.inst.joinId), d.counted, ...(d.eff ? posBinds(d.eff.at) : NULL_POS), d.eff?.reason ?? null],
      [gen],
    ),
    ...keyedStatements(
      p.db,
      JOB.counterDeltas,
      JOB_WIDTH.counterDeltas,
      ds.filter((d) => d.pending !== 0 || d.former !== 0),
      (d) => [...refBinds(d.group), d.pending, d.former],
      [gen],
    ),
  ];
}

const progress = (p: Page, job: Job, cursor: unknown, staging: string | null, startGen: number): D1PreparedStatement =>
  stmt(p, Q.jobProgress.sql, cursor === null ? null : JSON.stringify(cursor), staging, startGen, job.id);

const groupOf = (job: Job): EventRef => refFromCols(job.row.group_tx, job.row.group_ix);

/** Closes the group's instances by join position, its last page clears closing and enqueues a power job. */
async function dissolvePage(p: Page, job: Job): Promise<Done> {
  const group = groupOf(job);
  const rows = await read(p, Q.jobGroupPass.sql, [...refBinds(group), ...(job.cursor?.after ?? START), p.maxRows]);
  const derived = derive(rows);
  let used = 0;
  let last = false;
  const stmts = fitPage(p, derived.length, (k) => {
    used = k;
    last = k === derived.length && rows.length < p.maxRows;
    const items = derived.slice(0, k);
    const ds = deltas(items);
    const changes = memberChanges(ds);
    const g = job.gen;
    return [
      ...cacheStatements(p, items, ds, g),
      ...(last
        ? [
            stmt(p, Q.jobDissolveDone.sql, ...refBinds(group), g),
            ...keyedStatements(p.db, COMMIT.enqueueGroupJobs, COMMIT_WIDTH.enqueueGroupJobs, [group], (x) => ['power', refKey(x), ...refBinds(x), ...NULL_POS], [g]),
            stmt(p, Q.jobDeleteAtGroupGen.sql, job.id, ...refBinds(group), g),
          ]
        : []),
      ...memberPublishBatch(p.db, changes, p.now, g),
      // The publication increments the group's gen, start_gen moves along with it.
      ...(last ? [] : [progress(p, job, { after: keyOf(items[k - 1].inst.joinedAt) }, null, g + (changes.length > 0 ? 1 : 0))]),
    ];
  });
  await write(p, stmts);
  return { rows: used, finished: last };
}

/**
 * The credential pass of `retire` and `repair`: every instance of the credential against the
 * retirements that remain. Its last page clears retiring under the credential's start_gen.
 */
async function credentialPage(p: Page, job: Job): Promise<Done> {
  const cred = bytesFromCol(job.row.cred);
  const rows = await read(p, Q.jobCredPass.sql, [cred, ...(job.cursor?.after ?? START), p.maxRows]);
  const derived = derive(rows);
  let used = 0;
  let last = false;
  const stmts = fitPage(p, derived.length, (k) => {
    used = k;
    last = k === derived.length && rows.length < p.maxRows;
    const items = derived.slice(0, k);
    const ds = deltas(items);
    // The groups of a credential each have a generation of their own, the publication takes any:
    // the page read their counters in this run under the lease.
    return [
      ...cacheStatements(p, items, ds, null),
      ...memberPublishBatch(p.db, memberChanges(ds), p.now),
      ...(last
        ? [stmt(p, Q.jobRetireDone.sql, cred, job.gen), stmt(p, Q.jobDeleteAtCredGen.sql, job.id, cred, job.gen)]
        : [progress(p, job, { after: keyOf(items[k - 1].inst.joinedAt) }, null, job.gen)]),
    ];
  });
  await write(p, stmts);
  return { rows: used, finished: last };
}

interface Staging {
  members: number;
  pending: number;
  former: number;
  applied: number;
  notApplied: number;
}
const ZERO: Staging = { members: 0, pending: 0, former: 0, applied: 0, notApplied: 0 };

/**
 * Counts a group into staging: the instances by join position (caches derived first), then the
 * retained applied and not applied verdicts by position. The last page publishes under start_gen.
 */
async function recomputePage(p: Page, job: Job): Promise<Done> {
  const group = groupOf(job);
  const g = job.gen;
  const cursor = job.cursor ?? { pass: 'instances', after: null };
  const staged: Staging = job.restart || job.row.staging === null ? { ...ZERO } : { ...ZERO, ...JSON.parse(String(job.row.staging)) };
  const after = cursor.after ?? START;
  if (cursor.pass === 'instances') {
    const rows = await read(p, Q.jobGroupPass.sql, [...refBinds(group), ...after, p.maxRows]);
    const derived = derive(rows);
    let used = 0;
    const stmts = fitPage(p, derived.length, (k) => {
      used = k;
      const items = derived.slice(0, k);
      const s = { ...staged };
      for (const d of items) s[d.counted === 'open' ? 'members' : d.counted] += 1;
      const next = k === derived.length && rows.length < p.maxRows ? { pass: 'applied', after: null } : { pass: 'instances', after: keyOf(items[k - 1].inst.joinedAt) };
      return [...cacheStatements(p, items, [], g), progress(p, job, next, JSON.stringify(s), g)];
    });
    await write(p, stmts);
    return { rows: used, finished: false };
  }
  const applied = cursor.pass === 'applied';
  const rows = await read(p, Q.jobVerdictPass.sql, [...refBinds(group), applied ? 1 : 0, ...after, p.maxRows]);
  staged[applied ? 'applied' : 'notApplied'] += rows.length;
  if (rows.length === p.maxRows || applied) {
    const last = rows.at(-1);
    const next =
      rows.length === p.maxRows && last
        ? { pass: cursor.pass, after: [Number(last.at_h), Number(last.at_ti), Number(last.at_ph), Number(last.at_ix)] }
        : { pass: 'notApplied', after: null };
    await write(p, [progress(p, job, next, JSON.stringify(staged), g)]);
    return { rows: rows.length, finished: false };
  }
  await write(p, [
    stmt(p, Q.jobRecomputePublish.sql, staged.pending, staged.former, staged.applied, staged.notApplied, ...refBinds(group), g),
    stmt(p, Q.jobDeleteAtGroupGen.sql, job.id, ...refBinds(group), g),
    // Open on both sides: the publication always enqueues a power job.
    ...memberPublishStatements(p.db, group, { members: Number(job.row.g_members), open: true }, { members: staged.members, open: true }, p.now, g),
  ]);
  return { rows: rows.length, finished: true };
}

/** Sums the voting power of the group's open instances into staging, page by page, inside SQL. */
async function powerPage(p: Page, job: Job): Promise<Done> {
  const group = groupOf(job);
  const g = job.gen;
  const after = job.cursor?.after ?? START;
  const rows = await read(p, Q.jobPowerPass.sql, [...refBinds(group), ...after, p.maxRows]);
  const lastRow = rows.at(-1);
  const upper: Key = lastRow ? [Number(lastRow.joined_h), Number(lastRow.joined_ti), Number(lastRow.joined_ph), Number(lastRow.joined_ix)] : after;
  const last = rows.length < p.maxRows;
  await write(p, [
    ...(job.restart ? [progress(p, job, null, null, g)] : []),
    stmt(p, Q.jobPowerSum.sql, ...refBinds(group), ...after, ...upper, JSON.stringify({ after: upper }), g, job.id),
    ...(last ? [stmt(p, Q.jobPowerPublish.sql, job.id, ...refBinds(group), g), stmt(p, Q.jobDeleteAtGroupGen.sql, job.id, ...refBinds(group), g)] : []),
  ]);
  return { rows: rows.length, finished: last };
}

/**
 * Deletes a group's verdicts below the floor beyond the newest kept of each class, by position,
 * adds them to the trimmed columns and increments the group's gen when it deleted any. A finished
 * group is due again once the floor passes the first height with a trimmable verdict.
 */
async function trimPage(p: Page, group: EventRef, floor: number): Promise<Done> {
  const g = refBinds(group);
  const counts = await p.db.batch<{ n: number }>([
    stmt(p, Q.trimCount.sql, ...g, 1, floor, p.maxRows, RETENTION_KEEP_APPLIED),
    stmt(p, Q.trimCount.sql, ...g, 0, floor, p.maxRows, RETENTION_KEEP_NOT_APPLIED),
  ]);
  p.reads += 2;
  const applied = Number(counts[0].results?.[0]?.n ?? 0);
  const notApplied = Math.min(Number(counts[1].results?.[0]?.n ?? 0), p.maxRows - applied);
  const finished = applied + notApplied < p.maxRows;
  await write(p, [
    ...(applied + notApplied > 0 ? [stmt(p, Q.trimGroup.sql, applied, notApplied, ...g)] : []),
    ...(applied > 0 ? [stmt(p, Q.trimDelete.sql, ...g, 1, floor, applied, RETENTION_KEEP_APPLIED)] : []),
    ...(notApplied > 0 ? [stmt(p, Q.trimDelete.sql, ...g, 0, floor, notApplied, RETENTION_KEEP_NOT_APPLIED)] : []),
    ...(finished
      ? [stmt(p, Q.trimNext.sql, ...g, ...g, ...g), stmt(p, Q.trimDone.sql, ...g, ...g, ...g)]
      : []),
  ]);
  return { rows: applied + notApplied, finished };
}

/** The keyset binds of a queue row's after_key, the group key `<tx hex>#<index>` its scan passed. */
function afterBinds(afterKey: unknown): [Uint8Array, number] {
  if (afterKey === null) return [new Uint8Array(0), -1];
  const [tx, ix] = String(afterKey).split('#');
  return [hashBytes(tx), Number(ix)];
}

/**
 * Consumes the power change queue oldest seq first: per DRep its open instances by group from its
 * keyset, a power job and a gen increment per group found, the queue row deleted only once its
 * instances are exhausted. Progress and delete bind the seq the page read, so a DRep written again
 * in between stays queued with its keyset reset.
 */
async function powerScanPage(p: Page): Promise<Done> {
  const queue = await read(p, Q.powerQueue.sql, [POWER_SCAN_PAGE]);
  let left = p.maxRows;
  const found = new Map<string, EventRef>();
  const done: Array<[string, number]> = [];
  let partial: { drep: string; seq: number; key: string } | null = null;
  const size = Math.floor((D1_MAX_BINDS - (JOB_TRAILING.scanInstances ?? 0)) / JOB_WIDTH.scanInstances);
  scan: for (const chunk of chunked(queue, size)) {
    const limit = left;
    const rows = await read(p, JOB.scanInstances(chunk.length), [...chunk.flatMap((q) => [q.drep_id, ...afterBinds(q.after_key)]), limit]);
    const own = new Map<string, EventRef[]>();
    for (const r of rows) own.set(String(r.k_drep), [...(own.get(String(r.k_drep)) ?? []), refFromCols(r.group_tx, r.group_ix)]);
    for (const q of chunk) {
      const refs = (own.get(String(q.drep_id)) ?? []).sort((a, b) => (a.txHash < b.txHash ? -1 : a.txHash > b.txHash ? 1 : a.index - b.index));
      const take = refs.slice(0, left);
      for (const r of take) found.set(refKey(r), r);
      left -= take.length;
      if (take.length === refs.length && refs.length < limit) done.push([String(q.drep_id), Number(q.seq)]);
      else {
        partial = { drep: String(q.drep_id), seq: Number(q.seq), key: refKey(take[take.length - 1]) };
        break scan;
      }
      if (left === 0) break scan;
    }
  }
  const groups = [...found.values()];
  await write(p, [
    ...keyedStatements(p.db, JOB.scanPowerJobs, JOB_WIDTH.scanPowerJobs, groups, refBinds),
    ...keyedStatements(p.db, JOB.scanGens, JOB_WIDTH.scanGens, groups, refBinds),
    ...keyedStatements(p.db, JOB.scanDone, JOB_WIDTH.scanDone, done, (d) => d),
    ...(partial ? [stmt(p, Q.powerProgress.sql, partial.key, partial.drep, partial.seq)] : []),
    stmt(p, Q.powerScanDone.sql),
  ]);
  return { rows: p.maxRows - left, finished: partial === null && done.length === queue.length && queue.length < POWER_SCAN_PAGE };
}
