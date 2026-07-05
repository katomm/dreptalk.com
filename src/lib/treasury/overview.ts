// Shared loader for the Treasury and Net Change Limit overview: the same
// fetch + compose used by the (now-redirected) /treasury page and the budget
// discussion category, which embeds this overview above its thread list.
import { NCL_PERIODS, type NclPeriod } from '../../../config/ncl-periods.js';
import { nclStatusFor, type NclStatus } from '@/lib/governance/ncl.js';
import { getEnactedTreasuryWithdrawals, getNclActionLinks, type EnactedWithdrawal, type NclActionLink } from '@/lib/db/treasury.js';
import { getProtocolParams } from '@/lib/db/protocolParams.js';

export interface NclPeriodCard {
  period: NclPeriod;
  status: NclStatus;
  windowWithdrawals: EnactedWithdrawal[];
  definingLinks: NclActionLink[];
  relatedLinks: NclActionLink[];
}

export interface TreasuryOverviewData {
  treasuryLovelace: bigint | null;
  treasuryEpoch: number | null;
  currentStatus: NclStatus | null;
  /** Newest period first. */
  periods: NclPeriodCard[];
}

/**
 * Fetch and compose everything the treasury overview needs: enacted
 * withdrawal totals per NCL period, the curated defining/related action
 * links, and the current period's status for the treasury donut. Returns
 * null when there is no db (e.g. local dev without a binding).
 */
export async function loadTreasuryOverview(db: D1Database): Promise<TreasuryOverviewData | null> {
  if (!db) return null;

  const withdrawals = await getEnactedTreasuryWithdrawals(db);
  const allIds = NCL_PERIODS.flatMap((p) => [...p.definingActionIds, ...p.relatedActionIds]);
  const links = await getNclActionLinks(db, allIds);
  const params = await getProtocolParams(db);
  const currentEpoch = params?.epoch ?? null;
  const treasuryLovelace = params?.treasuryLovelace ? BigInt(params.treasuryLovelace) : null;
  const treasuryEpoch = params?.treasuryEpoch ?? null;

  const linkList = (ids: string[]) => ids.map((id) => links.get(id)).filter((l): l is NonNullable<typeof l> => !!l);

  // Newest period first.
  const periods: NclPeriodCard[] = [...NCL_PERIODS]
    .sort((a, b) => b.startEpoch - a.startEpoch)
    .map((p) => ({
      period: p,
      status: nclStatusFor(p, withdrawals),
      windowWithdrawals: withdrawals
        .filter((w) => w.enactedEpoch >= p.startEpoch && w.enactedEpoch <= p.endEpoch)
        .sort((a, b) => b.enactedEpoch - a.enactedEpoch),
      definingLinks: linkList(p.definingActionIds),
      relatedLinks: linkList(p.relatedActionIds),
    }));

  const currentPeriod = periods.find((p) => currentEpoch != null && currentEpoch >= p.period.startEpoch && currentEpoch <= p.period.endEpoch) ?? periods[0];
  const currentStatus = currentPeriod ? nclStatusFor(currentPeriod.period, withdrawals) : null;

  return {
    treasuryLovelace,
    treasuryEpoch,
    currentStatus,
    periods,
  };
}
