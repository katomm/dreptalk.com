import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { upsertProtocolParams, getProtocolParams } from './protocolParams.js';

const PARAMS = {
  epoch: 540, dvtTreasuryWithdrawal: 0.67, dvtUpdateConstitution: 0.75,
  dvtMotionNoConfidence: 0.67, dvtCommitteeNormal: 0.67, dvtCommitteeNoConfidence: 0.6,
  dvtHardFork: 0.6, dvtPpNetwork: 0.67, dvtPpEconomic: 0.67, dvtPpTechnical: 0.67, dvtPpGov: 0.75,
  pvtMotionNoConfidence: 0.51, pvtCommitteeNormal: 0.51, pvtCommitteeNoConfidence: 0.51,
  pvtHardFork: 0.51, pvtSecurityGroup: 0.51,
  ccThreshold: 0.67, committeeMinSize: 7, committeeSize: 8, syncedAt: 1717000000000, rawJson: null,
  treasuryLovelace: null, reservesLovelace: null, circulationLovelace: null, treasuryEpoch: null,
};

describe('protocol_params', () => {
  it('upserts a single row and reads it back', async () => {
    await upsertProtocolParams(env.DB, PARAMS);
    const p = await getProtocolParams(env.DB);
    expect(p!.dvtTreasuryWithdrawal).toBe(0.67);
    expect(p!.ccThreshold).toBe(0.67);
    expect(p!.committeeMinSize).toBe(7);
    expect(p!.committeeSize).toBe(8);
  });
  it('round-trips a null committee size', async () => {
    await upsertProtocolParams(env.DB, { ...PARAMS, committeeSize: null });
    const p = await getProtocolParams(env.DB);
    expect(p!.committeeSize).toBeNull();
  });
  it('upsert overwrites the single row (id=1)', async () => {
    await upsertProtocolParams(env.DB, { ...PARAMS, epoch: 541, dvtTreasuryWithdrawal: 0.6 });
    const p = await getProtocolParams(env.DB);
    expect(p!.epoch).toBe(541);
    expect(p!.dvtTreasuryWithdrawal).toBe(0.6);
  });
  it('round-trips raw_json', async () => {
    await upsertProtocolParams(env.DB, { ...PARAMS, rawJson: '{"gov_action_deposit":100000000000}' });
    const p = await getProtocolParams(env.DB);
    expect(p!.rawJson).toBe('{"gov_action_deposit":100000000000}');
  });
});
