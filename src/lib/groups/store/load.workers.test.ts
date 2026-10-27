/// <reference types="@cloudflare/workers-types" />
// The engine store's cost does not grow with what is stored. Each history shape is stored at 0,
// 1,000 and 10,000 rows, the same 20 new inputs go on top, and the engine runs them in with the
// production budget through the production query meter, with the D1 rows_read of every
// statement summed. A truncation of the new inputs and the first rebuild call are measured the
// same way.
//
// Storage of spam, measured on the local D1: 1,000 valid compact creates with a founder join,
// and 1,000 creates batched 64 per tx with one registered founder and one shared control script.
// With hashes and keys as hex text and the derivable ids stored, a compact create cost 6,267
// bytes and a batched one 4,465. With hashes and keys as bytes and without the stored group id
// and the DRep ids of ledger and tracked rows, a compact create costs 3,744 bytes and a batched
// one 2,781. Stored values of a compact create, indexes and page overhead not included, in bytes:
// queue 279 (event_json 144), verdicts 250 (2 rows), txs 245 (payload 112), instances 200,
// scripts 183, groups 159, versions 149, ledger 110, jobs 107 (the power job), tx_context 93,
// tracked 78, trim_due 37, 1,888 in all. The bounds are the measured values rounded up to 250.
import { env } from 'cloudflare:test';
import type { Budget } from 'drep-groups';
import { endOf, runEngine } from 'drep-groups';
import { describe, expect, it } from 'vitest';
import {
  baseInputs,
  batchedCreates,
  compactCreates,
  deliver,
  HISTORY_FROM,
  HOSTILE,
  historyApplied,
  hostileTxs,
  type Input,
  meteredDb,
  SHAPES,
  settle,
  WORST_MEMBERS,
  worstCaseBase,
} from '../__tests__/loadFixtures.js';
import { ENGINE_BUDGET, RUN_MAX_QUERIES } from '../constants.js';
import { D1Store } from './d1Store.js';
import { acquireLease, invocationOwner } from './lease.js';
import { frontiers, pendingRecovery } from './reads.js';
import { openRecovery } from './recovery.js';

const SIZES = [0, 1_000, 10_000] as const;
const BIG: Budget = { ...ENGINE_BUDGET, controlTxs: 1000, controlBytes: 10_000_000, credentialUnits: 1000, credentialInputs: 10_000 };

interface Cost {
  queries: number;
  rows: number;
}
interface Measured {
  runs: Cost[];
  total: Cost;
  work: { verdicts: number; valid: number };
  truncate: Cost;
  rebuildCall: Cost;
  /** The production ingest of the 20 new inputs, storeLedgerRows and storeLabelTxs. */
  ingest: Cost;
  /** The most queries of one truncation call. */
  truncateCallMax: number;
}

const heightOf = (x: Input): number => ('tx' in x ? x.tx.blockHeight : x.ledger.blockHeight);
const sum = (xs: Cost[]): Cost => xs.reduce((a, b) => ({ queries: a.queries + b.queries, rows: a.rows + b.rows }), { queries: 0, rows: 0 });

/** One metered runEngine call. */
async function meteredRun(lease: string): Promise<{ cost: Cost; more: boolean }> {
  const m = meteredDb(env.DB);
  const r = await runEngine(new D1Store(m.db), ENGINE_BUDGET, lease);
  return { cost: { queries: m.queries(), rows: m.rowsRead() }, more: r.more };
}

async function measure(shape: (typeof SHAPES)[number], n: number): Promise<Measured> {
  const lease = (await acquireLease(env.DB, invocationOwner())) as string;
  const b = baseInputs();
  await deliver(env.DB, lease, b.inputs, b.top);
  await settle(env.DB, lease, BIG);

  const history = shape.history(env.DB, n, HISTORY_FROM, b.base);
  await env.DB.batch([...history.stmts, historyApplied(env.DB, history.top)]);
  // Every shape stores at least n label txs, ledger rows or versions above the base.
  const stored = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM drep_group_txs WHERE block_height >= ?1) + (SELECT COUNT(*) FROM drep_group_ledger
       WHERE block_height >= ?1) + (SELECT COUNT(*) FROM drep_group_versions WHERE at_h >= ?1) AS n`,
  )
    .bind(HISTORY_FROM)
    .first<{ n: number }>();
  expect(stored?.n).toBeGreaterThanOrEqual(n);

  const fresh = shape.fresh(history.top, b.base, n);
  const top = Math.max(...fresh.inputs.map(heightOf));
  const ingestMeter = meteredDb(env.DB);
  await deliver(env.DB, lease, fresh.inputs, top, ingestMeter.db);
  const ingest = { queries: ingestMeter.queries(), rows: ingestMeter.rowsRead() };

  const runs: Cost[] = [];
  for (let more = true; more; ) {
    if (runs.length >= 100) throw new Error('runEngine did not settle');
    const r = await meteredRun(lease);
    runs.push(r.cost);
    more = r.more;
  }
  // The runs did the work: every new input applied, G at the end.
  expect((await frontiers(env.DB)).G).toEqual(endOf(top));
  const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM drep_group_tracked WHERE complete = 1 AND next_h IS NOT NULL').first<{ n: number }>();
  expect(left?.n).toBe(0);
  const work = (await env.DB
    .prepare('SELECT COUNT(*) AS verdicts, COALESCE(SUM(valid), 0) AS valid FROM drep_group_verdicts WHERE at_h > ?')
    .bind(history.top)
    .first<{ verdicts: number; valid: number }>()) as { verdicts: number; valid: number };
  expect(work.verdicts).toBe(fresh.verdicts);

  // A truncation of the new inputs, run to its end.
  await openRecovery(env.DB, { kind: 'truncate', above: history.top }, lease);
  const truncation: Cost[] = [];
  while ((await pendingRecovery(env.DB)) !== null) {
    if (truncation.length >= 100) throw new Error('the truncation did not finish');
    truncation.push((await meteredRun(lease)).cost);
  }
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM drep_group_verdicts WHERE at_h > ?').bind(history.top).first()).toEqual({ n: 0 });

  // The first call of a rebuild over everything stored.
  await openRecovery(env.DB, { kind: 'rebuild' }, lease);
  const rebuildCall = (await meteredRun(lease)).cost;

  return {
    runs,
    total: sum(runs),
    work,
    truncate: sum(truncation),
    rebuildCall,
    ingest,
    truncateCallMax: Math.max(...truncation.map((c) => c.queries)),
  };
}

const results = new Map<string, Map<number, Measured>>();

describe('the engine store cost does not grow with stored history', () => {
  for (const shape of SHAPES) {
    for (const n of SIZES) {
      it(`${shape.name}: ${n} rows`, { timeout: 120_000 }, async () => {
        const r = await measure(shape, n);
        const per = results.get(shape.name) ?? new Map<number, Measured>();
        per.set(n, r);
        results.set(shape.name, per);
      });
    }

    it(`${shape.name}: queries equal and rows read flat across 0, 1,000 and 10,000 rows`, () => {
      const per = results.get(shape.name);
      if (!per || per.size !== SIZES.length) throw new Error('a measurement is missing');
      const [r0, r1k, r10k] = SIZES.map((n) => per.get(n) as Measured);
      // Same work at every size.
      expect(r10k.work).toEqual(r0.work);
      expect(r1k.work).toEqual(r0.work);
      // Query count independent of history, run by run.
      expect(r10k.runs.map((x) => x.queries)).toEqual(r0.runs.map((x) => x.queries));
      expect(r1k.runs.map((x) => x.queries)).toEqual(r0.runs.map((x) => x.queries));
      expect(r10k.truncate.queries).toBe(r0.truncate.queries);
      // Rows read do not grow with history, the first call and all runs together.
      expect(r10k.runs[0].rows).toBeLessThanOrEqual(r0.runs[0].rows * 2 + 50);
      expect(r10k.total.rows).toBeLessThanOrEqual(r0.total.rows * 2 + 50);
      expect(r10k.truncate.rows).toBeLessThanOrEqual(r0.truncate.rows * 2 + 50);
      // A rebuild call works one page whatever is stored beyond it.
      expect(r10k.rebuildCall.queries).toBe(r1k.rebuildCall.queries);
      expect(r10k.rebuildCall.rows).toBeLessThanOrEqual(r1k.rebuildCall.rows * 2 + 50);
      // The ingest of the same new inputs costs the same whatever is stored.
      expect(r10k.ingest.queries).toBe(r0.ingest.queries);
      expect(r1k.ingest.queries).toBe(r0.ingest.queries);
      expect(r10k.ingest.rows).toBeLessThanOrEqual(r0.ingest.rows * 2 + 50);
      // Every recovery call is one engine run and fits its query limit.
      for (const r of [r0, r1k, r10k]) {
        expect(r.truncateCallMax).toBeLessThanOrEqual(RUN_MAX_QUERIES);
        expect(r.rebuildCall.queries).toBeLessThanOrEqual(RUN_MAX_QUERIES);
      }
    });
  }

  it('sees the rows a scan reads', async () => {
    const shape = SHAPES.find((s) => s.name === 'many verdicts in one group') as (typeof SHAPES)[number];
    const b = baseInputs();
    await env.DB.batch(shape.history(env.DB, 1_000, HISTORY_FROM, b.base).stmts);
    const m = meteredDb(env.DB);
    await m.db.prepare('SELECT COUNT(*) AS n FROM drep_group_verdicts WHERE reason = ?').bind('stale seq').first();
    expect(m.queries()).toBe(1);
    expect(m.rowsRead()).toBeGreaterThanOrEqual(1_000);
  });

  it('reports the measured numbers', () => {
    const lines: string[] = [];
    for (const [name, per] of results) {
      for (const [n, r] of per) {
        lines.push(
          `${name} | ${n} | runs ${r.runs.length} | first ${r.runs[0].queries}q ${r.runs[0].rows}r | all ${r.total.queries}q ${r.total.rows}r | truncate ${r.truncate.queries}q ${r.truncate.rows}r | rebuild call ${r.rebuildCall.queries}q ${r.rebuildCall.rows}r | truncate call max ${r.truncateCallMax}q | ingest ${r.ingest.queries}q ${r.ingest.rows}r`,
        );
      }
    }
    console.log(lines.join('\n'));
    expect(lines.length).toBe(SHAPES.length * SIZES.length);
  });
});

const membersDone = (done: 0 | 1): D1PreparedStatement =>
  env.DB.prepare(`UPDATE drep_group_tracked SET history_done = ? WHERE cred IN (SELECT unhex('00' || value) FROM json_each(?))`).bind(
    done,
    JSON.stringify(WORST_MEMBERS),
  );

// The worst measured normal run is 284 queries of 400 (64 anchored updates with control changes per tx).
describe('the worst case of one engine run', () => {
  const worst = new Map<string, { queries: number; units: number; verdicts: { n: number; valid: number } }>();
  for (const variant of Object.keys(HOSTILE)) {
    it(`${variant}: fits RUN_MAX_QUERIES`, { timeout: 60_000 }, async () => {
      const lease = (await acquireLease(env.DB, invocationOwner())) as string;
      const b = worstCaseBase();
      await deliver(env.DB, lease, b.inputs, b.top);
      // The members wait for their history while the group plane passes their joins.
      await membersDone(0).run();
      await settle(env.DB, lease, BIG);
      const h = hostileTxs(variant);
      await deliver(env.DB, lease, h.inputs, h.top);
      await membersDone(1).run();
      const m = meteredDb(env.DB);
      const r = await runEngine(new D1Store(m.db), ENGINE_BUDGET, lease);
      // Both planes at their full budget.
      expect(r.controlTxs).toBe(ENGINE_BUDGET.controlTxs);
      expect(r.inputs).toBe(ENGINE_BUDGET.credentialInputs);
      const v = await env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(valid), 0) AS valid FROM drep_group_verdicts WHERE at_h >= 40').first();
      worst.set(variant, { queries: m.queries(), units: r.units, verdicts: v as { n: number; valid: number } });
      expect(m.queries()).toBeLessThanOrEqual(RUN_MAX_QUERIES);
    });
  }

  it('reports the measured worst cases', () => {
    console.log([...worst.entries()].map(([k, v]) => `${k}: ${v.queries} of ${RUN_MAX_QUERIES}, units ${v.units}, verdicts ${v.verdicts.n} (${v.verdicts.valid} valid)`).join('\n'));
    expect(worst.size).toBe(Object.keys(HOSTILE).length);
  });
});

const COMPACT_BOUND = 3_750;
const BATCHED_BOUND = 3_000;

const sizeAfter = async (): Promise<number> => (await env.DB.prepare('SELECT 1').all()).meta.size_after as number;

/** Database growth per create of the inputs, run in through the engine. */
async function bytesPerCreate(c: { inputs: Input[]; top: number }, creates: number): Promise<number> {
  // Earlier tests freed pages that new rows would reuse without growing the file, so a filler
  // takes every free page first and the measurement starts at a file that only grows.
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS load_filler (b BLOB)').run();
  for (let size = await sizeAfter(); ; ) {
    const r = await env.DB.prepare('INSERT INTO load_filler (b) VALUES (zeroblob(262144))').run();
    if ((r.meta.size_after as number) > size) break;
    size = r.meta.size_after as number;
  }
  const before = await sizeAfter();
  const lease = (await acquireLease(env.DB, invocationOwner())) as string;
  await deliver(env.DB, lease, c.inputs, c.top);
  await settle(env.DB, lease, BIG);
  const after = await sizeAfter();
  await env.DB.prepare('DROP TABLE load_filler').run();
  const counts = await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM drep_groups) AS groups, (SELECT COUNT(*) FROM drep_group_instances WHERE counted_as = 'open') AS members",
  ).first();
  expect(counts).toEqual({ groups: creates, members: creates });
  expect(await nonBlobValues()).toEqual([]);
  return (after - before) / creates;
}

/** Every BLOB column of the groups tables holding a value that is not a BLOB, a write that skipped the codec. */
async function nonBlobValues(): Promise<string[]> {
  const tables = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'drep_group%'").all<{ name: string }>())
    .results;
  const out: string[] = [];
  for (const { name } of tables) {
    const cols = (await env.DB.prepare('SELECT name, type FROM pragma_table_info(?)').bind(name).all<{ name: string; type: string }>()).results;
    for (const c of cols.filter((x) => x.type === 'BLOB')) {
      const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${name} WHERE typeof(${c.name}) NOT IN ('blob', 'null')`).first<{ n: number }>();
      if (r?.n) out.push(`${name}.${c.name}`);
    }
  }
  return out;
}

describe('storage cost of spam', () => {
  it(`stores a valid compact create with its founder join in under ${COMPACT_BOUND} bytes`, { timeout: 120_000 }, async () => {
    const perCreate = await bytesPerCreate(compactCreates(1_000, HISTORY_FROM), 1_000);
    console.log(`storage, one founder per create: ${perCreate} bytes per create`);
    expect(perCreate).toBeLessThan(COMPACT_BOUND);
  });

  it(`stores creates batched 64 per tx with one founder in under ${BATCHED_BOUND} bytes each`, { timeout: 120_000 }, async () => {
    const perCreate = await bytesPerCreate(batchedCreates(1_000, HISTORY_FROM), 1_000);
    console.log(`storage, batched: ${perCreate} bytes per create`);
    expect(perCreate).toBeLessThan(BATCHED_BOUND);
  });
});
