/// <reference types="@cloudflare/workers-types" />
// Single-row cache (id=1) of CIP-1694 voting thresholds + committee quorum,
// synced from Koios by gov-sync. Parameterized SQL only.

export interface ProtocolParams {
  epoch: number | null;
  dvtMotionNoConfidence: number | null;
  dvtCommitteeNormal: number | null;
  dvtCommitteeNoConfidence: number | null;
  dvtUpdateConstitution: number | null;
  dvtHardFork: number | null;
  dvtPpNetwork: number | null;
  dvtPpEconomic: number | null;
  dvtPpTechnical: number | null;
  dvtPpGov: number | null;
  dvtTreasuryWithdrawal: number | null;
  pvtMotionNoConfidence: number | null;
  pvtCommitteeNormal: number | null;
  pvtCommitteeNoConfidence: number | null;
  pvtHardFork: number | null;
  pvtSecurityGroup: number | null;
  ccThreshold: number | null;
  committeeMinSize: number | null;
  /** Active committee members (authorized, non-expired). Null until first synced. */
  committeeSize: number | null;
  syncedAt: number;
  /** Full epoch_params response JSON, for parameter old to new lookups. Null until first synced. */
  rawJson: string | null;
  /** Treasury balance in lovelace, from Koios /totals. Null until first synced. */
  treasuryLovelace: string | null;
  /** Reserves balance in lovelace, from Koios /totals. Null until first synced. */
  reservesLovelace: string | null;
  /** Epoch the treasury/reserves balances are from. Null until first synced. */
  treasuryEpoch: number | null;
}

interface Row {
  epoch: number | null;
  dvt_motion_no_confidence: number | null; dvt_committee_normal: number | null;
  dvt_committee_no_confidence: number | null; dvt_update_constitution: number | null;
  dvt_hard_fork: number | null; dvt_pp_network: number | null; dvt_pp_economic: number | null;
  dvt_pp_technical: number | null; dvt_pp_gov: number | null; dvt_treasury_withdrawal: number | null;
  pvt_motion_no_confidence: number | null; pvt_committee_normal: number | null;
  pvt_committee_no_confidence: number | null; pvt_hard_fork: number | null; pvt_security_group: number | null;
  cc_threshold: number | null; committee_min_size: number | null; committee_size: number | null;
  synced_at: number;
  raw_json: string | null;
  treasury_lovelace: string | null; reserves_lovelace: string | null; treasury_epoch: number | null;
}

export async function getProtocolParams(db: D1Database): Promise<ProtocolParams | null> {
  const r = await db.prepare('SELECT * FROM protocol_params WHERE id = 1').first<Row>();
  if (!r) return null;
  return {
    epoch: r.epoch,
    dvtMotionNoConfidence: r.dvt_motion_no_confidence, dvtCommitteeNormal: r.dvt_committee_normal,
    dvtCommitteeNoConfidence: r.dvt_committee_no_confidence, dvtUpdateConstitution: r.dvt_update_constitution,
    dvtHardFork: r.dvt_hard_fork, dvtPpNetwork: r.dvt_pp_network, dvtPpEconomic: r.dvt_pp_economic,
    dvtPpTechnical: r.dvt_pp_technical, dvtPpGov: r.dvt_pp_gov, dvtTreasuryWithdrawal: r.dvt_treasury_withdrawal,
    pvtMotionNoConfidence: r.pvt_motion_no_confidence, pvtCommitteeNormal: r.pvt_committee_normal,
    pvtCommitteeNoConfidence: r.pvt_committee_no_confidence, pvtHardFork: r.pvt_hard_fork,
    pvtSecurityGroup: r.pvt_security_group, ccThreshold: r.cc_threshold,
    committeeMinSize: r.committee_min_size, committeeSize: r.committee_size ?? null,
    syncedAt: r.synced_at,
    rawJson: r.raw_json,
    treasuryLovelace: r.treasury_lovelace, reservesLovelace: r.reserves_lovelace,
    treasuryEpoch: r.treasury_epoch,
  };
}

export async function upsertProtocolParams(db: D1Database, p: ProtocolParams): Promise<void> {
  await db.prepare(
    `INSERT OR REPLACE INTO protocol_params
       (id, epoch, dvt_motion_no_confidence, dvt_committee_normal, dvt_committee_no_confidence,
        dvt_update_constitution, dvt_hard_fork, dvt_pp_network, dvt_pp_economic, dvt_pp_technical,
        dvt_pp_gov, dvt_treasury_withdrawal, pvt_motion_no_confidence, pvt_committee_normal,
        pvt_committee_no_confidence, pvt_hard_fork, pvt_security_group, cc_threshold,
        committee_min_size, committee_size, synced_at, raw_json,
        treasury_lovelace, reserves_lovelace, treasury_epoch)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    p.epoch, p.dvtMotionNoConfidence, p.dvtCommitteeNormal, p.dvtCommitteeNoConfidence,
    p.dvtUpdateConstitution, p.dvtHardFork, p.dvtPpNetwork, p.dvtPpEconomic, p.dvtPpTechnical,
    p.dvtPpGov, p.dvtTreasuryWithdrawal, p.pvtMotionNoConfidence, p.pvtCommitteeNormal,
    p.pvtCommitteeNoConfidence, p.pvtHardFork, p.pvtSecurityGroup, p.ccThreshold,
    p.committeeMinSize, p.committeeSize, p.syncedAt, p.rawJson,
    p.treasuryLovelace, p.reservesLovelace, p.treasuryEpoch,
  ).run();
}
