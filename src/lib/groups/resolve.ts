/// <reference types="@cloudflare/workers-types" />
// Resolution of DRepTalk's own group transactions after the engine runs of a tick. A tracked tx the engine has
// fully processed is resolved by its outcomes (applied, partial or failed), a tx that can no longer be on chain is
// marked never included, which frees its control slot. Outcomes always win over never included.
import type { EventRef } from 'drep-groups';
import { D1_MAX_BINDS } from '../db/sql.js';
import type { GovSyncKoios } from '../sync/phases/context.js';
import { hashBytes, type Row } from './codec.js';
import { DEPTH, RESOLVE_KOIOS_PER_TICK, RESOLVE_ROWS_PER_TICK } from './constants.js';
import { writeBatch } from './store/lease.js';
import { OWN, OWN_WIDTH, Q } from './store/queries.js';
import { keyedStatements } from './store/recovery.js';

/** The reason an event without a stored outcome is read with. No row is written for it. */
export const NO_VERDICT_REASON = 'no verdict recorded';

export type ResolveKoios = Pick<GovSyncKoios, 'tip' | 'firstBlockAfterSlot' | 'txStatus' | 'utxoInfo'>;

export interface ObservedResult {
  ref: EventRef;
  valid: boolean;
  reason: string | null;
}

/** Statements a keyed OWN statement needs for `n` rows. */
export const statementsFor = (name: keyof typeof OWN, n: number): number => Math.ceil(n / Math.floor(D1_MAX_BINDS / OWN_WIDTH[name]));

/** Worst case D1 queries of one resolver pass: both candidate pages, the progress read and the write batch. */
export const RESOLVE_MAX_QUERIES =
  2 + statementsFor('txProgress', 2 * RESOLVE_ROWS_PER_TICK) + 2 + statementsFor('resolveRows', 2 * RESOLVE_ROWS_PER_TICK);

export interface TxProgress {
  /** Height of the stored tx, null when the ingest has not stored it. */
  height: number | null;
  processed: boolean;
  /** Stored outcomes with a valid verdict. */
  valid: number;
}

/** Progress of each tx, by its lowercase hex hash. */
export async function txProgress(db: D1Database, hashes: string[]): Promise<Map<string, TxProgress>> {
  const stmts = keyedStatements(db, OWN.txProgress, OWN_WIDTH.txProgress, [...new Set(hashes)], (h) => [hashBytes(h), h]);
  const out = new Map<string, TxProgress>();
  if (stmts.length === 0) return out;
  for (const res of await db.batch<Row>(stmts)) {
    for (const r of res.results ?? []) {
      out.set(String(r.hx), {
        height: r.h === null ? null : Number(r.h),
        processed: Number(r.processed) === 1,
        valid: Number(r.valid),
      });
    }
  }
  return out;
}

/**
 * True when the engine has processed every event of the tx: the group cursor is past it and each credential plane
 * event is at or below its subject's applied cursor.
 */
export async function txProcessed(db: D1Database, txHash: string): Promise<boolean> {
  return (await txProgress(db, [txHash])).get(txHash)?.processed ?? false;
}

/** Queries trackedResults issues for the results. */
export const trackedResultsCost = (results: ObservedResult[]): number =>
  statementsFor('trackedTxs', new Set(results.map((r) => r.ref.txHash)).size);

/** The results whose tx a signing row tracks. */
export async function trackedResults(db: D1Database, results: ObservedResult[]): Promise<ObservedResult[]> {
  const hashes = [...new Set(results.map((r) => r.ref.txHash))];
  const stmts = keyedStatements(db, OWN.trackedTxs, OWN_WIDTH.trackedTxs, hashes, (h) => [h]);
  if (stmts.length === 0) return [];
  const tracked = new Set((await db.batch<Row>(stmts)).flatMap((res) => (res.results ?? []).map((r) => String(r.hx))));
  return results.filter((r) => tracked.has(r.ref.txHash));
}

/** Queries writeGrouplessOutcomes issues for `n` results. */
export const grouplessCost = (n: number): number => (n === 0 ? 0 : 2 + statementsFor('insertGrouplessOutcomes', n));

/**
 * Outcomes of tracked refs the commit did not write (verdicts without a group), at the height of the stored tx.
 * An outcome already stored stays.
 */
export async function writeGrouplessOutcomes(db: D1Database, lease: string, results: ObservedResult[], now: number): Promise<void> {
  if (results.length === 0) return;
  await writeBatch(
    db,
    lease,
    keyedStatements(db, OWN.insertGrouplessOutcomes, OWN_WIDTH.insertGrouplessOutcomes, results, (r) => [
      r.ref.txHash,
      hashBytes(r.ref.txHash),
      r.ref.index,
      r.valid ? 1 : 0,
      r.reason,
      now,
    ]),
  );
}

interface Candidate {
  id: string;
  body: string;
  status: string;
  events: number | null;
  invalidHereafter: number | null;
  feeInputs: Array<{ txHash: string; index: number }>;
  spentSeen: number | null;
  neverIncluded: boolean;
}

/** The resolution columns written for one row. */
interface Write {
  id: string;
  resolution: string | null;
  resolvedAt: number | null;
  resolvedH: number | null;
  neverIncludedAt: number | null;
  spentSeen: number | null;
}

const HEX_HASH = /^[0-9a-f]{64}$/;

function feeInputsOf(raw: unknown): Candidate['feeInputs'] {
  if (typeof raw !== 'string') return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.flatMap((x: { txHash?: unknown; index?: unknown }) =>
      typeof x?.txHash === 'string' && HEX_HASH.test(x.txHash) && Number.isInteger(x.index) ? [{ txHash: x.txHash, index: Number(x.index) }] : [],
    );
  } catch {
    return [];
  }
}

function candidateOf(r: Row): Candidate | null {
  const body = String(r.body_hash);
  if (!HEX_HASH.test(body)) {
    console.error(`[drep-groups] signing row ${String(r.id)} has a malformed body hash`);
    return null;
  }
  return {
    id: String(r.id),
    body,
    status: String(r.status),
    events: r.event_count === null ? null : Number(r.event_count),
    invalidHereafter: r.invalid_hereafter === null ? null : Number(r.invalid_hereafter),
    feeInputs: feeInputsOf(r.fee_inputs),
    spentSeen: r.spent_seen_h === null ? null : Number(r.spent_seen_h),
    neverIncluded: r.never_included_at !== null,
  };
}

/** Every event valid is applied, none failed, any other mix partial. A missing outcome counts as not applied. */
function resolutionOf(valid: number, events: number): 'applied' | 'partial' | 'failed' {
  if (valid === 0) return 'failed';
  return valid >= events ? 'applied' : 'partial';
}

const keep = (c: Candidate, over: Partial<Write>): Write => ({
  id: c.id,
  resolution: null,
  resolvedAt: null,
  resolvedH: null,
  neverIncludedAt: null,
  spentSeen: c.spentSeen,
  ...over,
});

/** A collecting or cancelled row was never submitted by DRepTalk, a spent fee input means someone else spent it. */
const spendable = (c: Candidate): boolean => (c.status === 'collecting' || c.status === 'cancelled') && c.feeInputs.length > 0;

/**
 * Never included probes for open rows whose tx is not stored, the oldest expiry first: past expiry with DEPTH
 * blocks after the first block past it, or DEPTH blocks after a fee input was first seen spent, each only while
 * Koios does not know the tx. A Koios failure leaves every row as it is.
 */
async function probe(koios: ResolveKoios, rows: Candidate[], now: number): Promise<Write[]> {
  const maybe = rows.filter((c) => c.invalidHereafter !== null || spendable(c));
  if (maybe.length === 0) return [];
  try {
    const tip = await koios.tip();
    const past = (c: Candidate): boolean => c.invalidHereafter !== null && tip.abs_slot > c.invalidHereafter;
    const picked = maybe.filter((c) => past(c) || spendable(c)).slice(0, RESOLVE_KOIOS_PER_TICK);
    if (picked.length === 0) return [];
    const spendRows = picked.filter(spendable);
    const slots = [...new Set(picked.filter(past).map((c) => c.invalidHereafter as number))];
    const [utxos, firsts] = await Promise.all([
      spendRows.length > 0 ? koios.utxoInfo(spendRows.flatMap((c) => c.feeInputs)) : Promise.resolve([]),
      Promise.all(slots.map(async (s) => [s, await koios.firstBlockAfterSlot(s)] as const)),
    ]);
    const spentByRef = new Map(utxos.map((u) => [`${u.txHash}#${u.index}`, u.isSpent]));
    const firstAfter = new Map(firsts);
    const states = picked.map((c) => {
      const answers = spendable(c) ? c.feeInputs.flatMap((f) => spentByRef.get(`${f.txHash}#${f.index}`) ?? []) : [];
      const spent = answers.includes(true);
      const first = past(c) ? (firstAfter.get(c.invalidHereafter as number) ?? null) : null;
      const expiredDeep = first !== null && tip.block_no >= first.height + DEPTH;
      const spentDeep = spent && c.spentSeen !== null && tip.block_no >= c.spentSeen + DEPTH;
      return { c, spent, unspent: !spent && answers.length > 0, ask: expiredDeep || spentDeep };
    });
    const asked = states.filter((s) => s.ask).map((s) => s.c.body);
    const status = asked.length > 0 ? await koios.txStatus(asked) : new Map<string, number | null>();
    const writes: Write[] = [];
    for (const { c, spent, unspent, ask } of states) {
      if (ask && status.has(c.body) && status.get(c.body) === null) {
        writes.push(keep(c, { resolution: 'never_included', resolvedAt: now, neverIncludedAt: now }));
      } else if (spent && c.spentSeen === null) {
        writes.push(keep(c, { spentSeen: tip.block_no }));
      } else if (unspent && c.spentSeen !== null) {
        writes.push(keep(c, { spentSeen: null }));
      }
    }
    return writes;
  } catch (err) {
    console.warn('[drep-groups] the never included probe failed, rows stay open', err);
    return [];
  }
}

/**
 * Resolves up to RESOLVE_ROWS_PER_TICK open group rows and rechecks as many rows marked never included. A
 * processed tx takes its outcomes, its height and clears never included. Rows whose tx is not stored go through
 * the never included probe. A stored but unprocessed tx stays open.
 */
export async function resolveGroupActions(deps: {
  db: D1Database;
  lease: string;
  koios: ResolveKoios;
  now: number;
}): Promise<{ resolved: number; neverIncluded: number }> {
  const { db, lease, koios, now } = deps;
  const pages = await db.batch<Row>([
    db.prepare(Q.resolveOpen.sql).bind(RESOLVE_ROWS_PER_TICK),
    db.prepare(Q.resolveNeverIncluded.sql).bind(RESOLVE_ROWS_PER_TICK),
  ]);
  const rows = pages.flatMap((p) => (p.results ?? []).flatMap((r) => candidateOf(r) ?? []));
  if (rows.length === 0) return { resolved: 0, neverIncluded: 0 };
  const progress = await txProgress(db, rows.map((c) => c.body));

  const writes: Write[] = [];
  const unstored: Candidate[] = [];
  for (const c of rows) {
    const p = progress.get(c.body);
    if (p?.processed && p.height !== null) {
      if (c.events === null) {
        console.error(`[drep-groups] signing row ${c.id} has no event count, left open`);
        continue;
      }
      writes.push(keep(c, { resolution: resolutionOf(p.valid, c.events), resolvedAt: now, resolvedH: p.height }));
    } else if (!c.neverIncluded && (p?.height ?? null) === null) {
      unstored.push(c);
    }
  }
  const resolved = writes.length;
  const probed = await probe(koios, unstored, now);
  writes.push(...probed);
  if (writes.length > 0) {
    await writeBatch(
      db,
      lease,
      keyedStatements(db, OWN.resolveRows, OWN_WIDTH.resolveRows, writes, (w) => [
        w.id,
        w.resolution,
        w.resolvedAt,
        w.resolvedH,
        w.neverIncludedAt,
        w.spentSeen,
      ]),
    );
  }
  return { resolved, neverIncluded: probed.filter((w) => w.resolution === 'never_included').length };
}
