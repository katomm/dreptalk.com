/// <reference types="@cloudflare/workers-types" />
// Engine change sets built directly from the library types, no engine run, plus helpers that
// measure what a commit binds.
import type {
  ChangeSet,
  Credential,
  CursorUpdate,
  EventRef,
  GroupVersion,
  NativeScript,
  Pos,
  StoredInstance,
} from 'drep-groups';
import type { EngineSnapshot } from 'drep-groups';
import { credKey, parseNativeScript } from 'drep-groups';
import {
  credFromKey,
  credKeyFromCol,
  decodeContext,
  decodeEvent,
  hashBytes,
  hashFromCol,
  instanceFromRow,
  MAX,
  posFromRow,
  versionFromRow,
} from '../codec.js';
import type { PreRead } from '../store/commit.js';
import { txHex } from './loadFixtures.js';

export type Unit = { change: ChangeSet; cursor: CursorUpdate };

export const hex = (n: number, len = 56): string => n.toString(16).padStart(len, '0');
export const txHashOf = (h: number, ti = 0): string => hex(h * 100 + ti, 64);
export const pos = (h: number, ti = 0, ph: 0 | 1 | 2 = 2, ix = 0): Pos => ({
  blockHeight: h,
  txIndex: ti,
  phase: ph,
  index: ix,
  txHash: txHashOf(h, ti),
});
export const ref = (h: number, ix = 0, ti = 0): EventRef => ({ txHash: txHashOf(h, ti), index: ix });
export const keyCred = (n: number): Credential => ({ kind: 'key', hash: hex(n) });

export const emptyChange = (): ChangeSet => ({
  scripts: [],
  memberScripts: [],
  versions: [],
  instances: [],
  verdicts: [],
  queued: [],
  txContexts: [],
  appliedQueue: [],
  effects: [],
});

/** A unit that moves the group cursor to the end of the tx at height h. */
export const groupUnit = (h: number, change: Partial<ChangeSet>): Unit => ({
  change: { ...emptyChange(), ...change },
  cursor: { kind: 'group', G: { ...pos(h), index: MAX } },
});

/** A unit that moves the applied cursor of one credential. */
export const credUnit = (c: Credential, through: Pos, change: Partial<ChangeSet>): Unit => ({
  change: { ...emptyChange(), ...change },
  cursor: { kind: 'credential', credential: c, appliedThrough: through },
});

export const emptyPreRead = (): PreRead => ({
  instances: new Map(),
  dissolves: new Map(),
  firstUnreg: new Map(),
  verdictsKnown: new Set(),
  groups: new Map(),
});

/** A version of a group created at `created`, written at `at`. */
export function version(group: EventRef, created: Pos, at: Pos, over: Partial<GroupVersion> = {}): GroupVersion {
  return {
    id: group,
    at,
    mode: 'open',
    control: hex(1),
    admission: null,
    profile: null,
    seq: 0n,
    status: 'active',
    createdAt: created,
    profileSetAt: null,
    ...over,
  };
}

export function instance(join: EventRef, group: EventRef, member: Credential, joinedAt: Pos, over: Partial<StoredInstance> = {}): StoredInstance {
  return {
    joinId: join,
    group,
    member,
    mode: 'open',
    joinedAt,
    approvedAt: null,
    closedAt: null,
    closeReason: null,
    ...over,
  };
}

// CBOR of the native script [0, h'..'], a single signature.
export function sigScriptBytes(n: number): Uint8Array {
  const h = hex(n);
  const out = new Uint8Array(4 + 28);
  out.set([0x82, 0x00, 0x58, 0x1c]);
  for (let i = 0; i < 28; i++) out[4 + i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** CBOR of `depth` nested `all` scripts around one signature: [1, [[1, [ ... [0, h] ]]]]. */
export function deepScriptBytes(depth: number): Uint8Array {
  const sig = sigScriptBytes(1);
  const out = new Uint8Array(3 * (depth - 1) + sig.length);
  for (let i = 0; i < depth - 1; i++) out.set([0x82, 0x01, 0x81], i * 3);
  out.set(sig, 3 * (depth - 1));
  return out;
}

export function deepScript(depth: number): { bytes: Uint8Array; script: NativeScript } {
  const bytes = deepScriptBytes(depth);
  const script = parseNativeScript(bytes);
  if (script === null) throw new Error('deep script does not parse');
  return { bytes, script };
}

/** Wraps a database so every bind records its parameter count. */
export function bindCountingDb(db: D1Database): { db: D1Database; maxBinds: () => number } {
  let max = 0;
  const wrapStmt = (st: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(st, {
      get(target, p) {
        if (p === 'bind') {
          return (...args: unknown[]) => {
            max = Math.max(max, args.length);
            return target.bind(...args);
          };
        }
        const v = Reflect.get(target, p);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  const counted = new Proxy(db, {
    get(target, p) {
      if (p === 'prepare') return (sql: string) => wrapStmt(target.prepare(sql));
      const v = Reflect.get(target, p);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { db: counted, maxBinds: () => max };
}

/**
 * Group units of `txs` label txs. Each tx publishes 8 scripts and carries 64 events: 32 updates
 * of 32 distinct groups, each with a new anchor and a verdict, and 32 joins queued for 32
 * distinct subjects.
 */
export function worstCaseGroupUnits(txs: number): Unit[] {
  const units: Unit[] = [];
  for (let t = 0; t < txs; t++) {
    const h = 1000 + t;
    const change = emptyChange();
    for (let s = 0; s < 8; s++) {
      const bytes = sigScriptBytes(t * 100 + s + 1);
      change.scripts.push({ hash: hex(t * 100 + s + 1), script: parseNativeScript(bytes) as NativeScript, bytes, at: pos(h, 0, 1, -1) });
    }
    for (let e = 0; e < 32; e++) {
      const group = ref(10 + t * 32 + e);
      const at = pos(h, 0, 2, e);
      change.versions.push(
        version(group, pos(10 + t * 32 + e), at, {
          seq: BigInt(e + 1),
          profile: { url: `https://example.org/${t}/${e}.json`, dataHash: hex(e, 64) },
          profileSetAt: at,
        }),
      );
      change.verdicts.push({
        ref: { txHash: at.txHash, index: e },
        tag: 'update',
        valid: true,
        reason: null,
        at,
        group,
        subject: null,
      });
    }
    for (let e = 32; e < 64; e++) {
      const at = pos(h, 0, 2, e);
      const group = ref(10 + t * 32 + (e - 32));
      const subject = keyCred(t * 100 + e);
      change.queued.push({
        subject,
        at,
        group,
        txHash: at.txHash,
        event: { ok: true, event: { tag: 'join', group, member: subject } },
      });
    }
    change.txContexts.push({
      txHash: txHashOf(h),
      context: { signers: [hex(1)], requiredSigners: [hex(1)], invalidBefore: null, invalidHereafter: 100n },
    });
    units.push({ change, cursor: { kind: 'group', G: { ...pos(h), index: Number.MAX_SAFE_INTEGER } } });
  }
  return units;
}

/** Credential units, each with `inputs / units` inputs, every input a join into a group of its own. */
export function worstCaseCredentialUnits(units: number, inputs: number): Unit[] {
  const per = Math.floor(inputs / units);
  const out: Unit[] = [];
  for (let u = 0; u < units; u++) {
    const c = keyCred(5000 + u);
    const change = emptyChange();
    let last = pos(2000);
    for (let i = 0; i < per; i++) {
      const h = 2000 + u * per + i;
      const at = pos(h, 0, 2, 0);
      const group = ref(100 + u * per + i);
      const join = { txHash: at.txHash, index: 0 };
      const inst = instance(join, group, c, at);
      change.instances.push(inst);
      change.effects.push({ kind: 'instanceCreated', instance: inst });
      change.appliedQueue.push(join);
      change.verdicts.push({ ref: join, tag: 'join', valid: true, reason: null, at, group, subject: c });
      last = at;
    }
    out.push({ change, cursor: { kind: 'credential', credential: c, appliedThrough: last } });
  }
  return out;
}

type Row = Record<string, unknown>;

/** The stored engine state in the shape both stores can be compared in, every list canonically ordered. */
export interface ComparableSnapshot {
  frontiers: { L: number; R: number | null; G: Pos };
  versions: string[];
  scripts: string[];
  memberScripts: string[];
  instances: string[];
  verdicts: string[];
  queue: string[];
  txContexts: string[];
  labelTxs: string[];
  ledger: string[];
  appliedThrough: string[];
}

// JSON with sorted object keys, so field order never matters.
const sorted = (_k: string, v: unknown): unknown => {
  if (typeof v === 'bigint') return `${v}n`;
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
};
const canon = (xs: unknown[]): string[] => xs.map((x) => JSON.stringify(x, sorted)).sort();

/** The reference store's snapshot in comparable form. Verdicts without a group are not stored by D1. */
export function comparableMemory(s: EngineSnapshot): ComparableSnapshot {
  return {
    frontiers: s.frontiers,
    versions: canon(s.versions),
    scripts: canon(s.scripts.map((x) => ({ hash: x.hash, at: x.at }))),
    memberScripts: canon(s.memberScripts.map((x) => ({ credential: credKey(x.credential), at: x.at }))),
    instances: canon(s.instances),
    verdicts: canon(s.verdicts.filter((v) => v.group !== null)),
    queue: canon(s.queue),
    txContexts: canon(s.txContexts),
    labelTxs: canon(s.labelTxs),
    ledger: canon(
      s.ledger.map((l) => ({ kind: l.kind, credential: credKey(l.credential), txHash: l.txHash, blockHeight: l.blockHeight, txIndex: l.txIndex, certIndex: l.certIndex })),
    ),
    appliedThrough: canon(s.appliedThrough.map((a) => ({ credential: credKey(a.credential), at: a.at }))),
  };
}

/** The D1 store's state in comparable form, with the stored L (not the L held below flagged markers). */
export async function comparableD1(db: D1Database): Promise<ComparableSnapshot> {
  const all = async (sql: string): Promise<Row[]> => (await db.prepare(sql).all<Row>()).results ?? [];
  const meta = (await all('SELECT * FROM drep_group_meta WHERE id = 1'))[0] as Row;
  const ref = (tx: unknown, ix: unknown): EventRef => ({ txHash: hashFromCol(tx), index: Number(ix) });
  return {
    frontiers: { L: Number(meta.L), R: meta.R === null ? null : Number(meta.R), G: posFromRow(meta, 'G') },
    versions: canon((await all('SELECT * FROM drep_group_versions')).map(versionFromRow)),
    scripts: canon((await all('SELECT * FROM drep_group_scripts')).map((r) => ({ hash: hashFromCol(r.hash), at: posFromRow(r, 'at') }))),
    memberScripts: canon(
      (await all('SELECT * FROM drep_group_member_scripts')).map((r) => ({ credential: credKeyFromCol(r.cred), at: posFromRow(r, 'at') })),
    ),
    instances: canon((await all('SELECT * FROM drep_group_instances')).map(instanceFromRow)),
    verdicts: canon(
      (await all('SELECT * FROM drep_group_verdicts')).map((r) => ({
        ref: ref(r.tx_hash, r.idx),
        tag: String(r.tag),
        valid: Number(r.valid) === 1,
        reason: r.reason === null ? null : String(r.reason),
        at: posFromRow(r, 'at'),
        group: ref(r.group_tx, r.group_ix),
        subject: r.subject === null ? null : credFromKey(credKeyFromCol(r.subject)),
      })),
    ),
    queue: canon(
      (await all('SELECT * FROM drep_group_queue')).map((r) => ({
        subject: credFromKey(credKeyFromCol(r.subject)),
        at: posFromRow(r, 'at'),
        group: r.group_tx === null ? null : ref(r.group_tx, r.group_ix),
        txHash: hashFromCol(r.tx_hash),
        event: decodeEvent(String(r.event_json)),
        applied: Number(r.applied) === 1,
      })),
    ),
    txContexts: canon(
      (await all('SELECT * FROM drep_group_tx_context')).map((r) => ({
        txHash: hashFromCol(r.tx_hash),
        blockHeight: Number(r.block_height),
        txIndex: Number(r.tx_index),
        context: decodeContext(r),
      })),
    ),
    labelTxs: canon(
      (await all('SELECT * FROM drep_group_txs')).map((r) => ({
        txHash: hashFromCol(r.tx_hash),
        blockHeight: Number(r.block_height),
        txIndex: Number(r.tx_index),
        marker: Number(r.marker) === 1,
      })),
    ),
    ledger: canon(
      (await all('SELECT * FROM drep_group_ledger')).map((r) => ({
        kind: String(r.kind),
        credential: credKeyFromCol(r.cred),
        txHash: hashFromCol(r.tx_hash),
        blockHeight: Number(r.block_height),
        txIndex: Number(r.tx_index),
        certIndex: Number(r.cert_index),
      })),
    ),
    appliedThrough: canon(
      (await all('SELECT * FROM drep_group_tracked WHERE applied_h IS NOT NULL')).map((r) => ({
        credential: credKeyFromCol(r.cred),
        at: posFromRow(r, 'applied'),
      })),
    ),
  };
}

/** Wraps a database so the rows_written of every statement of one call are summed, trigger rows included. */
export async function changesPerCall<T>(db: D1Database, call: (db: D1Database) => Promise<T>): Promise<{ result: T; changes: number }> {
  let changes = 0;
  const add = (r: D1Result): void => {
    const w = (r.meta as { rows_written?: number }).rows_written;
    if (w === undefined) throw new Error('rows_written not reported');
    changes += w;
  };
  const wrapStmt = (st: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(st, {
      get(target, p) {
        if (p === 'bind') return (...args: unknown[]) => wrapStmt(target.bind(...args));
        if (p === 'run' || p === 'all') {
          return async () => {
            const r = await (target[p] as () => Promise<D1Result>).call(target);
            add(r);
            return r;
          };
        }
        const v = Reflect.get(target, p);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  const counted = new Proxy(db, {
    get(target, p) {
      if (p === 'prepare') return (sql: string) => wrapStmt(target.prepare(sql));
      if (p === 'batch') {
        return async (stmts: D1PreparedStatement[]) => {
          const res = await target.batch(stmts);
          for (const r of res) add(r);
          return res;
        };
      }
      const v = Reflect.get(target, p);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const result = await call(counted);
  return { result, changes };
}

export interface GroupSeed {
  members?: number;
  /** A SQL integer literal, exact above 2^53. */
  power?: string;
  status?: 'active' | 'dissolved';
  closing?: number;
  dissolvedAt?: number | null;
  mode?: 'open' | 'permissioned';
  url?: string | null;
  /** The anchor hash as lowercase hex. */
  hash?: string | null;
  due?: 'profile' | 'website' | null;
  dueAt?: number;
}

/** A group row keyed by txHex(n), created at height 1, and optionally a due row. */
export async function seedGroup(db: D1Database, n: number, o: GroupSeed = {}): Promise<void> {
  const at = (h: number): string => `${h}, 0, 2, 0, X'${txHex(h)}'`;
  const d = o.dissolvedAt ?? null;
  const url = o.url === undefined ? 'https://x.test/g.json' : o.url;
  const hash = o.hash === undefined ? '0a' : o.hash;
  const tx = hashBytes(txHex(n));
  await db
    .prepare(
      `INSERT INTO drep_groups (group_tx, group_ix, cur_h, cur_ti, cur_ph, cur_ix, cur_tx, mode, control, profile_url, profile_hash,
        seq, status, created_h, created_ti, created_ph, created_ix, created_tx,
        dissolved_h, dissolved_ti, dissolved_ph, dissolved_ix, dissolved_tx, members, member_power, closing)
       VALUES (?1, 0, ${at(1)}, ?2, X'aa', ?3, ?4, '7', ?5, ${at(1)},
        ${d === null ? 'NULL, NULL, NULL, NULL, NULL' : at(d)}, ?6, CAST(?7 AS INTEGER), ?8)`,
    )
    .bind(tx, o.mode ?? 'open', url, hash === null ? null : hashBytes(hash), o.status ?? 'active', o.members ?? 2, o.power ?? '0', o.closing ?? 0)
    .run();
  if (o.due) {
    await db.prepare('INSERT INTO drep_group_due (kind, group_tx, group_ix, due_at) VALUES (?, ?, 0, ?)').bind(o.due, tx, o.dueAt ?? 0).run();
  }
}
