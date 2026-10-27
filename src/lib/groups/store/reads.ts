/// <reference types="@cloudflare/workers-types" />
// Engine reads of the D1 store: the label tx pager, queued joins, ready credentials,
// frontiers and the pending recovery. Every read is a bounded indexed statement.
import type {
  ChangeSet,
  Credential,
  CredentialInput,
  DecodedEvent,
  EventRef,
  Frontiers,
  LedgerInput,
  Pos,
  QueuedEvent,
  ReadyCredential,
  Recovery,
  StoredLabelTx,
  TxContext,
} from 'drep-groups';
import { comparePos, endOf, posOfCert, refKey } from 'drep-groups';
import { chunked, D1_MAX_BINDS } from '../../db/sql.js';
import {
  bytesFromCol,
  credFromKey,
  decodeContext,
  decodeEvent,
  labelTxFromRow,
  posFromRow,
  posOrNull,
} from '../codec.js';
import { KEYED, KEYED_WIDTH, Q } from './queries.js';

export { load } from './view.js';

type Row = Record<string, unknown>;

const MAX = Number.MAX_SAFE_INTEGER;
const order = (p: Pos): [number, number, number, number] => [p.blockHeight, p.txIndex, p.phase, p.index];

/**
 * The first (height, tx index) whose tx end lies strictly after `p`. A tx's events all sit
 * before its end (phase 2, index MAX), so only a position at a tx end excludes its own tx.
 */
function firstTxAfter(p: Pos): [number, number] {
  if (p.phase !== 2 || p.index !== MAX) return [p.blockHeight, p.txIndex];
  return p.txIndex === MAX ? [p.blockHeight + 1, 0] : [p.blockHeight, p.txIndex + 1];
}

/**
 * Ledger rows sit at (height, tx index, 0, cert index). Phase 0 is the lowest, so against a
 * position of a later phase every cert of the same tx lies before it.
 */
const certBound = (p: Pos): [number, number, number] => [p.blockHeight, p.txIndex, p.phase === 0 ? p.index : MAX];

/** Non marker txs strictly after `after` and at or below height L, by count and bytes. */
export async function nextLabelTxs(
  db: D1Database,
  after: Pos,
  L: number,
  maxTxs: number,
  maxBytes: number,
): Promise<{ txs: StoredLabelTx[]; done: boolean }> {
  const [h, ti] = firstTxAfter(after);
  const rows =
    maxTxs > 0 ? ((await db.prepare(Q.labelTxPage.sql).bind(h, ti, L, maxTxs).all<Row>()).results ?? []) : [];
  const txs: StoredLabelTx[] = [];
  let bytes = 0;
  for (const r of rows) {
    const b = Number(r.bytes);
    if (txs.length > 0 && bytes + b > maxBytes) break;
    txs.push({ tx: labelTxFromRow(r), bytes: b });
    bytes += b;
  }
  // A short page that took every row it read has nothing left behind it.
  if (rows.length < maxTxs && txs.length === rows.length) return { txs, done: true };
  const last = txs.at(-1)?.tx;
  const [nh, nti] = last ? [last.blockHeight, last.txIndex + 1] : [h, ti];
  const probe = await db.prepare(Q.labelTxProbe.sql).bind(nh, nti, L).first<Row>();
  return { txs, done: probe === null };
}

/** Join events by ref: the overlay's queued entries first, then the stored queue, then markers. */
export async function queuedJoins(
  db: D1Database,
  refs: EventRef[],
  overlay: ChangeSet[],
): Promise<Map<string, DecodedEvent | 'ignored'>> {
  const out = new Map<string, DecodedEvent | 'ignored'>();
  const queued = overlay.flatMap((o) => o.queued);
  const rest: EventRef[] = [];
  for (const r of refs) {
    const hit = queued.find((q) => q.txHash === r.txHash && q.at.index === r.index);
    if (hit) out.set(refKey(r), hit.event);
    else rest.push(r);
  }
  const stmts = chunked(rest, Math.floor(D1_MAX_BINDS / KEYED_WIDTH.queuedJoins)).map((c) =>
    db.prepare(KEYED.queuedJoins(c.length)).bind(...c.flatMap((r) => [r.txHash, r.index])),
  );
  if (stmts.length === 0) return out;
  for (const res of await db.batch<Row>(stmts)) {
    for (const r of res.results ?? []) {
      const k = refKey({ txHash: String(r.k_tx), index: Number(r.k_ix) });
      if (r.event_json !== null) out.set(k, decodeEvent(String(r.event_json)));
      else if (r.marker !== null) out.set(k, 'ignored');
    }
  }
  return out;
}

function queuedFromRow(r: Row): QueuedEvent {
  return {
    subject: credFromKey(String(r.subject)),
    at: posFromRow(r, 'at'),
    group: r.group_tx === null ? null : { txHash: String(r.group_tx), index: Number(r.group_ix) },
    txHash: String(r.tx_hash),
    event: decodeEvent(String(r.event_json)),
  };
}

function ledgerFromRow(r: Row, c: Credential): LedgerInput {
  return {
    kind: String(r.kind) as LedgerInput['kind'],
    credential: c,
    txHash: String(r.tx_hash),
    blockHeight: Number(r.block_height),
    txIndex: Number(r.tx_index),
    certIndex: Number(r.cert_index),
    // Only the witness that matches the member script is kept, which answers the same search.
    witnessScripts: r.witness === null ? [] : [bytesFromCol(r.witness)],
  };
}

type Pending =
  | { kind: 'event'; at: Pos; q: QueuedEvent }
  | { kind: 'ledger'; at: Pos; input: LedgerInput };

/**
 * Complete credentials with unapplied inputs at or below their bound, oldest next input first.
 * `known = 0` credentials are bound by G, all others by min(G, END(R)). Inputs are paged strictly
 * after the applied cursor within maxUnits and maxInputs in total.
 */
export async function readyCredentials(
  db: D1Database,
  maxUnits: number,
  maxInputs: number,
  upTo: { G: Pos; R: number | null },
): Promise<ReadyCredential[]> {
  if (maxUnits <= 0 || maxInputs <= 0) return [];
  const capped = upTo.R === null || comparePos(upTo.G, endOf(upTo.R)) <= 0 ? upTo.G : endOf(upTo.R);
  const [unknown, known] = await db.batch<Row>([
    db.prepare(Q.readyTracked.sql).bind(0, ...order(upTo.G), maxUnits),
    db.prepare(Q.readyTracked.sql).bind(1, ...order(capped), maxUnits),
  ]);
  const candidates = [
    ...(unknown.results ?? []).map((r) => ({ r, bound: upTo.G })),
    ...(known.results ?? []).map((r) => ({ r, bound: capped })),
  ]
    .map((x) => ({ ...x, cred: String(x.r.cred), next: posFromRow(x.r, 'next') }))
    .sort((a, b) => comparePos(a.next, b.next) || (a.cred < b.cred ? -1 : a.cred > b.cred ? 1 : 0))
    .slice(0, maxUnits);

  const picked: Array<{ c: Credential; inputs: Pending[]; more: boolean }> = [];
  let left = maxInputs;
  for (const { r, cred, bound } of candidates) {
    if (left <= 0) break;
    const c = credFromKey(cred);
    const applied = posOrNull(r, 'applied') ?? endOf(-1);
    const [queue, ledger] = await db.batch<Row>([
      db.prepare(Q.queueInputs.sql).bind(cred, ...order(applied), ...order(bound), left + 1),
      db.prepare(Q.ledgerInputs.sql).bind(cred, ...certBound(applied), ...certBound(bound), left + 1),
    ]);
    const all: Pending[] = [
      ...(queue.results ?? []).map((x): Pending => {
        const q = queuedFromRow(x);
        return { kind: 'event', at: q.at, q };
      }),
      ...(ledger.results ?? []).map((x): Pending => {
        const input = ledgerFromRow(x, c);
        return { kind: 'ledger', at: posOfCert(input), input };
      }),
    ].sort((a, b) => comparePos(a.at, b.at));
    const inputs = all.slice(0, left);
    left -= inputs.length;
    picked.push({ c, inputs, more: all.length > inputs.length });
  }

  const hashes = [...new Set(picked.flatMap((p) => p.inputs.flatMap((x) => (x.kind === 'event' ? [x.q.txHash] : []))))];
  const contexts = new Map<string, TxContext>();
  const stmts = chunked(hashes, Math.floor(D1_MAX_BINDS / KEYED_WIDTH.txContexts)).map((c) =>
    db.prepare(KEYED.txContexts(c.length)).bind(...c),
  );
  if (stmts.length > 0) {
    for (const res of await db.batch<Row>(stmts)) {
      for (const r of res.results ?? []) contexts.set(String(r.tx_hash), decodeContext(r));
    }
  }

  return picked.map((p) => ({
    c: p.c,
    more: p.more,
    inputs: p.inputs.map((x): CredentialInput => {
      if (x.kind === 'ledger') return { kind: 'ledger', at: x.at, input: x.input };
      const tx = contexts.get(x.q.txHash);
      if (!tx) throw new Error(`queue entry without a tx context: ${x.q.txHash}`);
      return { kind: 'event', q: x.q, tx };
    }),
  }));
}

/** The frontiers, with L held below the lowest marker flagged for refetch. */
export async function frontiers(db: D1Database): Promise<Frontiers> {
  const r = await db.prepare(Q.frontiers.sql).first<Row>();
  if (!r) throw new Error('drep group meta row missing');
  const L = Number(r.L);
  return {
    L: r.refetch_h === null ? L : Math.min(L, Number(r.refetch_h) - 1),
    R: r.R === null ? null : Number(r.R),
    G: posFromRow(r, 'G'),
  };
}

/** The first recovery slot. */
export async function pendingRecovery(db: D1Database): Promise<Recovery | null> {
  const r = await db.prepare(Q.pendingRecovery.sql).first<Row>();
  if (!r) throw new Error('drep group meta row missing');
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
