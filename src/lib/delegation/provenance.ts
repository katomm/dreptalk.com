// Pure classification for the voting-power-origins analysis. No network, no
// D1: Koios rows in, buckets out. The core correction over a naive window
// filter: an arrival is the START of the current stint with self (derived
// from the account's full cert history with same-target re-certs collapsed),
// never the newest cert's epoch. /drep_delegators.epoch_no is only a safe
// pre-filter (the stint start is never later than the newest cert).
import type { AccountUpdateHistoryRow, DrepDelegatorRow, TxCert } from '../koios/client';

export const PROVENANCE_WINDOWS = [12, 36, 73] as const;
export type ProvenanceWindow = (typeof PROVENANCE_WINDOWS)[number];

// Provenance lookups per request are capped: the top candidates by current
// stake get analyzed, the rest is an honest "not analyzed" remainder. Start
// at 500, Task 7 measures real latency and may raise it.
export const ANALYSIS_CAP = 500;

export type SourceType = 'drep' | 'new' | 'abstain' | 'no_confidence' | 'unknown';

export interface ProvenanceSource {
  type: SourceType;
  /** Only for type 'drep'. */
  drepId?: string;
  /** Display name from our dreps table, filled by the compute layer. */
  name?: string | null;
  count: number;
  /** Lovelace sum of the delegators' CURRENT stake, decimal string. */
  amount: string;
  /** Arrivals in this bucket that had delegated to self before. */
  returningCount: number;
}

export interface ProvenancePayload {
  version: 1;
  computedAt: number;
  currentEpoch: number;
  windowEpochs: number;
  base: { count: number; amount: string };
  /** IDENTIFIED arrivals only. Candidates are never presented as arrivals. */
  sources: ProvenanceSource[];
  coverage: { analyzedCandidateCount: number; totalCandidateCount: number; analyzedCandidateAmount: string; totalCandidateAmount: string };
  /** Capped out or dropped by the tx budget: unclassified, may mix arrivals and base. */
  notAnalyzed: { count: number; amount: string } | null;
  /** Analyzed but the stint boundary stayed uncertain. */
  unresolved: { count: number; amount: string } | null;
  /** Analyzed candidates that turned out to be re-cert base. */
  reclassifiedBaseCount: number;
  returningTotal: number;
}

const ABSTAIN_KEYS = new Set(['drep_always_abstain', 'always_abstain', 'abstain']);
const NO_CONFIDENCE_KEYS = new Set(['drep_always_no_confidence', 'always_no_confidence', 'no_confidence']);

/** Canonicalizes a raw cert target: 'abstain', 'no_confidence', a drep id, or null. */
export function normalizeTarget(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (ABSTAIN_KEYS.has(raw)) return 'abstain';
  if (NO_CONFIDENCE_KEYS.has(raw)) return 'no_confidence';
  return raw;
}

function sumAmounts(rows: { amount: string }[]): string {
  let total = 0n;
  for (const r of rows) total += BigInt(r.amount);
  return total.toString();
}

/**
 * Splits current delegators into provenance candidates and proven base.
 * epoch_no is the NEWEST cert's epoch, so epoch_no < cutoff proves the stint
 * began before the window, epoch_no >= cutoff only makes the account a
 * candidate (classifyCandidate may still send it to base).
 */
export function prefilterDelegators(
  rows: DrepDelegatorRow[],
  currentEpoch: number,
  windowEpochs: number,
): { candidates: DrepDelegatorRow[]; base: { count: number; amount: string } } {
  const cutoff = currentEpoch - windowEpochs;
  const candidates: DrepDelegatorRow[] = [];
  const baseRows: DrepDelegatorRow[] = [];
  for (const row of rows) (row.epoch_no >= cutoff ? candidates : baseRows).push(row);
  return { candidates, base: { count: baseRows.length, amount: sumAmounts(baseRows) } };
}

function byAmountDesc(a: { amount: string }, b: { amount: string }): number {
  const av = BigInt(a.amount);
  const bv = BigInt(b.amount);
  return bv > av ? 1 : bv < av ? -1 : 0;
}

/** Caps candidates at the top `cap` by current stake, summing the remainder. */
export function capCandidates(
  candidates: DrepDelegatorRow[],
  cap: number = ANALYSIS_CAP,
): { analyzed: DrepDelegatorRow[]; notAnalyzed: { count: number; amount: string } | null } {
  if (candidates.length <= cap) return { analyzed: candidates, notAnalyzed: null };
  const sorted = [...candidates].sort(byAmountDesc);
  const rest = sorted.slice(cap);
  return { analyzed: sorted.slice(0, cap), notAnalyzed: { count: rest.length, amount: sumAmounts(rest) } };
}

export interface ResolvedEvent {
  txHash: string;
  epoch: number;
  slot: number;
  /** Canonical target, or null when the cert could not be resolved. */
  target: string | null;
}

interface VoteDelegationCertInfo {
  drep_id?: unknown;
  stake_address?: unknown;
}

/**
 * One account's delegation_drep events in chain order with resolved targets.
 * Within one tx the LAST matching vote_delegation cert wins (highest index),
 * a missing tx or cert yields target null (degraded, never thrown).
 */
export function resolveEvents(
  historyRows: AccountUpdateHistoryRow[],
  stakeAddress: string,
  certsByTx: Map<string, TxCert[]>,
): ResolvedEvent[] {
  return historyRows
    .filter((r) => r.stake_address === stakeAddress && r.action_type === 'delegation_drep')
    .sort((a, b) => a.absolute_slot - b.absolute_slot || a.tx_hash.localeCompare(b.tx_hash))
    .map((r) => {
      let target: string | null = null;
      for (const cert of certsByTx.get(r.tx_hash) ?? []) {
        if (cert.type !== 'vote_delegation') continue;
        const info = cert.info as VoteDelegationCertInfo | null;
        if (!info || info.stake_address !== stakeAddress) continue;
        target = normalizeTarget(info.drep_id);
      }
      return { txHash: r.tx_hash, epoch: r.epoch_no, slot: r.absolute_slot, target };
    });
}

export type Classification =
  | { kind: 'base' }
  | { kind: 'arrival'; source: { type: SourceType; drepId?: string }; returning: boolean }
  | { kind: 'unresolved' };

/**
 * Classifies one candidate from its resolved event list. Three analytically
 * distinct outcomes: 'base' (stint began before the cutoff, the re-cert
 * case), 'arrival' (stint start certainly in the window, its SOURCE may
 * still be 'unknown'), and 'unresolved' (not even the stint boundary is
 * certain). Unresolved is never an arrival. Nothing here ever throws.
 */
export function classifyCandidate(
  events: ResolvedEvent[],
  selfDrepId: string,
  cutoffEpoch: number,
): Classification {
  if (events.length === 0) return { kind: 'unresolved' };
  // Collapse consecutive same-target events into runs (first event of each
  // run keeps the run's epoch). A null target is never merged into a run.
  const runs: { target: string | null; epoch: number }[] = [];
  for (const e of events) {
    const prev = runs[runs.length - 1];
    if (prev && prev.target !== null && prev.target === e.target) continue;
    runs.push({ target: e.target, epoch: e.epoch });
  }
  const last = runs[runs.length - 1];
  // Current delegators must end on self, anything else is stint-uncertain.
  if (last.target !== selfDrepId) return { kind: 'unresolved' };
  if (last.epoch < cutoffEpoch) return { kind: 'base' };
  const priorRuns = runs.slice(0, -1);
  const sourceRun = priorRuns[priorRuns.length - 1];
  if (!sourceRun) return { kind: 'arrival', source: { type: 'new' }, returning: false };
  if (sourceRun.target === null) {
    // The unresolved predecessor might have been self. Inside the window,
    // either reading keeps the arrival in-window: arrival with unknown
    // source. Before the cutoff, it could extend the stint past the
    // boundary: unresolved.
    if (sourceRun.epoch >= cutoffEpoch) {
      return { kind: 'arrival', source: { type: 'unknown' }, returning: false };
    }
    return { kind: 'unresolved' };
  }
  // returning is computed over RESOLVED runs only: a null deeper in the
  // history can under-report returning, never mis-assign a source.
  const returning = priorRuns.slice(0, -1).some((r) => r.target === selfDrepId);
  if (sourceRun.target === 'abstain') return { kind: 'arrival', source: { type: 'abstain' }, returning };
  if (sourceRun.target === 'no_confidence') return { kind: 'arrival', source: { type: 'no_confidence' }, returning };
  return { kind: 'arrival', source: { type: 'drep', drepId: sourceRun.target }, returning };
}

export const PROVENANCE_PAYLOAD_VERSION = 1;

/** True when a cached payload was produced by the current semantics. */
export function isCurrentPayloadVersion(payloadJson: string): boolean {
  try {
    return (JSON.parse(payloadJson) as { version?: unknown }).version === PROVENANCE_PAYLOAD_VERSION;
  } catch {
    return false;
  }
}

// Hard budget for deduped tx_info lookups per request: churn-heavy whales
// cannot run the cost away. Overflow degrades the smallest-stake candidates
// into the unclassified bucket. Go/No-Go tuned by Task 7's measurements.
export const TX_LOOKUP_BUDGET = 2500;

/** Groups classified arrivals by source, sorts by amount descending. */
export function aggregateSources(
  arrivals: { row: DrepDelegatorRow; source: { type: SourceType; drepId?: string }; returning: boolean }[],
): ProvenanceSource[] {
  const byKey = new Map<string, { type: SourceType; drepId?: string; count: number; total: bigint; returningCount: number }>();
  for (const { row, source, returning } of arrivals) {
    const key = source.type === 'drep' ? `drep:${source.drepId}` : source.type;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { type: source.type, count: 0, total: 0n, returningCount: 0 };
      if (source.drepId !== undefined) entry.drepId = source.drepId;
      byKey.set(key, entry);
    }
    entry.count += 1;
    entry.total += BigInt(row.amount);
    if (returning) entry.returningCount += 1;
  }
  return [...byKey.values()]
    .sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : 0))
    .map(({ total, ...src }) => ({ ...src, amount: total.toString() }));
}
