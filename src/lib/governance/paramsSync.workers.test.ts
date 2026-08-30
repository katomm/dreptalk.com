import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import type { CommitteeMember, EpochParamsRow } from '../koios/client.js';
import { getProtocolParams } from '../db/protocolParams.js';
import { syncProtocolParams, type ParamsSyncKoios } from './paramsSync.js';

function epochParamsRow(overrides: Partial<EpochParamsRow> = {}): EpochParamsRow {
  return {
    epoch_no: 570,
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
    pvt_motion_no_confidence: 0.51,
    pvt_committee_normal: 0.51,
    pvt_committee_no_confidence: 0.51,
    pvt_hard_fork_initiation: 0.51,
    pvtpp_security_group: 0.51,
    committee_min_size: 7,
    ...overrides,
  };
}

function member(overrides: Partial<CommitteeMember> = {}): CommitteeMember {
  return {
    status: 'authorized',
    cc_hot_id: 'cc_hot1test',
    cc_cold_id: 'cc_cold1test',
    cc_hot_hex: 'aa'.repeat(28),
    cc_cold_hex: 'bb'.repeat(28),
    expiration_epoch: 900,
    cc_hot_has_script: false,
    cc_cold_has_script: false,
    ...overrides,
  };
}

function fakeKoios(overrides: Partial<ParamsSyncKoios> = {}): ParamsSyncKoios {
  return {
    epochParams: overrides.epochParams ?? (async () => epochParamsRow()),
    committeeSummary:
      overrides.committeeSummary ??
      (async () => ({
        quorum: 0.67,
        members: [member(), member({ status: 'resigned', cc_hot_hex: 'cc'.repeat(28), cc_cold_hex: 'dd'.repeat(28) })],
      })),
    totals: overrides.totals ?? (async () => ({ epochNo: 570, treasuryLovelace: '1500000000000', reservesLovelace: '900000000000' })),
  };
}

describe('syncProtocolParams', () => {
  it('writes thresholds, active committee size, and treasury balances on first sync', async () => {
    const r = await syncProtocolParams({ koios: fakeKoios(), db: env.DB, now: 1_000 });

    expect(r.written).toBe(1);
    expect(r.epoch).toBe(570);
    const stored = await getProtocolParams(env.DB);
    expect(stored).toMatchObject({
      epoch: 570,
      dvtTreasuryWithdrawal: 0.67,
      pvtSecurityGroup: 0.51,
      ccThreshold: 0.67,
      committeeMinSize: 7,
      // Only the authorized, non-expired member counts.
      committeeSize: 1,
      treasuryLovelace: '1500000000000',
      reservesLovelace: '900000000000',
      treasuryEpoch: 570,
    });
  });

  it('writes nothing when a second sync sees identical data', async () => {
    await syncProtocolParams({ koios: fakeKoios(), db: env.DB, now: 1_000 });
    const r = await syncProtocolParams({ koios: fakeKoios(), db: env.DB, now: 2_000 });

    expect(r.written).toBe(0);
    expect((await getProtocolParams(env.DB))!.syncedAt).toBe(1_000);
  });

  it('carries stored treasury balances forward when the totals fetch fails', async () => {
    await syncProtocolParams({ koios: fakeKoios(), db: env.DB, now: 1_000 });

    const r = await syncProtocolParams({
      koios: fakeKoios({
        epochParams: async () => epochParamsRow({ epoch_no: 571 }),
        totals: async () => { throw new Error('koios 503'); },
      }),
      db: env.DB,
      now: 2_000,
    });

    expect(r.written).toBe(1);
    const stored = await getProtocolParams(env.DB);
    expect(stored).toMatchObject({
      epoch: 571,
      treasuryLovelace: '1500000000000',
      reservesLovelace: '900000000000',
      treasuryEpoch: 570,
    });
  });

  it('does not write when Koios has no epoch params row', async () => {
    const r = await syncProtocolParams({
      koios: fakeKoios({ epochParams: async () => null }),
      db: env.DB,
      now: 1_000,
    });

    expect(r.written).toBe(0);
    expect(await getProtocolParams(env.DB)).toBeNull();
  });

  it('reports committee members missing from the seeded membership timeline', async () => {
    const r = await syncProtocolParams({ koios: fakeKoios(), db: env.DB, now: 1_000 });

    expect(r.unknownMembers).toBeGreaterThan(0);
  });
});
