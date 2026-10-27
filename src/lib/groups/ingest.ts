/// <reference types="@cloudflare/workers-types" />
// Koios ingest of the DRep groups store. A run probes the stored chain for a rollback, discovers
// label 8416 txs, asks the gate about new credentials, reads their registration histories and the
// registrations since the last run, checks the witness of script registrations and refetches
// markers flagged by a rebuild. Only blocks DEPTH deep are read. Every step derives its work from
// stored state and writes through the lease checked store functions, so a run that fails at any
// point leaves every cursor matching what was stored and the next run continues from there.
import type { ChainTx, Credential, LedgerInput, Recovery, TxPosition } from 'drep-groups';
import {
  credKey,
  decodePayload,
  decodeTransaction,
  GROUPS_LABEL,
  hexToBytes,
  LIBRARY_VERSION,
  memberScriptWitness,
  RETENTION_FLOOR,
} from 'drep-groups';
import { chunked, D1_MAX_BINDS } from '../db/sql.js';
import { type DrepRegistrationRow, KOIOS_PAGE_CAP, type MetalabelTxRow } from '../koios/client.js';
import type { GovSyncKoios } from '../sync/phases/context.js';
import type { Allowance } from '../sync/queryBudget.js';
import { credBytes, credFromKey, credKeyFromCol, hashBytes, hashFromCol } from './codec.js';
import {
  DEPTH,
  DISCOVERY_MAX_STATEMENTS,
  DISCOVERY_PAGES_PER_RUN,
  HISTORY_BATCH,
  MARKER_REFETCH_ATTEMPTS,
  MARKER_REFETCH_PER_RUN,
  MAX_GATE_CHECKS_PER_RUN,
  MAX_HISTORY_BATCHES_PER_RUN,
  MAX_NEW_TXS_PER_RUN,
  MAX_REG_PAGES_PER_RUN,
  MAX_ROLLBACK_PROBES_PER_RUN,
  MAX_SCRIPT_SEARCH_FETCHES_PER_RUN,
  MAX_SCRIPT_SEARCH_ROWS_PER_RUN,
  MAX_SOLO_HISTORIES_PER_RUN,
  REG_OVERLAP_SECONDS,
} from './constants.js';
import { credentialForDrepId, drepIdForCredential } from './ids.js';
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
} from './store/ingest.js';
import { writeBatch } from './store/lease.js';
import { INGEST, INGEST_TRAILING, INGEST_WIDTH, Q } from './store/queries.js';
import { pendingRecovery } from './store/reads.js';
import { keyedStatements, openRecoveryStatements, readMeta, slotsFromMeta } from './store/recovery.js';

export type GroupsKoios = Pick<
  GovSyncKoios,
  | 'tip'
  | 'txByMetalabel'
  | 'txCborBatch'
  | 'txPositionBatch'
  | 'drepRegistrationsSince'
  | 'drepRegistrationsFor'
  | 'drepRegistrationsForMany'
  | 'blockAt'
  | 'knownDrepIds'
>;

export interface IngestResult {
  newTxs: number;
  markers: number;
  newLedgerRows: number;
  /** Join members named by the new label txs, each tracked from now on. */
  tracked: number;
  gateChecked: number;
  witnessChecks: number;
  refetched: number;
  /** A rollback probe search is still running, nothing else ran. */
  probing: boolean;
  /** The recovery open when the run ended. */
  recovery: Recovery | null;
  /** Work is left that a cap of this run held back. */
  backlog: boolean;
  /** Steps skipped because the query allowance did not cover them. */
  starved: string[];
}

type Row = Record<string, unknown>;
type Block = { height: number; hash: string };
type LabelInput = { tx: ChainTx; blockHash: string };

interface Ctx {
  db: D1Database;
  koios: GroupsKoios;
  lease: string;
  now: number;
  limits: { page: number; regPagesPerRun: number };
  safe: number;
  safeBlock: { hash: string; block_time: number };
  result: IngestResult;
  /** False, and the step named starved, when the allowance does not cover `cost` more queries. */
  fits: (step: string, cost: number) => boolean;
}

/** Statements needed for `n` keyed rows of an ingest statement. */
const per = (name: keyof typeof INGEST, n: number): number =>
  n === 0 ? 0 : Math.ceil(n / Math.floor((D1_MAX_BINDS - (INGEST_TRAILING[name] ?? 0)) / INGEST_WIDTH[name]));

// Query counts of the store calls, the meta read and the lease guard included.
const labelStatements = (txs: number, members: number): number => 2 + per('upsertTxs', txs) + per('trackCreds', members) + 3;
const labelCost = (txs: number, members: number): number => 1 + per('existingTxs', txs) + labelStatements(txs, members);
const ledgerCost = (rows: number, creds: number): number =>
  1 +
  per('existingLedger', rows) +
  per('trackedState', creds) +
  2 +
  per('knownFromLedger', creds) +
  per('insertLedger', rows) +
  2 * per('moveFound', creds) +
  Math.max(1, per('historyDone', creds)) +
  1;
const PROBE_QUERIES = 2 * MAX_ROLLBACK_PROBES_PER_RUN + 4;
const GATE_QUERIES = 1 + 2 + per('setKnown', MAX_GATE_CHECKS_PER_RUN) + 1;
const WITNESS_QUERIES =
  1 +
  2 +
  per('witnessChecked', MAX_SCRIPT_SEARCH_ROWS_PER_RUN) +
  per('witnessFound', MAX_SCRIPT_SEARCH_ROWS_PER_RUN) +
  per('witnessFailed', MAX_SCRIPT_SEARCH_ROWS_PER_RUN);

// A partial Koios answer never counts as complete: the run fails and the next one retries.
function requireAll<T extends { tx_hash: string }>(hashes: string[], rows: T[], what: string): Map<string, T> {
  const by = new Map(rows.map((r) => [r.tx_hash, r]));
  const missing = hashes.filter((h) => !by.has(h));
  if (missing.length > 0) {
    console.error(`[drep-groups] koios ${what} left out tx ${missing[0]}${missing.length > 1 ? ` and ${missing.length - 1} more` : ''}`);
    throw new Error(`koios ${what} left out ${missing.length} of ${hashes.length} transactions`);
  }
  return by;
}

/** The tx as the library reads it. CBOR it cannot read is stored as a marker. */
function chainTx(cbor: string, pos: TxPosition): ChainTx {
  try {
    return decodeTransaction(hexToBytes(cbor), pos);
  } catch {
    console.warn(`[drep-groups] unreadable tx cbor ${pos.txHash}, stored as a marker`);
    return {
      ...pos,
      isValid: false,
      invalidBefore: null,
      invalidHereafter: null,
      requiredSigners: [],
      witnessKeyHashes: [],
      payload: undefined,
      payloadRepeated: false,
      witnessScripts: [],
    };
  }
}

/** Join members of a non marker tx, as credKey strings. */
function joinMembers(tx: ChainTx): string[] {
  if (isMarkerTx(tx)) return [];
  return (decodePayload(tx.payload as Uint8Array)?.events ?? []).flatMap((e) =>
    e.ok && e.event.tag === 'join' ? [credKey(e.event.member)] : [],
  );
}

/** CBOR per tx hash, empty when the call fails. */
async function cborsOf(koios: GroupsKoios, hashes: string[]): Promise<Map<string, string>> {
  try {
    return new Map((await koios.txCborBatch(hashes)).map((r) => [r.tx_hash, r.cbor]));
  } catch (err) {
    console.warn(`[drep-groups] tx_cbor failed for ${hashes.length} transactions`, err);
    return new Map();
  }
}

async function keyedRead(db: D1Database, name: keyof typeof INGEST, keys: unknown[]): Promise<Row[]> {
  const stmts = chunked(keys, Math.floor(D1_MAX_BINDS / INGEST_WIDTH[name])).map((c) => db.prepare(INGEST[name](c.length)).bind(...c));
  if (stmts.length === 0) return [];
  return (await db.batch<Row>(stmts)).flatMap((r) => r.results ?? []);
}

async function all(db: D1Database, sql: string, ...binds: unknown[]): Promise<Row[]> {
  return (await db.prepare(sql).bind(...binds).all<Row>()).results ?? [];
}

/** The highest stored label tx or ledger row block below a height. */
async function storedBlockBelow(db: D1Database, below: number): Promise<Block | null> {
  const res = await db.batch<Row>([db.prepare(Q.probeTxBlock.sql).bind(below), db.prepare(Q.probeLedgerBlock.sql).bind(below)]);
  let best: Block | null = null;
  for (const r of res.flatMap((x) => x.results ?? [])) {
    const height = Number(r.block_height);
    if (best === null || height > best.height) best = { height, hash: hashFromCol(r.block_hash) };
  }
  return best;
}

/**
 * Compares the top stored block with the chain. A mismatch walks the stored blocks down, across
 * runs, to L - RETENTION_FLOOR: the first match opens a truncation above it, none a fork.
 */
async function probeRollback(ctx: Ctx, meta: Row): Promise<{ probing: boolean; recovery: Recovery | null }> {
  const { db, koios, lease } = ctx;
  const L = Number(meta.L);
  const floor = L - RETENTION_FLOOR;
  const state = (active: number, below: number | null) => db.prepare(Q.probeState.sql).bind(active, below);
  let below: number;
  let probes = 0;
  if (Number(meta.probe_active) === 1) {
    below = Number(meta.probe_below);
  } else {
    let top = await storedBlockBelow(db, Number.MAX_SAFE_INTEGER);
    if (meta.L_hash !== null && L >= 0 && (top === null || L > top.height)) top = { height: L, hash: String(meta.L_hash) };
    if (top === null) return { probing: false, recovery: null };
    probes++;
    const onChain = await koios.blockAt(top.height);
    // No block at the top yet says nothing about the stored chain.
    if (onChain === null || onChain.hash === top.hash) return { probing: false, recovery: null };
    below = top.height;
  }
  const open = async (r: Recovery, cutTime: number | null) => {
    await writeBatch(db, lease, [...openRecoveryStatements(db, slotsFromMeta(meta), r, cutTime), state(0, null)]);
    return { probing: false, recovery: r };
  };
  for (; probes < MAX_ROLLBACK_PROBES_PER_RUN; probes++) {
    const b = await storedBlockBelow(db, below);
    if (b === null || b.height < floor) return open({ kind: 'fork' }, null);
    const onChain = await koios.blockAt(b.height);
    // Without an answer the common ancestor is unknown: fail, the next run asks again.
    if (onChain === null) throw new Error(`rollback probe at ${b.height} got no block from koios`);
    if (onChain.hash === b.hash) return open({ kind: 'truncate', above: b.height }, onChain.block_time);
    below = b.height;
  }
  await writeBatch(db, lease, [state(1, below)]);
  return { probing: true, recovery: null };
}

/**
 * Stores label txs block by block, each batch cut at DISCOVERY_MAX_STATEMENTS estimated
 * statements and never inside a block. With `top`, every batch moves L to its last block and the
 * last one to `top`, L never goes down. Stops when the allowance does not cover a batch.
 */
async function storeBlocks(
  ctx: Ctx,
  step: string,
  items: LabelInput[],
  top: Block | null,
  L: number,
): Promise<{ out: Array<'stored' | 'duplicate' | 'marker'>; members: string[]; done: boolean }> {
  const { db, koios, lease, safe, safeBlock } = ctx;
  const sorted = [...items].sort((a, b) => a.tx.blockHeight - b.tx.blockHeight);
  const blocks: LabelInput[][] = [];
  for (const x of sorted) {
    const last = blocks.at(-1);
    if (last && last[0].tx.blockHeight === x.tx.blockHeight) last.push(x);
    else blocks.push([x]);
  }
  const batches: LabelInput[][] = [];
  let members = 0;
  for (const block of blocks) {
    const m = block.reduce((n, x) => n + joinMembers(x.tx).length, 0);
    const cur = batches.at(-1);
    if (cur && labelStatements(cur.length + block.length, members + m) <= DISCOVERY_MAX_STATEMENTS) {
      cur.push(...block);
      members += m;
    } else {
      batches.push([...block]);
      members = m;
    }
  }
  if (batches.length === 0 && top !== null && top.height > L) batches.push([]);
  const cutTime = async (h: number) => (await koios.blockAt(h))?.block_time ?? null;
  const out: Array<'stored' | 'duplicate' | 'marker'> = [];
  const named: string[] = [];
  let lHeight = L;
  for (const [i, batch] of batches.entries()) {
    const joins = batch.flatMap((x) => joinMembers(x.tx));
    if (!ctx.fits(step, labelCost(batch.length, new Set(joins).size))) return { out, members: named, done: false };
    const last = batch.at(-1);
    const to = top === null ? null : i === batches.length - 1 ? top : last ? { height: last.tx.blockHeight, hash: last.blockHash } : null;
    const moveL = to !== null && to.height >= lHeight ? { height: to.height, hash: to.hash, safeHeight: safe, safeTime: safeBlock.block_time } : null;
    const res = await storeLabelTxs(db, lease, batch, moveL, cutTime);
    if (moveL) lHeight = moveL.height;
    out.push(...res);
    batch.forEach((x, j) => {
      if (res[j] === 'stored') named.push(...joinMembers(x.tx));
    });
  }
  return { out, members: named, done: true };
}

/** Txs with their CBOR and position. A tx Koios leaves out of either answer fails the run. */
async function fetchLabelTxs(koios: GroupsKoios, rows: MetalabelTxRow[]): Promise<LabelInput[]> {
  if (rows.length === 0) return [];
  const hashes = rows.map((r) => r.tx_hash);
  const [cbors, positions] = await Promise.all([koios.txCborBatch(hashes), koios.txPositionBatch(hashes)]);
  const c = requireAll(hashes, cbors, 'tx_cbor');
  const p = requireAll(hashes, positions, 'tx_info');
  return hashes.map((h) => {
    const pos = p.get(h) as (typeof positions)[number];
    return {
      tx: chainTx((c.get(h) as (typeof cbors)[number]).cbor, { txHash: h, blockHeight: pos.block_height, txIndex: pos.tx_block_index }),
      blockHash: pos.block_hash,
    };
  });
}

/** Label txs from L - 1 at safe depth, capped per run, the last block taken always in full. */
async function discover(ctx: Ctx, meta: Row): Promise<void> {
  const { db, koios, limits, safe, safeBlock, result } = ctx;
  const L = Number(meta.L);
  const read: MetalabelTxRow[] = [];
  let complete = false;
  for (let p = 0; p < DISCOVERY_PAGES_PER_RUN && !complete; p++) {
    const page = await koios.txByMetalabel(GROUPS_LABEL, Math.max(0, L - 1), limits.page, p * limits.page);
    read.push(...page);
    complete = page.length < limits.page || page.some((r) => r.block_height > safe);
  }
  // A block is read in full after a scan that reached its end, else when a later block was read.
  const lastRead = read.reduce((m, r) => Math.max(m, r.block_height), -1);
  const seen = new Set<string>();
  const rows = read
    .filter((r) => r.block_height <= safe && (complete || r.block_height < lastRead) && !seen.has(r.tx_hash) && seen.add(r.tx_hash))
    .sort((a, b) => a.block_height - b.block_height);
  if (!ctx.fits('discovery', per('existingTxs', rows.length))) return;
  const stored = new Set((await keyedRead(db, 'existingTxs', rows.map((r) => hashBytes(r.tx_hash)))).map((r) => hashFromCol(r.tx_hash)));
  const take: MetalabelTxRow[] = [];
  let capped = false;
  for (const r of rows.filter((x) => !stored.has(x.tx_hash))) {
    if (take.length >= MAX_NEW_TXS_PER_RUN && r.block_height !== take[take.length - 1].block_height) {
      capped = true;
      break;
    }
    take.push(r);
  }
  const lastRow = capped ? take[take.length - 1] : rows.at(-1);
  const top: Block | null =
    complete && !capped
      ? { height: safe, hash: safeBlock.hash }
      : lastRow
        ? { height: lastRow.block_height, hash: lastRow.block_hash }
        : null;
  const { out, members, done } = await storeBlocks(ctx, 'discovery', await fetchLabelTxs(koios, take), top, L);
  result.newTxs += out.filter((o) => o !== 'duplicate').length;
  result.markers += out.filter((o) => o === 'marker').length;
  result.tracked += new Set(members).size;
  if (capped || !complete || !done) result.backlog = true;
}

/** Credentials not judged yet, oldest first. A DRep Koios does not know needs no history. */
async function gate(ctx: Ctx): Promise<void> {
  const { db, koios, lease, result } = ctx;
  if (!ctx.fits('gate', GATE_QUERIES)) return;
  const creds = (await all(db, Q.gateCandidates.sql, MAX_GATE_CHECKS_PER_RUN)).map((r) => credKeyFromCol(r.cred));
  if (creds.length === 0) return;
  const ids = creds.map((c) => drepIdForCredential(credFromKey(c)));
  const known = await koios.knownDrepIds(ids);
  await setKnown(
    db,
    lease,
    creds.filter((_, i) => known.has(ids[i])),
    creds.filter((_, i) => !known.has(ids[i])),
  );
  result.gateChecked = creds.length;
  if (creds.length === MAX_GATE_CHECKS_PER_RUN) result.backlog = true;
}

/** Registration rows with their block position, at safe depth and of the wanted credentials only. */
async function ledgerRows(ctx: Ctx, regs: DrepRegistrationRow[], wanted: Set<string>): Promise<StoredLedgerRow[]> {
  const items = regs.flatMap((r) => {
    if (r.block_time > ctx.safeBlock.block_time) return [];
    const c = credentialForDrepId(r.drep_id);
    return c && wanted.has(credKey(c)) ? [{ r, c }] : [];
  });
  if (items.length === 0) return [];
  const hashes = [...new Set(items.map((x) => x.r.update_tx_hash))];
  const p = requireAll(hashes, await ctx.koios.txPositionBatch(hashes), 'tx_info');
  return items.flatMap(({ r, c }) => {
    const pos = p.get(r.update_tx_hash) as { block_hash: string; block_height: number; tx_block_index: number };
    if (pos.block_height > ctx.safe) return [];
    const kind = r.action === 'registered' ? 'reg' : 'unreg';
    const input: LedgerInput = {
      kind,
      credential: c,
      txHash: r.update_tx_hash,
      blockHeight: pos.block_height,
      txIndex: pos.tx_block_index,
      certIndex: r.cert_index,
    };
    // A script credential's reg row waits for the check of its witness.
    const pending = c.kind === 'script' && kind === 'reg';
    return [{ input, blockHash: pos.block_hash, blockTime: r.block_time, witnessState: pending ? 'pending' : 'na', witness: null }];
  });
}

const stored = (out: Array<'stored' | 'duplicate'>): number => out.filter((o) => o === 'stored').length;

/**
 * Histories of known credentials: batched reads of HISTORY_BATCH credentials, a batch that fills a
 * page moves to the solo path, then one page per solo credential from its offset.
 */
async function histories(ctx: Ctx): Promise<void> {
  const { db, koios, lease, limits, result } = ctx;
  const candidates = async (solo: 0 | 1, limit: number) =>
    (await all(db, Q.historyCandidates.sql, solo, limit)).map((r) => ({ cred: credKeyFromCol(r.cred), offset: Number(r.history_offset) }));
  const idOf = (c: string) => drepIdForCredential(credFromKey(c));
  for (let n = 0; n < MAX_HISTORY_BATCHES_PER_RUN; n++) {
    if (!ctx.fits('histories', 1)) return;
    const creds = (await candidates(0, HISTORY_BATCH)).map((x) => x.cred);
    if (creds.length === 0) break;
    const page = await koios.drepRegistrationsForMany(creds.map(idOf), limits.page, 0);
    if (page.length >= limits.page) {
      if (!ctx.fits('histories', 3 + per('markSolo', creds.length))) return;
      await markSolo(db, lease, creds);
      continue;
    }
    const rows = await ledgerRows(ctx, page, new Set(creds));
    if (!ctx.fits('histories', ledgerCost(rows.length, creds.length))) return;
    result.newLedgerRows += stored(await finishHistoryBatch(db, lease, creds, rows));
    if (n === MAX_HISTORY_BATCHES_PER_RUN - 1 && creds.length === HISTORY_BATCH) result.backlog = true;
  }
  if (!ctx.fits('histories', 1)) return;
  for (const { cred, offset } of await candidates(1, MAX_SOLO_HISTORIES_PER_RUN)) {
    const page = await koios.drepRegistrationsFor(idOf(cred), limits.page, offset);
    const rows = await ledgerRows(ctx, page, new Set([cred]));
    if (!ctx.fits('histories', ledgerCost(rows.length, 1))) return;
    const full = page.length >= limits.page;
    result.newLedgerRows += stored(await storeHistoryPage(db, lease, cred, rows, full ? offset + page.length : null));
    if (full) result.backlog = true;
  }
}

/**
 * Registrations since the reader time minus REG_OVERLAP_SECONDS, from the stored offset. Reaching
 * the end, or rows newer than the safe block, moves the reader to the safe block's time and R to
 * the safe height. Otherwise only the offset moves.
 */
async function readRegistrations(ctx: Ctx): Promise<void> {
  const { db, koios, lease, limits, safe, safeBlock, result } = ctx;
  if (!ctx.fits('registrations', 1)) return;
  const meta = await readMeta(db);
  if (meta.reg_time === null) return;
  const regTime = Number(meta.reg_time);
  const since = Math.max(0, regTime - REG_OVERLAP_SECONDS);
  let offset = Number(meta.reg_offset);
  for (let p = 0; p < limits.regPagesPerRun; p++) {
    const page = await koios.drepRegistrationsSince(since, limits.page, offset);
    const end = page.length < limits.page || page.some((r) => r.block_time > safeBlock.block_time);
    const named = [...new Set(page.flatMap((r) => {
      const c = credentialForDrepId(r.drep_id);
      return c ? [credKey(c)] : [];
    }))];
    if (!ctx.fits('registrations', per('trackedState', named.length))) return;
    const tracked = new Set((await keyedRead(db, 'trackedState', named.map(credBytes))).map((r) => credKeyFromCol(r.cred)));
    const rows = await ledgerRows(ctx, page, tracked);
    if (!ctx.fits('registrations', ledgerCost(rows.length, new Set(rows.map((r) => credKey(r.input.credential))).size))) return;
    const cursor = end
      ? { regTime: Math.max(regTime, safeBlock.block_time), regOffset: 0, R: safe }
      : { regTime, regOffset: offset + page.length, R: null };
    result.newLedgerRows += stored(await storeLedgerRows(db, lease, rows, cursor));
    if (end) return;
    offset += page.length;
  }
  result.backlog = true;
}

/**
 * Pending reg rows of script credentials whose check is due, oldest retry first: the witness that
 * matches the credential, or none. A fetch that fails or leaves a tx out backs off.
 */
async function searchWitnesses(ctx: Ctx): Promise<void> {
  const { db, koios, lease, now, result } = ctx;
  if (!ctx.fits('witnesses', WITNESS_QUERIES)) return;
  const rows = await all(db, Q.pendingWitnesses.sql, now, MAX_SCRIPT_SEARCH_ROWS_PER_RUN);
  if (rows.length === 0) return;
  const hashes = [...new Set(rows.map((r) => hashFromCol(r.tx_hash)))].slice(0, MAX_SCRIPT_SEARCH_FETCHES_PER_RUN);
  const fetched = new Set(hashes);
  const due = rows.filter((r) => fetched.has(hashFromCol(r.tx_hash)));
  const cbors = await cborsOf(koios, hashes);
  const checks = due.map((r) => {
    const txHash = hashFromCol(r.tx_hash);
    const certIndex = Number(r.cert_index);
    const cbor = cbors.get(txHash);
    if (cbor !== undefined) {
      try {
        const tx = decodeTransaction(hexToBytes(cbor), { txHash, blockHeight: Number(r.block_height), txIndex: Number(r.tx_index) });
        const credential: Credential = credFromKey(credKeyFromCol(r.cred));
        return { txHash, certIndex, witness: memberScriptWitness(credential, tx.witnessScripts)?.bytes ?? null };
      } catch {
        // Unreadable CBOR backs off like a failed fetch.
      }
    }
    console.warn(`[drep-groups] witness check of ${txHash} failed, retried later`);
    return { txHash, certIndex, failed: true as const };
  });
  await recordWitnessChecks(db, lease, checks, now);
  result.witnessChecks = checks.length;
  if (rows.length === MAX_SCRIPT_SEARCH_ROWS_PER_RUN || due.length < rows.length) result.backlog = true;
}

/**
 * Markers a rebuild flagged, refetched and stored again so the library judges them anew. After
 * MARKER_REFETCH_ATTEMPTS failed fetches the flag is cleared and the tx stays a marker.
 */
async function refetchMarkers(ctx: Ctx): Promise<void> {
  const { db, koios, lease, result } = ctx;
  if (!ctx.fits('markers', 1)) return;
  const rows = await all(db, Q.refetchMarkers.sql, MARKER_REFETCH_PER_RUN);
  if (rows.length === 0) return;
  // A failing call fails the run, only a tx left out of an answer counts as an attempt.
  const cbors = new Map((await koios.txCborBatch(rows.map((r) => hashFromCol(r.tx_hash)))).map((r) => [r.tx_hash, r.cbor]));
  const ok: LabelInput[] = [];
  const failed: Row[] = [];
  for (const r of rows) {
    const txHash = hashFromCol(r.tx_hash);
    const cbor = cbors.get(txHash);
    if (cbor === undefined) failed.push(r);
    else {
      const pos = { txHash, blockHeight: Number(r.block_height), txIndex: Number(r.tx_index) };
      ok.push({ tx: chainTx(cbor, pos), blockHash: hashFromCol(r.block_hash) });
    }
  }
  const { out, done } = await storeBlocks(ctx, 'markers', ok, null, Number.POSITIVE_INFINITY);
  result.refetched = out.length;
  if (!done) return;
  if (failed.length > 0) {
    if (!ctx.fits('markers', 2 + per('refetchFailed', failed.length))) return;
    await writeBatch(db, lease, keyedStatements(db, INGEST.refetchFailed, INGEST_WIDTH.refetchFailed, failed, (r) => [hashBytes(hashFromCol(r.tx_hash))]));
    for (const r of failed) {
      const txHash = hashFromCol(r.tx_hash);
      if (Number(r.refetch_attempts) + 1 >= MARKER_REFETCH_ATTEMPTS) console.error(`[drep-groups] gave up refetching marker ${txHash}, it stays a marker`);
      else console.warn(`[drep-groups] refetch of marker ${txHash} failed, retried later`);
    }
  }
  if (rows.length === MARKER_REFETCH_PER_RUN || failed.length > 0) result.backlog = true;
}

/**
 * One ingest run. Nothing runs while a recovery is open, and while a rollback probe search runs
 * only the probes do. Each step is skipped when the allowance does not cover it.
 */
export async function ingestDrepGroups(deps: {
  db: D1Database;
  koios: GroupsKoios;
  lease: string;
  budget: Allowance;
  now: number;
  limits?: Partial<{ page: number; regPagesPerRun: number }>;
}): Promise<IngestResult> {
  const { db, koios, lease, budget, now } = deps;
  const result: IngestResult = {
    newTxs: 0,
    markers: 0,
    newLedgerRows: 0,
    tracked: 0,
    gateChecked: 0,
    witnessChecks: 0,
    refetched: 0,
    probing: false,
    recovery: null,
    backlog: false,
    starved: [],
  };
  const fits = (step: string, cost: number): boolean => {
    if (budget.covers(cost)) return true;
    if (!result.starved.includes(step)) result.starved.push(step);
    result.backlog = true;
    return false;
  };
  if (!fits('ingest', 1)) return result;
  const meta = await readMeta(db);
  const open = slotsFromMeta(meta).first;
  if (open !== null) return { ...result, recovery: open };

  const safe = (await koios.tip()).block_no - DEPTH;
  const safeBlock = await koios.blockAt(safe);
  if (safeBlock === null) throw new Error(`koios has no block at the safe height ${safe}`);
  const ctx: Ctx = {
    db,
    koios,
    lease,
    now,
    limits: { page: KOIOS_PAGE_CAP, regPagesPerRun: MAX_REG_PAGES_PER_RUN, ...deps.limits },
    safe,
    safeBlock,
    result,
    fits,
  };

  // Nothing is stored on a chain whose stored top is not confirmed.
  if (!fits('probes', PROBE_QUERIES)) return result;
  const probe = await probeRollback(ctx, meta);
  if (probe.probing || probe.recovery) return { ...result, ...probe };

  await discover(ctx, meta);
  await gate(ctx);
  await histories(ctx);
  await readRegistrations(ctx);
  await searchWitnesses(ctx);
  await refetchMarkers(ctx);
  // Stays null while a slot is open when this last check does not fit, callers read pendingRecovery.
  if (fits('ingest', 1)) result.recovery = await pendingRecovery(db);
  return result;
}

/**
 * Writes the library version in one batch with, when it differed and inputs are stored, the
 * rebuild that judges them again. True when a rebuild was opened.
 */
export async function checkLibraryVersion(db: D1Database, lease: string): Promise<boolean> {
  const [m, inputs] = await db.batch<Row>([db.prepare(Q.metaRow.sql), db.prepare(Q.storedInputs.sql)]);
  const meta = m.results?.[0];
  if (!meta) throw new Error('drep group meta row missing');
  if (meta.lib_version === LIBRARY_VERSION) return false;
  const i = inputs.results?.[0];
  const rebuild = i !== undefined && (i.txs !== null || i.ledger !== null);
  await writeBatch(db, lease, [
    db.prepare(Q.libVersion.sql).bind(LIBRARY_VERSION),
    ...(rebuild ? openRecoveryStatements(db, slotsFromMeta(meta), { kind: 'rebuild' }, null) : []),
  ]);
  return rebuild;
}
