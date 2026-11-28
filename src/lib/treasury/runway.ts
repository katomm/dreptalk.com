// Treasury runway: how long the treasury lasts at a chosen yearly spending.
// A what-if, not a forecast. Inflow continues at the rate of the last 73
// closed epochs as a share of the reserves, and the reserves keep shrinking at
// their rate over the last 146 closed epochs. Only closed epochs (up to L)
// are used. Money in lovelace, rates in parts per billion.
import { NCL_PERIODS } from '../../../config/ncl-periods.js';
import { EPOCH_LENGTH_SECONDS, epochStartUnix, type NetworkConfig } from '../config/network.js';
import { treasuryTotalLovelace } from '../governance/onchain.js';
import { paidInEpochs, paidInYear, type RecipientSummary, type TreasuryActionRow } from './recipients.js';
import { EPOCHS_PER_YEAR, type RunwayInputs } from './runwayProjection.js';

export { EPOCHS_PER_YEAR, projectRunway, type RunwayInputs, type RunwayProjection } from './runwayProjection.js';

export interface EpochBalance {
  epoch: number;
  treasury: bigint | null;
  reserves: bigint | null;
}

const INFLOW_WINDOW = 73;
const DECAY_WINDOW = 146;
const PPB = 1_000_000_000;

/** Full payload totals of enacted withdrawals, by enactment epoch. */
export function paidByEnactedEpoch(rows: TreasuryActionRow[]): Map<number, bigint> {
  const out = new Map<number, bigint>();
  for (const r of rows) {
    if (r.status !== 'enacted' || r.enactedEpoch == null) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(r.payload);
    } catch {
      continue;
    }
    out.set(r.enactedEpoch, (out.get(r.enactedEpoch) ?? 0n) + treasuryTotalLovelace(payload));
  }
  return out;
}

/** Null unless both windows are complete up to the last closed epoch L. */
export function runwayInputs(
  balances: EpochBalance[],
  paidByEpoch: Map<number, bigint>,
  lastClosedEpoch: number,
  cfg: NetworkConfig,
): RunwayInputs | null {
  const L = lastClosedEpoch;
  const T = new Map<number, bigint>();
  const R = new Map<number, bigint>();
  for (const b of balances) {
    if (b.epoch > L) continue;
    if (b.treasury != null) T.set(b.epoch, b.treasury);
    if (b.reserves != null && b.reserves > 0n) R.set(b.epoch, b.reserves);
  }
  const rL = R.get(L);
  const rOld = R.get(L - DECAY_WINDOW);
  const tL = T.get(L);
  if (rL == null || rOld == null || tL == null) return null;

  let rateSum = 0;
  for (let e = L - INFLOW_WINDOW; e < L; e++) {
    const t0 = T.get(e);
    const t1 = T.get(e + 1);
    const r = R.get(e);
    if (t0 == null || t1 == null || r == null) return null;
    const inflow = t1 - t0 + (paidByEpoch.get(e + 1) ?? 0n);
    rateSum += Number(inflow) / Number(r);
  }
  const rate = rateSum / INFLOW_WINDOW;
  const decay = 1 - (Number(rL) / Number(rOld)) ** (1 / DECAY_WINDOW);
  return {
    lastClosedEpoch: L,
    treasury: tL,
    reserves: rL,
    inflowRatePpb: Math.round(rate * PPB),
    decayPpb: Math.round(decay * PPB),
    epochStartSec: epochStartUnix(L, cfg),
    epochLengthSec: EPOCH_LENGTH_SECONDS,
  };
}

export interface RunwayPreset {
  id: 'last12' | 'ncl' | 'year2025';
  label: string;
  lovelacePerYear: bigint;
}

export function runwayPresets(list: RecipientSummary[], lastClosedEpoch: number, currentEpoch: number, _cfg: NetworkConfig): RunwayPreset[] {
  const out: RunwayPreset[] = [
    { id: 'last12', label: 'Last 12 months', lovelacePerYear: paidInEpochs(list, lastClosedEpoch - (EPOCHS_PER_YEAR - 1), lastClosedEpoch) },
  ];
  const period = NCL_PERIODS.find((p) => currentEpoch >= p.startEpoch && currentEpoch <= p.endEpoch);
  if (period) {
    const epochs = BigInt(period.endEpoch - period.startEpoch + 1);
    out.push({ id: 'ncl', label: 'Net Change Limit fully used', lovelacePerYear: (period.ceilingLovelace * BigInt(EPOCHS_PER_YEAR)) / epochs });
  }
  out.push({ id: 'year2025', label: 'Pace of 2025', lovelacePerYear: paidInYear(list, 2025) });
  return out;
}
