// The runway projection on its own, without database or config imports, so
// the page's slider script can run the exact same math in the browser.

export interface RunwayInputs {
  lastClosedEpoch: number;
  treasury: bigint;
  reserves: bigint;
  /** Inflow per epoch as parts per billion of the reserves. */
  inflowRatePpb: number;
  /** Reserve decay per epoch, parts per billion. */
  decayPpb: number;
  epochStartSec: number;
  epochLengthSec: number;
}

export const EPOCHS_PER_YEAR = 73;
const HORIZON_EPOCHS = 30 * EPOCHS_PER_YEAR;
const PPB = 1_000_000_000;

function yearAt(inp: RunwayInputs, epoch: number): number {
  return new Date((inp.epochStartSec + (epoch - inp.lastClosedEpoch) * inp.epochLengthSec) * 1000).getUTCFullYear();
}

export interface RunwayProjection {
  endEpoch: number | null;
  endYear: number | null;
  horizonYear: number;
  /** One point per year from L, plus the end epoch. */
  points: { epoch: number; treasury: bigint }[];
}

export function projectRunway(inp: RunwayInputs, spendPerYear: bigint): RunwayProjection {
  const L = inp.lastClosedEpoch;
  const rate = BigInt(inp.inflowRatePpb);
  const decay = BigInt(inp.decayPpb);
  const spend = spendPerYear / BigInt(EPOCHS_PER_YEAR);
  const ppb = BigInt(PPB);
  let t = inp.treasury;
  let r = inp.reserves;
  const points = [{ epoch: L, treasury: t }];
  let endEpoch: number | null = null;
  for (let i = 1; i <= HORIZON_EPOCHS; i++) {
    t += (r * rate) / ppb - spend;
    r -= (r * decay) / ppb;
    if (t <= 0n) {
      endEpoch = L + i;
      points.push({ epoch: endEpoch, treasury: 0n });
      break;
    }
    if (i % EPOCHS_PER_YEAR === 0) points.push({ epoch: L + i, treasury: t });
  }
  return {
    endEpoch,
    endYear: endEpoch == null ? null : yearAt(inp, endEpoch),
    horizonYear: yearAt(inp, L + HORIZON_EPOCHS),
    points,
  };
}

