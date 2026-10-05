import { describe, it, expect } from 'vitest';
import { protocolParamsFromEpochParams } from './protocolParamsAdapter.js';
import type { EpochParamsRow } from './client.js';

// A realistic /epoch_params row, with Koios's own field names. Two of them
// differ from the app's field names in a way a rename would silently break:
// dvt_update_to_constitution (not dvt_update_constitution) and
// dvt_hard_fork_initiation (not dvt_hard_fork).
const KOIOS_ROW = {
  epoch_no: 540,
  protocol_major: 10,
  protocol_minor: 0,
  committee_max_term_length: 146,
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
} satisfies EpochParamsRow;

describe('protocolParamsFromEpochParams', () => {
  it('maps every Koios threshold field onto its app field name', () => {
    const p = protocolParamsFromEpochParams(KOIOS_ROW);
    expect(p.epoch).toBe(540);
    expect(p.dvtMotionNoConfidence).toBe(0.67);
    expect(p.dvtCommitteeNormal).toBe(0.67);
    expect(p.dvtCommitteeNoConfidence).toBe(0.6);
    expect(p.dvtUpdateConstitution).toBe(0.75);
    expect(p.dvtHardFork).toBe(0.6);
    expect(p.dvtPpNetwork).toBe(0.67);
    expect(p.dvtPpEconomic).toBe(0.67);
    expect(p.dvtPpTechnical).toBe(0.67);
    expect(p.dvtPpGov).toBe(0.75);
    expect(p.dvtTreasuryWithdrawal).toBe(0.67);
    expect(p.pvtMotionNoConfidence).toBe(0.51);
    expect(p.pvtCommitteeNormal).toBe(0.51);
    expect(p.pvtCommitteeNoConfidence).toBe(0.51);
    expect(p.pvtHardFork).toBe(0.51);
    expect(p.pvtSecurityGroup).toBe(0.51);
    expect(p.committeeMinSize).toBe(7);
  });

  it('leaves the fields that do not come from epoch_params unset', () => {
    const p = protocolParamsFromEpochParams(KOIOS_ROW);
    expect(p.ccThreshold).toBeNull();
    expect(p.committeeSize).toBeNull();
    expect(p.rawJson).toBeNull();
    expect(p.treasuryLovelace).toBeNull();
    expect(p.reservesLovelace).toBeNull();
    expect(p.circulationLovelace).toBeNull();
    expect(p.treasuryEpoch).toBeNull();
    expect(p.syncedAt).toBe(0);
  });

  it('turns missing and null Koios fields into nulls', () => {
    const p = protocolParamsFromEpochParams({ epoch_no: 541, dvt_hard_fork_initiation: null });
    expect(p.epoch).toBe(541);
    expect(p.dvtHardFork).toBeNull();
    expect(p.dvtMotionNoConfidence).toBeNull();
    expect(p.committeeMinSize).toBeNull();
  });
});
