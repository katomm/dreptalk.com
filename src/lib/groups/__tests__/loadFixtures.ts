/// <reference types="@cloudflare/workers-types" />
// Chain inputs, bulk stored histories and a metered database for the load measurement of the
// D1 store. Test only.
import type { Budget, ChainTx, Credential, LedgerInput } from 'drep-groups';
import { bytesToHex, credKey, hexToBytes, nativeScriptHash, runEngine } from 'drep-groups';
import { countingDb } from '../../sync/queryBudget.js';
import { credBytes, hashBytes } from '../codec.js';
import { D1Store } from '../store/d1Store.js';
import { storeLabelTxs, storeLedgerRows } from '../store/ingest.js';
import { writeBatch } from '../store/lease.js';
import { INGEST } from '../store/queries.js';

const MAX = Number.MAX_SAFE_INTEGER;

// A minimal definite length CBOR encoder: unsigned integers, bytes, text, arrays, maps with uint keys,
// tags, booleans and null.
export type Cbor = number | boolean | null | Uint8Array | string | Cbor[] | Map<number, Cbor> | { tag: number; value: Cbor };
function head(out: number[], major: number, n: number): void {
  const m = major << 5;
  if (n < 24) out.push(m | n);
  else if (n < 0x100) out.push(m | 24, n);
  else if (n < 0x1_0000) out.push(m | 25, n >> 8, n & 0xff);
  else out.push(m | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}
function put(out: number[], v: Cbor): void {
  if (v === null) out.push(0xf6);
  else if (typeof v === 'boolean') out.push(v ? 0xf5 : 0xf4);
  else if (typeof v === 'number') head(out, 0, v);
  else if (v instanceof Uint8Array) {
    head(out, 2, v.length);
    out.push(...v);
  } else if (typeof v === 'string') {
    const b = new TextEncoder().encode(v);
    head(out, 3, b.length);
    out.push(...b);
  } else if (Array.isArray(v)) {
    head(out, 4, v.length);
    for (const x of v) put(out, x);
  } else if (!(v instanceof Map)) {
    head(out, 6, v.tag);
    put(out, v.value);
  } else {
    head(out, 5, v.size);
    for (const [k, x] of v) {
      put(out, k);
      put(out, x);
    }
  }
}
export function cbor(v: Cbor): Uint8Array {
  const out: number[] = [];
  put(out, v);
  return Uint8Array.from(out);
}

export const txHex = (n: number): string => n.toString(16).padStart(64, '0');
export const keyHex = (n: number): string => n.toString(16).padStart(56, '0');
export const keyOf = (hash: string): Credential => ({ kind: 'key', hash });

/** The native script of a single key signature as a CBOR value. */
export const sig = (key: string): Cbor => [0, hexToBytes(key)];

/** The native script of a single key signature and its hash. */
export function sigScript(key: string): { bytes: Uint8Array; hash: string } {
  const bytes = cbor(sig(key));
  return { bytes, hash: nativeScriptHash(bytes) };
}

type Ref = { txHash: string; index: number };
const refCbor = (r: Ref): Cbor => [hexToBytes(r.txHash), r.index];
export const ev = {
  create: (control: string): Cbor => [0, 0, hexToBytes(control), []],
  update: (group: Ref, seq: number, changes = new Map<number, Cbor>()): Cbor => [1, refCbor(group), seq, changes],
  join: (group: Ref | number, member: string, kind: 'key' | 'script' = 'key'): Cbor => [
    3,
    typeof group === 'number' ? [group] : refCbor(group),
    [kind === 'key' ? 0 : 1, hexToBytes(member)],
  ],
  approve: (join: Ref): Cbor => [4, refCbor(join)],
  leave: (join: Ref): Cbor => [5, refCbor(join)],
  resign: (group: Ref, key: string): Cbor => [7, refCbor(group), hexToBytes(key)],
};

const chunks = (b: Uint8Array): Uint8Array[] => {
  const out: Uint8Array[] = [];
  for (let i = 0; i < b.length; i += 64) out.push(b.subarray(i, i + 64));
  return out;
};

/** The payload as a CBOR value, scripts published under key 2 in chunks of at most 64 bytes. */
export function payloadValue(events: Cbor[], scripts: Uint8Array[] = []): Cbor {
  const m = new Map<number, Cbor>([
    [0, 1],
    [1, events],
  ]);
  if (scripts.length > 0) m.set(2, scripts.map(chunks));
  return m;
}

/** Payload bytes. */
export function payload(events: Cbor[], scripts: Uint8Array[] = []): Uint8Array {
  return cbor(payloadValue(events, scripts));
}

export function labelTx(n: number, h: number, o: { payload: Uint8Array; rs?: string[]; wk?: string[] }): ChainTx {
  return {
    txHash: txHex(n),
    blockHeight: h,
    txIndex: 0,
    isValid: true,
    invalidBefore: null,
    invalidHereafter: null,
    requiredSigners: o.rs ?? [],
    witnessKeyHashes: o.wk ?? [],
    payload: o.payload,
    payloadRepeated: false,
    witnessScripts: [],
  };
}

export function ledgerRow(n: number, h: number, c: Credential, kind: 'reg' | 'unreg'): LedgerInput {
  return { kind, credential: c, txHash: txHex(n), blockHeight: h, txIndex: 0, certIndex: 0 };
}

export type Input = { tx: ChainTx } | { ledger: LedgerInput };

/**
 * Stores inputs through the production ingest, marks every credential they name complete (a known
 * DRep with its history done) and moves L and R to `top`. The two production ingest calls run on
 * `ingestDb`, so a caller can meter them alone.
 */
export async function deliver(db: D1Database, lease: string, inputs: Input[], top: number, ingestDb: D1Database = db): Promise<void> {
  const ledger = inputs.flatMap((x) => ('ledger' in x ? [x.ledger] : []));
  const txs = inputs.flatMap((x) => ('tx' in x ? [x.tx] : []));
  const creds = new Map<string, Credential>(ledger.map((l) => [credKey(l.credential), l.credential]));
  if (creds.size > 0) {
    await writeBatch(
      db,
      lease,
      [...creds.keys()].map((k) => db.prepare(INGEST.trackCreds(1)).bind(credBytes(k), 1)),
    );
    await storeLedgerRows(
      ingestDb,
      lease,
      ledger.map((input) => ({
        input,
        blockHash: input.txHash,
        blockTime: input.blockHeight * 20,
        witnessState: 'na' as const,
        witness: null,
      })),
      null,
    );
  }
  if (txs.length > 0) {
    await storeLabelTxs(ingestDb, lease, txs.map((tx) => ({ tx, blockHash: tx.txHash })), null, async (h) => h * 20);
  }
  const members = txs.flatMap((t) => t.requiredSigners.map((k) => credKey(keyOf(k))));
  await writeBatch(db, lease, [
    db
      .prepare(
        `UPDATE drep_group_tracked SET known = 1, history_done = 1
         WHERE cred IN (SELECT unhex(value) FROM json_each(?)) AND (known IS NULL OR known = 1)`,
      )
      .bind(JSON.stringify([...creds.keys(), ...members].map((k) => bytesToHex(credBytes(k))))),
    db.prepare('UPDATE drep_group_meta SET L = ?, R = ? WHERE id = 1').bind(top, top),
  ]);
}

/** Runs the engine until it reports no more work and returns every run's report. */
export async function settle(db: D1Database, lease: string, budget: Budget): Promise<number> {
  const store = new D1Store(db);
  for (let runs = 1; runs <= 500; runs++) {
    const r = await runEngine(store, budget, lease);
    if (!r.more) return runs;
  }
  throw new Error('runEngine did not settle');
}

/**
 * The production query meter, plus the D1 rows_read of every statement result. `first` is read
 * through `all`, which counts as the same single query and carries the result meta.
 */
export function meteredDb(real: D1Database): { db: D1Database; queries: () => number; rowsRead: () => number } {
  const { db: counted, meter } = countingDb(real);
  let rows = 0;
  const add = (r: D1Result): void => {
    const n = (r.meta as { rows_read?: number }).rows_read;
    if (typeof n !== 'number') throw new Error('rows_read not reported');
    rows += n;
  };
  const patch = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const s = stmt as unknown as Record<string, unknown>;
    const all = s.all as () => Promise<D1Result<Record<string, unknown>>>;
    const run = s.run as () => Promise<D1Result>;
    const bind = s.bind as (...a: unknown[]) => D1PreparedStatement;
    s.all = async () => {
      const r = await all.call(stmt);
      add(r);
      return r;
    };
    s.run = async () => {
      const r = await run.call(stmt);
      add(r);
      return r;
    };
    s.first = async (col?: string) => {
      const r = await all.call(stmt);
      add(r);
      const row = r.results?.[0] ?? null;
      return col === undefined || row === null ? row : (row[col] ?? null);
    };
    s.raw = () => {
      throw new Error('raw is not metered');
    };
    s.bind = (...a: unknown[]) => patch(bind.apply(stmt, a));
    return stmt;
  };
  const db = {
    prepare: (sql: string) => patch(counted.prepare(sql)),
    batch: async <T = unknown>(stmts: D1PreparedStatement[]) => {
      const res = await counted.batch<T>(stmts);
      for (const r of res) add(r);
      return res;
    },
    exec: () => {
      throw new Error('exec is not metered');
    },
  } as unknown as D1Database;
  return { db, queries: () => meter.used(), rowsRead: () => rows };
}

// Bulk histories. Every statement generates its rows from a series 0..n-1 in SQL, so 10,000
// rows take one statement per table. Hashes are the bytes of printf('%064x', ...) of a counter,
// keys of printf('%056x', ...), exactly txHex and keyHex. A history row sits at its own height.
export const series = (n: number): string =>
  `WITH RECURSIVE s(i) AS (SELECT 0 WHERE ${n} > 0 UNION ALL SELECT i + 1 FROM s WHERE i + 1 < ${n})`;
export const hashSql = (base: number, expr = 's.i'): string => `unhex(printf('%064x', ${base} + ${expr}))`;
const keySql = (base: number, expr = 's.i'): string => `unhex(printf('%056x', ${base} + ${expr}))`;
export const credSql = (base: number, expr = 's.i'): string => `unhex('00' || printf('%056x', ${base} + ${expr}))`;
/** SQL literal of a stored key credential. */
const credLit = (c: Credential): string => `X'${bytesToHex(credBytes(credKey(c)))}'`;
const POS0 = (h: string, tx: string): string => `${h}, 0, 2, 0, ${tx}`;

/** Label tx rows and their contexts at heights `h`, already applied by the group plane. */
function txRows(db: D1Database, n: number, base: number, h: string, signers: string, expr = 's.i'): D1PreparedStatement[] {
  const tx = hashSql(base, expr);
  return [
    db.prepare(`${series(n)}
      INSERT INTO drep_group_txs (tx_hash, block_height, block_hash, tx_index, marker, payload, required_signers,
        witness_key_hashes, invalid_before, invalid_hereafter, is_valid, payload_repeated, bytes)
      SELECT ${tx}, ${h}, ${tx}, 0, 0, X'a10001', ${signers}, X'', NULL, NULL, 1, 0, 3 FROM s`),
    db.prepare(`${series(n)}
      INSERT INTO drep_group_tx_context (tx_hash, block_height, tx_index, signers, required_signers, invalid_before, invalid_hereafter)
      SELECT ${tx}, ${h}, 0, ${signers}, ${signers}, NULL, NULL FROM s`),
  ];
}

/** Applied join entries of the credentials `credSql(credBase)`, with their verdicts. */
function joinRows(
  db: D1Database,
  n: number,
  o: { txBase: number; txExpr?: string; credBase: number; h: string; group: Ref; valid: boolean; applied: boolean },
): D1PreparedStatement[] {
  const tx = hashSql(o.txBase, o.txExpr);
  const signers = o.valid ? keySql(o.credBase) : `X''`;
  return [
    ...txRows(db, n, o.txBase, o.h, signers, o.txExpr),
    db.prepare(`${series(n)}
      INSERT INTO drep_group_queue (tx_hash, idx, subject, at_h, at_ti, at_ph, at_ix, at_tx, group_tx, group_ix, event_json, applied)
      SELECT ${tx}, 0, ${credSql(o.credBase)}, ${POS0(o.h, tx)}, ?, ?,
        json_object('ok', json('true'), 'event', json_object('tag', 'join', 'group', json_object('txHash', ?, 'index', ?),
          'member', json_object('kind', 'key', 'hash', printf('%056x', ${o.credBase} + s.i)))), ${o.applied ? 1 : 0}
      FROM s`).bind(hashBytes(o.group.txHash), o.group.index, o.group.txHash, o.group.index),
    ...(o.applied
      ? [
          db.prepare(`${series(n)}
            INSERT INTO drep_group_verdicts (tx_hash, idx, group_tx, group_ix, at_h, at_ti, at_ph, at_ix, at_tx, tag, valid, reason, subject)
            SELECT ${tx}, 0, ?, ?, ${POS0(o.h, tx)}, 'join', ${o.valid ? 1 : 0},
              ${o.valid ? 'NULL' : "'member key not in required_signers'"}, ${credSql(o.credBase)} FROM s`).bind(
            hashBytes(o.group.txHash),
            o.group.index,
          ),
        ]
      : []),
  ];
}

/** Tracked rows of `credSql(credBase)`, applied through `applied` (a position SQL list or NULLs). */
function trackedRows(db: D1Database, n: number, credBase: number, o: { known: number; done: number; applied: string; next: string }): D1PreparedStatement {
  return db.prepare(`${series(n)}
    INSERT INTO drep_group_tracked (cred, seq, known, history_done, applied_h, applied_ti, applied_ph, applied_ix,
      applied_tx, next_h, next_ti, next_ph, next_ix, next_tx)
    SELECT ${credSql(credBase)}, (SELECT COALESCE(MAX(seq), 0) FROM drep_group_tracked) + 1 + s.i,
      ${o.known}, ${o.done}, ${o.applied}, ${o.next} FROM s`);
}

/** Ledger rows of `cred` (an SQL expression), kind by `kind` (an SQL expression), at heights `h`. */
function ledgerRows(
  db: D1Database,
  n: number,
  o: { txBase: number; txExpr?: string; cred: string; kind: string; h: string },
): D1PreparedStatement {
  const tx = hashSql(o.txBase, o.txExpr);
  return db.prepare(`${series(n)}
    INSERT INTO drep_group_ledger (tx_hash, cert_index, cred, kind, block_height, block_hash, tx_index, block_time,
      witness, witness_state)
    SELECT ${tx}, 0, ${o.cred}, ${o.kind}, ${o.h}, ${tx}, 0, (${o.h}) * 20, NULL, 'na'
    FROM s`);
}

export interface Shape {
  name: string;
  /** Statements that store a history of `n` rows per table at heights from `from`, and its top height. */
  history: (db: D1Database, n: number, from: number, base: Base) => { stmts: D1PreparedStatement[]; top: number };
  /** The 20 new inputs above the history, the verdicts they cause. */
  fresh: (top: number, base: Base, n: number) => { inputs: Input[]; verdicts: number };
}

/** The stored base every shape builds on: one open group with a control key and three members. */
export interface Base {
  group: Ref;
  control: string;
  /** A member that joined at height 50, unregistered at 60 and registered again at 70. */
  old: { cred: Credential; join: Ref };
}

/** The first height of a stored history, above the base. */
export const HISTORY_FROM = 100;
const CONTROL = keyHex(1);
const GROUP_TX = 10;

/** The base chain: the group at 10, members C, D and E, C retired after its join and registered again. */
export function baseInputs(): { inputs: Input[]; top: number; base: Base } {
  const control = sigScript(CONTROL);
  const group: Ref = { txHash: txHex(GROUP_TX), index: 0 };
  const [c, d, e] = [keyHex(7), keyHex(8), keyHex(9)];
  const join = (n: number, h: number, m: string) => ({ tx: labelTx(n, h, { payload: payload([ev.join(group, m)]), rs: [m] }) });
  const inputs: Input[] = [
    { tx: labelTx(GROUP_TX, 10, { payload: payload([ev.create(control.hash)], [control.bytes]), rs: [CONTROL], wk: [CONTROL] }) },
    { ledger: ledgerRow(40, 40, keyOf(c), 'reg') },
    { ledger: ledgerRow(41, 41, keyOf(d), 'reg') },
    { ledger: ledgerRow(42, 42, keyOf(e), 'reg') },
    join(50, 50, c),
    join(51, 51, d),
    join(52, 52, e),
    { ledger: ledgerRow(60, 60, keyOf(c), 'unreg') },
    { ledger: ledgerRow(70, 70, keyOf(c), 'reg') },
  ];
  return { inputs, top: 70, base: { group, control: CONTROL, old: { cred: keyOf(c), join: { txHash: txHex(50), index: 0 } } } };
}

/** Moves G to the end of the history, all of it applied. */
export const historyApplied = (db: D1Database, top: number): D1PreparedStatement =>
  db
    .prepare(`UPDATE drep_group_meta SET L = ?, R = ?, G_h = ?, G_ti = ${MAX}, G_ph = 2, G_ix = ${MAX}, G_tx = X'' WHERE id = 1`)
    .bind(top, top, top);

// 10 new members, each registered and then joining the group: 20 inputs, 10 verdicts.
function freshJoins(top: number, base: Base, pairs = 10): Input[] {
  const out: Input[] = [];
  for (let i = 0; i < pairs; i++) {
    const m = keyHex(90_000_000 + i);
    const h = top + 1 + 2 * i;
    out.push({ ledger: ledgerRow(h, h, keyOf(m), 'reg') });
    out.push({ tx: labelTx(h + 1, h + 1, { payload: payload([ev.join(base.group, m)]), rs: [m] }) });
  }
  return out;
}

const groupBinds = (b: Base): [Uint8Array, number] => [hashBytes(b.group.txHash), b.group.index];

export const SHAPES: Shape[] = [
  {
    name: 'long version chain of one group',
    history: (db, n, from, b) => {
      const tx = hashSql(1_000_000);
      const h = `${from} + s.i`;
      const stmts = [
        db.prepare(`${series(n)}
          INSERT INTO drep_group_versions (group_tx, group_ix, at_h, at_ti, at_ph, at_ix, at_tx, mode, control, admission,
            profile_url, profile_hash, seq, status, created_h, created_ti, created_ph, created_ix, created_tx,
            profile_set_h, profile_set_ti, profile_set_ph, profile_set_ix, profile_set_tx)
          SELECT v.group_tx, v.group_ix, ${POS0(h, tx)}, v.mode, v.control, v.admission, v.profile_url, v.profile_hash,
            CAST(s.i + 1 AS TEXT), v.status, v.created_h, v.created_ti, v.created_ph, v.created_ix, v.created_tx,
            v.profile_set_h, v.profile_set_ti, v.profile_set_ph, v.profile_set_ix, v.profile_set_tx
          FROM s, drep_group_versions v WHERE v.group_tx = ? AND v.group_ix = ? AND v.seq = '0'`).bind(...groupBinds(b)),
        db.prepare(`${series(n)}
          INSERT INTO drep_group_verdicts (tx_hash, idx, group_tx, group_ix, at_h, at_ti, at_ph, at_ix, at_tx, tag, valid, reason, subject)
          SELECT ${tx}, 0, ?, ?, ${POS0(h, tx)}, 'update', 1, NULL, NULL FROM s`).bind(...groupBinds(b)),
        ...txRows(db, n, 1_000_000, h, `X'${b.control}'`),
      ];
      if (n > 0) {
        const last = from + n - 1;
        stmts.push(
          db
            .prepare(`UPDATE drep_groups SET cur_h = ?, cur_ti = 0, cur_ph = 2, cur_ix = 0, cur_tx = ?, seq = ?,
              applied_events = applied_events + ? WHERE group_tx = ? AND group_ix = ?`)
            .bind(last, hashBytes(txHex(1_000_000 + n - 1)), String(n), n, ...groupBinds(b)),
        );
      }
      return { stmts, top: from + n - 1 };
    },
    fresh: (top, b, n) => {
      const inputs: Input[] = Array.from({ length: 20 }, (_, i) => ({
        tx: labelTx(top + 1 + i, top + 1 + i, { payload: payload([ev.update(b.group, n + i)]), rs: [b.control], wk: [b.control] }),
      }));
      return { inputs, verdicts: 20 };
    },
  },
  {
    name: 'group with many members',
    history: (db, n, from, b) => {
      const reg = `${from} + 2 * s.i`;
      const join = `${from} + 2 * s.i + 1`;
      const joinTx = hashSql(2_000_000, '2 * s.i + 1');
      return {
        stmts: [
          trackedRows(db, n, 3_000_000, { known: 1, done: 1, applied: POS0(join, joinTx), next: 'NULL, NULL, NULL, NULL, NULL' }),
          ledgerRows(db, n, { txBase: 2_000_000, txExpr: '2 * s.i', cred: credSql(3_000_000), kind: "'reg'", h: reg }),
          ...joinRows(db, n, {
            txBase: 2_000_000,
            txExpr: '2 * s.i + 1',
            credBase: 3_000_000,
            h: join,
            group: b.group,
            valid: true,
            applied: true,
          }),
          db.prepare(`${series(n)}
            INSERT INTO drep_group_instances (join_tx, join_ix, group_tx, group_ix, cred, drep_id, mode, joined_h, joined_ti,
              joined_ph, joined_ix, joined_tx, counted_as)
            SELECT ${joinTx}, 0, ?, ?, ${credSql(3_000_000)}, 'drep1load' || printf('%056x', 3000000 + s.i), 'open',
              ${POS0(join, joinTx)}, 'open' FROM s`).bind(...groupBinds(b)),
          db
            .prepare('UPDATE drep_groups SET members = members + ?, applied_events = applied_events + ? WHERE group_tx = ? AND group_ix = ?')
            .bind(n, n, ...groupBinds(b)),
        ],
        top: from + 2 * n - 1,
      };
    },
    fresh: (top, b) => ({ inputs: freshJoins(top, b), verdicts: 10 }),
  },
  {
    name: 'credential with many registrations and a long queue',
    history: (db, n, from, b) => {
      // One credential alternating reg and unreg, ending with an unreg, and n joins of credentials
      // whose history never completes, queued below G for good.
      const c = credLit(keyOf(keyHex(4_000_000)));
      const h = `${from} + s.i`;
      const last = from + n - 1;
      const queued = `${from} + ${n} + s.i`;
      const lastTx = txHex(5_000_000 + n - 1);
      return {
        stmts: [
          db
            .prepare(`INSERT INTO drep_group_tracked (cred, seq, known, history_done, applied_h, applied_ti, applied_ph,
              applied_ix, applied_tx) VALUES (${c}, (SELECT COALESCE(MAX(seq), 0) + 1 FROM drep_group_tracked), 1, 1,
              ?, ?, ?, ?, ?)`)
            .bind(...(n > 0 ? [last, 0, 0, 0, hashBytes(lastTx)] : [null, null, null, null, null])),
          ledgerRows(db, n, { txBase: 5_000_000, cred: c, kind: "CASE WHEN s.i % 2 = 0 THEN 'reg' ELSE 'unreg' END", h }),
          trackedRows(db, n, 6_000_000, { known: 1, done: 0, applied: 'NULL, NULL, NULL, NULL, NULL', next: POS0(queued, hashSql(7_000_000)) }),
          ...joinRows(db, n, { txBase: 7_000_000, credBase: 6_000_000, h: queued, group: b.group, valid: true, applied: false }),
        ],
        top: from + 2 * n - 1,
      };
    },
    fresh: (top, b, n) => {
      const c = keyOf(keyHex(4_000_000));
      const rows: Input[] = Array.from({ length: 10 }, (_, i) => ({
        ledger: ledgerRow(top + 1 + i, top + 1 + i, c, (n + i) % 2 === 0 ? 'reg' : 'unreg'),
      }));
      return { inputs: [...rows, ...freshJoins(top + 10, b, 5)], verdicts: 5 };
    },
  },
  {
    name: 'flood of unsigned joins naming fake keys',
    history: (db, n, from, b) => {
      const h = `${from} + s.i`;
      return {
        stmts: [
          trackedRows(db, n, 8_000_000, { known: 0, done: 0, applied: POS0(h, hashSql(9_000_000)), next: 'NULL, NULL, NULL, NULL, NULL' }),
          ...joinRows(db, n, { txBase: 9_000_000, credBase: 8_000_000, h, group: b.group, valid: false, applied: true }),
          db
            .prepare('UPDATE drep_groups SET not_applied_events = not_applied_events + ? WHERE group_tx = ? AND group_ix = ?')
            .bind(n, ...groupBinds(b)),
        ],
        top: from + n - 1,
      };
    },
    fresh: (top, b) => ({ inputs: freshJoins(top, b), verdicts: 10 }),
  },
  {
    name: 'many verdicts in one group',
    history: (db, n, from, b) => {
      const tx = hashSql(10_000_000);
      const h = `${from} + s.i`;
      return {
        stmts: [
          db.prepare(`${series(n)}
            INSERT INTO drep_group_verdicts (tx_hash, idx, group_tx, group_ix, at_h, at_ti, at_ph, at_ix, at_tx, tag, valid, reason, subject)
            SELECT ${tx}, 0, ?, ?, ${POS0(h, tx)}, 'update', 0, 'stale seq', NULL FROM s`).bind(...groupBinds(b)),
          ...txRows(db, n, 10_000_000, h, `X'${b.control}'`),
          db
            .prepare('UPDATE drep_groups SET not_applied_events = not_applied_events + ? WHERE group_tx = ? AND group_ix = ?')
            .bind(n, ...groupBinds(b)),
        ],
        top: from + n - 1,
      };
    },
    fresh: (top, b) => ({ inputs: freshJoins(top, b), verdicts: 10 }),
  },
  {
    name: 'change to an old instance whose member has a growing later ledger history',
    history: (db, n, from, b) => {
      // The old member's rows after its join alternate unreg and reg, ending with a reg.
      const c = credLit(b.old.cred);
      const h = `${from} + s.i`;
      const last = from + n - 1;
      return {
        stmts: [
          ledgerRows(db, n, { txBase: 11_000_000, cred: c, kind: "CASE WHEN s.i % 2 = 0 THEN 'unreg' ELSE 'reg' END", h }),
          ...(n > 0
            ? [
                db
                  .prepare(`UPDATE drep_group_tracked SET applied_h = ?, applied_ti = 0, applied_ph = 0, applied_ix = 0, applied_tx = ?
                    WHERE cred = ${c}`)
                  .bind(last, hashBytes(txHex(11_000_000 + n - 1))),
              ]
            : []),
        ],
        top: from + n - 1,
      };
    },
    fresh: (top, b, n) => {
      const leave: Input = {
        tx: labelTx(top + 1, top + 1, { payload: payload([ev.leave(b.old.join)]), rs: [b.old.cred.hash] }),
      };
      const rows: Input[] = Array.from({ length: 19 }, (_, i) => ({
        ledger: ledgerRow(top + 2 + i, top + 2 + i, b.old.cred, (n + i) % 2 === 0 ? 'unreg' : 'reg'),
      }));
      return { inputs: [leave, ...rows], verdicts: 1 };
    },
  },
];

// The worst case of one run: two label txs of 64 events each on the group plane, then 8
// credentials with 4 inputs each (a reg and three joins into groups of their own).
const WORST_GROUPS_TX = [10, 11] as const;
export const WORST_MEMBERS = Array.from({ length: 8 }, (_, j) => keyHex(200 + j));
const worstGroup = (t: number, i: number): Ref => ({ txHash: txHex(WORST_GROUPS_TX[t]), index: i });

/** 128 groups, 8 registered members and their 24 joins, stored and passed by the group plane. */
export function worstCaseBase(): { inputs: Input[]; top: number } {
  const control = sigScript(CONTROL);
  const creates = Array.from({ length: 64 }, () => ev.create(control.hash));
  const joins = WORST_MEMBERS.flatMap((m, j) => [0, 1, 2].map((k) => ev.join(worstGroup(0, 3 * j + k), m)));
  return {
    inputs: [
      ...WORST_GROUPS_TX.map((n) => ({ tx: labelTx(n, n, { payload: payload(creates, [control.bytes]), rs: [CONTROL], wk: [CONTROL] }) })),
      ...WORST_MEMBERS.map((m, j) => ({ ledger: ledgerRow(20 + j, 20 + j, keyOf(m), 'reg') })),
      { tx: labelTx(30, 30, { payload: payload(joins), rs: WORST_MEMBERS }) },
    ],
    top: 30,
  };
}

const orphan = (t: number, i: number): Ref => ({ txHash: txHex(500_000 + 64 * t + i), index: 70_000 + i });

/** The two hostile label txs of a variant at heights 40 and 41. */
export const HOSTILE: Record<string, (t: number) => { events: Cbor[]; scripts: Uint8Array[]; wk: string[] }> = {
  // 64 valid updates of 64 distinct groups per tx.
  updates: (t) => ({ events: Array.from({ length: 64 }, (_, i) => ev.update(worstGroup(t, i), 0)), scripts: [], wk: [CONTROL] }),
  // 64 approves of refs to txs that are not stored, at event indexes above 65,535.
  'orphan approves': (t) => ({ events: Array.from({ length: 64 }, (_, i) => ev.approve(orphan(t, i))), scripts: [], wk: [] }),
  // 64 leaves of the stored joins and of orphans, membership events queued for their subjects.
  leaves: (t) => ({
    events: Array.from({ length: 64 }, (_, i) => ev.leave(i < 24 && t === 0 ? { txHash: txHex(30), index: i } : orphan(t, i))),
    scripts: [],
    wk: [],
  }),
  // 64 creates per tx, each with its own control script of 8 published per tx.
  creates: (t) => {
    const keys = Array.from({ length: 8 }, (_, i) => keyHex(1000 + 8 * t + i));
    const scripts = keys.map(sigScript);
    return { events: Array.from({ length: 64 }, (_, i) => ev.create(scripts[i % 8].hash)), scripts: scripts.map((s) => s.bytes), wk: keys };
  },
  // 64 updates per tx that each set a new profile anchor and hand control to one of 8 new keys
  // published in the same tx, all of which sign.
  'anchored updates': (t) => {
    const keys = Array.from({ length: 8 }, (_, i) => keyHex(2000 + 8 * t + i));
    const scripts = keys.map(sigScript);
    const changes = (i: number) =>
      new Map<number, Cbor>([
        [0, hexToBytes(scripts[i % 8].hash)],
        [2, [[`https://example.org/group/${t}/${i}.json`], hexToBytes(txHex(i))]],
      ]);
    return {
      events: Array.from({ length: 64 }, (_, i) => ev.update(worstGroup(t, i), 0, changes(i))),
      scripts: scripts.map((s) => s.bytes),
      wk: [CONTROL, ...keys],
    };
  },
  // Half updates, half orphan approves.
  mixed: (t) => ({
    events: Array.from({ length: 64 }, (_, i) => (i % 2 === 0 ? ev.update(worstGroup(t, i), 0) : ev.approve(orphan(t, i)))),
    scripts: [],
    wk: [CONTROL],
  }),
};

export function hostileTxs(variant: string): { inputs: Input[]; top: number } {
  const make = HOSTILE[variant];
  return {
    inputs: [0, 1].map((t) => {
      const { events, scripts, wk } = make(t);
      return { tx: labelTx(40 + t, 40 + t, { payload: payload(events, scripts), rs: wk, wk }) };
    }),
    top: 41,
  };
}

/** 1,000 founders, each registered, then a create with its own control key and its founder join. */
export function compactCreates(count: number, from: number): { inputs: Input[]; top: number } {
  const inputs: Input[] = [];
  for (let i = 0; i < count; i++) {
    const f = keyHex(300_000 + i);
    const control = sigScript(f);
    const h = from + 2 * i;
    inputs.push({ ledger: ledgerRow(h, h, keyOf(f), 'reg') });
    inputs.push({ tx: labelTx(h + 1, h + 1, { payload: payload([ev.create(control.hash), ev.join(0, f)], [control.bytes]), rs: [f], wk: [f] }) });
  }
  return { inputs, top: from + 2 * count - 1 };
}

/**
 * The same number of groups at the lowest cost per create: one registered founder with one shared
 * control script published once, 64 creates per tx, then the founder joins every group, 64 joins per tx.
 */
export function batchedCreates(count: number, from: number): { inputs: Input[]; top: number } {
  const f = keyHex(400_000);
  const control = sigScript(f);
  const inputs: Input[] = [{ ledger: ledgerRow(from, from, keyOf(f), 'reg') }];
  const txs = Math.ceil(count / 64);
  const per = (t: number) => Math.min(64, count - 64 * t);
  for (let t = 0; t < txs; t++) {
    const events = Array.from({ length: per(t) }, () => ev.create(control.hash));
    const h = from + 1 + t;
    inputs.push({ tx: labelTx(h, h, { payload: payload(events, t === 0 ? [control.bytes] : []), rs: [f], wk: [f] }) });
  }
  for (let t = 0; t < txs; t++) {
    const groups = Array.from({ length: per(t) }, (_, i) => ev.join({ txHash: txHex(from + 1 + t), index: i }, f));
    const h = from + 1 + txs + t;
    inputs.push({ tx: labelTx(h, h, { payload: payload(groups), rs: [f] }) });
  }
  return { inputs, top: from + 2 * txs };
}
