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
  it('upserts the single row, reads it back, and overwrites it in place', async () => {
    await upsertProtocolParams(env.DB, { ...PARAMS, rawJson: '{"gov_action_deposit":100000000000}' });
    const p = await getProtocolParams(env.DB);
    expect(p!.epoch).toBe(540);
    expect(p!.dvtTreasuryWithdrawal).toBe(0.67);
    expect(p!.ccThreshold).toBe(0.67);
    expect(p!.committeeMinSize).toBe(7);
    expect(p!.committeeSize).toBe(8);
    expect(p!.rawJson).toBe('{"gov_action_deposit":100000000000}');

    // The second upsert replaces the same row (id=1), including a null committee size.
    await upsertProtocolParams(env.DB, { ...PARAMS, epoch: 541, dvtTreasuryWithdrawal: 0.6, committeeSize: null });
    const next = await getProtocolParams(env.DB);
    expect(next!.epoch).toBe(541);
    expect(next!.dvtTreasuryWithdrawal).toBe(0.6);
    expect(next!.committeeSize).toBeNull();
    expect(next!.rawJson).toBeNull();
    const { n } = (await env.DB.prepare('SELECT COUNT(*) AS n FROM protocol_params').first<{ n: number }>())!;
    expect(n).toBe(1);
  });
});
