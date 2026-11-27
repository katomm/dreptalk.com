import { describe, it, expect } from 'vitest';
import { protocolParamsFromEpochParams } from './protocolParamsAdapter.js';
import type { EpochParamsRow } from './client.js';

// A /epoch_params row with Koios's own field names and a distinct value per
// field, so a swapped mapping fails. Two names differ from the app's in a way a
// rename would silently break: dvt_update_to_constitution (not
// dvt_update_constitution) and dvt_hard_fork_initiation (not dvt_hard_fork).
const KOIOS_ROW = {
  epoch_no: 540,
  protocol_major: 10,
  protocol_minor: 0,
  committee_max_term_length: 146,
  dvt_motion_no_confidence: 0.61,
  dvt_committee_normal: 0.62,
  dvt_committee_no_confidence: 0.63,
  dvt_update_to_constitution: 0.64,
  dvt_hard_fork_initiation: 0.65,
  dvt_p_p_network_group: 0.66,
  dvt_p_p_economic_group: 0.67,
  dvt_p_p_technical_group: 0.68,
  dvt_p_p_gov_group: 0.69,
  dvt_treasury_withdrawal: 0.7,
  pvt_motion_no_confidence: 0.51,
  pvt_committee_normal: 0.52,
  pvt_committee_no_confidence: 0.53,
  pvt_hard_fork_initiation: 0.54,
  pvtpp_security_group: 0.55,
  committee_min_size: 7,
} satisfies EpochParamsRow;

describe('protocolParamsFromEpochParams', () => {
  it('maps every Koios threshold field onto its app field name and leaves the rest unset', () => {
    expect(protocolParamsFromEpochParams(KOIOS_ROW)).toEqual({
      epoch: 540,
      dvtMotionNoConfidence: 0.61,
      dvtCommitteeNormal: 0.62,
      dvtCommitteeNoConfidence: 0.63,
      dvtUpdateConstitution: 0.64,
      dvtHardFork: 0.65,
      dvtPpNetwork: 0.66,
      dvtPpEconomic: 0.67,
      dvtPpTechnical: 0.68,
      dvtPpGov: 0.69,
      dvtTreasuryWithdrawal: 0.7,
      pvtMotionNoConfidence: 0.51,
      pvtCommitteeNormal: 0.52,
      pvtCommitteeNoConfidence: 0.53,
      pvtHardFork: 0.54,
      pvtSecurityGroup: 0.55,
      committeeMinSize: 7,
      ccThreshold: null,
      committeeSize: null,
      syncedAt: 0,
      rawJson: null,
      treasuryLovelace: null,
      reservesLovelace: null,
      circulationLovelace: null,
      treasuryEpoch: null,
    });
  });

  it('turns missing and null Koios fields into nulls', () => {
    const p = protocolParamsFromEpochParams({ epoch_no: 541, dvt_hard_fork_initiation: null });
    expect(p.epoch).toBe(541);
    expect(p.dvtHardFork).toBeNull();
    expect(p.dvtMotionNoConfidence).toBeNull();
    expect(p.committeeMinSize).toBeNull();
  });
});
