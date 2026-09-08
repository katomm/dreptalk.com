/// <reference types="@cloudflare/workers-types" />
// The window data pack: one JSON document holding everything a Governance
// Review edition for a window of epochs is written from. Every number a
// published edition shows must trace to a field of this pack, so the field
// names and their semantics are the contract, not an implementation detail.
//
// Two rules run through the whole file:
//  - Actions are grouped by their lifecycle epochs, never by the status they
//    carry today. An action that expired two epochs after the window was open
//    during it, and the edition has to say so.
//  - Power is historical power read from drep_voting_power_history, never
//    drep_votes.voted_power (which is sync-time power and drifts).
//
// All ada amounts are numbers in ada and their field names end in Ada.
import { getCommitteeTimeline } from '../db/committee.js';
import { activeCommitteeMembersAt } from '../koios/committeeTimeline.js';
import { listEpochStats } from '../db/governanceEpochStats.js';
import { EPOCH_STATS_METRICS, type EpochStatsMetricKey } from '../analytics/epochStatsContract.js';
import type { EpochStatsRow } from '../analytics/epochStats.js';
import { epochFromUnix, type NetworkConfig } from '../config/network.js';
import { readThresholdSnapshot } from '../governance/thresholds.js';
import { govActionHref } from './links.js';
import { NCL_PERIODS } from '../../../config/ncl-periods.js';
import { nclStatusFor } from '../governance/ncl.js';
import { epochReadiness, watermarks, type EpochReadiness } from './readiness.js';
import { epochBoundsUnix, lovelaceToAda, REVIEW_PACK_VERSION } from './units.js';
import {
  readCcMemberNames,
  readCommitteeMinSizeAt,
  readDrepNames,
  readEarlierActionsOfTypes,
  readEnactedWithdrawals,
  readPowerCoverage,
  readPowerDrops,
  readPowerForDreps,
  readTopDrepsAtEpoch,
  readVoteHistoryForActions,
  readVoteHistoryInRange,
  readVotesForActions,
  readVotesInRange,
  readWindowActions,
  type ActionDbRow,
  type VoteRow,
} from './packReads.js';

export interface PackAction {
  id: string;
  url: string;
  type: string;
  title: string;
  status: string;
  submittedEpoch: number | null;
  ratifiedEpoch: number | null;
  enactedEpoch: number | null;
  decidedEpoch: number | null;
  expiryEpoch: number | null;
  withdrawalAda: number | null;
  tally: {
    drep: { yes: number; no: number; abstain: number; yesPct: number | null; noPct: number | null; yesPowerAda: number | null; noPowerAda: number | null; abstainPowerAda: number | null; abstainExcluded: true };
    spo: { yes: number; no: number; abstain: number; yesPct: number | null; noPct: number | null };
    cc: { yes: number; no: number; abstain: number; yesPct: number | null; abstainExcluded: true };
  };
  thresholds: { drep: number | null; spo: number | null; cc: number | null; ccBelowMinSize: boolean | null };
  eventsInWindow: Array<{ kind: 'submitted' | 'ratified' | 'enacted' | 'expired' | 'dropped' | 'closed'; epoch: number }>;
  open: boolean;
  /** The close epoch was inferred from decided_epoch because the action predates the ratified_epoch column. */
  closeEpochDerived?: true;
}

/** Unit of a series value, so a renderer never has to guess how to format it. */
export type PackUnit = 'ada' | 'count' | 'pct' | 'ratio';

export interface PackRecord {
  metric: string;
  unit: PackUnit;
  rangeFrom: number;
  rangeTo: number;
  endValue: number;
  min: { epoch: number; value: number };
  max: { epoch: number; value: number };
  lastEpochAtOrBelow: number | null;
  lastEpochAtOrAbove: number | null;
}

export interface WindowPack {
  packVersion: number;
  network: string;
  window: { from: number; to: number; startsAt: string; endsAt: string; asOf: string | null; committeeAsOf: number; readiness: { ready: boolean; epochs: Record<string, EpochReadiness> } };
  actions: { events: PackAction[]; closingAtBoundary: PackAction[]; open: PackAction[]; comparisons: PackAction[] };
  votesByEpoch: Array<{ epoch: number; role: string; votesCast: number; finalVoters: number }>;
  /** Totals over the whole window, counted once per voter. Never the sum of the votesByEpoch rows. */
  windowTotals: { votesCast: number; finalDrepVoters: number; finalSpoVoters: number };
  voteTimeline: Record<string, Array<{ epoch: number; byCount: { yes: number; no: number; abstain: number }; byPowerAda: { yes: number; no: number; abstain: number } | null }>>;
  topVoters: Record<string, Array<{ drepId: string; name: string | null; vote: string; epochCast: number | null; powerAda: number | null; powerAsOfEpoch: number }>>;
  topDreps: Array<{ drepId: string; name: string | null; powerAda: number; ballots: Record<string, string | 'did not vote'> }>;
  ccVotes: Record<string, Array<{ hotKeyHex: string; name: string | null; vote: string; epochCast: number | null; activeAtDecision: boolean | null }>>;
  committee: { asOfEpoch: number; members: Array<{ coldKeyHex: string; termExpiration: number; authorizedFrom: number; resignedAt: number | null }>; minSize: { value: number | null; observedAtEpoch: number | null; reason?: string }; endingWithin12: number };
  epochStats: { rows: Array<Record<string, number | string | boolean | null> & { epoch: number }>; metrics: Record<string, { column: string; definition: string; reliability: string; unit: PackUnit }> };
  powerHistory: { coverage: { from: number; to: number } | null; covered: boolean; coveredAtTo: boolean; drops: Array<{ drepId: string; name: string | null; fromAda: number; toAda: number; deltaAda: number; deregistered: boolean }> | null; dropsRange: { from: number; to: number } | null };
  /** The curated net change limit periods this window falls in, with what the
   *  ceiling had absorbed by `epochTo`. An NCL is set by an info action and has
   *  no on-chain value, so the ceiling itself comes from the site's curated
   *  registry, the consumption from the same enacted withdrawals the treasury
   *  section counts. */
  ncl: Array<{
    id: string;
    label: string;
    ceilingAda: number;
    /** The ceiling before it was raised, and the size of the raise, when the registry records one. */
    previousCeilingAda: number | null;
    raisedByAda: number | null;
    startEpoch: number;
    endEpoch: number;
    definingActionIds: string[];
    relatedActionIds: string[];
    /** Defining actions of this period with a lifecycle event inside the window. */
    definedInWindow: string[];
    consumedAda: number;
    remainingAda: number;
    consumedPct: number;
    withdrawalCount: number;
    unreadableCount: number;
    asOfEpoch: number;
  }>;
  treasury: { byEpochAda: Array<{ epoch: number; balanceAda: number | null }>; enactedByEpoch: Array<{ epoch: number; count: number; totalAda: number; unreadableCount: number; ids: string[] }>; largestSingle: Array<{ id: string; title: string; epoch: number; ada: number }>; totalEnactedAda: number; unreadablePayloads: Array<{ id: string; epoch: number }> };
  records: PackRecord[];
  spo: Record<string, { yes: number; no: number; abstain: number }>;
}

/**
 * Action types rare enough that one of them deciding is itself the story, so
 * the signals surface them and earlier ones of the same type are pulled in for
 * comparison. Info actions and treasury withdrawals are routine and excluded.
 */
export const RARE_TYPES = new Set(['HardForkInitiation', 'NewConstitution', 'NewCommittee', 'NoConfidence', 'ParameterChange']);

/** Lead-in epochs read before the window, so a chart has context around it. */
const LEAD_IN_EPOCHS = 20;
/** Lead-in epochs for the vote activity series, which is read per epoch. */
const VOTE_LEAD_IN_EPOCHS = 4;
const TOP_DREPS = 15;
const TOP_VOTERS = 12;
const TOP_WITHDRAWALS = 5;
const MAX_DROPS = 10;
/** A committee term expiring this soon after the window is worth a sentence. */
const TERM_HORIZON = 12;

export function withdrawalLovelace(payload: string | null): bigint | null {
  if (!payload) return null;
  try {
    const p = JSON.parse(payload) as { tag?: string; contents?: unknown[] };
    if (p.tag !== 'TreasuryWithdrawals' || !Array.isArray(p.contents)) return null;
    const list = p.contents[0] as Array<[unknown, number]>;
    if (!Array.isArray(list)) return null;
    return list.reduce((a, [, amt]) => a + BigInt(Math.round(Number(amt))), 0n);
  } catch {
    return null;
  }
}

export function withdrawalAda(payload: string | null): number | null {
  const lovelace = withdrawalLovelace(payload);
  return lovelace == null ? null : lovelaceToAda(lovelace.toString());
}

/** The parameter names a ParameterChange payload touches (the keys of contents[1]). */
function changedParameterNames(payload: string | null): string[] {
  if (!payload) return [];
  try {
    const p = JSON.parse(payload) as { tag?: string; contents?: unknown[] };
    if (p.tag !== 'ParameterChange' || !Array.isArray(p.contents)) return [];
    const map = p.contents[1];
    return map && typeof map === 'object' ? Object.keys(map) : [];
  } catch {
    return [];
  }
}

function eventsInWindow(r: ActionDbRow, from: number, to: number): PackAction['eventsInWindow'] {
  const inW = (e: number | null): e is number => e != null && e >= from && e <= to;
  const out: PackAction['eventsInWindow'] = [];
  if (inW(r.submitted_epoch)) out.push({ kind: 'submitted', epoch: r.submitted_epoch });
  if (inW(r.ratified_epoch)) out.push({ kind: 'ratified', epoch: r.ratified_epoch });
  if (inW(r.enacted_epoch)) out.push({ kind: 'enacted', epoch: r.enacted_epoch });
  if ((r.status === 'expired' || r.status === 'dropped' || r.status === 'closed') && inW(r.decided_epoch)) {
    out.push({ kind: r.status, epoch: r.decided_epoch });
  }
  return out;
}

/**
 * Voting closes at the ratification epoch, or at the terminal epoch for
 * expired, dropped and closed actions. Null while still open. Actions from
 * before the ratified_epoch column exists carry only an enactment epoch, and
 * ratification is the epoch before enactment, so that is derived rather than
 * reported as "still open" (which would put a long-settled action in the
 * window's open list).
 */
function closeEpoch(r: ActionDbRow): { epoch: number | null; derived: boolean } {
  if (r.ratified_epoch != null) return { epoch: r.ratified_epoch, derived: false };
  if (r.status === 'enacted') {
    return r.decided_epoch != null ? { epoch: r.decided_epoch - 1, derived: true } : { epoch: null, derived: false };
  }
  return { epoch: r.decided_epoch, derived: false };
}

export function toPackAction(r: ActionDbRow, from: number, to: number): PackAction {
  const th = readThresholdSnapshot(r.thresholds_json);
  const close = closeEpoch(r);
  const action: PackAction = {
    id: r.id,
    url: govActionHref(r.id),
    type: r.type,
    title: r.title,
    status: r.status,
    submittedEpoch: r.submitted_epoch,
    ratifiedEpoch: r.ratified_epoch,
    enactedEpoch: r.enacted_epoch,
    decidedEpoch: r.decided_epoch,
    expiryEpoch: r.expiry_epoch,
    withdrawalAda: r.type === 'TreasuryWithdrawals' ? withdrawalAda(r.onchain_payload) : null,
    tally: {
      drep: {
        yes: r.drep_yes, no: r.drep_no, abstain: r.drep_abstain, yesPct: r.drep_yes_pct, noPct: r.drep_no_pct,
        yesPowerAda: lovelaceToAda(r.drep_yes_power), noPowerAda: lovelaceToAda(r.drep_no_power), abstainPowerAda: lovelaceToAda(r.drep_abstain_power),
        abstainExcluded: true,
      },
      spo: { yes: r.spo_yes, no: r.spo_no, abstain: r.spo_abstain, yesPct: r.spo_yes_pct, noPct: r.spo_no_pct },
      cc: { yes: r.cc_yes, no: r.cc_no, abstain: r.cc_abstain, yesPct: r.cc_yes_pct, abstainExcluded: true },
    },
    thresholds: { drep: th?.drep ?? null, spo: th?.spo ?? null, cc: th?.cc ?? null, ccBelowMinSize: th?.ccBelowMinSize ?? null },
    eventsInWindow: eventsInWindow(r, from, to),
    open: r.status === 'active',
  };
  if (close.derived) action.closeEpochDerived = true;
  return action;
}

/** Whether the action's voting window was still running at the end of the pack's window. */
function openDuring(r: ActionDbRow, to: number): boolean {
  if (r.submitted_epoch == null || r.submitted_epoch > to) return false;
  const close = closeEpoch(r).epoch;
  return close == null || close > to;
}

interface GroupedActions {
  events: ActionDbRow[];
  closingAtBoundary: ActionDbRow[];
  open: ActionDbRow[];
}

/**
 * Splits the candidate rows by lifecycle, never by today's status. A row with
 * an event inside the window stays in events even when it is still open (its
 * `open` flag says so), so an action is never reported twice.
 */
function groupActions(rows: ActionDbRow[], from: number, to: number): GroupedActions {
  const out: GroupedActions = { events: [], closingAtBoundary: [], open: [] };
  for (const r of rows) {
    if (eventsInWindow(r, from, to).length > 0) out.events.push(r);
    else if (openDuring(r, to)) {
      if (r.expiry_epoch === to + 1) out.closingAtBoundary.push(r);
      else out.open.push(r);
    }
  }
  return out;
}

const VOTE_BUCKETS = { Yes: 'yes', No: 'no', Abstain: 'abstain' } as const;
type VoteBucket = (typeof VOTE_BUCKETS)[keyof typeof VOTE_BUCKETS];

function bucketOf(vote: string): VoteBucket | null {
  return VOTE_BUCKETS[vote as keyof typeof VOTE_BUCKETS] ?? null;
}

function emptyCounts(): Record<VoteBucket, number> {
  return { yes: 0, no: 0, abstain: 0 };
}

/**
 * Votes cast and distinct final voters per epoch and role. The votes-cast
 * count includes superseded votes (a re-vote is a second row), final voters
 * count each voter once for the epoch its surviving vote was cast in.
 */
function votesByEpoch(current: VoteRow[], history: VoteRow[], cfg: NetworkConfig): WindowPack['votesByEpoch'] {
  const cast = new Map<string, number>();
  const voters = new Map<string, Set<string>>();
  const key = (epoch: number, role: string) => `${epoch}|${role}`;
  for (const r of [...current, ...history]) {
    if (r.block_time == null) continue;
    const k = key(epochFromUnix(r.block_time, cfg), r.voter_role);
    cast.set(k, (cast.get(k) ?? 0) + 1);
  }
  for (const r of current) {
    if (r.block_time == null) continue;
    const k = key(epochFromUnix(r.block_time, cfg), r.voter_role);
    const set = voters.get(k) ?? new Set<string>();
    set.add(r.voter_id);
    voters.set(k, set);
  }
  return [...cast.keys()]
    .map((k) => {
      const [epoch, role] = k.split('|');
      return { epoch: Number(epoch), role, votesCast: cast.get(k) ?? 0, finalVoters: voters.get(k)?.size ?? 0 };
    })
    .sort((a, b) => a.epoch - b.epoch || a.role.localeCompare(b.role));
}

/**
 * The same figures over the whole window range, computed distinct across the
 * range rather than summed over the per-epoch rows: a DRep whose surviving
 * ballots fall in two epochs of the window is one final voter, not two. An
 * edition's numbers strip reads these, never a single epoch's row.
 */
function windowTotals(current: VoteRow[], history: VoteRow[], cfg: NetworkConfig, from: number, to: number): WindowPack['windowTotals'] {
  const inRange = (r: VoteRow): boolean => {
    if (r.block_time == null) return false;
    const e = epochFromUnix(r.block_time, cfg);
    return e >= from && e <= to;
  };
  let votesCast = 0;
  for (const r of current) if (inRange(r)) votesCast += 1;
  for (const r of history) if (inRange(r)) votesCast += 1;
  const dreps = new Set<string>();
  const spos = new Set<string>();
  for (const r of current) {
    if (!inRange(r)) continue;
    if (r.voter_role === 'DRep') dreps.add(r.voter_id);
    else if (r.voter_role === 'SPO') spos.add(r.voter_id);
  }
  return { votesCast, finalDrepVoters: dreps.size, finalSpoVoters: spos.size };
}

/** Power in ada of one DRep at one epoch, keyed for the in-memory lookups below. */
const powerKey = (drepId: string, epoch: number) => `${drepId}|${epoch}`;

/**
 * Per action, the votes cast in each epoch, by count and (only for epochs the
 * power rows were actually read for) by the voters' power at that epoch. Never
 * cumulative: a row says what happened during that epoch. An epoch outside
 * `powerRange` reports byPowerAda as null rather than as zero, an unread epoch
 * must never look like an epoch in which nobody held power.
 */
function voteTimeline(
  ids: string[],
  votes: VoteRow[],
  cfg: NetworkConfig,
  power: Map<string, number>,
  powerRange: { from: number; to: number } | null,
): WindowPack['voteTimeline'] {
  const perAction = new Map<string, Map<number, { byCount: Record<VoteBucket, number>; byPowerAda: Record<VoteBucket, number>; powerKnown: boolean }>>();
  for (const id of ids) perAction.set(id, new Map());
  for (const v of votes) {
    if (v.block_time == null) continue;
    const bucket = bucketOf(v.vote);
    const epochs = perAction.get(v.ga_id);
    if (!bucket || !epochs) continue;
    const epoch = epochFromUnix(v.block_time, cfg);
    const row = epochs.get(epoch) ?? { byCount: emptyCounts(), byPowerAda: emptyCounts(), powerKnown: powerRange != null && epoch >= powerRange.from && epoch <= powerRange.to };
    row.byCount[bucket] += 1;
    // Only DReps carry voting power. SPO and committee ballots are counted, never weighted.
    if (row.powerKnown && v.voter_role === 'DRep') row.byPowerAda[bucket] += power.get(powerKey(v.voter_id, epoch)) ?? 0;
    epochs.set(epoch, row);
  }
  const out: WindowPack['voteTimeline'] = {};
  for (const [id, epochs] of perAction) {
    out[id] = [...epochs.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([epoch, row]) => ({ epoch, byCount: { ...row.byCount }, byPowerAda: row.powerKnown ? { ...row.byPowerAda } : null }));
  }
  return out;
}

/** Per action, the largest DRep voters by their power at the window's end. */
function topVoters(
  ids: string[],
  current: VoteRow[],
  cfg: NetworkConfig,
  power: Map<string, number>,
  names: Map<string, string | null>,
  to: number,
): WindowPack['topVoters'] {
  const out: WindowPack['topVoters'] = {};
  for (const id of ids) out[id] = [];
  for (const v of current) {
    if (v.voter_role !== 'DRep' || !out[v.ga_id]) continue;
    out[v.ga_id].push({
      drepId: v.voter_id,
      name: names.get(v.voter_id) ?? null,
      vote: v.vote,
      epochCast: v.block_time == null ? null : epochFromUnix(v.block_time, cfg),
      powerAda: power.get(powerKey(v.voter_id, to)) ?? null,
      powerAsOfEpoch: to,
    });
  }
  for (const id of ids) {
    out[id] = out[id]
      .sort((a, b) => (b.powerAda ?? -1) - (a.powerAda ?? -1) || a.drepId.localeCompare(b.drepId))
      .slice(0, TOP_VOTERS);
  }
  return out;
}

/** Per action, the committee ballots with whether the member could act at the decision. */
function ccVotes(
  actions: PackAction[],
  current: VoteRow[],
  cfg: NetworkConfig,
  names: Map<string, string>,
  hotToCold: Map<string, string>,
  activeAt: (epoch: number) => Set<string>,
  to: number,
): WindowPack['ccVotes'] {
  const decidedBy = new Map(actions.map((a) => [a.id, a.decidedEpoch ?? to]));
  const out: WindowPack['ccVotes'] = {};
  for (const a of actions) out[a.id] = [];
  for (const v of current) {
    if (v.voter_role !== 'ConstitutionalCommittee' || !out[v.ga_id] || !v.voter_hex) continue;
    const hot = v.voter_hex.toLowerCase();
    const cold = hotToCold.get(hot);
    out[v.ga_id].push({
      hotKeyHex: hot,
      name: names.get(hot) ?? null,
      vote: v.vote,
      epochCast: v.block_time == null ? null : epochFromUnix(v.block_time, cfg),
      // Null, not false: an unmapped hot key means we cannot tell, and a
      // committee ballot reported as inactive when it was not is a wrong claim.
      activeAtDecision: cold == null ? null : activeAt(decidedBy.get(v.ga_id) ?? to).has(cold),
    });
  }
  for (const id of Object.keys(out)) out[id].sort((a, b) => (a.epochCast ?? 0) - (b.epochCast ?? 0) || a.hotKeyHex.localeCompare(b.hotKeyHex));
  return out;
}

/** Per action, the SPO ballot counts. */
function spoCounts(ids: string[], current: VoteRow[]): WindowPack['spo'] {
  const out: WindowPack['spo'] = {};
  for (const id of ids) out[id] = emptyCounts();
  for (const v of current) {
    if (v.voter_role !== 'SPO' || !out[v.ga_id]) continue;
    const bucket = bucketOf(v.vote);
    if (bucket) out[v.ga_id][bucket] += 1;
  }
  return out;
}

interface StatsField {
  /** Field name in the pack's flat epoch rows and in epochStats.metrics. */
  field: string;
  /** Key in the epoch-stats metric contract, which doubles as the EpochStatsRow field. */
  key: EpochStatsMetricKey;
  unit: PackUnit;
}

// The pack renames the two lovelace columns to their ada equivalents, so a
// field name never promises a unit the value is not in. The contract entry
// (and its column) still comes from EPOCH_STATS_METRICS under the same field
// name, so a reader can always trace a series back to its stored column.
const STATS_FIELDS: StatsField[] = [
  { field: 'totalDrepPowerAda', key: 'totalDrepPower', unit: 'ada' },
  { field: 'poweredDrepCount', key: 'poweredDrepCount', unit: 'count' },
  { field: 'recentlyVotingDrepCount', key: 'recentlyVotingDrepCount', unit: 'count' },
  { field: 'silentPoweredDrepCount', key: 'silentPoweredDrepCount', unit: 'count' },
  { field: 'abstainPowerAda', key: 'abstainPower', unit: 'ada' },
  { field: 'ancPowerAda', key: 'ancPower', unit: 'ada' },
  { field: 'delegatorTotal', key: 'delegatorTotal', unit: 'count' },
  { field: 'abstainDelegators', key: 'abstainDelegators', unit: 'count' },
  { field: 'ancDelegators', key: 'ancDelegators', unit: 'count' },
  { field: 'gini', key: 'gini', unit: 'ratio' },
  { field: 'top10SharePct', key: 'top10SharePct', unit: 'pct' },
  { field: 'minCoalition50', key: 'minCoalition50', unit: 'count' },
  { field: 'minCoalition67', key: 'minCoalition67', unit: 'count' },
  { field: 'votesCast', key: 'votesCast', unit: 'count' },
  { field: 'treasuryAda', key: 'treasuryLovelace', unit: 'ada' },
];

/** The series a records pass runs over, in the order the pack reports them. */
const RECORD_FIELDS = ['recentlyVotingDrepCount', 'votesCast', 'totalDrepPowerAda', 'poweredDrepCount', 'top10SharePct', 'gini', 'treasuryAda', 'delegatorTotal']
  .map((field) => STATS_FIELDS.find((f) => f.field === field) as StatsField);

function statValue(row: EpochStatsRow, f: StatsField): number | null {
  const raw = row[f.key as keyof EpochStatsRow];
  if (raw == null) return null;
  if (f.unit === 'ada') return lovelaceToAda(raw as string);
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function packStatsRow(row: EpochStatsRow): Record<string, number | string | boolean | null> & { epoch: number } {
  const out: Record<string, number | string | boolean | null> & { epoch: number } = { epoch: row.epoch, voteDataComplete: row.voteDataComplete };
  for (const f of STATS_FIELDS) out[f.field] = statValue(row, f);
  return out;
}

function statsMetrics(): WindowPack['epochStats']['metrics'] {
  const out: WindowPack['epochStats']['metrics'] = {};
  for (const f of STATS_FIELDS) {
    const m = EPOCH_STATS_METRICS[f.key];
    out[f.field] = { column: m.column, definition: m.definition, reliability: m.reliability, unit: f.unit };
  }
  return out;
}

/**
 * Records over the longest run of usable epochs ending at the window's end.
 * A flagged series is only usable where vote_data_complete is set, so a record
 * is never claimed across an epoch whose votes were still being swept, and the
 * reported range says exactly how far back the claim reaches.
 */
function buildRecords(rows: EpochStatsRow[], to: number): PackRecord[] {
  const byEpoch = new Map(rows.map((r) => [r.epoch, r]));
  const out: PackRecord[] = [];
  for (const f of RECORD_FIELDS) {
    const flagged = EPOCH_STATS_METRICS[f.key].reliability === 'flagged';
    const usable = (epoch: number): number | null => {
      const row = byEpoch.get(epoch);
      if (!row || (flagged && !row.voteDataComplete)) return null;
      return statValue(row, f);
    };
    const endValue = usable(to);
    if (endValue == null) continue;
    const series: Array<{ epoch: number; value: number }> = [];
    for (let e = to; ; e--) {
      const v = usable(e);
      if (v == null) break;
      series.push({ epoch: e, value: v });
    }
    series.reverse();
    let min = series[0];
    let max = series[0];
    for (const p of series) {
      if (p.value < min.value) min = p;
      if (p.value > max.value) max = p;
    }
    const earlier = series.filter((p) => p.epoch < to);
    const lastAtOrBelow = [...earlier].reverse().find((p) => p.value <= endValue) ?? null;
    const lastAtOrAbove = [...earlier].reverse().find((p) => p.value >= endValue) ?? null;
    out.push({
      metric: f.field,
      unit: f.unit,
      rangeFrom: series[0].epoch,
      rangeTo: to,
      endValue,
      min: { epoch: min.epoch, value: min.value },
      max: { epoch: max.epoch, value: max.value },
      lastEpochAtOrBelow: lastAtOrBelow?.epoch ?? null,
      lastEpochAtOrAbove: lastAtOrAbove?.epoch ?? null,
    });
  }
  return out;
}

/**
 * Treasury as of the window's end. The withdrawal rows are already capped at
 * that epoch by their read, so a withdrawal enacted later can never enter a
 * historical pack, neither in the per-epoch groups nor in the lifetime total.
 *
 * A withdrawal whose on-chain payload cannot be read is a gap, not an amount of
 * zero: counting it as zero would understate every sum and the ranking without
 * saying so. Such a row keeps its place in the per-epoch count, stays out of
 * the sums and the ranking, and is listed in `unreadablePayloads` so an edition
 * can name the limitation instead of publishing a total that is quietly short.
 */
function buildTreasury(
  statsRows: EpochStatsRow[],
  withdrawals: Array<{ id: string; title: string | null; enacted_epoch: number; onchain_payload: string | null }>,
  from: number,
): WindowPack['treasury'] {
  const byEpochAda = statsRows.map((r) => ({ epoch: r.epoch, balanceAda: lovelaceToAda(r.treasuryLovelace) }));
  const withAda = withdrawals.map((w) => ({ ...w, ada: withdrawalAda(w.onchain_payload) }));
  const readable = withAda.filter((w): w is (typeof withAda)[number] & { ada: number } => w.ada != null);
  const tail = new Map<number, { epoch: number; count: number; totalAda: number; unreadableCount: number; ids: string[] }>();
  for (const w of withAda) {
    if (w.enacted_epoch < from - LEAD_IN_EPOCHS) continue;
    const g = tail.get(w.enacted_epoch) ?? { epoch: w.enacted_epoch, count: 0, totalAda: 0, unreadableCount: 0, ids: [] };
    g.count += 1;
    if (w.ada == null) g.unreadableCount += 1;
    else g.totalAda += w.ada;
    g.ids.push(w.id);
    tail.set(w.enacted_epoch, g);
  }
  return {
    byEpochAda,
    enactedByEpoch: [...tail.values()].sort((a, b) => a.epoch - b.epoch),
    largestSingle: [...readable]
      .sort((a, b) => b.ada - a.ada || a.id.localeCompare(b.id))
      .slice(0, TOP_WITHDRAWALS)
      .map((w) => ({ id: w.id, title: w.title ?? '', epoch: w.enacted_epoch, ada: w.ada })),
    totalEnactedAda: readable.reduce((a, w) => a + w.ada, 0),
    unreadablePayloads: withAda.filter((w) => w.ada == null).map((w) => ({ id: w.id, epoch: w.enacted_epoch })),
  };
}

/**
 * The net change limit periods the window overlaps. The ceiling is a curated
 * value (an info action carries no on-chain amount), the consumption comes from
 * the same withdrawal rows the treasury section uses, which are already capped
 * at the window's end, so a later payment never appears in a historical pack.
 * A withdrawal whose payload cannot be read is counted as a gap here too, never
 * as zero, so an edition can say what the figure leaves out.
 */
function buildNcl(
  withdrawals: Array<{ enacted_epoch: number; onchain_payload: string | null }>,
  decidedIdsInWindow: Set<string>,
  from: number,
  to: number,
): WindowPack['ncl'] {
  const readable: Array<{ enactedEpoch: number; lovelace: bigint }> = [];
  for (const w of withdrawals) {
    const lovelace = withdrawalLovelace(w.onchain_payload);
    if (lovelace != null) readable.push({ enactedEpoch: w.enacted_epoch, lovelace });
  }
  return NCL_PERIODS.filter((p) => p.startEpoch <= to && p.endEpoch >= from)
    .sort((a, b) => b.startEpoch - a.startEpoch)
    .map((p) => {
      const status = nclStatusFor(p, readable);
      const inPeriod = withdrawals.filter((w) => w.enacted_epoch >= p.startEpoch && w.enacted_epoch <= p.endEpoch);
      return {
        id: p.id,
        label: p.label,
        ceilingAda: lovelaceToAda(p.ceilingLovelace.toString()) ?? 0,
        previousCeilingAda: p.previousCeilingLovelace == null ? null : lovelaceToAda(p.previousCeilingLovelace.toString()),
        raisedByAda:
          p.previousCeilingLovelace == null ? null : lovelaceToAda((p.ceilingLovelace - p.previousCeilingLovelace).toString()),
        startEpoch: p.startEpoch,
        endEpoch: p.endEpoch,
        definingActionIds: p.definingActionIds,
        relatedActionIds: p.relatedActionIds,
        definedInWindow: p.definingActionIds.filter((id) => decidedIdsInWindow.has(id)),
        consumedAda: lovelaceToAda(status.consumedLovelace.toString()) ?? 0,
        remainingAda: lovelaceToAda(status.remainingLovelace.toString()) ?? 0,
        consumedPct: status.consumedPct,
        withdrawalCount: status.withdrawalCount,
        unreadableCount: inPeriod.filter((w) => withdrawalLovelace(w.onchain_payload) == null).length,
        asOfEpoch: to,
      };
    });
}

/** The minimum and maximum window length an edition may cover, in epochs. */
const MIN_WINDOW_EPOCHS = 3;
const MAX_WINDOW_EPOCHS = 6;

/**
 * Builds the full pack for one window. `allowShort` is for the state endpoint,
 * which asks for a candidate window while it is still growing towards three
 * epochs, a published edition always covers three to six.
 */
export async function buildWindowPack(
  db: D1Database,
  cfg: NetworkConfig,
  from: number,
  to: number,
  opts: { allowShort?: boolean } = {},
): Promise<WindowPack> {
  const span = to - from + 1;
  if (!opts.allowShort && (span < MIN_WINDOW_EPOCHS || span > MAX_WINDOW_EPOCHS)) {
    throw new Error(`window ${from}-${to} must cover ${MIN_WINDOW_EPOCHS} to ${MAX_WINDOW_EPOCHS} epochs`);
  }

  const actionRows = await readWindowActions(db, from, to);
  const grouped = groupActions(actionRows, from, to);
  const events = grouped.events.map((r) => toPackAction(r, from, to));
  const closingAtBoundary = grouped.closingAtBoundary.map((r) => toPackAction(r, from, to));
  const openActions = grouped.open.map((r) => toPackAction(r, from, to));

  // Comparisons: earlier actions of the rare types the window actually decided
  // or is about to decide. A parameter change only compares with earlier
  // changes that touched at least one of the same parameters.
  const focus = [...grouped.events, ...grouped.closingAtBoundary];
  const rareTypes = [...new Set(focus.map((r) => r.type).filter((t) => RARE_TYPES.has(t)))];
  const focusParams = new Set(focus.filter((r) => r.type === 'ParameterChange').flatMap((r) => changedParameterNames(r.onchain_payload)));
  const seenIds = new Set([...grouped.events, ...grouped.closingAtBoundary, ...grouped.open].map((r) => r.id));
  const comparisons = (await readEarlierActionsOfTypes(db, rareTypes, from))
    .filter((r) => !seenIds.has(r.id))
    .filter((r) => r.type !== 'ParameterChange' || changedParameterNames(r.onchain_payload).some((k) => focusParams.has(k)))
    .map((r) => toPackAction(r, from, to));

  // Vote activity over the window plus a short lead-in, so a chart has a slope
  // to start from rather than beginning at the window's first epoch.
  const activityStart = epochBoundsUnix(from - VOTE_LEAD_IN_EPOCHS, cfg).start;
  const activityEnd = epochBoundsUnix(to, cfg).end;
  const [rangeCurrent, rangeHistory] = await Promise.all([
    readVotesInRange(db, activityStart, activityEnd),
    readVoteHistoryInRange(db, activityStart, activityEnd),
  ]);

  const focusActions = [...events, ...closingAtBoundary];
  const focusIds = focusActions.map((a) => a.id);
  const [focusCurrent, focusHistory] = await Promise.all([
    readVotesForActions(db, focusIds, activityEnd),
    readVoteHistoryForActions(db, focusIds, activityEnd),
  ]);

  // Power comes from the history table only. voted_power on a vote row is the
  // power at sync time and would silently restate an old ballot's weight.
  const coverage = await readPowerCoverage(db);
  const covered = coverage != null && coverage.from <= from && coverage.to >= to;
  // The rankings taken at the window's end need only that one epoch inside the
  // coverage, not the whole window: a window that reaches below the coverage
  // floor still has a valid snapshot at its last epoch, and gating it on the
  // whole window would drop the top DReps from every such backfill edition.
  const coveredAtTo = coverage != null && coverage.from <= to && coverage.to >= to;
  const voterIds = [...new Set([...focusCurrent, ...focusHistory].filter((v) => v.voter_role === 'DRep').map((v) => v.voter_id))];
  // Power is read for every epoch a focus action was voted in, not only for the
  // window: voting on an action starts when it is submitted, which can be many
  // epochs earlier, and the per-epoch power sums must cover that whole timeline.
  const voteEpochs = [...focusCurrent, ...focusHistory]
    .filter((v) => v.block_time != null)
    .map((v) => epochFromUnix(v.block_time as number, cfg));
  const earliestVoteEpoch = voteEpochs.length > 0 ? Math.min(...voteEpochs) : from;
  const powerRange = coverage == null
    ? null
    : (() => {
        const lo = Math.max(coverage.from, Math.min(earliestVoteEpoch, from - VOTE_LEAD_IN_EPOCHS));
        const hi = Math.min(coverage.to, to);
        return lo <= hi ? { from: lo, to: hi } : null;
      })();
  const powerRows = voterIds.length > 0 && powerRange != null
    ? await readPowerForDreps(db, powerRange.from, powerRange.to, voterIds)
    : [];
  const power = new Map<string, number>();
  for (const r of powerRows) {
    const ada = lovelaceToAda(r.amount);
    if (ada != null) power.set(powerKey(r.drep_id, r.epoch), ada);
  }

  const names = await readDrepNames(db, voterIds);

  const topDrepRows = coveredAtTo ? await readTopDrepsAtEpoch(db, to, TOP_DREPS) : [];
  const ballotByDrep = new Map<string, Map<string, string>>();
  for (const v of focusCurrent) {
    if (v.voter_role !== 'DRep') continue;
    const m = ballotByDrep.get(v.voter_id) ?? new Map<string, string>();
    m.set(v.ga_id, v.vote);
    ballotByDrep.set(v.voter_id, m);
  }
  const topDreps = topDrepRows.map((r) => ({
    drepId: r.drep_id,
    name: r.name,
    powerAda: lovelaceToAda(r.amount) ?? 0,
    ballots: Object.fromEntries(focusIds.map((id) => [id, ballotByDrep.get(r.drep_id)?.get(id) ?? ('did not vote' as const)])),
  }));

  // Drops need both ends of the comparison inside the rolling coverage.
  const dropsFrom = from - 1;
  const dropRows = coverage != null && dropsFrom >= coverage.from && to <= coverage.to
    ? await readPowerDrops(db, dropsFrom, to, MAX_DROPS)
    : null;
  const drops = dropRows?.map((r) => {
    const fromAda = lovelaceToAda(r.from_amount) ?? 0;
    const toAda = lovelaceToAda(r.to_amount) ?? 0;
    return { drepId: r.drep_id, name: r.name, fromAda, toAda, deltaAda: toAda - fromAda, deregistered: r.status === 'deregistered' };
  }) ?? null;
  // The two epochs a drop row compares, so a reader of the pack can name the span.
  const dropsRange = drops == null ? null : { from: dropsFrom, to };

  const [ccNames, { members, hotToCold }] = await Promise.all([readCcMemberNames(db), getCommitteeTimeline(db)]);
  const activeAtCache = new Map<number, Set<string>>();
  const activeAt = (epoch: number): Set<string> => {
    const hit = activeAtCache.get(epoch);
    if (hit) return hit;
    const set = activeCommitteeMembersAt(members, epoch);
    activeAtCache.set(epoch, set);
    return set;
  };
  const activeAtTo = activeAt(to);
  const committeeRows = members.filter(
    (m) => activeAtTo.has(m.coldKeyHex) && m.versionFrom <= to && (m.versionTo == null || m.versionTo >= to),
  );
  const minSizeRow = await readCommitteeMinSizeAt(db, to);

  const allStats = await listEpochStats(db);
  const windowStats = allStats.filter((r) => r.epoch >= from - LEAD_IN_EPOCHS && r.epoch <= to);
  const withdrawals = await readEnactedWithdrawals(db, to);

  const readinessEpochs: Record<string, EpochReadiness> = {};
  for (let e = from; e <= to; e++) readinessEpochs[String(e)] = await epochReadiness(db, cfg, e);

  const wm = await watermarks(db);
  const stamps = [wm.votesMs, wm.statsMs, wm.actionsMs].filter((t): t is number => t != null);
  const asOf = stamps.length > 0 ? new Date(Math.min(...stamps)).toISOString() : null;

  return {
    packVersion: REVIEW_PACK_VERSION,
    network: cfg.network,
    window: {
      from,
      to,
      startsAt: new Date(epochBoundsUnix(from, cfg).start * 1000).toISOString(),
      endsAt: new Date(epochBoundsUnix(to, cfg).end * 1000).toISOString(),
      asOf,
      committeeAsOf: to,
      readiness: {
        ready: Object.values(readinessEpochs).every((r) => r.ready) && Object.keys(readinessEpochs).length > 0,
        epochs: readinessEpochs,
      },
    },
    actions: { events, closingAtBoundary, open: openActions, comparisons },
    votesByEpoch: votesByEpoch(rangeCurrent, rangeHistory, cfg),
    windowTotals: windowTotals(rangeCurrent, rangeHistory, cfg, from, to),
    voteTimeline: voteTimeline(focusIds, [...focusCurrent, ...focusHistory], cfg, power, powerRange),
    topVoters: topVoters(focusIds, focusCurrent, cfg, power, names, to),
    topDreps,
    ccVotes: ccVotes(focusActions, focusCurrent, cfg, ccNames, hotToCold, activeAt, to),
    committee: {
      asOfEpoch: to,
      members: committeeRows.map((m) => ({ coldKeyHex: m.coldKeyHex, termExpiration: m.termExpiration, authorizedFrom: m.authorizedFrom, resignedAt: m.resignedAt })),
      minSize: minSizeRow ?? { value: null, observedAtEpoch: null, reason: 'no parameter snapshot at or before the window' },
      endingWithin12: committeeRows.filter((m) => m.termExpiration <= to + TERM_HORIZON).length,
    },
    epochStats: { rows: windowStats.map(packStatsRow), metrics: statsMetrics() },
    powerHistory: { coverage, covered, coveredAtTo, drops, dropsRange },
    ncl: buildNcl(
      withdrawals,
      new Set([...grouped.events, ...grouped.closingAtBoundary].map((r) => r.id)),
      from,
      to,
    ),
    treasury: buildTreasury(windowStats, withdrawals, from),
    records: buildRecords(allStats, to),
    spo: spoCounts(focusIds, focusCurrent),
  };
}
