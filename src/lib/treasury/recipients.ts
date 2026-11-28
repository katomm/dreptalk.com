// Groups every treasury withdrawal payload entry by recipient address, for the
// recipients overview and the address pages. Pure. Every amount on those pages
// is a sum over these summaries, so tiles, bar, chart and table always agree.
// Paid means enacted only. Time values are unix seconds: a payout belongs to the
// start of its enactment epoch, a request to its submission time.
import { epochStartUnix, type NetworkConfig } from '../config/network.js';
import { recipientKeyId, recipientKeyToBech32, treasuryEntries, type RecipientKey } from '../governance/onchain.js';

/** One TreasuryWithdrawals row of governance_actions, payload as raw text. */
export interface TreasuryActionRow {
  id: string;
  title: string | null;
  status: string;
  returnAddress: string | null;
  submittedEpoch: number | null;
  /** Unix milliseconds, as stored in governance_actions.submitted_at. */
  submittedAt: number | null;
  enactedEpoch: number | null;
  slug: string | null;
  payload: string;
}

export interface RecipientShare {
  action: TreasuryActionRow;
  /** This address's part of the action, all its entries summed. */
  lovelace: bigint;
  /** Unix seconds of the enactment epoch start, enacted shares only. */
  paidAt: number | null;
  /** Unix seconds of the submission, null without any submission info. */
  requestedAt: number | null;
}

export interface RecipientSummary {
  /** Null for the bucket of entries without a valid hash. */
  key: RecipientKey | null;
  id: string;
  address: string | null;
  paid: bigint;
  notPaid: bigint;
  notPaidByStatus: { status: string; lovelace: bigint }[];
  /** Distinct actions naming this address. */
  withdrawals: number;
  /** Newest submission first. */
  shares: RecipientShare[];
  firstPaidAt: number | null;
  lastPaidAt: number | null;
  proposers: { returnAddress: string | null; count: number }[];
}

export const UNKNOWN_RECIPIENT_ID = 'unknown';

function parsePayload(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function requestedAtOf(r: TreasuryActionRow, cfg: NetworkConfig): number | null {
  if (r.submittedAt != null) return r.submittedAt / 1000;
  return r.submittedEpoch != null ? epochStartUnix(r.submittedEpoch, cfg) : null;
}

export function groupRecipients(rows: TreasuryActionRow[], cfg: NetworkConfig): RecipientSummary[] {
  const byId = new Map<string, { key: RecipientKey | null; shares: Map<string, RecipientShare> }>();
  for (const r of rows) {
    const entries = treasuryEntries(parsePayload(r.payload));
    if (entries.length === 0) continue;
    const enacted = r.status === 'enacted';
    for (const e of entries) {
      const id = e.key ? recipientKeyId(e.key) : UNKNOWN_RECIPIENT_ID;
      let g = byId.get(id);
      if (!g) {
        g = { key: e.key, shares: new Map() };
        byId.set(id, g);
      }
      const prev = g.shares.get(r.id);
      if (prev) {
        prev.lovelace += e.lovelace;
        continue;
      }
      g.shares.set(r.id, {
        action: r,
        lovelace: e.lovelace,
        paidAt: enacted && r.enactedEpoch != null ? epochStartUnix(r.enactedEpoch, cfg) : null,
        requestedAt: requestedAtOf(r, cfg),
      });
    }
  }

  const out: RecipientSummary[] = [];
  for (const [id, g] of byId) {
    const shares = [...g.shares.values()].sort((a, b) => (b.requestedAt ?? -1) - (a.requestedAt ?? -1));
    let paid = 0n;
    let notPaid = 0n;
    const byStatus = new Map<string, bigint>();
    const proposers = new Map<string | null, number>();
    let firstPaidAt: number | null = null;
    let lastPaidAt: number | null = null;
    for (const s of shares) {
      if (s.action.status === 'enacted') {
        paid += s.lovelace;
        if (s.paidAt != null) {
          firstPaidAt = firstPaidAt == null ? s.paidAt : Math.min(firstPaidAt, s.paidAt);
          lastPaidAt = lastPaidAt == null ? s.paidAt : Math.max(lastPaidAt, s.paidAt);
        }
      } else {
        notPaid += s.lovelace;
        byStatus.set(s.action.status, (byStatus.get(s.action.status) ?? 0n) + s.lovelace);
      }
      proposers.set(s.action.returnAddress, (proposers.get(s.action.returnAddress) ?? 0) + 1);
    }
    out.push({
      key: g.key,
      id,
      address: g.key ? recipientKeyToBech32(g.key, cfg.network) : null,
      paid,
      notPaid,
      notPaidByStatus: [...byStatus].map(([status, lovelace]) => ({ status, lovelace })),
      withdrawals: shares.length,
      shares,
      firstPaidAt,
      lastPaidAt,
      proposers: [...proposers]
        .map(([returnAddress, count]) => ({ returnAddress, count }))
        .sort((a, b) => b.count - a.count || String(a.returnAddress).localeCompare(String(b.returnAddress))),
    });
  }
  return out.sort((a, b) => cmpDesc(a.paid, b.paid) || cmpDesc(a.notPaid, b.notPaid) || a.id.localeCompare(b.id));
}

function cmpDesc(a: bigint, b: bigint): number {
  return a === b ? 0 : a > b ? -1 : 1;
}

export function sumPaid(list: RecipientSummary[]): bigint {
  return list.reduce((acc, s) => acc + s.paid, 0n);
}

export interface BarSegment {
  /** Summary id, or 'other' for the folded rest. */
  id: string;
  summary: RecipientSummary | null;
  lovelace: bigint;
  pct: number;
  /** Number of addresses in the folded segment, 0 otherwise. */
  folded: number;
}

export const OTHER_SEGMENT_ID = 'other';

/** The two largest paid addresses plus every one at or above minPct, the rest folded. */
export function concentrationSegments(list: RecipientSummary[], minPct = 5): BarSegment[] {
  const paidList = list.filter((s) => s.paid > 0n).sort((a, b) => cmpDesc(a.paid, b.paid));
  const total = sumPaid(paidList);
  if (total === 0n) return [];
  const pct = (v: bigint) => Number((v * 1_000_000n) / total) / 10_000;
  const segments: BarSegment[] = [];
  let restLovelace = 0n;
  let restCount = 0;
  paidList.forEach((s, i) => {
    if (i < 2 || pct(s.paid) >= minPct) segments.push({ id: s.id, summary: s, lovelace: s.paid, pct: pct(s.paid), folded: 0 });
    else {
      restLovelace += s.paid;
      restCount++;
    }
  });
  if (restCount > 0) segments.push({ id: OTHER_SEGMENT_ID, summary: null, lovelace: restLovelace, pct: pct(restLovelace), folded: restCount });
  return segments;
}

function quarterOf(sec: number): { year: number; q: number } {
  const d = new Date(sec * 1000);
  return { year: d.getUTCFullYear(), q: Math.floor(d.getUTCMonth() / 3) + 1 };
}

/**
 * Paid per calendar quarter, by segment id (ids outside segmentIds count as
 * 'other'). From the first quarter with a payout to the quarter of nowSec,
 * empty quarters included.
 */
export function paidByQuarter(
  list: RecipientSummary[],
  segmentIds: string[],
  nowSec: number,
): { quarter: string; bySegment: Map<string, bigint> }[] {
  const ids = new Set(segmentIds);
  const buckets = new Map<number, Map<string, bigint>>();
  let first: number | null = null;
  for (const s of list) {
    const seg = ids.has(s.id) ? s.id : OTHER_SEGMENT_ID;
    for (const sh of s.shares) {
      if (sh.action.status !== 'enacted' || sh.paidAt == null) continue;
      const { year, q } = quarterOf(sh.paidAt);
      const idx = year * 4 + (q - 1);
      first = first == null ? idx : Math.min(first, idx);
      const m = buckets.get(idx) ?? new Map<string, bigint>();
      m.set(seg, (m.get(seg) ?? 0n) + sh.lovelace);
      buckets.set(idx, m);
    }
  }
  if (first == null) return [];
  const now = quarterOf(nowSec);
  const last = Math.max(now.year * 4 + (now.q - 1), ...buckets.keys());
  const out: { quarter: string; bySegment: Map<string, bigint> }[] = [];
  for (let i = first; i <= last; i++) out.push({ quarter: `${Math.floor(i / 4)} Q${(i % 4) + 1}`, bySegment: buckets.get(i) ?? new Map() });
  return out;
}

/** Paid by payout year and not paid by submission year, oldest year first. */
export function yearRows(s: RecipientSummary): { year: number; paid: bigint; notPaid: bigint }[] {
  const years = new Map<number, { paid: bigint; notPaid: bigint }>();
  const add = (sec: number, field: 'paid' | 'notPaid', v: bigint) => {
    const y = new Date(sec * 1000).getUTCFullYear();
    const r = years.get(y) ?? { paid: 0n, notPaid: 0n };
    r[field] += v;
    years.set(y, r);
  };
  for (const sh of s.shares) {
    if (sh.action.status === 'enacted') {
      if (sh.paidAt != null) add(sh.paidAt, 'paid', sh.lovelace);
    } else if (sh.requestedAt != null) add(sh.requestedAt, 'notPaid', sh.lovelace);
  }
  return [...years].sort((a, b) => a[0] - b[0]).map(([year, r]) => ({ year, ...r }));
}

/** Paid with an enactment epoch in [fromEpoch, toEpoch]. */
export function paidInEpochs(list: RecipientSummary[], fromEpoch: number, toEpoch: number): bigint {
  let sum = 0n;
  for (const s of list)
    for (const sh of s.shares) {
      const e = sh.action.enactedEpoch;
      if (sh.action.status === 'enacted' && e != null && e >= fromEpoch && e <= toEpoch) sum += sh.lovelace;
    }
  return sum;
}

/** Paid with a payout date in the given UTC calendar year. */
export function paidInYear(list: RecipientSummary[], year: number): bigint {
  let sum = 0n;
  for (const s of list)
    for (const sh of s.shares)
      if (sh.action.status === 'enacted' && sh.paidAt != null && new Date(sh.paidAt * 1000).getUTCFullYear() === year) sum += sh.lovelace;
  return sum;
}
