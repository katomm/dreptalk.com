// Threshold sync/read tests; run in real workerd so app_meta is a real D1 table.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { syncDrepThresholds, getDrepThresholds, thresholdsFromEpochParams } from './thresholds.js';
import type { EpochParams } from '../koios/client.js';

const db = () => env.DB;

const PARAMS: EpochParams = {
  dvt_motion_no_confidence: 0.67,
  dvt_committee_normal: 0.67,
  dvt_committee_no_confidence: 0.6,
  dvt_update_to_constitution: 0.75,
  dvt_hard_fork_initiation: 0.6,
  dvt_p_p_network_group: 0.67,
  dvt_p_p_economic_group: 0.67,
  dvt_p_p_technical_group: 0.67,
  dvt_p_p_gov_group: 0.75,
  dvt_treasury_withdrawal: 0.67,
};

describe('thresholdsFromEpochParams', () => {
  it('derives distinct sorted markers', () => {
    expect(thresholdsFromEpochParams(PARAMS).markers).toEqual([0.6, 0.67, 0.75]);
  });
});

describe('syncDrepThresholds + getDrepThresholds', () => {
  it('returns null before any sync', async () => {
    expect(await getDrepThresholds(db())).toBeNull();
  });

  it('stores and reads back thresholds with asOf', async () => {
    const ok = await syncDrepThresholds({ koios: { epochParams: async () => PARAMS }, db: db(), now: 1_700_000_000 });
    expect(ok).toBe(true);
    const stored = await getDrepThresholds(db());
    expect(stored?.markers).toEqual([0.6, 0.67, 0.75]);
    expect(stored?.asOf).toBe(1_700_000_000);
    expect(stored?.thresholds.dvt_treasury_withdrawal).toBe(0.67);
  });

  it('returns false and does not write when Koios has no params', async () => {
    const ok = await syncDrepThresholds({ koios: { epochParams: async () => null }, db: db(), now: 2 });
    expect(ok).toBe(false);
  });
});
