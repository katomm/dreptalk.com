// Pure view model for effective voting concentration, how concentrated the
// actually exercised DRep voting power on one action was. Input is the raw
// voted_power column of every live DRep vote on the action. Honesty rule,
// if ANY vote row is missing its power, the whole view is null, a partial
// sum must never render as a total. Specials cannot appear here, the two
// default options are ledger options, not voters, so drep_votes never holds
// rows for them. All sums are BigInt, the network-wide voted total
// approaches 2^53 lovelace. No I/O, deterministic, unit-tested.

export interface VoteConcentrationView {
  /** Number of live DRep votes the stats are computed over. */
  voterCount: number;
  /** Sum of the voted power, lovelace. */
  votedPower: bigint;
  /** Smallest number of the largest voters covering at least half the voted power. */
  halfCount: number;
  /** Largest single voter's share of the voted power, percent. */
  largestPct: number;
  /** Top-5 share of the voted power, percent. Null with 5 or fewer voters. */
  top5Pct: number | null;
  /**
   * Smallest number of the largest voters whose combined power reaches the
   * required yes power. Null without a threshold reading, and null when even
   * the full voted power falls short of it.
   */
  thresholdCount: number | null;
}

/** Four-decimal percent of part out of total, BigInt-safe, 0 when total is 0. */
function pct4(part: bigint, total: bigint): number {
  if (total <= 0n) return 0;
  return Number((part * 1_000_000n) / total) / 10_000;
}

/**
 * Yes power required to cross the ratification threshold, on the same base the
 * full-stake bar's marker uses (fullStakeView.ts), threshold percent of the
 * abstain-reduced representative stake, reprTotal from governance_epoch_stats.
 * Null when any input is absent, malformed, or the base is not positive.
 */
export function requiredYesPower(
  reprTotalPower: string | null,
  activeAbstainPower: number | null,
  approvalThresholdPct: number | null,
): bigint | null {
  if (reprTotalPower === null || approvalThresholdPct === null) return null;
  let reprTotal: bigint;
  try {
    reprTotal = BigInt(reprTotalPower);
  } catch {
    return null;
  }
  const abstain = activeAbstainPower === null ? 0n : BigInt(activeAbstainPower);
  const base = reprTotal - abstain;
  if (base <= 0n) return null;
  // Threshold percent to 4 decimals as an integer scale, so 60.5% stays exact.
  const thrScaled = BigInt(Math.round(approvalThresholdPct * 10_000));
  if (thrScaled <= 0n) return null;
  return (base * thrScaled) / 1_000_000n;
}

export function buildVoteConcentration(
  powers: (number | null)[],
  requiredYes: bigint | null,
): VoteConcentrationView | null {
  if (powers.length === 0) return null;
  const known: bigint[] = [];
  for (const p of powers) {
    if (p === null) return null;
    known.push(BigInt(p));
  }
  known.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  let total = 0n;
  for (const p of known) total += p;
  if (total <= 0n) return null;

  let halfCount = 0;
  let cumulative = 0n;
  for (const p of known) {
    cumulative += p;
    halfCount += 1;
    // Exact boundary counts as reached, cumulative/total >= 1/2.
    if (cumulative * 2n >= total) break;
  }

  let top5 = 0n;
  for (const p of known.slice(0, 5)) top5 += p;

  let thresholdCount: number | null = null;
  if (requiredYes !== null && requiredYes > 0n && total >= requiredYes) {
    let cum = 0n;
    for (let i = 0; i < known.length; i += 1) {
      cum += known[i];
      if (cum >= requiredYes) {
        thresholdCount = i + 1;
        break;
      }
    }
  }

  return {
    voterCount: known.length,
    votedPower: total,
    halfCount,
    largestPct: pct4(known[0], total),
    top5Pct: known.length > 5 ? pct4(top5, total) : null,
    thresholdCount,
  };
}
