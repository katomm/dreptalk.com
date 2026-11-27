// Copy for the path-to-pass lines on the voting card and the Votes tab section. Pure: takes the math from
// passPath.ts and returns finished strings and list rows, so every word is tested.
// The wording describes arithmetic ("would have to switch"), never pressure.
import { formatAdaCompact } from '../format/ada.js';
import { drepPath } from '../dreps/profile.js';
import { truncateIdMiddle } from '../forum/view.js';
import type { BodyStakeView } from './fullStakeView.js';
import {
  ccSeatsToPass,
  drepBuckets,
  fewestToPass,
  reachTier,
  reconcileCandidates,
  SCALE,
  spoBuckets,
  type CcSeatTier,
  type FewestResult,
  type PassCandidate,
  type Stance,
  type StakeBuckets,
  type StakeTier,
  type Tier,
} from './passPath.js';
import { fmtPctFine } from './view.js';
import { positionsVoterAnchor } from './voteStatement.js';

export interface PassListRow {
  name: string;
  stanceLabel: 'Not voted' | 'No' | 'Abstain' | 'Yes';
  powerLabel: string;
  /** Abstain rows only: how much of the gap the switch closes, which is less than the
   *  power because the stake also joins the counted total, with the tooltip text. */
  closes: { label: string; tip: string } | null;
  href: string;
}

export interface PassListView {
  rows: PassListRow[];
  /** Sidebar link text, e.g. "51 DReps would have to switch, 15 if No voters switch too". */
  summary: string;
  /** Opening line of the Votes tab section. */
  intro: string;
  /** Why an Abstain switch counts for less, when the list has one. */
  abstainNote: string | null;
  comparison: string | null;
}

export interface PassPathRowView {
  line: string;
  list: PassListView | null;
}

/** Fragment id of the Votes tab section the sidebar links to. */
export const PASS_SECTION_ID = 'path-to-pass';

export const PASS_PATH_FOOTNOTE =
  'Reachability as of the last tally sync. New votes move it at every sync, delegation changes and DReps going inactive at the epoch boundary.';

export const PASS_LIST_FOOTNOTE = "At today's voting power. A vote or switch to Yes is counted, nothing is predicted.";

const STANCE_LABEL: Record<Stance, PassListRow['stanceLabel']> = {
  notVoted: 'Not voted',
  No: 'No',
  Abstain: 'Abstain',
  Yes: 'Yes',
};

function ada(lovelace: bigint, digits: number): string {
  return formatAdaCompact(lovelace.toString(), digits) ?? '0 ₳';
}

/** How much an abstainer's switch counts relative to a No-side switch, as words. */
function abstainShare(thrBp: bigint): string {
  const pct = ((SCALE - thrBp) * 200n + SCALE) / (2n * SCALE);
  return pct === 33n ? 'a third' : `${pct}%`;
}

function tierLine(body: 'DRep' | 'SPO', t: StakeTier, b: StakeBuckets, passiveAbstainInA: boolean): string {
  const gap = ada(t.gapLovelace, 2);
  const who = body === 'DRep' ? 'DReps' : 'pools';
  switch (t.tier) {
    case 'nonVoters':
      return `Reachable if ${who} who haven't voted yet vote Yes. ${gap} more yes needed.`;
    case 'abstainers':
      return body === 'DRep'
        ? `Needs ${gap} more yes. DReps who haven't voted can't carry it alone, abstainers would have to switch too.`
        : `Needs ${gap} more yes. Pools that haven't voted can't carry it alone, ${passiveAbstainInA ? 'pools that voted Abstain or default to always abstain' : 'pools that voted Abstain'} would have to vote Yes too (they count at ${abstainShare(t.thrBp)}).`;
    case 'noVoters':
      return `Only reachable if ${who} who voted No switch to Yes.`;
    case 'fixed':
      if (t.dxDecides)
        return "Not reachable with today's active DReps. It would take inactive DReps whose stake still counts as No voting again.";
      if (b.F > 0n) return "Can't be reached by votes. Always-no-confidence stake alone blocks it.";
      return "Can't be reached by votes.";
  }
}

function dreps(n: number): string {
  return `${n} DRep${n === 1 ? '' : 's'}`;
}

function listRow(p: FewestResult['picks'][number], actionHref: string): PassListRow {
  const abstain = p.stance === 'Abstain';
  const closes = ada(p.worth / SCALE, 1);
  return {
    name: p.name ?? truncateIdMiddle(p.drepId),
    stanceLabel: STANCE_LABEL[p.stance],
    powerLabel: ada(p.power, 1),
    closes: abstain
      ? {
          label: `closes ${closes}`,
          tip: `A switch from Abstain adds ${ada(p.power, 1)} to Yes and to the counted total, so it closes the gap by ${closes}.`,
        }
      : null,
    href: p.stance === 'notVoted' ? drepPath(p) : `${actionHref}${positionsVoterAnchor(p.drepId)}`,
  };
}

export function stakeRowView(args: {
  body: 'DRep' | 'SPO';
  tier: StakeTier;
  buckets: StakeBuckets;
  list: FewestResult | null;
  comparison: FewestResult | null;
  actionHref: string;
  /** SPOs: whether passive always-abstain pools sit with the abstainers (every type but a hard fork). */
  passiveAbstainInA?: boolean;
}): PassPathRowView {
  const { body, tier, buckets, list, comparison, actionHref, passiveAbstainInA = true } = args;
  const line = tierLine(body, tier, buckets, passiveAbstainInA);
  if (body !== 'DRep' || !list?.reaches) return { line, list: null };
  const count = list.picks.length;
  const n = comparison?.reaches && comparison.picks.length < count ? comparison.picks.length : null;
  const hasAbstain = list.picks.some((p) => p.stance === 'Abstain');
  const thr = fmtPctFine(Number(tier.thrBp) / 10_000);
  const gap = ada(tier.gapLovelace, 2);
  // On the nonVoters tier every pick has not voted yet, so nobody switches.
  const fresh = tier.tier === 'nonVoters';
  return {
    line,
    list: {
      rows: list.picks.map((p) => listRow(p, actionHref)),
      summary: fresh
        ? `${dreps(count)} voting Yes would reach ${thr}`
        : `${dreps(count)} would have to switch${n != null ? `, ${n} if No voters switch too` : ''}`,
      intro: fresh
        ? `The fewest DReps who haven't voted yet whose Yes votes would reach the ${thr} threshold, largest first. That takes ${gap} more yes.`
        : `The fewest DReps whose switch to Yes would reach the ${thr} threshold, ordered by how much each switch counts. ${gap} more yes is needed.`,
      abstainNote: hasAbstain
        ? `A DRep who voted Abstain counts at ${abstainShare(tier.thrBp)} of their voting power, because a switch also adds their stake to the counted total.`
        : null,
      comparison: n != null ? `If DReps who voted No switch as well: at least ${dreps(n)}.` : null,
    },
  };
}

const ALLOWED: Record<Exclude<Tier, 'fixed'>, Stance[]> = {
  nonVoters: ['notVoted'],
  abstainers: ['notVoted', 'Abstain'],
  noVoters: ['notVoted', 'Abstain', 'No'],
};

/**
 * Early phase: the threshold is reachable by non-voters alone and more power has not
 * voted yet than has voted (Yes, No and Abstain). A gap this early only reads like
 * the action is failing, so the row shows no path until turnout catches up.
 */
function earlyPhase(tier: StakeTier, b: StakeBuckets, stake: BodyStakeView): boolean {
  const a = stake.amounts;
  return tier.tier === 'nonVoters' && b.Dv > a.yes + a.no + a.activeAbstain;
}

/**
 * The path to pass for one voting card row, or null when the row shows none: a
 * closed action, a row that is met or has no verdict, a CC below its minimum size,
 * a row in its early phase.
 * The DRep row needs candidates that match the tally, because without a votable
 * population a tier would count stake of inactive DReps as movable.
 */
export function passPathRow(
  r: { body: 'DRep' | 'SPO' | 'CC'; met: boolean | null; thresholdPct: number | null; stake: BodyStakeView | null },
  ctx: {
    isActive: boolean;
    ccBlocked: boolean;
    ccBoundarySize: number | null;
    cc: { yes: number; no: number; abstain: number };
    passCandidates: PassCandidate[] | null;
    actionHref: string;
  },
): PassPathRowView | null {
  if (!ctx.isActive || r.met !== false || r.thresholdPct == null) return null;
  if (r.body === 'CC') {
    if (ctx.ccBlocked || ctx.ccBoundarySize == null) return null;
    const seats = ccSeatsToPass({ ...ctx.cc, size: ctx.ccBoundarySize }, r.thresholdPct);
    // Same early phase as the stake rows, counted in seats.
    if (!seats || (seats.tier === 'nonVoters' && seats.notVoted > ctx.cc.yes + ctx.cc.no + ctx.cc.abstain)) return null;
    return ccRowView(seats);
  }
  if (!r.stake) return null;
  const actionHref = ctx.actionHref;
  if (r.body === 'SPO') {
    const buckets = spoBuckets(r.stake);
    const tier = reachTier(buckets, r.thresholdPct);
    return tier && !earlyPhase(tier, buckets, r.stake)
      ? stakeRowView({
          body: 'SPO',
          tier,
          buckets,
          list: null,
          comparison: null,
          actionHref,
          passiveAbstainInA: !r.stake.aaCounted,
        })
      : null;
  }
  const cands = ctx.passCandidates;
  if (!cands) return null;
  const rec = reconcileCandidates(cands, r.stake);
  if (!rec.ok) return null;
  const buckets = drepBuckets(r.stake, rec.notVotedSum);
  const tier = reachTier(buckets, r.thresholdPct);
  if (!tier || earlyPhase(tier, buckets, r.stake)) return null;
  const list = tier.tier === 'fixed' ? null : fewestToPass(cands, tier, ALLOWED[tier.tier], buckets.Dv);
  // Abstainers count at a fraction, so a list leaning on them can shrink once No
  // voters are allowed too. On the other tiers the list already uses every group it can.
  const comparison = tier.tier === 'abstainers' ? fewestToPass(cands, tier, ALLOWED.noVoters, buckets.Dv) : null;
  return stakeRowView({ body: 'DRep', tier, buckets, list, comparison, actionHref });
}

export function ccRowView(t: CcSeatTier): PassPathRowView {
  const line =
    t.tier === 'nonVoters'
      ? `Reachable if ${t.extraYes} of the ${t.notVoted} members who haven't voted vote Yes.`
      : t.tier === 'abstainers'
        ? `Needs ${t.extraYes} more Yes, including members who abstained.`
        : 'Only reachable if members who voted No switch to Yes.';
  return { line, list: null };
}

/** Card-level reasons no vote can pass the action. */
export function hardBlockLines(args: {
  withdrawal: bigint | null;
  nclRemaining: bigint | null;
  ccBlocked: boolean;
  ccVotes: boolean;
}): string[] {
  const lines: string[] = [];
  if (args.withdrawal != null && args.nclRemaining != null && args.withdrawal > args.nclRemaining) {
    lines.push(
      `Exceeds the Net Change Limit headroom (${ada(args.nclRemaining, 2)} left). Can't be enacted in this period, whatever the votes.`,
    );
  }
  if (args.ccBlocked && args.ccVotes) {
    lines.push('The committee is below its minimum size, so no action that needs it can pass.');
  }
  return lines;
}
