/// <reference types="@cloudflare/workers-types" />
// Stores chain inputs of the DRep groups store. Every function is one lease checked batch per
// call, the caller pages. A new input is classified against the applied progress and a late one
// opens its recovery in the same batch, a row already stored under its key is no input.
import type { ChainTx, Credential, DecodedPayload, LedgerInput, Pos } from 'drep-groups';
import { classifyNewInput, comparePos, credKey, decodePayload, posOfCert } from 'drep-groups';
import { chunked, D1_MAX_BINDS } from '../../db/sql.js';
import { afterTx, credBytes, credKeyFromCol, hashBytes, hashFromCol, hashListBytes, posBinds, posFromRow, posOrNull, type Row } from '../codec.js';
import { writeBatch } from './lease.js';
import { COMMIT, COMMIT_WIDTH, INGEST, INGEST_WIDTH, Q } from './queries.js';
import { keyedStatements, mergeSlots, readMeta, type Slots, slotsFromMeta, slotStatements } from './recovery.js';

export interface StoredLedgerRow {
  input: LedgerInput;
  blockHash: string;
  blockTime: number;
  witnessState: 'na' | 'pending' | 'checked';
  witness: Uint8Array | null;
}

/**
 * The library's marker rule: txs it ignores (invalid, label repeated, no payload) and txs without
 * a readable event or script. Mirrors the rule of its reference store, which is not exported.
 */
export function isMarkerTx(tx: ChainTx): boolean {
  return storedPayload(tx) === null;
}

/** The decoded payload of a label tx stored with its payload, null for a marker. Decodes once. */
function storedPayload(tx: ChainTx): DecodedPayload | null {
  if (!tx.isValid || tx.payloadRepeated || tx.payload === undefined) return null;
  const d = decodePayload(tx.payload);
  return d === null || (d.scripts.length === 0 && !d.events.some((e) => e.ok)) ? null : d;
}

/** The profile anchor hashes of a stored payload: one per readable create or update that sets a profile. */
function payloadAnchors(d: DecodedPayload): string[] {
  const out = new Set<string>();
  for (const e of d.events) {
    if (!e.ok) continue;
    const profile = e.event.tag === 'create' ? e.event.profile : e.event.tag === 'update' ? e.event.changes.profile : undefined;
    if (profile) out.add(profile.dataHash);
  }
  return [...out];
}

/** The profile anchor hashes a stored label tx references. A marker references none. */
export function anchorHashes(tx: ChainTx): string[] {
  const d = storedPayload(tx);
  return d === null ? [] : payloadAnchors(d);
}

/** Runs keyed reads in one batch and returns all rows. */
async function readKeyed<T>(db: D1Database, name: keyof typeof INGEST, items: T[], binds: (x: T) => unknown[]): Promise<Row[]> {
  const stmts = chunked(items, Math.floor(D1_MAX_BINDS / INGEST_WIDTH[name])).map((c) =>
    db.prepare(INGEST[name](c.length)).bind(...c.flatMap(binds)),
  );
  if (stmts.length === 0) return [];
  return (await db.batch<Row>(stmts)).flatMap((r) => r.results ?? []);
}

const stmts = <T>(db: D1Database, name: keyof typeof INGEST, items: T[], binds: (x: T) => readonly unknown[], trailing: unknown[] = []) =>
  keyedStatements(db, INGEST[name], INGEST_WIDTH[name], items, binds, trailing);

/** A row stored while a recovery is open restarts its phases: any row under a fork, a row above a truncation's cut. */
function restarts(s: Slots, heights: number[]): boolean {
  if (s.first?.kind === 'fork') return heights.length > 0;
  const first = s.first;
  return first?.kind === 'truncate' && heights.some((h) => h > first.above);
}

function txRow(tx: ChainTx, blockHash: string, blockTime: number | null, marker: boolean): unknown[] {
  const [hash, block] = [hashBytes(tx.txHash), hashBytes(blockHash)];
  if (marker) return [hash, tx.blockHeight, block, tx.txIndex, 1, null, null, null, null, null, null, null, 0, blockTime];
  const payload = tx.payload as Uint8Array;
  return [
    hash,
    tx.blockHeight,
    block,
    tx.txIndex,
    0,
    payload,
    hashListBytes(tx.requiredSigners),
    hashListBytes(tx.witnessKeyHashes),
    tx.invalidBefore === null ? null : tx.invalidBefore.toString(),
    tx.invalidHereafter === null ? null : tx.invalidHereafter.toString(),
    tx.isValid ? 1 : 0,
    tx.payloadRepeated ? 1 : 0,
    payload.length,
    blockTime,
  ];
}

/**
 * Stores label txs, markers without payload. Join members of a stored payload become tracked, and
 * the profile anchors it references are recorded.
 * `L` moves the discovery frontier and, when the first credential is tracked, creates the
 * registration cursor at the safe block. With `L` null (the safe block is unknown) no L, R or
 * reader cursor is written. A re-delivered marker flagged for refetch is judged again and stays
 * 'duplicate'.
 */
export async function storeLabelTxs(
  db: D1Database,
  lease: string,
  txs: Array<{ tx: ChainTx; blockHash: string; blockTime?: number | null }>,
  L: { height: number; hash: string; safeHeight: number; safeTime: number } | null,
  cutTime: (h: number) => Promise<number | null>,
): Promise<Array<'stored' | 'duplicate' | 'marker'>> {
  const meta = await readMeta(db);
  const existing = new Map<string, { flagged: boolean }>();
  for (const r of await readKeyed(db, 'existingTxs', txs, (x) => [hashBytes(x.tx.txHash)])) {
    existing.set(hashFromCol(r.tx_hash), { flagged: Number(r.marker) === 1 && Number(r.refetch) === 1 });
  }
  const before = slotsFromMeta(meta);
  let slots = before;
  const G = posFromRow(meta, 'G');
  const storedL = Number(meta.L);
  const out: Array<'stored' | 'duplicate' | 'marker'> = [];
  const rows: unknown[][] = [];
  const heights: number[] = [];
  const members = new Map<string, Credential>();
  const anchors: Array<[Uint8Array, Uint8Array]> = [];
  const seen = new Set<string>();
  for (const { tx, blockHash, blockTime } of txs) {
    const prev = existing.get(tx.txHash);
    if (seen.has(tx.txHash) || (prev && !prev.flagged)) {
      out.push('duplicate');
      continue;
    }
    seen.add(tx.txHash);
    const payload = storedPayload(tx);
    const marker = payload === null;
    rows.push(txRow(tx, blockHash, blockTime ?? null, marker));
    out.push(prev ? 'duplicate' : marker ? 'marker' : 'stored');
    if (prev && marker) continue;
    heights.push(tx.blockHeight);
    if (payload === null) continue;
    for (const e of payload.events) {
      if (e.ok && e.event.tag === 'join') members.set(credKey(e.event.member), e.event.member);
    }
    for (const h of payloadAnchors(payload)) anchors.push([hashBytes(h), hashBytes(tx.txHash)]);
    const r = classifyNewInput({ kind: 'labelTx', at: afterTx(tx) }, { G, appliedThrough: null, L: storedL });
    if (r !== 'ordinary') slots = mergeSlots(slots, r, r.kind === 'truncate' ? await cutTime(tx.blockHeight) : null);
  }
  const tracked = [...members.keys()].map((k, i) => [credBytes(k), i + 1]);
  await writeBatch(db, lease, [
    ...stmts(db, 'upsertTxs', rows, (r) => r),
    ...stmts(db, 'trackCreds', tracked, (r) => r),
    ...stmts(db, 'insertAnchorRefs', anchors, (r) => r),
    ...(L === null
      ? []
      : [
          db.prepare(Q.setL.sql).bind(L.height, L.hash),
          db.prepare(Q.createRegCursor.sql).bind(L.safeHeight, L.safeTime),
        ]),
    ...slotStatements(db, before, slots, restarts(slots, heights)),
  ]);
  return out;
}

/** Statements that store ledger rows of tracked credentials, with their classification. */
async function ledgerStatements(
  db: D1Database,
  meta: Row,
  rows: StoredLedgerRow[],
): Promise<{ stmts: D1PreparedStatement[]; out: Array<'stored' | 'duplicate'>; slots: Slots; heights: number[] }> {
  const keyOf = (i: LedgerInput): string => `${i.txHash}#${i.certIndex}`;
  const existing = new Set(
    (await readKeyed(db, 'existingLedger', rows, (r) => [hashBytes(r.input.txHash), r.input.certIndex])).map(
      (r) => `${hashFromCol(r.tx_hash)}#${Number(r.cert_index)}`,
    ),
  );
  const creds = [...new Set(rows.map((r) => credKey(r.input.credential)))];
  const tracked = new Map<string, { known: number | null; applied: Pos | null; found: Pos | null }>();
  for (const r of await readKeyed(db, 'trackedState', creds, (c) => [credBytes(c)])) {
    tracked.set(credKeyFromCol(r.cred), { known: r.known === null ? null : Number(r.known), applied: posOrNull(r, 'applied'), found: posOrNull(r, 'found') });
  }
  const G = posFromRow(meta, 'G');
  const L = Number(meta.L);
  let slots = slotsFromMeta(meta);
  const out: Array<'stored' | 'duplicate'> = [];
  const inserts: unknown[][] = [];
  const heights: number[] = [];
  const known = new Set<string>();
  const found = new Map<string, Pos>();
  const next = new Map<string, Pos>();
  for (const row of rows) {
    const { input } = row;
    const k = keyOf(input);
    if (existing.has(k)) {
      out.push('duplicate');
      continue;
    }
    existing.add(k);
    const cred = credKey(input.credential);
    const t = tracked.get(cred);
    if (!t) throw new Error(`ledger row of an untracked credential: ${cred}`);
    const at = posOfCert(input);
    let state: StoredLedgerRow['witnessState'] | 'skipped' = row.witnessState;
    if (input.kind === 'reg' && input.credential.kind === 'script' && state === 'pending' && t.found && comparePos(at, t.found) > 0) {
      state = 'skipped';
    }
    if (state === 'checked' && row.witness !== null && (t.found === null || comparePos(at, t.found) < 0)) {
      t.found = at;
      found.set(cred, at);
    }
    if (t.known === 0) {
      t.known = 1;
      known.add(cred);
    }
    const r = classifyNewInput({ kind: 'ledger', at }, { G, appliedThrough: t.applied, L });
    if (r !== 'ordinary') slots = mergeSlots(slots, r, r.kind === 'truncate' ? row.blockTime : null);
    // A late row lowers nothing, its recovery derives next again.
    const n = next.get(cred);
    if (r === 'ordinary' && (n === undefined || comparePos(at, n) < 0)) next.set(cred, at);
    heights.push(input.blockHeight);
    inserts.push([
      hashBytes(input.txHash),
      input.certIndex,
      credBytes(cred),
      input.kind,
      input.blockHeight,
      hashBytes(row.blockHash),
      input.txIndex,
      row.blockTime,
      row.witness,
      state,
    ]);
    out.push('stored');
  }
  const posRows = (m: Map<string, Pos>) => [...m.entries()].map(([c, p]) => [credBytes(c), ...posBinds(p)]);
  return {
    stmts: [
      ...stmts(db, 'knownFromLedger', [...known], (c) => [credBytes(c)]),
      ...stmts(db, 'insertLedger', inserts, (r) => r),
      ...stmts(db, 'moveFound', posRows(found), (r) => r),
      ...keyedStatements(db, COMMIT.lowerNext, COMMIT_WIDTH.lowerNext, posRows(next), (r) => r),
    ],
    out,
    slots,
    heights,
  };
}

async function storeLedger(db: D1Database, lease: string, rows: StoredLedgerRow[], tail: D1PreparedStatement[]): Promise<Array<'stored' | 'duplicate'>> {
  const meta = await readMeta(db);
  const before = slotsFromMeta(meta);
  const { stmts: ledger, out, slots, heights } = await ledgerStatements(db, meta, rows);
  await writeBatch(db, lease, [...ledger, ...tail, ...slotStatements(db, before, slots, restarts(slots, heights))]);
  return out;
}

/**
 * Stores ledger rows of tracked credentials. A late row opens a truncation or a fork with its own
 * block time as cut time. The reader cursor and R are written when given.
 */
export async function storeLedgerRows(
  db: D1Database,
  lease: string,
  rows: StoredLedgerRow[],
  cursor: { regTime: number; regOffset: number; R: number | null } | null,
): Promise<Array<'stored' | 'duplicate'>> {
  return storeLedger(db, lease, rows, cursor === null ? [] : [db.prepare(Q.regCursor.sql).bind(cursor.regTime, cursor.regOffset, cursor.R)]);
}

/** Records the gate answer of credentials not judged yet: known DReps need a history, unknown ones are complete. */
export async function setKnown(db: D1Database, lease: string, known: string[], unknown: string[]): Promise<void> {
  await writeBatch(db, lease, [
    ...stmts(db, 'setKnown', known, (c) => [credBytes(c)], [1]),
    ...stmts(db, 'setKnown', unknown, (c) => [credBytes(c)], [0]),
  ]);
}

/** Stores the complete histories of a batch of credentials and marks them done. */
export async function finishHistoryBatch(
  db: D1Database,
  lease: string,
  creds: string[],
  rows: StoredLedgerRow[],
): Promise<Array<'stored' | 'duplicate'>> {
  return storeLedger(db, lease, rows, stmts(db, 'historyDone', creds, (c) => [credBytes(c)]));
}

/** Stores one page of a solo history. A null offset ends the history. */
export async function storeHistoryPage(
  db: D1Database,
  lease: string,
  cred: string,
  rows: StoredLedgerRow[],
  nextOffset: number | null,
): Promise<Array<'stored' | 'duplicate'>> {
  return storeLedger(
    db,
    lease,
    rows,
    nextOffset === null
      ? stmts(db, 'historyDone', [cred], (c) => [credBytes(c)])
      : [db.prepare(Q.historyOffset.sql).bind(nextOffset, credBytes(cred))],
  );
}

/** Credentials whose history is too long for a batch, read page by page. */
export async function markSolo(db: D1Database, lease: string, creds: string[]): Promise<void> {
  await writeBatch(db, lease, stmts(db, 'markSolo', creds, (c) => [credBytes(c)]));
}

/**
 * Results of witness checks of pending rows. A checked row keeps only the matching witness and an
 * earlier match moves found back. A failed fetch keeps the row pending and backs off.
 */
export async function recordWitnessChecks(
  db: D1Database,
  lease: string,
  checks: Array<{ txHash: string; certIndex: number; witness: Uint8Array | null } | { txHash: string; certIndex: number; failed: true }>,
  now: number,
): Promise<void> {
  const ok = checks.flatMap((c) => ('failed' in c ? [] : [c]));
  const failed = checks.filter((c) => 'failed' in c);
  await writeBatch(db, lease, [
    ...stmts(db, 'witnessChecked', ok, (c) => [hashBytes(c.txHash), c.certIndex, c.witness]),
    ...stmts(db, 'witnessFound', ok.filter((c) => c.witness !== null), (c) => [hashBytes(c.txHash), c.certIndex]),
    ...stmts(db, 'witnessFailed', failed, (c) => [hashBytes(c.txHash), c.certIndex], [now]),
  ]);
}
