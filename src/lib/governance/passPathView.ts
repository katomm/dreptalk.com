// Copy for the path-to-pass lines on the voting card. Pure: takes the math from
// passPath.ts and returns finished strings and list rows, so every word is tested.
// The wording describes arithmetic ("would have to switch"), never pressure.
import { formatAdaCompact } from '../format/ada.js';
import { truncateIdMiddle } from '../forum/view.js';
import {
  SCALE,
  type CcSeatTier,
  type FewestResult,
  type Stance,
  type StakeBuckets,
  type StakeTier,
} from './passPath.js';
import { positionsVoterAnchor } from './voteStatement.js';

export interface PassListRow {
  name: string;
  stanceLabel: 'Not voted' | 'No' | 'Abstain';
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
};

function ada(lovelace: bigint, digits: number): string {
  return formatAdaCompact(lovelace.toString(), digits) ?? '0 ₳';
}

/** How much an abstainer's switch counts relative to a No-side switch, as words. */
function abstainShare(thrBp: bigint): string {
  const pct = ((SCALE - thrBp) * 200n + SCALE) / (2n * SCALE);
  return pct === 33n ? 'a third' : `${pct}%`;
}

function tierLine(body: 'DRep' | 'SPO', t: StakeTier, b: StakeBuckets): string {
  const gap = ada(t.gapLovelace, 2);
  const who = body === 'DRep' ? 'DReps' : 'pools';
  switch (t.tier) {
    case 'nonVoters':
      return `Reachable if ${who} who haven't voted yet vote Yes. ${gap} more yes needed.`;
    case 'abstainers':
      return body === 'DRep'
        ? `DReps who haven't voted can't carry it alone. Abstainers would have to switch to Yes too. Still missing: ${gap} of yes, or the equivalent from abstainers, who count at ${abstainShare(t.thrBp)}.`
        : `Pools that haven't voted can't carry it alone. Pools that voted Abstain or default to always abstain would have to vote Yes too. Still missing: ${gap} of yes, or the equivalent from them, who count at ${abstainShare(t.thrBp)}.`;
    case 'noVoters':
      return `Only reachable if ${who} who voted No switch to Yes.`;
    case 'fixed':
      if (b.F > 0n && b.Dx > 0n)
        return "Can't be reached by votes. Always-no-confidence stake and stake of inactive DReps still counted as No block it together.";
      if (b.Dx > 0n) return "Can't be reached by votes. Stake of inactive DReps still counted as No blocks it.";
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
    href: p.stance === 'notVoted' ? `/dreps/${p.drepId}/` : `${actionHref}${positionsVoterAnchor(p.drepId)}`,
  };
}

export function stakeRowView(args: {
  body: 'DRep' | 'SPO';
  tier: StakeTier;
  buckets: StakeBuckets;
  list: FewestResult | null;
  comparison: FewestResult | null;
  actionHref: string;
}): PassPathRowView {
  const { body, tier, buckets, list, comparison, actionHref } = args;
  const line = tierLine(body, tier, buckets);
  if (body !== 'DRep' || !list?.reaches) return { line, list: null };
  const n = comparison?.reaches ? comparison.picks.length : null;
  return {
    line,
    list: {
      rows: list.picks.map((p) => listRow(p, actionHref)),
      comparison:
        tier.tier === 'abstainers' && n != null && n < list.picks.length
          ? `If DReps who voted No switch as well: at least ${n} DRep${n === 1 ? '' : 's'}.`
          : null,
    },
  };
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
