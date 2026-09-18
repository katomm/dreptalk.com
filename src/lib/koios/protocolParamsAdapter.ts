// The single Koios /epoch_params to ProtocolParams mapping. Pure: no D1, no
// fetch, so both the gov-sync params phase (paramsSync.ts, which writes the
// cached row) and the /ga/new submit form (which reads the live response the
// browser already fetches for the deposit) map the response the same way.
//
// The field names on the two sides differ in places, and two of them are easy
// to get subtly wrong: Koios calls the constitution threshold
// dvt_update_to_constitution and the hard fork one dvt_hard_fork_initiation,
// while the app's columns are dvtUpdateConstitution and dvtHardFork.
//
// Not to be confused with the mapper in db/protocolParams.ts, which maps the
// stored D1 columns, not the Koios response.
import type { EpochParamsRow } from './client.js';
import type { ProtocolParams } from '../db/protocolParams.js';

/**
 * Maps a Koios /epoch_params row to ProtocolParams. The fields /epoch_params
 * does not carry (the committee quorum and size from /committee_info, the
 * treasury balances from /totals, and the cache bookkeeping) come back unset:
 * null, with syncedAt 0. Callers that have those values fill them in on top,
 * callers that only need thresholds ignore them.
 */
export function protocolParamsFromEpochParams(ep: EpochParamsRow): ProtocolParams {
  return {
    epoch: ep.epoch_no ?? null,
    dvtMotionNoConfidence: ep.dvt_motion_no_confidence ?? null,
    dvtCommitteeNormal: ep.dvt_committee_normal ?? null,
    dvtCommitteeNoConfidence: ep.dvt_committee_no_confidence ?? null,
    dvtUpdateConstitution: ep.dvt_update_to_constitution ?? null,
    dvtHardFork: ep.dvt_hard_fork_initiation ?? null,
    dvtPpNetwork: ep.dvt_p_p_network_group ?? null,
    dvtPpEconomic: ep.dvt_p_p_economic_group ?? null,
    dvtPpTechnical: ep.dvt_p_p_technical_group ?? null,
    dvtPpGov: ep.dvt_p_p_gov_group ?? null,
    dvtTreasuryWithdrawal: ep.dvt_treasury_withdrawal ?? null,
    pvtMotionNoConfidence: ep.pvt_motion_no_confidence ?? null,
    pvtCommitteeNormal: ep.pvt_committee_normal ?? null,
    pvtCommitteeNoConfidence: ep.pvt_committee_no_confidence ?? null,
    pvtHardFork: ep.pvt_hard_fork_initiation ?? null,
    pvtSecurityGroup: ep.pvtpp_security_group ?? null,
    committeeMinSize: ep.committee_min_size ?? null,
    ccThreshold: null,
    committeeSize: null,
    syncedAt: 0,
    rawJson: null,
    treasuryLovelace: null,
    reservesLovelace: null,
    circulationLovelace: null,
    treasuryEpoch: null,
  };
}
