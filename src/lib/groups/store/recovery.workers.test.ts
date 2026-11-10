/// <reference types="@cloudflare/workers-types" />
import { env } from 'cloudflare:test';
import type { Budget, ChainInput, ChainTx, Credential, EventRef, LedgerInput, Pos, Recovery } from 'drep-groups';
import { bytesToHex, credKey, decodePayload, endOf, LeaseLostError, MemoryStore, memberScriptWitness, refKey, runEngine } from 'drep-groups';
import { generateChain } from 'drep-groups/conformance';
import { describe, expect, it } from 'vitest';
import {
  changesPerCall,
  comparableD1,
  comparableMemory,
  credUnit,
  groupUnit,
  hex,
  instance,
  keyCred,
  pos,
  ref,
  txHashOf,
  version,
} from '../__tests__/engineFixtures.js';
import { credBytes, credFromKey, credKeyFromCol, hashBytes, type Row } from '../codec.js';
import { ENGINE_BUDGET, RECOVERY_STEP_OVERHEAD, WITNESS_BACKOFF_BASE_MS } from '../constants.js';
import { checkLibraryVersion } from '../ingest.js';
import { commit } from './commit.js';
import { D1Store } from './d1Store.js';
import {
  finishHistoryBatch,
  isMarkerTx,
  markSolo,
  recordWitnessChecks,
  setKnown,
  type StoredLedgerRow,
  storeHistoryPage,
  storeLabelTxs,
  storeLedgerRows,
} from './ingest.js';
import { acquireLease, invocationOwner } from './lease.js';
import { finishRecovery, openRecovery, resetStep, truncateStep } from './recovery.js';
import { frontiers, pendingRecovery } from './reads.js';

const db = env.DB;
const MAX = Number.MAX_SAFE_INTEGER;
const HEAVY = 120_000;

async function lease(): Promise<string> {
  const t = await acquireLease(db, invocationOwner());
  if (t === null) throw new Error('no lease');
  return t;
}

async function meta(): Promise<Row> {
  return (await db.prepare('SELECT * FROM drep_group_meta WHERE id = 1').first<Row>()) as Row;
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  return Number((await db.prepare(sql).bind(...binds).first<{ n: number }>())?.n);
}

async function exec(...sql: string[]): Promise<void> {
  for (let i = 0; i < sql.length; i += 50) await db.batch(sql.slice(i, i + 50).map((s) => db.prepare(s)));
}

const P = (p: Pos): string => `${p.blockHeight}, ${p.txIndex}, ${p.phase}, ${p.index}, X'${p.txHash}'`;
/** SQL literal of a stored credential. */
const C = (key: string): string => `X'${bytesToHex(credBytes(key))}'`;
// A block hash for inputs whose block hash is not read.
const BLOCK = hex(11, 64);
const certAt = (h: number, ix = 0): Pos => pos(h, 0, 0, ix);
const noTime = async (): Promise<number | null> => null;

/** A tracked group action row, with the given extra columns as SQL literals. */
const pendingRow = (id: string, bodyHash: string, over: Record<string, string | number> = {}): string => {
  const cols: Record<string, string | number> = {
    id: `'${id}'`,
    drep_id: "'g'",
    action: "'group_update'",
    action_params: "'{}'",
    unsigned_tx_cbor: "'00'",
    body_hash: `'${bodyHash}'`,
    native_script: "'{}'",
    created_by: "'u1'",
    created_at: 1,
    expires_at: 2,
    subject_kind: "'group'",
    control_slot: 1,
    ...over,
  };
  return `INSERT INTO pending_multisig_tx (${Object.keys(cols).join(', ')}) VALUES (${Object.values(cols).join(', ')})`;
};
const outcomeRow = (tx: string, idx: number, h: number): string =>
  `INSERT INTO drep_group_own_outcomes (tx_hash, idx, valid, reason, at_h, written_at) VALUES ('${tx}', ${idx}, 1, NULL, ${h}, 1)`;
const resolutionOf = async (id: string): Promise<Row | null> =>
  db.prepare('SELECT resolution, resolved_at, resolved_h FROM pending_multisig_tx WHERE id = ?').bind(id).first<Row>();

async function track(c: Credential, seq: number, over: Record<string, string | number> = {}): Promise<void> {
  const cols = { cred: C(credKey(c)), seq, known: 1, history_done: 1, ...over };
  await exec(`INSERT INTO drep_group_tracked (${Object.keys(cols).join(', ')}) VALUES (${Object.values(cols).join(', ')})`);
}

const ledgerRow = (c: Credential, kind: 'reg' | 'unreg', h: number, ix = 0, blockTime = h * 20): StoredLedgerRow => ({
  input: { kind, credential: c, txHash: txHashOf(h), blockHeight: h, txIndex: 0, certIndex: ix },
  blockHash: hex(h, 64),
  blockTime,
  witnessState: 'na',
  witness: null,
});

const markerTx = (h: number): ChainTx => ({
  txHash: txHashOf(h),
  blockHeight: h,
  txIndex: 0,
  isValid: false,
  invalidBefore: null,
  invalidHereafter: null,
  requiredSigners: [],
  witnessKeyHashes: [],
  payload: undefined,
  payloadRepeated: false,
  witnessScripts: [],
});

async function setMeta(cols: Record<string, string | number | null>): Promise<void> {
  const set = Object.entries(cols).map(([k, v]) => `${k} = ${v === null ? 'NULL' : typeof v === 'string' ? `'${v}'` : v}`);
  await exec(`UPDATE drep_group_meta SET ${set.join(', ')} WHERE id = 1`);
}

const setG = (p: Pos) =>
  exec(`UPDATE drep_group_meta SET G_h = ${p.blockHeight}, G_ti = ${p.txIndex}, G_ph = ${p.phase}, G_ix = ${p.index}, G_tx = X'${p.txHash}' WHERE id = 1`);

/** Steps a recovery to its end through the engine's own calls. */
async function stepToDone(step: () => Promise<'more' | 'done'>, cap = 100_000): Promise<number> {
  for (let i = 1; i <= cap; i++) if ((await step()) === 'done') return i;
  throw new Error('recovery did not finish');
}

// The same chain fed to the reference store and to D1, through each store's own ingest.
class Twin {
  readonly mem = new MemoryStore();
  readonly memLease = this.mem.acquireLease('mem');
  readonly d1 = new D1Store(db);
  constructor(readonly lease: string) {}

  static async create(): Promise<Twin> {
    return new Twin(await lease());
  }

  async deliver(inputs: ChainInput[]): Promise<void> {
    for (const x of inputs) {
      if (x.kind === 'tx') {
        this.mem.ingestLabelTx(x.tx);
        await storeLabelTxs(db, this.lease, [{ tx: x.tx, blockHash: hex(x.tx.blockHeight, 64) }], null, async (h) => h * 20);
      } else {
        this.mem.ingestLedgerRow(x.input);
        await this.storeLedger(x.input);
      }
    }
    // Every credential complete, as the reference store's default.
    await exec('UPDATE drep_group_tracked SET known = 1, history_done = 1 WHERE known IS NULL');
  }

  async storeLedger(input: LedgerInput): Promise<void> {
    const c = input.credential;
    await db
      .prepare(
        `INSERT OR IGNORE INTO drep_group_tracked (cred, seq, known, history_done)
         VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM drep_group_tracked), 1, 1)`,
      )
      .bind(credBytes(credKey(c)))
      .run();
    await exec(`UPDATE drep_group_tracked SET known = 1, history_done = 1 WHERE known IS NULL AND cred = ${C(credKey(c))}`);
    const script = c.kind === 'script' && input.kind === 'reg';
    const row: StoredLedgerRow = {
      ...ledgerRow(c, input.kind, input.blockHeight, input.certIndex),
      input: { ...input, witnessScripts: undefined },
      witnessState: script ? 'checked' : 'na',
      witness: script ? (memberScriptWitness(c, input.witnessScripts)?.bytes ?? null) : null,
    };
    await storeLedgerRows(db, this.lease, [row], null);
  }

  async frontiersAt(tip: number): Promise<void> {
    this.mem.setFrontiers({ L: tip, R: tip });
    await setMeta({ L: tip, R: tip });
  }

  async open(r: Recovery): Promise<void> {
    await this.mem.openRecovery(r, this.memLease);
    await this.d1.openRecovery(r, this.lease);
  }

  async runD1(budget: Budget, cap = 2000): Promise<void> {
    for (let i = 0; i < cap; i++) if (!(await runEngine(this.d1, budget, this.lease)).more) return;
    throw new Error('engine did not settle');
  }

  async runMem(budget: Budget = ENGINE_BUDGET, cap = 2000): Promise<void> {
    for (let i = 0; i < cap; i++) if (!(await runEngine(this.mem, budget, this.memLease)).more) return;
    throw new Error('engine did not settle');
  }

  async settle(budget: Budget = ENGINE_BUDGET): Promise<void> {
    await this.runMem(budget);
    await this.runD1(budget);
  }

  async expectEqual(): Promise<void> {
    expect(await comparableD1(db)).toEqual(comparableMemory(this.mem.snapshot()));
  }
}

const TIP = 40;

async function settledTwin(seed = 1): Promise<{ t: Twin; chain: ChainInput[] }> {
  const chain = generateChain(seed, { txs: 20, credentials: 4, groups: 3 });
  const t = await Twin.create();
  await t.deliver(chain);
  await t.frontiersAt(TIP);
  await t.settle();
  await t.expectEqual();
  return { t, chain };
}

const ONE: Budget = { ...ENGINE_BUDGET, truncateRows: 1, resetRows: 1 };

async function phase(): Promise<string | null> {
  return (await meta()).rec_phase as string | null;
}

/** Runs the D1 engine with budget 1 until the stored phase is `target`. */
async function stepUntil(t: Twin, target: string, cap = 5000): Promise<void> {
  for (let i = 0; i < cap; i++) {
    if ((await phase()) === target) return;
    await runEngine(t.d1, ONE, t.lease);
  }
  throw new Error(`phase ${target} not reached`);
}

// Fixture of many credentials and groups with rows on both sides of the cut at 50. The worst groups and
// credentials come first in every page: listed groups with an anchor change above the cut, no profile due
// row and no recompute job yet, credentials whose applied unreg below the cut remains after it.
async function seedLarge(groups: number, creds: number, worst = { groups: 0, creds: 0 }): Promise<void> {
  const sql: string[] = [];
  const gtx = (g: number): string => hex(500_000 + g, 64);
  const cred = (c: number): string => `key:${hex(10_000 + c)}`;
  const at = (h: number, ti = 0): string => P(pos(h, ti));
  for (let w = 0; w < worst.groups; w++) {
    const id = `X'${hex(400_000 + w, 64)}', 0`;
    const vcols = `group_tx, group_ix, at_h, at_ti, at_ph, at_ix, at_tx, mode, control, admission, profile_url, profile_hash, seq,
      status, created_h, created_ti, created_ph, created_ix, created_tx`;
    sql.push(`INSERT INTO drep_group_versions (${vcols}) VALUES (${id}, ${at(10, 1)}, 'open', X'aa', NULL, 'https://a/w${w}', X'0a', '0', 'active', ${at(10, 1)}),
      (${id}, ${at(60, 1)}, 'open', X'aa', NULL, 'https://b/w${w}', X'0b', '1', 'active', ${at(10, 1)})`);
    sql.push(`INSERT INTO drep_groups (group_tx, group_ix, cur_h, cur_ti, cur_ph, cur_ix, cur_tx, mode, control, admission,
        profile_url, profile_hash, seq, status, created_h, created_ti, created_ph, created_ix, created_tx, members)
      VALUES (${id}, ${at(60, 1)}, 'open', X'aa', NULL, 'https://b/w${w}', X'0b', '1', 'active', ${at(10, 1)}, 2)`);
    sql.push(`INSERT INTO drep_group_due (kind, group_tx, group_ix, due_at) VALUES ('website', ${id}, 0)`);
  }
  for (let w = 0; w < worst.creds; w++) {
    const k = `key:${hex(90_000 + w)}`;
    const kb = C(k);
    const lt = (h: number): string => hex(3_000_000 + w, 56) + String(h).padStart(8, '0');
    const certP = (h: number): string => `${h}, 0, 0, 0, X'${lt(h)}'`;
    sql.push(`INSERT INTO drep_group_tracked (cred, seq, known, history_done, applied_h, applied_ti, applied_ph, applied_ix,
        applied_tx, retiring, retired_at_h, retired_at_ti, retired_at_ph, retired_at_ix, retired_at_tx)
      VALUES (${kb}, ${100_000 + w}, 1, 1, ${certP(70)}, 1, ${certP(65)})`);
    sql.push(`INSERT INTO drep_group_ledger (tx_hash, cert_index, cred, kind, block_height, block_hash, tx_index, block_time,
        witness, witness_state)
      VALUES (X'${lt(20)}', 0, ${kb}, 'reg', 20, X'0b', 0, 400, NULL, 'na'), (X'${lt(30)}', 0, ${kb}, 'unreg', 30, X'0b', 0, 600, NULL, 'na'),
        (X'${lt(65)}', 0, ${kb}, 'unreg', 65, X'0b', 0, 1300, NULL, 'na')`);
  }
  for (let g = 0; g < groups; g++) {
    const kind = g % 3; // 0: created above the cut, 1: updated above the cut, 2: dissolved at 40
    const dissolvedAbove = kind === 1 && g % 6 === 1;
    const id = `X'${gtx(g)}', 0`;
    const vcols = `group_tx, group_ix, at_h, at_ti, at_ph, at_ix, at_tx, mode, control, admission, profile_url, profile_hash, seq,
      status, created_h, created_ti, created_ph, created_ix, created_tx`;
    const created = kind === 0 ? at(60, 1) : at(10, 1);
    if (kind !== 0) {
      sql.push(`INSERT INTO drep_group_versions (${vcols}) VALUES (${id}, ${at(10, 1)}, 'permissioned', X'aa', NULL, 'https://a/${g}', X'0a', '0', 'active', ${created})`);
    }
    const top = kind === 2 ? 40 : 60;
    const status = kind === 2 || dissolvedAbove ? 'dissolved' : 'active';
    const topAt = dissolvedAbove ? at(70, 1) : at(top, 1);
    sql.push(`INSERT INTO drep_group_versions (${vcols}) VALUES (${id}, ${topAt}, 'permissioned', X'aa', NULL, 'https://b/${g}', X'0b', '1', '${status}', ${created})`);
    const dis = status === 'dissolved' ? topAt : 'NULL, NULL, NULL, NULL, NULL';
    sql.push(`INSERT INTO drep_groups (group_tx, group_ix, cur_h, cur_ti, cur_ph, cur_ix, cur_tx, mode, control, admission,
        profile_url, profile_hash, seq, status, created_h, created_ti, created_ph, created_ix, created_tx,
        dissolved_h, dissolved_ti, dissolved_ph, dissolved_ix, dissolved_tx, members, closing)
      VALUES (${id}, ${topAt}, 'permissioned', X'aa', NULL, 'https://b/${g}', X'0b', '1', '${status}', ${created}, ${dis}, 2,
        ${dissolvedAbove ? 1 : 0})`);
    sql.push(`INSERT INTO drep_group_due (kind, group_tx, group_ix, due_at) VALUES ('website', ${id}, 0), ('profile', ${id}, 0)`);
    sql.push(`INSERT INTO drep_group_trim_due (group_tx, group_ix, oldest_h) VALUES (${id}, 20)`);
    const icols = `join_tx, join_ix, group_tx, group_ix, cred, drep_id, mode, joined_h, joined_ti, joined_ph, joined_ix, joined_tx,
      approved_h, approved_ti, approved_ph, approved_ix, approved_tx, closed_h, closed_ti, closed_ph, closed_ix, closed_tx, close_reason, counted_as`;
    const c = C(cred(g % creds));
    sql.push(`INSERT INTO drep_group_instances (${icols}) VALUES
      (X'${hex(600_000 + g, 64)}', 0, ${id}, ${c}, 'd', 'permissioned', ${at(20, 2)}, ${at(60, 2)}, ${at(70, 2)}, 'left', 'former'),
      (X'${hex(700_000 + g, 64)}', 0, ${id}, ${c}, 'd', 'permissioned', ${at(60, 3)}, NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, NULL, NULL, 'pending')`);
    sql.push(`INSERT INTO drep_group_verdicts (tx_hash, idx, group_tx, group_ix, at_h, at_ti, at_ph, at_ix, at_tx, tag, valid, reason, subject)
      VALUES (X'${hex(800_000 + g, 64)}', 0, ${id}, ${at(60, 4)}, 'update', 1, NULL, NULL),
        (X'${hex(900_000 + g, 64)}', 0, ${id}, ${at(20, 4)}, 'update', 1, NULL, NULL)`);
    sql.push(`INSERT INTO drep_group_txs (tx_hash, block_height, block_hash, tx_index, marker, bytes) VALUES
      (X'${hex(800_000 + g, 64)}', 60, X'0b', ${4 + g}, 0, 1), (X'${hex(950_000 + g, 64)}', 30, X'0b', ${4 + g}, 1, 0)`);
    // A tracked action resolved at 60 with its outcomes, an older one at 20, and join requests on both sides.
    sql.push(
      pendingRow(`seed-${g}-60`, hex(800_000 + g, 64), { resolution: "'applied'", resolved_at: 1, resolved_h: 60 }).replace('INSERT', 'INSERT OR REPLACE'),
      pendingRow(`seed-${g}-20`, hex(900_000 + g, 64), { resolution: "'applied'", resolved_at: 1, resolved_h: 20 }).replace('INSERT', 'INSERT OR REPLACE'),
    );
    sql.push(`INSERT INTO drep_group_own_outcomes (tx_hash, idx, valid, reason, at_h, written_at)
      VALUES ('${hex(800_000 + g, 64)}', 0, 1, NULL, 60, 1), ('${hex(900_000 + g, 64)}', 0, 1, NULL, 20, 1)`);
    sql.push(`INSERT INTO drep_group_join_notify (join_tx, join_ix, join_h) VALUES (X'${hex(700_000 + g, 64)}', 0, 60), (X'${hex(600_000 + g, 64)}', 0, 20)`);
    if (g % 10 === 0) {
      sql.push(`INSERT INTO drep_group_jobs (kind, job_key, group_tx, group_ix, cursor_json, staging, start_gen)
        VALUES ('recompute', '${gtx(g)}#0', ${id}, '{"pass":"instances"}', '{}', 0)`);
    }
    if (dissolvedAbove) {
      sql.push(`INSERT INTO drep_group_jobs (kind, job_key, group_tx, group_ix, trigger_h, trigger_ti, trigger_ph, trigger_ix, trigger_tx)
        VALUES ('dissolve', '${gtx(g)}#0', ${id}, ${at(70, 1)})`);
    }
  }
  const tcols = `cred, seq, known, history_done, solo, history_offset, applied_h, applied_ti, applied_ph, applied_ix, applied_tx,
    next_h, next_ti, next_ph, next_ix, next_tx, found_h, found_ti, found_ph, found_ix, found_tx, retiring,
    retired_at_h, retired_at_ti, retired_at_ph, retired_at_ix, retired_at_tx`;
  const lcols = 'tx_hash, cert_index, cred, kind, block_height, block_hash, tx_index, block_time, witness, witness_state';
  for (let c = 0; c < creds; c++) {
    const k = cred(c);
    const kb = C(k);
    const lt = (h: number): string => hex(1_000_000 + c * 10 + h % 10, 56) + String(h).padStart(8, '0');
    const certP = (h: number): string => `${h}, ${c % 50}, 0, 0, X'${lt(h)}'`;
    const next = c % 4 === 0 ? certP(80) : 'NULL, NULL, NULL, NULL, NULL';
    const found = c % 3 === 0 ? certP(60) : 'NULL, NULL, NULL, NULL, NULL';
    const retired = c % 2 === 0 ? certP(65) : 'NULL, NULL, NULL, NULL, NULL';
    sql.push(`INSERT INTO drep_group_tracked (${tcols}) VALUES (${kb}, ${c + 1}, 1, 1, ${c % 10 === 0 ? 1 : 0}, ${c % 10 === 0 ? 5 : 0},
      ${certP(70)}, ${next}, ${found}, ${c % 2 === 0 ? 1 : 0}, ${retired})`);
    const rows = [`(X'${lt(30)}', 0, ${kb}, 'reg', 30, X'0b', ${c % 50}, 600, NULL, 'na')`];
    if (c % 2 === 0) rows.push(`(X'${lt(65)}', 0, ${kb}, 'unreg', 65, X'0b', ${c % 50}, 1300, NULL, 'na')`);
    if (c % 3 === 0) rows.push(`(X'${lt(60)}', 0, ${kb}, 'reg', 60, X'0b', ${c % 50}, 1200, x'00', 'checked')`);
    if (c % 4 === 0) rows.push(`(X'${lt(80)}', 0, ${kb}, 'reg', 80, X'0b', ${c % 50}, 1600, NULL, 'pending')`);
    sql.push(`INSERT INTO drep_group_ledger (${lcols}) VALUES ${rows.join(', ')}`);
    if (c % 2 === 0) {
      sql.push(`INSERT INTO drep_group_jobs (kind, job_key, cred, trigger_h, trigger_ti, trigger_ph, trigger_ix, trigger_tx)
        VALUES ('retire', '${k}', ${kb}, ${certP(65)})`);
    }
  }
  sql.push(`UPDATE drep_group_meta SET L = 90, L_hash = 'h90', R = 90, G_h = 90, G_ti = ${MAX}, G_ph = 2, G_ix = ${MAX}, G_tx = X'',
    reg_time = 1800, reg_offset = 7 WHERE id = 1`);
  await exec(...sql);
}

async function rowsAbove(h: number): Promise<number> {
  const checks = [
    'SELECT COUNT(*) AS n FROM drep_group_txs WHERE block_height > ?',
    'SELECT COUNT(*) AS n FROM drep_group_ledger WHERE block_height > ?',
    'SELECT COUNT(*) AS n FROM drep_group_versions WHERE at_h > ?',
    'SELECT COUNT(*) AS n FROM drep_group_scripts WHERE at_h > ?',
    'SELECT COUNT(*) AS n FROM drep_group_member_scripts WHERE at_h > ?',
    'SELECT COUNT(*) AS n FROM drep_group_instances WHERE joined_h > ? OR approved_h > ?1 OR closed_h > ?1',
    'SELECT COUNT(*) AS n FROM drep_group_verdicts WHERE at_h > ?',
    'SELECT COUNT(*) AS n FROM drep_group_queue WHERE at_h > ?',
    'SELECT COUNT(*) AS n FROM drep_group_tx_context WHERE block_height > ?',
    'SELECT COUNT(*) AS n FROM drep_groups WHERE cur_h > ?',
    'SELECT COUNT(*) AS n FROM drep_group_tracked WHERE applied_h > ?1 OR next_h > ?1 OR found_h > ?1 OR retired_at_h > ?1',
    'SELECT COUNT(*) AS n FROM drep_group_own_outcomes WHERE at_h > ?',
    'SELECT COUNT(*) AS n FROM drep_group_join_notify WHERE join_h > ?',
    'SELECT COUNT(*) AS n FROM pending_multisig_tx WHERE resolved_h > ?',
  ];
  let n = 0;
  for (const sql of checks) n += await count(sql, h);
  return n;
}

const STORED_TABLES = [
  'drep_group_txs',
  'drep_group_ledger',
  'drep_group_tracked',
  'drep_group_queue',
  'drep_group_tx_context',
  'drep_group_scripts',
  'drep_group_member_scripts',
  'drep_group_versions',
  'drep_groups',
  'drep_group_instances',
  'drep_group_leads',
  'drep_group_verdicts',
  'drep_group_jobs',
  'drep_group_trim_due',
  'drep_group_due',
  'drep_group_own_outcomes',
  'drep_group_join_notify',
];

async function storedRows(tables = STORED_TABLES): Promise<number> {
  let n = 0;
  for (const t of tables) n += await count(`SELECT COUNT(*) AS n FROM ${t}`);
  return n;
}

describe('drep groups ingest and recovery', () => {
  it('classifies a late ledger row and opens a truncation with its block time', async () => {
    const t = await lease();
    const a = keyCred(1);
    await track(a, 1, { applied_h: 100, applied_ti: 0, applied_ph: 0, applied_ix: 0, applied_tx: `X'${txHashOf(100)}'` });
    expect(await storeLedgerRows(db, t, [ledgerRow(a, 'reg', 90, 0, 1777)], null)).toEqual(['stored']);
    expect(await pendingRecovery(db)).toEqual({ kind: 'truncate', above: 89 });
    expect(await meta()).toMatchObject({ rec_first_time: 1777, rec_phase: 'jobs' });
  });

  it('opens nothing for a duplicate or a marker', async () => {
    const t = await lease();
    const a = keyCred(1);
    await track(a, 1);
    expect(await storeLedgerRows(db, t, [ledgerRow(a, 'reg', 90)], null)).toEqual(['stored']);
    await exec(`UPDATE drep_group_tracked SET applied_h = 100, applied_ti = 0, applied_ph = 0, applied_ix = 0, applied_tx = X'0f'`);
    expect(await storeLedgerRows(db, t, [ledgerRow(a, 'reg', 90)], null)).toEqual(['duplicate']);
    await setG(endOf(100));
    expect(await storeLabelTxs(db, t, [{ tx: markerTx(50), blockHash: BLOCK }], null, noTime)).toEqual(['marker']);
    expect(await storeLabelTxs(db, t, [{ tx: markerTx(50), blockHash: BLOCK }], null, noTime)).toEqual(['duplicate']);
    expect(await pendingRecovery(db)).toBeNull();
    expect(await count('SELECT COUNT(*) AS n FROM drep_group_txs WHERE marker = 1 AND bytes = 0 AND payload IS NULL')).toBe(1);
  });

  it('opens a fork for a late input older than the retention floor', async () => {
    const t = await lease();
    const a = keyCred(1);
    await track(a, 1, { applied_h: 200, applied_ti: 0, applied_ph: 0, applied_ix: 0, applied_tx: "X'0f'" });
    await setMeta({ L: 5000 });
    await storeLedgerRows(db, t, [ledgerRow(a, 'reg', 100)], null);
    expect(await pendingRecovery(db)).toEqual({ kind: 'fork' });
    expect(await meta()).toMatchObject({ rec_phase: 'state', rec_first_time: null });
  });

  it(
    'keeps every truncation call within the row budget, the last one included',
    async () => {
      for (const budget of [50, 400]) {
      await finishTest();
      await seedLarge(300, 1000, { groups: 40, creds: 60 });
      const t = await lease();
      await openRecovery(db, { kind: 'truncate', above: 50 }, t, 1000);
      const calls: number[] = [];
      let r: 'more' | 'done';
      do {
        const before = await meta();
        const c = await changesPerCall(db, (d) => truncateStep(d, 50, budget, t));
        calls.push(c.changes);
        r = c.result;
        if (r === 'more') {
          const { rec_phase: _a, ...was } = before;
          const { rec_phase: _b, ...now } = await meta();
          expect(now).toEqual(was);
        }
      } while (r === 'more');
      expect(Math.max(...calls)).toBeLessThanOrEqual(budget + RECOVERY_STEP_OVERHEAD);
      expect(await rowsAbove(50)).toBe(0);
      expect(await meta()).toMatchObject({ L: 50, L_hash: null, R: 50, G_h: 50, G_ti: MAX, reg_offset: 0, reg_time: 1000, rec_phase: 'done' });
      expect(await count('SELECT COUNT(*) AS n FROM drep_group_tracked WHERE history_offset > 0')).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM drep_group_tracked WHERE applied_h = 50 AND applied_ti = ?", MAX)).toBe(1060);
      expect(await count('SELECT COUNT(*) AS n FROM drep_group_tracked WHERE retiring = 1 AND retired_at_h = 30')).toBe(60);
      expect(await count("SELECT COUNT(*) AS n FROM drep_group_jobs WHERE kind = 'repair'")).toBe(560);
      expect(await count("SELECT COUNT(*) AS n FROM drep_group_jobs WHERE kind IN ('dissolve', 'retire')")).toBe(0);
      expect(await count('SELECT COUNT(*) AS n FROM drep_group_jobs WHERE cursor_json IS NOT NULL')).toBe(0);
      // Every remaining group was touched: one recompute and one power job each.
      const groups = await count('SELECT COUNT(*) AS n FROM drep_groups');
      expect(groups).toBe(240);
      for (const kind of ['recompute', 'power']) {
        expect(
          await count(
            'SELECT COUNT(*) AS n FROM drep_groups g JOIN drep_group_jobs j ON j.kind = ? AND j.group_tx = g.group_tx AND j.group_ix = g.group_ix',
            kind,
          ),
        ).toBe(groups);
      }
      expect(await count('SELECT COUNT(*) AS n FROM drep_groups WHERE closing = 1')).toBe(100);
      expect(await count('SELECT COUNT(*) AS n FROM drep_groups WHERE closing = 1 AND dissolved_h <= 50')).toBe(100);
      // Deleted groups leave no due rows, restored ones keep a profile due row and lose the website one.
      expect(await count("SELECT COUNT(*) AS n FROM drep_group_due WHERE kind = 'website'")).toBe(100);
      expect(await count('SELECT COUNT(*) AS n FROM drep_group_trim_due')).toBe(200);
      expect(await count("SELECT COUNT(*) AS n FROM drep_group_due WHERE kind = 'profile' AND group_tx >= ? AND group_tx < ?", hashBytes(hex(400_000, 64)), hashBytes(hex(500_000, 64)))).toBe(40);
      }
    },
    HEAVY,
  );

  it(
    'keeps a call that starts on a page of the worst rows within the row budget',
    async () => {
      // The phases before were run already (their rows are gone), each call starts on the worst page.
      for (const [phaseName, budget] of [
        ['versions', 400],
        ['versions', 50],
        ['credentials', 400],
        ['credentials', 50],
      ] as const) {
        await finishTest();
        await seedLarge(0, 0, phaseName === 'versions' ? { groups: 60, creds: 0 } : { groups: 0, creds: 80 });
        await exec(
          'DELETE FROM drep_group_versions WHERE at_h > 50',
          'DELETE FROM drep_group_ledger WHERE block_height > 50',
          `UPDATE drep_group_tracked SET applied_h = 50, applied_ti = ${MAX}, applied_ph = 2, applied_ix = ${MAX}, applied_tx = X''`,
        );
        const t = await lease();
        await openRecovery(db, { kind: 'truncate', above: 50 }, t, 1000);
        await setMeta({ rec_phase: phaseName });
        const c = await changesPerCall(db, (d) => truncateStep(d, 50, budget, t));
        expect(c.result).toBe('more');
        expect(c.changes).toBeGreaterThan(budget - 20);
        expect(c.changes).toBeLessThanOrEqual(budget + RECOVERY_STEP_OVERHEAD);
        await stepToDone(() => truncateStep(db, 50, budget, t));
        if (phaseName === 'versions') {
          expect(await count("SELECT COUNT(*) AS n FROM drep_group_due WHERE kind = 'profile'")).toBe(60);
          expect(await count("SELECT COUNT(*) AS n FROM drep_group_jobs WHERE kind = 'recompute'")).toBe(60);
        } else {
          expect(await count("SELECT COUNT(*) AS n FROM drep_group_tracked WHERE retiring = 1 AND retired_at_h = 30")).toBe(80);
          expect(await count("SELECT COUNT(*) AS n FROM drep_group_jobs WHERE kind = 'repair'")).toBe(80);
        }
      }
    },
    HEAVY,
  );

  it(
    'keeps a state call within the row budget when every deleted instance moves its DRep listing count',
    async () => {
      for (const budget of [400, 50]) {
        await finishTest();
        // DRep c holds open memberships in groups 2c and 2c + 1, both joined above the cut. Deleting the older
        // one moves the count to the other group, which becomes listed and gets its website due row from a stored
        // profile, deleting that one ends it: the worst case of the lead and website due triggers.
        const sql: string[] = [];
        const id = (g: number): string => `X'${hex(500_000 + g, 64)}', 0`;
        const icols = 'join_tx, join_ix, group_tx, group_ix, cred, drep_id, mode, joined_h, joined_ti, joined_ph, joined_ix, joined_tx, counted_as';
        for (let c = 0; c < 120; c++) {
          for (const g of [2 * c, 2 * c + 1]) {
            sql.push(`INSERT INTO drep_groups (group_tx, group_ix, cur_h, cur_ti, cur_ph, cur_ix, cur_tx, mode, control, admission,
                profile_url, profile_hash, seq, status, created_h, created_ti, created_ph, created_ix, created_tx, members)
              VALUES (${id(g)}, ${P(pos(10, 1))}, 'open', X'aa', NULL, 'https://example.org/g.json', X'${'aa'.repeat(32)}', '0', 'active',
                ${P(pos(10, 1))}, 1)`);
            sql.push(`INSERT OR REPLACE INTO drep_group_profiles (group_tx, group_ix, profile_url, data_hash, status, website, fetched_at)
              VALUES (${id(g)}, 'https://example.org/g.json', X'${'aa'.repeat(32)}', 'ok', 'https://example.org', 1)`);
          }
          const k = C(`key:${hex(10_000 + c)}`);
          sql.push(`INSERT INTO drep_group_instances (${icols}) VALUES
            (X'${hex(600_000 + c, 64)}', 0, ${id(2 * c)}, ${k}, 'd', 'open', ${P(pos(60, 2))}, 'open'),
            (X'${hex(700_000 + c, 64)}', 0, ${id(2 * c + 1)}, ${k}, 'd', 'open', ${P(pos(70, 2))}, 'open')`);
        }
        await exec(...sql);
        expect(await count('SELECT COUNT(*) AS n FROM drep_groups WHERE counted_members = 1')).toBe(120);
        expect(await count("SELECT COUNT(*) AS n FROM drep_group_due WHERE kind = 'website'")).toBe(120);
        const t = await lease();
        await openRecovery(db, { kind: 'truncate', above: 50 }, t, 1000);
        await setMeta({ rec_phase: 'state' });
        const c = await changesPerCall(db, (d) => truncateStep(d, 50, budget, t));
        expect(c.result).toBe('more');
        expect(c.changes).toBeGreaterThan(budget - 20);
        expect(c.changes).toBeLessThanOrEqual(budget + RECOVERY_STEP_OVERHEAD);
        await stepToDone(() => truncateStep(db, 50, budget, t));
        expect(await count('SELECT COUNT(*) AS n FROM drep_group_instances')).toBe(0);
        expect(await count('SELECT COUNT(*) AS n FROM drep_group_leads')).toBe(0);
        expect(await count('SELECT COUNT(*) AS n FROM drep_groups WHERE counted_members <> 0')).toBe(0);
      }
    },
    HEAVY,
  );

  it(
    'keeps every rebuild and fork call within the row budget',
    async () => {
      const t = await lease();
      const runReset = async (mode: 'rebuild' | 'fork', budget: number): Promise<void> => {
        await openRecovery(db, { kind: mode }, t);
        const calls: number[] = [];
        let r: 'more' | 'done';
        do {
          const c = await changesPerCall(db, (d) => resetStep(d, mode, budget, t));
          calls.push(c.changes);
          r = c.result;
        } while (r === 'more');
        expect(Math.max(...calls)).toBeLessThanOrEqual(budget + RECOVERY_STEP_OVERHEAD);
        await finishRecovery(db, { kind: mode }, t);
      };
      await seedLarge(300, 1000);
      await runReset('rebuild', 50);
      expect(
        await storedRows(['drep_group_versions', 'drep_groups', 'drep_group_instances', 'drep_group_jobs', 'drep_group_due', 'drep_group_own_outcomes', 'drep_group_join_notify']),
      ).toBe(0);
      expect(await count('SELECT COUNT(*) AS n FROM pending_multisig_tx WHERE resolved_h IS NOT NULL')).toBe(0);
      expect(await count('SELECT COUNT(*) AS n FROM drep_group_tracked WHERE applied_h IS NOT NULL')).toBe(0);
      expect(await count('SELECT COUNT(*) AS n FROM drep_group_txs WHERE marker = 1 AND refetch = 0')).toBe(0);
      await runReset('fork', 50);
      expect(await storedRows()).toBe(0);
      await exec(...STORED_TABLES.map((x) => `DELETE FROM ${x}`), `UPDATE drep_group_meta SET rec_phase = NULL WHERE id = 1`);
      await seedLarge(6, 8);
      await runReset('rebuild', 1);
      await runReset('fork', 1);
      expect(await storedRows()).toBe(0);
      expect(await frontiers(db)).toEqual({ L: -1, R: null, G: endOf(-1) });
      await runEngine(new D1Store(db), ENGINE_BUDGET, t);
      expect(await frontiers(db)).toEqual({ L: -1, R: null, G: endOf(-1) });
    },
    HEAVY,
  );

  describe('restarts the phases when the first slot changes, with truncateRows 1', () => {
    const CUT = 15;
    const LOW = 8;

    it(
      '(a) a lower truncation opened while the first is in phase state',
      async () => {
        const { t } = await settledTwin();
        await t.open({ kind: 'truncate', above: CUT });
        await stepUntil(t, 'state');
        await t.open({ kind: 'truncate', above: LOW });
        expect(await phase()).toBe('jobs');
        await t.settle(ONE);
        expect(await count('SELECT COUNT(*) AS n FROM drep_group_instances WHERE joined_h > ?1 OR approved_h > ?1 OR closed_h > ?1', LOW)).toBe(0);
        await t.expectEqual();
      },
      HEAVY,
    );

    it(
      '(b) a rebuild opened while a truncation is in phase undo',
      async () => {
        const { t, chain } = await settledTwin();
        await t.open({ kind: 'truncate', above: CUT });
        await stepUntil(t, 'undo');
        await t.open({ kind: 'rebuild' });
        expect(await pendingRecovery(db)).toEqual({ kind: 'rebuild' });
        expect(await meta()).toMatchObject({ rec_phase: 'state', rec_then_above: CUT, rebuilding: 1 });
        await recover(t);
        await t.expectEqual();
        // Raw rows come back through the readers, flagged markers through their refetch.
        await t.deliver(chain);
        await t.frontiersAt(TIP);
        await t.settle(ONE);
        await t.expectEqual();
      },
      HEAVY,
    );

    it(
      '(c) a fork opened during a truncation and during a rebuild',
      async () => {
        for (const first of ['truncate', 'rebuild'] as const) {
          const { t } = await settledTwin();
          await t.open(first === 'truncate' ? { kind: 'truncate', above: CUT } : { kind: 'rebuild' });
          await stepUntil(t, first === 'truncate' ? 'undo' : 'credentials');
          await t.open({ kind: 'fork' });
          expect(await meta()).toMatchObject({ rec_first_kind: 'fork', rec_then_above: null, rec_phase: 'state', rebuilding: 0 });
          await recover(t);
          expect(await storedRows()).toBe(0);
          await t.expectEqual();
          await finishTest();
        }
      },
      HEAVY,
    );

    it(
      '(d) a ledger row above the cut stored while the truncation is in phase cursors',
      async () => {
        const { t } = await settledTwin();
        await t.open({ kind: 'truncate', above: CUT });
        // Without power jobs the flags phase has work, so its last page stores the cursors phase.
        await exec("DELETE FROM drep_group_jobs WHERE kind = 'power'");
        await stepUntil(t, 'cursors');
        const c = credFromKey(credKeyFromCol((await db.prepare("SELECT cred FROM drep_group_tracked WHERE substr(cred, 1, 1) = X'00' LIMIT 1").first<Row>())?.cred));
        const input: LedgerInput = { kind: 'reg', credential: c, txHash: hex(4242, 64), blockHeight: CUT + 10, txIndex: 0, certIndex: 0 };
        t.mem.ingestLedgerRow(input);
        await t.storeLedger(input);
        expect(await phase()).toBe('jobs');
        expect(await count('SELECT COUNT(*) AS n FROM drep_group_tracked WHERE next_h = ?', CUT + 10)).toBe(1);
        await recover(t);
        expect(await count('SELECT COUNT(*) AS n FROM drep_group_ledger WHERE tx_hash = ?', hashBytes(input.txHash))).toBe(0);
        expect(await count('SELECT COUNT(*) AS n FROM drep_group_tracked WHERE next_h > ?', CUT)).toBe(0);
        await t.expectEqual();
      },
      HEAVY,
    );
  });

  it('restores the profile due row of a rolled back anchor change', async () => {
    const t = await lease();
    const G1 = ref(10);
    const created = pos(10);
    const A = { url: 'https://a.example/g.json', dataHash: hex(1, 64) };
    const B = { url: 'https://b.example/g.json', dataHash: hex(2, 64) };
    const [a, b] = [keyCred(1), keyCred(2)];
    await track(a, 1);
    await track(b, 2);
    await commit(db, [groupUnit(10, { versions: [version(G1, created, created, { profile: A, profileSetAt: created })] })], t);
    await commit(
      db,
      [
        credUnit(a, pos(20), { instances: [instance(ref(20), G1, a, pos(20))] }),
        credUnit(b, pos(21), { instances: [instance(ref(21), G1, b, pos(21))] }),
      ],
      t,
    );
    await commit(db, [groupUnit(60, { versions: [version(G1, created, pos(60), { seq: 1n, profile: B, profileSetAt: pos(60) })] })], t);
    // The profile of B was fetched and named a website.
    await exec(
      "DELETE FROM drep_group_due WHERE kind = 'profile'",
      `INSERT INTO drep_group_due (kind, group_tx, group_ix, due_at) VALUES ('website', X'${G1.txHash}', 0, 99999999999999)`,
    );
    const before = await groupRow(G1);
    expect(before).toMatchObject({ members: 2, profile_url: B.url, cur_h: 60 });
    const now = Date.now();
    await openRecovery(db, { kind: 'truncate', above: 50 }, t, 1000);
    await stepToDone(() => truncateStep(db, 50, 400, t));
    const after = await groupRow(G1);
    expect(after).toMatchObject({ members: 2, profile_url: A.url, profile_hash: Array.from(hashBytes(A.dataHash)), cur_h: 10, seq: '0' });
    expect(Number(after.gen)).toBeGreaterThan(Number(before.gen));
    const due = await db.prepare("SELECT due_at FROM drep_group_due WHERE kind = 'profile'").first<Row>();
    expect(Number(due?.due_at)).toBeGreaterThanOrEqual(now);
    expect(Number(due?.due_at)).toBeLessThanOrEqual(Date.now());
    expect(await count("SELECT COUNT(*) AS n FROM drep_group_due WHERE kind = 'website'")).toBe(0);
  });

  it('clears outcomes and resolution when recovery truncates the tx', async () => {
    const t = await lease();
    await exec(
      pendingRow('low', txHashOf(40), { resolution: "'applied'", resolved_at: 5, resolved_h: 40 }),
      pendingRow('high', txHashOf(60), { resolution: "'partial'", resolved_at: 5, resolved_h: 60, profile_hash: `'${hex(7, 64)}'` }),
      outcomeRow(txHashOf(40), 0, 40),
      outcomeRow(txHashOf(60), 0, 60),
      outcomeRow(txHashOf(60), 1, 60),
      `INSERT INTO drep_group_profile_docs (hash, body, created_by, created_at, anchored) VALUES ('${hex(7, 64)}', '{}', 'u1', 1, 1)`,
    );
    await openRecovery(db, { kind: 'truncate', above: 50 }, t, 1000);
    await stepToDone(() => truncateStep(db, 50, 400, t));
    expect(await count('SELECT COUNT(*) AS n FROM drep_group_own_outcomes')).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM drep_group_own_outcomes WHERE at_h = 40')).toBe(1);
    expect(await resolutionOf('high')).toEqual({ resolution: null, resolved_at: null, resolved_h: null });
    expect(await resolutionOf('low')).toEqual({ resolution: 'applied', resolved_at: 5, resolved_h: 40 });
    expect(await count('SELECT anchored AS n FROM drep_group_profile_docs')).toBe(1);
  });

  it('clears all outcomes on a rebuild', async () => {
    const t = await lease();
    await exec(
      pendingRow('low', txHashOf(10), { resolution: "'applied'", resolved_at: 5, resolved_h: 10 }),
      outcomeRow(txHashOf(10), 0, 10),
      outcomeRow(txHashOf(60), 0, 60),
    );
    await openRecovery(db, { kind: 'rebuild' }, t);
    await stepToDone(() => resetStep(db, 'rebuild', 400, t));
    expect(await count('SELECT COUNT(*) AS n FROM drep_group_own_outcomes')).toBe(0);
    expect(await resolutionOf('low')).toEqual({ resolution: null, resolved_at: null, resolved_h: null });
  });

  it('reopens a resolution without outcome rows on truncate and on a rebuild', async () => {
    const t = await lease();
    // Resolved failed by "no verdict recorded": no outcome row was ever written.
    const failed = { resolution: "'failed'", resolved_at: 5, resolved_h: 60 };
    await exec(pendingRow('p', txHashOf(60), failed));
    await openRecovery(db, { kind: 'truncate', above: 50 }, t, 1000);
    await stepToDone(() => truncateStep(db, 50, 400, t));
    await finishRecovery(db, { kind: 'truncate', above: 50 }, t);
    expect(await resolutionOf('p')).toEqual({ resolution: null, resolved_at: null, resolved_h: null });
    await exec(`UPDATE pending_multisig_tx SET resolution = 'failed', resolved_at = 5, resolved_h = 60 WHERE id = 'p'`);
    await openRecovery(db, { kind: 'rebuild' }, t);
    await stepToDone(() => resetStep(db, 'rebuild', 400, t));
    expect(await resolutionOf('p')).toEqual({ resolution: null, resolved_at: null, resolved_h: null });
  });

  it('keeps never included rows on truncate', async () => {
    const t = await lease();
    await exec(pendingRow('n', txHashOf(60), { resolution: "'never_included'", resolved_at: 5, resolved_h: 60, never_included_at: 5 }));
    await openRecovery(db, { kind: 'truncate', above: 50 }, t, 1000);
    await stepToDone(() => truncateStep(db, 50, 400, t));
    expect(await resolutionOf('n')).toEqual({ resolution: 'never_included', resolved_at: 5, resolved_h: 60 });
  });

  it('deletes join notify rows above the cut and on a rebuild', async () => {
    const t = await lease();
    await exec(
      `INSERT INTO drep_group_join_notify (join_tx, join_ix, join_h) VALUES (X'${txHashOf(40)}', 0, 40), (X'${txHashOf(60)}', 1, 60)`,
    );
    await openRecovery(db, { kind: 'truncate', above: 50 }, t, 1000);
    await stepToDone(() => truncateStep(db, 50, 400, t));
    await finishRecovery(db, { kind: 'truncate', above: 50 }, t);
    expect(await count('SELECT COUNT(*) AS n FROM drep_group_join_notify')).toBe(1);
    expect(await count('SELECT join_h AS n FROM drep_group_join_notify')).toBe(40);
    await openRecovery(db, { kind: 'rebuild' }, t);
    await stepToDone(() => resetStep(db, 'rebuild', 400, t));
    expect(await count('SELECT COUNT(*) AS n FROM drep_group_join_notify')).toBe(0);
  });

  it('sets reg_time from the cut time and falls back to the ledger time', async () => {
    const t = await lease();
    const a = keyCred(1);
    await track(a, 1);
    await storeLedgerRows(db, t, [ledgerRow(a, 'reg', 40, 0, 800), ledgerRow(a, 'reg', 60, 0, 1200)], null);
    const run = async (above: number, time: number | null): Promise<Row> => {
      await setMeta({ L: 100, R: 100, reg_time: 9000, reg_offset: 3 });
      await openRecovery(db, { kind: 'truncate', above }, t, time);
      await stepToDone(() => truncateStep(db, above, 400, t));
      await finishRecovery(db, { kind: 'truncate', above }, t);
      return meta();
    };
    expect(await run(50, 4000)).toMatchObject({ reg_time: 4000, reg_offset: 0, R: 50, L: 50 });
    expect(await run(50, null)).toMatchObject({ reg_time: 800, reg_offset: 0 });
    expect(await run(30, null)).toMatchObject({ reg_time: 0, reg_offset: 0, R: 30 });
    // The reader never moves forward: a cut time after its position keeps it.
    await setMeta({ reg_time: 100 });
    await openRecovery(db, { kind: 'truncate', above: 20 }, t, 4000);
    await stepToDone(() => truncateStep(db, 20, 400, t));
    expect(await meta()).toMatchObject({ reg_time: 100, reg_offset: 0 });
  });

  it('creates the reader cursor with R and reg_time in one batch', async () => {
    const t = await lease();
    const tx = joinTx();
    const L = { height: 200, hash: 'h200', safeHeight: 190, safeTime: 3800 };
    expect(await storeLabelTxs(db, t, [{ tx, blockHash: BLOCK }], L, noTime)).toEqual(['stored']);
    expect(await meta()).toMatchObject({ L: 200, L_hash: 'h200', R: 190, reg_time: 3800, reg_offset: 0 });
    const members = joinMembers(tx);
    expect(members.length).toBeGreaterThan(0);
    expect(await count('SELECT COUNT(*) AS n FROM drep_group_tracked WHERE known IS NULL')).toBe(members.length);
    // The cursor exists, a later batch moves L only.
    await storeLabelTxs(db, t, [{ tx: markerTx(205), blockHash: BLOCK }], { height: 210, hash: 'h210', safeHeight: 200, safeTime: 4000 }, noTime);
    expect(await meta()).toMatchObject({ L: 210, L_hash: 'h210', R: 190, reg_time: 3800 });
    // Without a safe block nothing of it is written.
    await storeLabelTxs(db, t, [{ tx: markerTx(206), blockHash: BLOCK }], null, noTime);
    expect(await meta()).toMatchObject({ L: 210, R: 190, reg_time: 3800 });
  });

  it('schedules a repair for a rolled back retirement whose retire job already finished', async () => {
    const t = await lease();
    const a = keyCred(1);
    const unreg = certAt(90);
    await track(a, 1);
    await storeLedgerRows(db, t, [ledgerRow(a, 'reg', 40), ledgerRow(a, 'unreg', 90)], null);
    // The unreg is applied and the retire job finished.
    await exec(`UPDATE drep_group_tracked SET applied_h = 90, applied_ti = 0, applied_ph = 0, applied_ix = 0,
      applied_tx = X'${unreg.txHash}', next_h = NULL, next_ti = NULL, next_ph = NULL, next_ix = NULL, next_tx = NULL, retiring = 1,
      retired_at_h = 90, retired_at_ti = 0, retired_at_ph = 0, retired_at_ix = 0, retired_at_tx = X'${unreg.txHash}'`);
    expect(await pendingRecovery(db)).toBeNull();
    await openRecovery(db, { kind: 'truncate', above: 80 }, t);
    await stepToDone(() => truncateStep(db, 80, 400, t));
    expect(await count("SELECT COUNT(*) AS n FROM drep_group_jobs WHERE kind = 'repair' AND job_key = ? AND cred = ?", credKey(a), credBytes(credKey(a)))).toBe(1);
    const row = (await db.prepare('SELECT * FROM drep_group_tracked').first<Row>()) as Row;
    expect(row).toMatchObject({ retiring: 0, retired_at_h: null, applied_h: 80, applied_ti: MAX, next_h: null });
  });

  it('promotes the second slot when the first finishes', async () => {
    const t = await lease();
    await openRecovery(db, { kind: 'rebuild' }, t);
    await openRecovery(db, { kind: 'truncate', above: 40 }, t, 800);
    expect(await meta()).toMatchObject({ rec_first_kind: 'rebuild', rec_then_above: 40, rec_then_time: 800, rec_phase: 'state' });
    await setMeta({ rec_phase: 'markers' });
    await finishRecovery(db, { kind: 'rebuild' }, t);
    expect(await pendingRecovery(db)).toEqual({ kind: 'truncate', above: 40 });
    expect(await meta()).toMatchObject({ rec_first_time: 800, rec_then_above: null, rec_then_time: null, rec_phase: 'jobs' });
  });

  it('resets started jobs at the start of a truncation', async () => {
    const t = await lease();
    const G1 = ref(10);
    const started = `'{"pass":"instances"}', '{"members":1}', 3`;
    await exec(
      `INSERT INTO drep_group_jobs (kind, job_key, group_tx, group_ix, cursor_json, staging, start_gen) VALUES
        ('recompute', '${refKey(G1)}', X'${G1.txHash}', 0, ${started}), ('power', '${refKey(G1)}', X'${G1.txHash}', 0, ${started})`,
      `INSERT INTO drep_group_jobs (kind, job_key, cred, cursor_json, staging, start_gen) VALUES ('repair', 'key:00', X'0000', ${started})`,
      `INSERT INTO drep_group_jobs (kind, job_key, group_tx, group_ix, trigger_h, trigger_ti, trigger_ph, trigger_ix, trigger_tx)
        VALUES ('dissolve', '${refKey(G1)}', X'${G1.txHash}', 0, ${P(pos(60))}), ('dissolve', 'kept', X'${G1.txHash}', 1, ${P(pos(40))})`,
    );
    await openRecovery(db, { kind: 'truncate', above: 50 }, t);
    for (let i = 0; (await phase()) === 'jobs'; i++) {
      if (i > 20) throw new Error('jobs phase did not end');
      await truncateStep(db, 50, 1, t);
    }
    const jobs = (await db.prepare('SELECT kind, job_key, cursor_json, staging, start_gen FROM drep_group_jobs ORDER BY id').all<Row>()).results;
    expect(jobs).toEqual([
      { kind: 'recompute', job_key: refKey(G1), cursor_json: null, staging: null, start_gen: null },
      { kind: 'power', job_key: refKey(G1), cursor_json: null, staging: null, start_gen: null },
      { kind: 'repair', job_key: 'key:00', cursor_json: null, staging: null, start_gen: null },
      { kind: 'dissolve', job_key: 'kept', cursor_json: null, staging: null, start_gen: null },
    ]);
  });

  it(
    'resumes a truncation after a lost lease',
    async () => {
      const { t } = await settledTwin();
      await t.open({ kind: 'truncate', above: 15 });
      await runEngine(t.d1, ONE, t.lease);
      await runEngine(t.d1, ONE, t.lease);
      await exec('UPDATE drep_group_lease SET expires_at = 0');
      await expect(runEngine(t.d1, ONE, t.lease)).rejects.toBeInstanceOf(LeaseLostError);
      const b = await lease();
      for (let i = 0; (await pendingRecovery(db)) !== null; i++) {
        if (i > 5000) throw new Error('recovery did not finish');
        await runEngine(t.d1, ONE, b);
      }
      await t.runMem(ONE);
      for (let i = 0; i < 2000 && (await runEngine(t.d1, ONE, b)).more; i++);
      await t.expectEqual();
    },
    HEAVY,
  );

  it('pops a recovery only when the finished one still matches', async () => {
    const t = await lease();
    await openRecovery(db, { kind: 'truncate', above: 80 }, t, 1600);
    await setMeta({ rec_phase: 'undo' });
    await openRecovery(db, { kind: 'truncate', above: 60 }, t, 1200);
    expect(await meta()).toMatchObject({ rec_first_kind: 'truncate', rec_first_above: 60, rec_first_time: 1200, rec_phase: 'jobs' });
    await setMeta({ rec_phase: 'undo' });
    await openRecovery(db, { kind: 'truncate', above: 70 }, t, 1400);
    expect(await meta()).toMatchObject({ rec_first_above: 60, rec_first_time: 1200, rec_phase: 'undo' });
    await finishRecovery(db, { kind: 'truncate', above: 80 }, t);
    expect(await pendingRecovery(db)).toEqual({ kind: 'truncate', above: 60 });
    await finishRecovery(db, { kind: 'truncate', above: 60 }, t);
    expect(await pendingRecovery(db)).toBeNull();
    expect(await meta()).toMatchObject({ rec_phase: null, rec_first_time: null });
  });

  it('rebuild keeps raw inputs and meta.L, sets rebuilding and flags markers for refetch', async () => {
    const t = await lease();
    const a = keyCred(1);
    await track(a, 1, { applied_h: 70, applied_ti: 0, applied_ph: 0, applied_ix: 0, applied_tx: "X'0f'" });
    await storeLabelTxs(db, t, [{ tx: markerTx(30), blockHash: BLOCK }, { tx: markerTx(70), blockHash: BLOCK }, { tx: joinTx(), blockHash: BLOCK }], null, noTime);
    await storeLedgerRows(db, t, [ledgerRow(a, 'reg', 75)], null);
    await setMeta({ L: 100, L_hash: 'h100', R: 100 });
    await setG(endOf(100));
    const raw = await storedRows(['drep_group_txs', 'drep_group_ledger']);
    await openRecovery(db, { kind: 'rebuild' }, t);
    await stepToDone(() => resetStep(db, 'rebuild', 400, t));
    expect(await meta()).toMatchObject({ L: 100, L_hash: 'h100', R: 100, rebuilding: 1, rec_phase: 'done' });
    expect(await frontiers(db)).toEqual({ L: 29, R: 100, G: endOf(-1) });
    expect(await storedRows(['drep_group_txs', 'drep_group_ledger'])).toBe(raw);
    expect(await count('SELECT COUNT(*) AS n FROM drep_group_txs WHERE marker = 1 AND refetch = 1')).toBe(2);
    const row = (await db.prepare('SELECT * FROM drep_group_tracked WHERE cred = ?').bind(credBytes(credKey(a))).first<Row>()) as Row;
    expect(row).toMatchObject({ applied_h: null, next_h: 75, next_ph: 0 });
  });

  it('clears rebuilding when a rebuild finishes with G already at END(L)', async () => {
    const t = await lease();
    await openRecovery(db, { kind: 'rebuild' }, t);
    await stepToDone(() => resetStep(db, 'rebuild', 400, t));
    expect(await meta()).toMatchObject({ L: -1, rebuilding: 1 });
    await finishRecovery(db, { kind: 'rebuild' }, t);
    expect(await meta()).toMatchObject({ rec_first_kind: null, rebuilding: 0 });
  });

  it('keeps rebuilding when a rebuild finishes with G behind END(L) or a truncation follows', async () => {
    const t = await lease();
    await setMeta({ L: 100 });
    await openRecovery(db, { kind: 'rebuild' }, t);
    await openRecovery(db, { kind: 'truncate', above: 50 }, t);
    await stepToDone(() => resetStep(db, 'rebuild', 400, t));
    await finishRecovery(db, { kind: 'rebuild' }, t);
    expect(await meta()).toMatchObject({ rec_first_kind: 'truncate', rebuilding: 1 });
    await stepToDone(() => truncateStep(db, 50, 400, t));
    await finishRecovery(db, { kind: 'truncate', above: 50 }, t);
    expect(await meta()).toMatchObject({ L: 50, rec_first_kind: null, rebuilding: 1 });
  });

  it('applies the witness rule and the completeness of a script credential', async () => {
    const t = await lease();
    const s: Credential = { kind: 'script', hash: hex(77) };
    const k = credKey(s);
    await track(s, 1, { known: 0, history_done: 0 });
    const tracked = async (): Promise<Row> => (await db.prepare('SELECT * FROM drep_group_tracked WHERE cred = ?').bind(credBytes(k)).first<Row>()) as Row;
    const state = async (h: number): Promise<unknown> =>
      (await db.prepare('SELECT witness_state FROM drep_group_ledger WHERE block_height = ?').bind(h).first<Row>())?.witness_state;
    const reg = (h: number, w: StoredLedgerRow['witnessState'], witness: Uint8Array | null = null): StoredLedgerRow => ({
      ...ledgerRow(s, 'reg', h),
      witnessState: w,
      witness,
    });
    await storeLedgerRows(db, t, [reg(50, 'pending')], null);
    expect(await tracked()).toMatchObject({ known: 1, history_done: 0, pending_witness: 1, complete: 0 });
    await finishHistoryBatch(db, t, [k], []);
    expect(await tracked()).toMatchObject({ history_done: 1, complete: 0 });
    await recordWitnessChecks(db, t, [{ txHash: txHashOf(50), certIndex: 0, witness: new Uint8Array([1]) }], 0);
    expect(await state(50)).toBe('checked');
    expect(await tracked()).toMatchObject({ pending_witness: 0, complete: 1, found_h: 50, found_ph: 0 });
    await storeLedgerRows(db, t, [reg(60, 'pending')], null);
    expect(await state(60)).toBe('skipped');
    expect(await tracked()).toMatchObject({ pending_witness: 0, complete: 1 });
    await storeLedgerRows(db, t, [reg(40, 'checked', new Uint8Array([2]))], null);
    expect(await tracked()).toMatchObject({ found_h: 40 });
    await storeLedgerRows(db, t, [reg(30, 'pending')], null);
    await recordWitnessChecks(db, t, [{ txHash: txHashOf(30), certIndex: 0, failed: true }], 1000);
    await recordWitnessChecks(db, t, [{ txHash: txHashOf(30), certIndex: 0, failed: true }], 2000);
    expect(await db.prepare('SELECT * FROM drep_group_ledger WHERE block_height = 30').first()).toMatchObject({
      witness_state: 'pending',
      witness_attempts: 2,
      witness_retry_at: 2000 + 2 * WITNESS_BACKOFF_BASE_MS,
    });
    expect(await tracked()).toMatchObject({ pending_witness: 1, complete: 0 });
    // A checked row without a match keeps found where it is.
    await recordWitnessChecks(db, t, [{ txHash: txHashOf(30), certIndex: 0, witness: null }], 3000);
    expect(await tracked()).toMatchObject({ pending_witness: 0, complete: 1, found_h: 40 });
  });

  it('a library version change rebuild sends script registrations without a witness back to the witness search', async () => {
    const t = await lease();
    const s: Credential = { kind: 'script', hash: hex(77) };
    const k = keyCred(5);
    await track(s, 1);
    await track(k, 2);
    const row = (c: Credential, kind: 'reg' | 'unreg', h: number, witness: string, state: string): string =>
      `INSERT INTO drep_group_ledger (tx_hash, cert_index, cred, kind, block_height, block_hash, tx_index, block_time,
         witness, witness_state, witness_attempts, witness_retry_at, ref_search_pos)
       VALUES (X'${txHashOf(h)}', 0, ${C(credKey(c))}, '${kind}', ${h}, X'0b', 0, ${h * 20}, ${witness}, '${state}', 3, 9000, 4)`;
    await exec(
      row(s, 'reg', 40, "X'01'", 'checked'),
      row(s, 'reg', 50, 'NULL', 'checked'),
      row(s, 'reg', 60, 'NULL', 'skipped'),
      row(s, 'unreg', 70, 'NULL', 'na'),
      row(k, 'reg', 80, 'NULL', 'na'),
      row(k, 'reg', 90, 'NULL', 'checked'),
    );
    await setMeta({ lib_version: '0.0.0' });
    expect(await checkLibraryVersion(db, t)).toBe(true);
    const ledger = async (h: number): Promise<Row> =>
      (await db
        .prepare('SELECT witness_state, witness_attempts, witness_retry_at, ref_search_pos FROM drep_group_ledger WHERE block_height = ?')
        .bind(h)
        .first<Row>()) as Row;
    const reset = { witness_state: 'pending', witness_attempts: 0, witness_retry_at: 0, ref_search_pos: 0 };
    const kept = (state: string) => ({ witness_state: state, witness_attempts: 3, witness_retry_at: 9000, ref_search_pos: 4 });
    expect(await ledger(40)).toEqual(kept('checked'));
    expect(await ledger(50)).toEqual(reset);
    expect(await ledger(60)).toEqual(reset);
    expect(await ledger(70)).toEqual(kept('na'));
    expect(await ledger(80)).toEqual(kept('na'));
    expect(await ledger(90)).toEqual(kept('checked'));
    const tracked = async (c: Credential): Promise<Row> =>
      (await db.prepare('SELECT pending_witness, complete FROM drep_group_tracked WHERE cred = ?').bind(credBytes(credKey(c))).first<Row>()) as Row;
    expect(await tracked(s)).toEqual({ pending_witness: 2, complete: 0 });
    expect(await tracked(k)).toEqual({ pending_witness: 0, complete: 1 });
    expect(await meta()).toMatchObject({ rec_first_kind: 'rebuild' });
    // The same version opens nothing and resets nothing again.
    await exec("UPDATE drep_group_ledger SET witness_state = 'checked' WHERE block_height IN (50, 60)");
    expect(await checkLibraryVersion(db, t)).toBe(false);
    expect((await ledger(50)).witness_state).toBe('checked');
  });

  it('records the gate answer once and pages solo histories', async () => {
    const t = await lease();
    const [a, b, c] = [keyCred(1), keyCred(2), keyCred(3)];
    for (const [i, x] of [a, b, c].entries()) await track(x, i + 1, { known: 'NULL', history_done: 0 });
    await setKnown(db, t, [credKey(a)], [credKey(b)]);
    await setKnown(db, t, [credKey(b)], [credKey(a)]);
    const row = async (x: Credential): Promise<Row> =>
      (await db.prepare('SELECT * FROM drep_group_tracked WHERE cred = ?').bind(credBytes(credKey(x))).first<Row>()) as Row;
    expect(await row(a)).toMatchObject({ known: 1, complete: 0 });
    expect(await row(b)).toMatchObject({ known: 0, complete: 1 });
    expect(await row(c)).toMatchObject({ known: null, complete: 0 });
    await markSolo(db, t, [credKey(a)]);
    await storeHistoryPage(db, t, credKey(a), [ledgerRow(a, 'reg', 10)], 50);
    expect(await row(a)).toMatchObject({ solo: 1, history_offset: 50, history_done: 0, next_h: 10 });
    await storeHistoryPage(db, t, credKey(a), [ledgerRow(a, 'unreg', 20)], null);
    expect(await row(a)).toMatchObject({ history_offset: 0, history_done: 1, complete: 1 });
    // The first ledger row of a known = 0 credential asks for its history.
    await storeLedgerRows(db, t, [ledgerRow(b, 'reg', 30)], null);
    expect(await row(b)).toMatchObject({ known: 1, history_done: 0, complete: 0 });
  });

  it('derives next again for the subjects of queue entries a rebuild deletes', async () => {
    const t = await lease();
    const [a, b] = [keyCred(1), keyCred(2)];
    await track(a, 1);
    await track(b, 2);
    await storeLedgerRows(db, t, [ledgerRow(a, 'reg', 30)], null);
    const qcols = 'tx_hash, idx, subject, at_h, at_ti, at_ph, at_ix, at_tx, group_tx, group_ix, event_json';
    const entry = (c: Credential, h: number, ix: number): string =>
      `INSERT INTO drep_group_queue (${qcols}) VALUES (X'${txHashOf(h)}', ${ix}, ${C(credKey(c))}, ${P(pos(h, 0, 2, ix))}, NULL, NULL, '{}')`;
    await exec(entry(a, 20, 0), entry(a, 25, 1), entry(b, 20, 2), entry(b, 26, 3));
    await exec(`UPDATE drep_group_tracked SET next_h = 20, next_ti = 0, next_ph = 2, next_ix = 0, next_tx = X'${txHashOf(20)}'`);
    await openRecovery(db, { kind: 'rebuild' }, t);
    let max = 0;
    for (;;) {
      const c = await changesPerCall(db, (d) => resetStep(d, 'rebuild', 1, t));
      max = Math.max(max, c.changes);
      if (c.result === 'done') break;
    }
    expect(max).toBeLessThanOrEqual(1 + RECOVERY_STEP_OVERHEAD);
    expect(await count('SELECT COUNT(*) AS n FROM drep_group_queue')).toBe(0);
    const row = async (c: Credential): Promise<Row> =>
      (await db.prepare('SELECT * FROM drep_group_tracked WHERE cred = ?').bind(credBytes(credKey(c))).first<Row>()) as Row;
    expect(await row(a)).toMatchObject({ applied_h: null, next_h: 30, next_ph: 0, next_ix: 0, next_tx: Array.from(hashBytes(txHashOf(30))) });
    expect(await row(b)).toMatchObject({ applied_h: null, next_h: null, next_tx: null });
    expect(Number((await row(b)).gen)).toBeGreaterThan(0);
  });

  it('a re-delivered flagged marker clears its flag and lifts the reported L', async () => {
    const t = await lease();
    await storeLabelTxs(db, t, [{ tx: markerTx(80), blockHash: BLOCK }], null, noTime);
    await setMeta({ L: 100 });
    await exec('UPDATE drep_group_txs SET refetch = 1');
    expect((await frontiers(db)).L).toBe(79);
    expect(await storeLabelTxs(db, t, [{ tx: markerTx(80), blockHash: BLOCK }], null, noTime)).toEqual(['duplicate']);
    expect((await frontiers(db)).L).toBe(100);
    // A flagged marker that now decodes gets its payload, its joins tracked and its classification.
    const tx = joinTx();
    await storeLabelTxs(db, t, [{ tx: { ...tx, isValid: false }, blockHash: BLOCK }], null, noTime);
    await exec(`UPDATE drep_group_txs SET refetch = 1 WHERE tx_hash = X'${tx.txHash}'`);
    await setG(endOf(100));
    expect(await storeLabelTxs(db, t, [{ tx, blockHash: BLOCK }], null, noTime)).toEqual(['duplicate']);
    expect(await db.prepare('SELECT marker, refetch, bytes FROM drep_group_txs WHERE tx_hash = ?').bind(hashBytes(tx.txHash)).first()).toEqual({
      marker: 0,
      refetch: 0,
      bytes: tx.payload?.length,
    });
    expect(await count('SELECT COUNT(*) AS n FROM drep_group_tracked')).toBe(joinMembers(tx).length);
    expect(await pendingRecovery(db)).toEqual({ kind: 'truncate', above: tx.blockHeight - 1 });
    expect(isMarkerTx(tx)).toBe(false);
  });
});

async function groupRow(g: EventRef): Promise<Row> {
  return (await db.prepare('SELECT * FROM drep_groups WHERE group_tx = ? AND group_ix = ?').bind(hashBytes(g.txHash), g.index).first<Row>()) as Row;
}

/** A generated label tx with at least one join event. */
function joinTx(): ChainTx {
  for (const x of generateChain(1, { txs: 20, credentials: 4, groups: 3 })) {
    if (x.kind === 'tx' && !isMarkerTx(x.tx) && joinMembers(x.tx).length > 0) return x.tx;
  }
  throw new Error('no join tx in the chain');
}

function joinMembers(tx: ChainTx): string[] {
  const out = new Set<string>();
  for (const e of decodePayload(tx.payload ?? new Uint8Array(0))?.events ?? []) {
    if (e.ok && e.event.tag === 'join') out.add(credKey(e.event.member));
  }
  return [...out];
}

/** Runs both stores until neither has an open recovery. */
async function recover(t: Twin): Promise<void> {
  for (let i = 0; (await t.mem.pendingRecovery()) !== null; i++) {
    if (i > 5000) throw new Error('reference recovery did not finish');
    await runEngine(t.mem, ONE, t.memLease);
  }
  for (let i = 0; (await pendingRecovery(db)) !== null; i++) {
    if (i > 5000) throw new Error('recovery did not finish');
    await runEngine(t.d1, ONE, t.lease);
  }
}

/** Clears the stored state and the lease between cases of one test. */
async function finishTest(): Promise<void> {
  await exec(
    ...STORED_TABLES.map((x) => `DELETE FROM ${x}`),
    'DELETE FROM drep_group_lease',
    `UPDATE drep_group_meta SET L = -1, L_hash = NULL, R = NULL, G_h = -1, G_ti = ${MAX}, G_ph = 2, G_ix = ${MAX}, G_tx = X'',
      rec_first_kind = NULL, rec_first_above = NULL, rec_first_time = NULL, rec_then_above = NULL, rec_then_time = NULL,
      rec_phase = NULL, rebuilding = 0, reg_time = NULL, reg_offset = 0 WHERE id = 1`,
  );
}
