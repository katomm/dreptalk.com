/// <reference types="@cloudflare/workers-types" />
// Writes engine change sets to D1 in one lease checked batch: the state the reference store
// keeps, plus the DRepTalk caches (counted_as, effective close), the published counters, the
// listing due rows, job triggers and the exact next input of every tracked credential.
import type { ChangeSet, Credential, CursorUpdate, EventRef, GroupVersion, Pos, StoredInstance } from 'drep-groups';
import { comparePos, credKey, effectiveClose, refKey } from 'drep-groups';
import { chunked, D1_MAX_BINDS } from '../../db/sql.js';
import {
  credBytes,
  encodeContext,
  encodeEvent,
  hashBytes,
  hashFromCol,
  posBinds,
  posOrNull,
  refBinds,
  refFromCols,
  scriptDisplayJson,
  versionFieldBinds,
} from '../codec.js';
import { drepIdForCredential, groupIdString } from '../ids.js';
import { LISTED_MIN_MEMBERS } from '../constants.js';
import { COMMIT, COMMIT_WIDTH, KEYED, KEYED_WIDTH, Q } from './queries.js';
import { writeBatch } from './lease.js';

type Row = Record<string, unknown>;
type Unit = { change: ChangeSet; cursor: CursorUpdate };
type Counted = 'open' | 'pending' | 'former';

const MAX = Number.MAX_SAFE_INTEGER;
const NULL_POS = [null, null, null, null, null] as const;
const order = (p: Pos): [number, number, number, number] => [p.blockHeight, p.txIndex, p.phase, p.index];
const optPos = (p: Pos | null): readonly unknown[] => (p === null ? NULL_POS : posBinds(p));
const later = (a: Pos | null, b: Pos | null): Pos | null => (a === null ? b : b === null || comparePos(a, b) >= 0 ? a : b);
const earlier = (a: Pos | null, b: Pos | null): Pos | null => (a === null ? b : b === null || comparePos(a, b) <= 0 ? a : b);
/** A ledger row at (height, tx index, 0, cert index). Mirrors posOfCert. */
const certPos = (r: Row): Pos => ({
  blockHeight: Number(r.u_h),
  txIndex: Number(r.u_ti),
  phase: 0,
  index: Number(r.u_ix),
  txHash: hashFromCol(r.u_tx),
});

export interface PreRead {
  /** By refKey(joinId), absent when new. */
  instances: Map<string, { countedAs: Counted | null; group: EventRef; joinedAt: Pos | null }>;
  /** By refKey(group), the stored dissolve. */
  dissolves: Map<string, Pos | null>;
  /** By refKey(joinId): the first applied unreg of the member after its join. */
  firstUnreg: Map<string, Pos | null>;
  /** Verdict refs already stored, a retried result writes no second delta. */
  verdictsKnown: Set<string>;
  /** By refKey(group), the stored members counter and anchor, absent for a new group. */
  groups: Map<string, { members: number; url: string | null; hash: string | null }>;
}

/** One statement per chunk of rows, each at or below the bind limit, with trailing binds after the rows. */
function rows<T>(
  db: D1Database,
  name: keyof typeof COMMIT,
  items: T[],
  binds: (x: T) => readonly unknown[],
  trailing: unknown[] = [],
): D1PreparedStatement[] {
  const size = Math.floor((D1_MAX_BINDS - trailing.length) / COMMIT_WIDTH[name]);
  return chunked(items, size).map((c) => db.prepare(COMMIT[name](c.length)).bind(...c.flatMap(binds), ...trailing));
}

/** What a batch writes, folded in unit order: the last write of a key wins, as in the reference store. */
function fold(units: Unit[]) {
  const instances = new Map<string, StoredInstance>();
  // The applied bound of each instance's member: the cursor of the unit that wrote it.
  const bounds = new Map<string, Pos>();
  const verdicts = new Map<string, ChangeSet['verdicts'][number]>();
  const latest = new Map<string, GroupVersion>();
  const dissolved = new Map<string, Pos>();
  const retired = new Map<string, { c: Credential; at: Pos[] }>();
  for (const { change, cursor } of units) {
    for (const i of change.instances) {
      instances.set(refKey(i.joinId), i);
      if (cursor.kind === 'credential') bounds.set(refKey(i.joinId), cursor.appliedThrough);
      else bounds.delete(refKey(i.joinId));
    }
    for (const v of change.verdicts) verdicts.set(refKey(v.ref), v);
    for (const v of change.versions) {
      const k = refKey(v.id);
      const cur = latest.get(k);
      if (!cur || comparePos(v.at, cur.at) >= 0) latest.set(k, v);
      if (v.status === 'dissolved') dissolved.set(k, v.at);
    }
    for (const e of change.effects) {
      if (e.kind === 'groupDissolved') dissolved.set(refKey(e.group), e.at);
      if (e.kind === 'credentialRetired') {
        const k = credKey(e.credential);
        const r = retired.get(k) ?? { c: e.credential, at: [] };
        r.at.push(e.at);
        retired.set(k, r);
      }
    }
  }
  const touched = new Map<string, EventRef>();
  for (const v of latest.values()) touched.set(refKey(v.id), v.id);
  for (const i of instances.values()) touched.set(refKey(i.group), i.group);
  for (const v of verdicts.values()) if (v.group) touched.set(refKey(v.group), v.group);
  return { instances, bounds, verdicts, latest, dissolved, retired, touched };
}

/** Bounded reads the batch is computed from. Runs are serialized under the lease, so read then write is safe. */
export async function preRead(db: D1Database, units: Unit[]): Promise<PreRead> {
  const f = fold(units);
  const pre: PreRead = {
    instances: new Map(),
    dissolves: new Map(),
    firstUnreg: new Map(),
    verdictsKnown: new Set(),
    groups: new Map(),
  };
  const joins = [...f.instances.values()].map((i) => i.joinId);
  const unregKeys = [...f.instances.values()].flatMap((i) => {
    const bound = f.bounds.get(refKey(i.joinId));
    return bound ? [{ i, bound }] : [];
  });
  const parts: Array<[string, D1PreparedStatement[]]> = [
    [
      'instances',
      chunked(joins, Math.floor(D1_MAX_BINDS / KEYED_WIDTH.loadInstances)).map((c) =>
        db.prepare(KEYED.loadInstances(c.length)).bind(...c.flatMap(refBinds)),
      ),
    ],
    ['groups', rows(db, 'preGroups', [...f.touched.values()], refBinds)],
    [
      'firstUnreg',
      rows(db, 'preFirstUnreg', unregKeys, ({ i, bound }) => [
        ...refBinds(i.joinId),
        credBytes(credKey(i.member)),
        ...order(i.joinedAt),
        ...order(bound),
      ]),
    ],
    ['verdicts', rows(db, 'preVerdicts', [...f.verdicts.values()], (v) => refBinds(v.ref))],
  ];
  for (const { i } of unregKeys) pre.firstUnreg.set(refKey(i.joinId), null);
  const stmts = parts.flatMap(([, s]) => s);
  if (stmts.length === 0) return pre;
  const results = await db.batch<Row>(stmts);
  let at = 0;
  for (const [name, s] of parts) {
    for (const res of results.slice(at, at + s.length)) {
      for (const r of res.results ?? []) {
        if (name === 'instances' && r.join_tx !== null) {
          pre.instances.set(refKey(refFromCols(r.k_tx, r.k_ix)), {
            countedAs: r.counted_as as Counted,
            group: refFromCols(r.group_tx, r.group_ix),
            joinedAt: posOrNull(r, 'joined'),
          });
        } else if (name === 'groups') {
          const k = refKey(refFromCols(r.k_gtx, r.k_gix));
          pre.dissolves.set(k, posOrNull(r, 'dis'));
          if (r.group_tx !== null) {
            pre.groups.set(k, {
              members: Number(r.members),
              url: r.profile_url === null ? null : String(r.profile_url),
              hash: r.profile_hash === null ? null : hashFromCol(r.profile_hash),
            });
          }
        } else if (name === 'firstUnreg') {
          pre.firstUnreg.set(refKey(refFromCols(r.k_tx, r.k_ix)), r.u_h === null ? null : certPos(r));
        } else if (name === 'verdicts') {
          pre.verdictsKnown.add(refKey(refFromCols(r.tx_hash, r.idx)));
        }
      }
    }
    at += s.length;
  }
  return pre;
}

type MemberChange = { group: EventRef; before: { members: number; open: boolean }; after: { members: number; open: boolean } };

/**
 * The only writer of `members`, for any number of groups. `members` is the counter before and
 * after, `before.members` the stored value read in the same pre-read. `open` is true on a side
 * that holds an open instance the other side lacks, so a member swap at an unchanged count still
 * enqueues a `power` job. Applies the listing rule, increments each group's `gen` (the members
 * update runs last, so `atGen` guards every statement against the same gen).
 */
export function memberPublishBatch(db: D1Database, changes: MemberChange[], now: number, atGen?: number): D1PreparedStatement[] {
  const guard = [atGen ?? null];
  const key = (x: MemberChange): [Uint8Array, number] => refBinds(x.group);
  const up = changes.filter((x) => x.before.members < LISTED_MIN_MEMBERS && x.after.members >= LISTED_MIN_MEMBERS);
  const down = changes.filter((x) => x.before.members >= LISTED_MIN_MEMBERS && x.after.members < LISTED_MIN_MEMBERS);
  const power = changes.filter((x) => x.before.open || x.after.open || x.before.members !== x.after.members);
  return [
    ...rows(db, 'deleteAllDue', down, key, guard),
    ...rows(db, 'dueProfileIfAnchored', up, key, [now, ...guard]),
    ...rows(db, 'enqueueGroupJobs', power, (x) => ['power', refKey(x.group), ...key(x), ...NULL_POS], guard),
    ...rows(db, 'publishMembers', changes, (x) => [...key(x), x.after.members - x.before.members], guard),
  ];
}

export function memberPublishStatements(
  db: D1Database,
  group: EventRef,
  before: { members: number; open: boolean },
  after: { members: number; open: boolean },
  now: number,
  atGen?: number,
): D1PreparedStatement[] {
  return memberPublishBatch(db, [{ group, before, after }], now, atGen);
}

type Anchor = { url: string | null; hash: string | null };
type AnchorChange = { group: EventRef; before: Anchor; after: Anchor };

/** Listed groups with a changed anchor: profile due now, website due row deleted. */
export function anchorDueBatch(db: D1Database, changes: AnchorChange[], now: number): D1PreparedStatement[] {
  const changed = changes.filter((x) => x.before.url !== x.after.url || x.before.hash !== x.after.hash);
  const key = (x: AnchorChange): [Uint8Array, number] => refBinds(x.group);
  return [...rows(db, 'dueProfileIfListed', changed, key, [now]), ...rows(db, 'deleteWebsiteDue', changed, key, [null])];
}

export function anchorDueStatements(db: D1Database, group: EventRef, before: Anchor, after: Anchor, now: number): D1PreparedStatement[] {
  return anchorDueBatch(db, [{ group, before, after }], now);
}

function countedAs(i: StoredInstance, eff: { at: Pos } | null): Counted {
  if (eff !== null) return 'former';
  return i.mode === 'open' || i.approvedAt !== null ? 'open' : 'pending';
}

/** Every statement of the commit batch, in dependency order. Pure, no I/O. */
export function commitStatements(db: D1Database, units: Unit[], pre: PreRead, now = Date.now()): D1PreparedStatement[] {
  const f = fold(units);
  const changes = units.map((u) => u.change);
  const g = refBinds;

  // Per group counter deltas. The open flags record instances entering or leaving the open set.
  type Delta = { group: EventRef; open: number; pending: number; former: number; applied: number; notApplied: number; openIn: boolean; openOut: boolean };
  const deltas = new Map<string, Delta>();
  for (const [k, group] of f.touched) {
    deltas.set(k, { group, open: 0, pending: 0, former: 0, applied: 0, notApplied: 0, openIn: false, openOut: false });
  }
  const bump = (d: Delta, c: Counted, by: number): void => {
    if (c === 'open') d.open += by;
    else if (c === 'pending') d.pending += by;
    else d.former += by;
  };

  const instanceRows: Array<{ i: StoredInstance; eff: ReturnType<typeof effectiveClose>; counted: Counted }> = [];
  for (const [k, i] of f.instances) {
    const gk = refKey(i.group);
    const dissolveAt = pre.dissolves.get(gk) ?? f.dissolved.get(gk) ?? null;
    let unreg = pre.firstUnreg.get(k) ?? null;
    for (const at of f.retired.get(credKey(i.member))?.at ?? []) {
      if (comparePos(at, i.joinedAt) > 0) unreg = earlier(unreg, at);
    }
    const eff = effectiveClose(i, dissolveAt, unreg);
    const counted = countedAs(i, eff);
    instanceRows.push({ i, eff, counted });
    const prev = pre.instances.get(k)?.countedAs ?? null;
    if (prev === counted) continue;
    const d = deltas.get(gk) as Delta;
    if (prev !== null) bump(d, prev, -1);
    bump(d, counted, 1);
    if (prev === 'open') d.openOut = true;
    if (counted === 'open') d.openIn = true;
  }
  const trim = new Map<string, number>();
  for (const [k, v] of f.verdicts) {
    if (!v.group) continue;
    const gk = refKey(v.group);
    trim.set(gk, Math.min(trim.get(gk) ?? MAX, v.at.blockHeight));
    if (pre.verdictsKnown.has(k)) continue;
    const d = deltas.get(gk) as Delta;
    if (v.valid) d.applied++;
    else d.notApplied++;
  }
  const published = [...deltas.entries()].filter(([, d]) => d.openIn || d.openOut);
  const members: MemberChange[] = published.map(([k, d]) => {
    const was = pre.groups.get(k)?.members ?? 0;
    return { group: d.group, before: { members: was, open: d.openOut }, after: { members: was + d.open, open: d.openIn } };
  });

  // Queue entries, the earliest new entry per subject, and the newest unreg per credential.
  const queued = changes.flatMap((c) => c.queued);
  const firstEntry = new Map<string, Pos>();
  for (const q of queued) {
    const k = credKey(q.subject);
    firstEntry.set(k, earlier(firstEntry.get(k) ?? null, q.at) as Pos);
  }
  const retired = [...f.retired.entries()].map(([k, r]) => ({ k, c: r.c, at: r.at.reduce<Pos | null>(later, null) as Pos }));
  const versions = changes.flatMap((c) => c.versions);
  const latest = [...f.latest.values()];
  const dissolveJobs = latest.filter((v) => v.status === 'dissolved');
  const anchors: AnchorChange[] = latest.map((v) => {
    const stored = pre.groups.get(refKey(v.id));
    return {
      group: v.id,
      before: { url: stored?.url ?? null, hash: stored?.hash ?? null },
      after: { url: v.profile?.url ?? null, hash: v.profile?.dataHash ?? null },
    };
  });
  const groupCursor = units.reduce<Pos | null>((p, u) => (u.cursor.kind === 'group' ? u.cursor.G : p), null);

  return [
    ...rows(db, 'insertScripts', changes.flatMap((c) => c.scripts), (s) => [hashBytes(s.hash), ...posBinds(s.at), s.bytes, scriptDisplayJson(s.script)]),
    ...rows(db, 'insertMemberScripts', changes.flatMap((c) => c.memberScripts), (m) => [
      credBytes(credKey(m.credential)),
      ...posBinds(m.at),
      m.bytes,
      scriptDisplayJson(m.script),
    ]),
    ...rows(db, 'upsertVersions', versions, (v) => [
      ...g(v.id),
      ...posBinds(v.at),
      ...versionFieldBinds(v),
      v.seq.toString(),
      v.status,
      ...posBinds(v.createdAt),
      ...optPos(v.profileSetAt),
    ]),
    ...rows(db, 'upsertGroups', latest, (v) => [...g(v.id), groupIdString(v.id), ...order(v.at)]),
    ...anchorDueBatch(db, anchors, now),
    ...rows(db, 'enqueueGroupJobs', dissolveJobs, (v) => ['dissolve', refKey(v.id), ...g(v.id), ...posBinds(v.at)], [null]),
    ...rows(db, 'upsertInstances', instanceRows, ({ i, eff, counted }) => [
      ...g(i.joinId),
      ...g(i.group),
      credBytes(credKey(i.member)),
      drepIdForCredential(i.member),
      i.mode,
      ...posBinds(i.joinedAt),
      ...optPos(i.approvedAt),
      ...optPos(i.closedAt),
      i.closeReason,
      counted,
      ...optPos(eff?.at ?? null),
      eff?.reason ?? null,
    ]),
    ...rows(db, 'insertVerdicts', [...f.verdicts.values()].filter((v) => v.group !== null), (v) => [
      ...g(v.ref),
      ...g(v.group as EventRef),
      ...posBinds(v.at),
      String(v.tag),
      v.valid ? 1 : 0,
      v.reason,
      v.subject === null ? null : credBytes(credKey(v.subject)),
    ]),
    // One gen increment per touched group: here, unless its members publication owns it.
    ...rows(db, 'groupDeltas', [...deltas.values()], (d) => [
      ...g(d.group),
      d.pending,
      d.former,
      d.applied,
      d.notApplied,
      d.openIn || d.openOut ? 0 : 1,
    ]),
    ...memberPublishBatch(db, members, now),
    ...rows(db, 'upsertTrimDue', [...trim.entries()], ([k, h]) => [...g(f.touched.get(k) as EventRef), h]),
    ...rows(db, 'insertQueue', queued, (q) => [
      hashBytes(q.txHash),
      q.at.index,
      credBytes(credKey(q.subject)),
      ...posBinds(q.at),
      ...(q.group === null ? [null, null] : refBinds(q.group)),
      encodeEvent(q.event),
    ]),
    ...rows(db, 'lowerNext', [...firstEntry.entries()], ([k, p]) => [credBytes(k), ...posBinds(p)]),
    ...rows(db, 'insertTxContexts', changes.flatMap((c) => c.txContexts), (t) => {
      const e = encodeContext(t.context);
      return [hashBytes(t.txHash), e.signers, e.requiredSigners, e.invalidBefore, e.invalidHereafter];
    }),
    ...rows(db, 'markApplied', changes.flatMap((c) => c.appliedQueue), (r) => g(r)),
    ...rows(db, 'retireCredentials', retired, (r) => [credBytes(r.k), ...posBinds(r.at)]),
    ...rows(db, 'enqueueRetireJobs', retired, (r) => [r.k, credBytes(r.k), ...posBinds(r.at)]),
    // Cursors last, so next is recomputed over the queue as this batch leaves it.
    ...(groupCursor === null ? [] : [db.prepare(Q.groupCursor.sql).bind(...posBinds(groupCursor), ...order(groupCursor))]),
    ...units.flatMap((u) => {
      if (u.cursor.kind !== 'credential') return [];
      const k = credBytes(credKey(u.cursor.credential));
      const a = u.cursor.appliedThrough;
      return [db.prepare(Q.credentialCursor.sql).bind(...posBinds(a), ...order(a), ...order(a), ...order(a), ...order(a), k)];
    }),
  ];
}

/** Commits the units atomically. An empty list still runs the lease guard. */
export async function commit(db: D1Database, units: Unit[], lease: string): Promise<void> {
  const pre = await preRead(db, units);
  await writeBatch(db, lease, commitStatements(db, units, pre));
}
