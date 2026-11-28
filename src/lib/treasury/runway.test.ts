import { describe, it, expect } from 'vitest';
import { EPOCH_LENGTH_SECONDS, epochStartUnix, resolveNetwork } from '../config/network.js';
import { groupRecipients, type TreasuryActionRow } from './recipients.js';
import { paidByEnactedEpoch, projectRunway, runwayInputs, runwayPresets, type EpochBalance, type RunwayInputs } from './runway.js';

const cfg = resolveNetwork('mainnet');
const L = 669;

// Reserves fall by 0.1 % per epoch, inflow is 0.05 % of the reserves.
function series(from: number, to: number, paid = new Map<number, bigint>()): EpochBalance[] {
  const out: EpochBalance[] = [];
  let R = 6_000_000_000_000_000n;
  let T = 1_500_000_000_000_000n;
  for (let e = from; e <= to; e++) {
    out.push({ epoch: e, treasury: T, reserves: R });
    T = T + (R * 5n) / 10_000n - (paid.get(e + 1) ?? 0n);
    R = R - R / 1000n;
  }
  return out;
}

const pay = (lovelace: number) =>
  JSON.stringify({ tag: 'TreasuryWithdrawals', contents: [[[{ credential: { scriptHash: 'a'.repeat(56) } }, lovelace]], null] });
const enacted = (epoch: number, lovelace: number): TreasuryActionRow => ({
  id: `r${epoch}#0`,
  title: 'T',
  status: 'enacted',
  returnAddress: null,
  submittedEpoch: epoch - 2,
  submittedAt: null,
  enactedEpoch: epoch,
  slug: null,
  payload: pay(lovelace),
});

describe('runwayInputs', () => {
  it('derives rate and decay from a clean series', () => {
    const inp = runwayInputs(series(L - 146, L), new Map(), L, cfg);
    expect(inp).not.toBeNull();
    expect(Math.abs((inp as RunwayInputs).inflowRatePpb - 500_000)).toBeLessThanOrEqual(1);
    expect(Math.abs((inp as RunwayInputs).decayPpb - 1_000_000)).toBeLessThanOrEqual(1);
  });

  it('adds paid withdrawals back into the inflow', () => {
    const paid = new Map([[L - 10, 10_000_000n]]);
    const inp = runwayInputs(series(L - 146, L, paid), paid, L, cfg);
    expect(Math.abs((inp as RunwayInputs).inflowRatePpb - 500_000)).toBeLessThanOrEqual(1);
  });

  it('returns null with 72 inflow pairs', () => {
    const s = series(L - 146, L).filter((b) => b.epoch !== L - 73);
    expect(runwayInputs(s, new Map(), L, cfg)).toBeNull();
  });

  it('returns null without R[L-146]', () => {
    expect(runwayInputs(series(L - 145, L), new Map(), L, cfg)).toBeNull();
  });

  it('returns null when a reserve is 0', () => {
    const s = series(L - 146, L).map((b) => (b.epoch === L - 5 ? { ...b, reserves: 0n } : b));
    expect(runwayInputs(s, new Map(), L, cfg)).toBeNull();
  });

  it('ignores the open epoch', () => {
    const base = runwayInputs(series(L - 146, L), new Map(), L, cfg);
    const wild = [...series(L - 146, L), { epoch: L + 1, treasury: 1n, reserves: 1n }];
    expect(runwayInputs(wild, new Map(), L, cfg)).toEqual(base);
  });
});

describe('projectRunway', () => {
  const prod: RunwayInputs = {
    lastClosedEpoch: L,
    treasury: 1_433_800_000_000_000n,
    reserves: 5_981_000_000_000_000n,
    inflowRatePpb: 694_000,
    decayPpb: 1_635_000,
    epochStartSec: epochStartUnix(L, cfg),
    epochLengthSec: EPOCH_LENGTH_SECONDS,
  };
  const ada = (m: number) => BigInt(m) * 1_000_000_000_000n;

  it('projects no end for zero spending and names the horizon year', () => {
    const r = projectRunway(prod, 0n);
    expect(r.endEpoch).toBeNull();
    expect(r.endYear).toBeNull();
    expect(r.horizonYear).toBe(new Date((epochStartUnix(L + 2190, cfg)) * 1000).getUTCFullYear());
  });

  it('matches the research figures for the prod values', () => {
    expect(projectRunway(prod, ada(532)).endYear).toBe(2031);
    expect(projectRunway(prod, ada(361)).endYear).toBe(2035);
    expect(projectRunway(prod, ada(277)).endYear).toBe(2039);
  });

  it('starts the points at the last closed epoch', () => {
    const r = projectRunway(prod, ada(532));
    expect(r.points[0]).toEqual({ epoch: L, treasury: prod.treasury });
    expect(r.points.at(-1)?.epoch).toBe(r.endEpoch);
  });
});

describe('presets and paid per epoch', () => {
  it('sums the full payload of enacted rows by epoch', () => {
    const m = paidByEnactedEpoch([enacted(600, 5), enacted(600, 7), { ...enacted(601, 9), status: 'expired' }]);
    expect(m.get(600)).toBe(12n);
    expect(m.has(601)).toBe(false);
  });

  it('presets use the exact amounts', () => {
    const list = groupRecipients([enacted(L - 10, 532_000_000), enacted(L - 100, 1)], cfg);
    const p = runwayPresets(list, L, L + 1, cfg);
    expect(p.find((x) => x.id === 'last12')?.lovelacePerYear).toBe(532_000_000n);
    const ncl = p.find((x) => x.id === 'ncl');
    expect(ncl?.lovelacePerYear).toBe((500_000_000_000_000n * 73n) / 101n);
  });

  it('drops the NCL preset outside any period', () => {
    expect(runwayPresets([], 100, 101, cfg).some((x) => x.id === 'ncl')).toBe(false);
  });
});
