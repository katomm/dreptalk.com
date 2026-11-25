// Copy for the path-to-pass lines on the voting card. Pure: takes the math from
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
import { positionsVoterAnchor } from './voteStatement.js';

export interface PassListRow {
  name: string;
  stanceLabel: 'Not voted' | 'No' | 'Abstain' | 'Yes';
  powerLabel: string;
  countsLabel: string | null;
  href: string;
}

export interface PassPathRowView {
  line: string;
  list: { rows: PassListRow[]; comparison: string | null } | null;
}

export const PASS_PATH_FOOTNOTE =
  'Reachability as of the last tally sync. New votes move it at every sync, delegation changes and DReps going inactive at the epoch boundary.';

export const PASS_LIST_FOOTNOTE = "At today's voting power. A switch to Yes is counted, nothing is predicted.";

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
        ? `DReps who haven't voted can't carry it alone. Abstainers would have to switch to Yes too. Still missing: ${gap} of yes, or the equivalent from abstainers, who count at ${abstainShare(t.thrBp)}.`
        : `Pools that haven't voted can't carry it alone. ${passiveAbstainInA ? 'Pools that voted Abstain or default to always abstain' : 'Pools that voted Abstain'} would have to vote Yes too. Still missing: ${gap} of yes, or the equivalent from them, who count at ${abstainShare(t.thrBp)}.`;
    case 'noVoters':
      return `Only reachable if ${who} who voted No switch to Yes.`;
    case 'fixed':
      if (t.dxDecides)
        return "Not reachable with today's active DReps. It would take inactive DReps whose stake still counts as No voting again.";
      if (b.F > 0n) return "Can't be reached by votes. Always-no-confidence stake alone blocks it.";
      return "Can't be reached by votes.";
  }
}

function listRow(p: FewestResult['picks'][number], actionHref: string): PassListRow {
  return {
    name: p.name ?? truncateIdMiddle(p.drepId),
    stanceLabel: STANCE_LABEL[p.stance],
    powerLabel: ada(p.power, 1),
    countsLabel: p.stance === 'Abstain' ? `counts ${ada(p.worth / SCALE, 1)}` : null,
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
  const n = comparison?.reaches ? comparison.picks.length : null;
  return {
    line,
    list: {
      rows: list.picks.map((p) => listRow(p, actionHref)),
      comparison:
        n != null && n < list.picks.length
          ? `If DReps who voted No switch as well: at least ${n} DRep${n === 1 ? '' : 's'}.`
          : null,
    },
  };
}

const ALLOWED: Record<Exclude<Tier, 'fixed'>, Stance[]> = {
  nonVoters: ['notVoted'],
  abstainers: ['notVoted', 'Abstain'],
  noVoters: ['notVoted', 'Abstain', 'No'],
};

/**
 * The path to pass for one voting card row, or null when the row shows none: a
 * closed action, a row that is met or has no verdict, a CC below its minimum size.
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
    return seats ? ccRowView(seats) : null;
  }
  if (!r.stake) return null;
  const actionHref = ctx.actionHref;
  if (r.body === 'SPO') {
    const buckets = spoBuckets(r.stake);
    const tier = reachTier(buckets, r.thresholdPct);
    return tier
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
  if (!tier) return null;
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
