/// <reference types="@cloudflare/workers-types" />
// Refreshes the cached CIP-1694 voting thresholds + committee quorum (used by
// the GA detail Voting Information card) from Koios, extracted from the
// gov-sync worker's params phase. Only-changed write against the single-row
// protocol_params cache, plus the committee membership timeline update that
// feeds the CC yes-percentage recompute.

import type { CommitteeMember, EpochParamsRow } from '../koios/client.js';
import { activeCommitteeSize } from '../koios/committee.js';
import { getProtocolParams, upsertProtocolParams } from '../db/protocolParams.js';
import { syncCurrentCommitteeMembership } from '../db/committee.js';

/** The three Koios reads this sync needs; structural so tests can stub them. */
export interface ParamsSyncKoios {
  epochParams(): Promise<EpochParamsRow | null>;
  committeeSummary(): Promise<{ quorum: number | null; members: CommitteeMember[] | null }>;
  totals(): Promise<{ epochNo: number; treasuryLovelace: string; reservesLovelace: string } | null>;
}

export interface ParamsSyncResult {
  /** 1 when the protocol_params row was (re)written, 0 on a settled no-op run. */
  written: number;
  epoch: number | null;
  /** Committee members seen on chain but missing from the seeded membership timeline. */
  unknownMembers: number;
}

export async function syncProtocolParams(deps: {
  koios: ParamsSyncKoios;
  db: D1Database;
  now: number;
}): Promise<ParamsSyncResult> {
  const { koios, db, now } = deps;
  const [ep, cc] = await Promise.all([koios.epochParams(), koios.committeeSummary()]);
  if (!ep) return { written: 0, epoch: null, unknownMembers: 0 };
  const cur = await getProtocolParams(db);
  // Treasury/reserves balances from a separate Koios endpoint. On a transient
  // failure, carry forward the currently-stored values instead of nulling them
  // out, since this upsert is a full-row replace.
  let totals: { epochNo: number; treasuryLovelace: string; reservesLovelace: string } | null = null;
  try {
    totals = await koios.totals();
  } catch (err) {
    console.error('[gov-params] totals fetch failed, keeping stored treasury values', err);
  }
  const next = {
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
    ccThreshold: cc.quorum,
    committeeMinSize: ep.committee_min_size ?? null,
    // Real committee size for the CIP-1694 min-size rule (null when Koios has
    // no committee row), from the same /committee_info call as the quorum.
    committeeSize:
      cc.members == null ? null : activeCommitteeSize(cc.members, ep.epoch_no ?? null),
    syncedAt: now,
    // Full epoch_params blob: the Overview's parameter old to new lookup reads
    // it (no extra Koios call). Stored verbatim so future keys need no schema change.
    rawJson: JSON.stringify(ep),
    // Fall back to the currently-stored balances when totals() came back null
    // or failed, so a transient Koios error never wipes them via this full-row upsert.
    treasuryLovelace: totals?.treasuryLovelace ?? cur?.treasuryLovelace ?? null,
    reservesLovelace: totals?.reservesLovelace ?? cur?.reservesLovelace ?? null,
    treasuryEpoch: totals?.epochNo ?? cur?.treasuryEpoch ?? null,
  };
  let written = 0;
  if (
    !cur ||
    cur.epoch !== next.epoch ||
    cur.dvtTreasuryWithdrawal !== next.dvtTreasuryWithdrawal ||
    cur.ccThreshold !== next.ccThreshold ||
    // Committee size comes from committee_info, not the epoch_params blob, so
    // rawJson comparison alone would miss membership changes (resignations).
    cur.committeeSize !== next.committeeSize ||
    cur.rawJson !== next.rawJson ||
    cur.treasuryLovelace !== next.treasuryLovelace ||
    cur.reservesLovelace !== next.reservesLovelace ||
    cur.treasuryEpoch !== next.treasuryEpoch
  ) {
    await upsertProtocolParams(db, next);
    written = 1;
  }
  // Keep the committee membership timeline current from the same committee_info
  // snapshot: newly rotated hot keys and term changes feed the CC yes-percentage
  // recompute. Protected against overwriting the seeded resignation history.
  let unknownMembers = 0;
  if (cc.members) {
    const cm = await syncCurrentCommitteeMembership(db, cc.members, ep.epoch_no ?? null);
    unknownMembers = cm.unknown;
    if (cm.unknown > 0) {
      console.warn(`[gov-params] ${cm.unknown} committee member(s) not in the seeded timeline; a committee change may need seeding`);
    }
  }
  console.log(`[gov-params] epoch=${next.epoch} treasury=${next.dvtTreasuryWithdrawal} cc=${next.ccThreshold} ccSize=${next.committeeSize} treasuryLovelace=${next.treasuryLovelace}`);
  return { written, epoch: next.epoch, unknownMembers };
}
