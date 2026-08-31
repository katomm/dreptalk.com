/// <reference types="@cloudflare/workers-types" />
// Current state of the two predefined delegation options, straight from the
// dreps rows the 6-hour sync maintains. This is the default delegation layer
// of the two-layer convention (see dreps/special.ts), kept apart from every
// representative aggregate.
import { SPECIAL_DREP_IDS } from '../dreps/special.js';

export interface DefaultDelegationOption {
  drepId: string;
  votingPower: string | null;
  delegatorCount: number | null;
  syncedAt: number | null;
}

const [ABSTAIN_ID, ANC_ID] = SPECIAL_DREP_IDS;

export async function getDefaultDelegationCurrent(db: D1Database): Promise<{
  abstain: DefaultDelegationOption | null;
  noConfidence: DefaultDelegationOption | null;
}> {
  const placeholders = SPECIAL_DREP_IDS.map(() => '?').join(', ');
  const rows = (
    await db
      .prepare(
        `SELECT drep_id, voting_power, delegator_count, last_synced_at
           FROM dreps WHERE drep_id IN (${placeholders})`,
      )
      .bind(...SPECIAL_DREP_IDS)
      .all<{ drep_id: string; voting_power: string | null; delegator_count: number | null; last_synced_at: number | null }>()
  ).results ?? [];
  const byId = new Map(rows.map((r) => [r.drep_id, {
    drepId: r.drep_id,
    votingPower: r.voting_power,
    delegatorCount: r.delegator_count,
    syncedAt: r.last_synced_at,
  }]));
  return { abstain: byId.get(ABSTAIN_ID) ?? null, noConfidence: byId.get(ANC_ID) ?? null };
}
