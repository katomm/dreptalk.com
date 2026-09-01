/// <reference types="@cloudflare/workers-types" />
// Decided-outcome and SPO tally reads for the analytics hub. Read-only, no
// writes here, the columns are populated by the tally sync elsewhere. title
// and topicSlug come from a LEFT JOIN against topics (an action without a
// forum topic still counts, so the join must not filter it out).

export interface DecidedOutcomeRow {
  gaId: string;
  title: string | null;
  topicSlug: string | null;
  type: string;
  status: string;
  submittedEpoch: number | null;
  decidedEpoch: number;
  thresholdsJson: string | null;
  drepYesPct: number | null;
  spoYesPct: number | null;
  spoYesPower: number | null;
  spoNoPower: number | null;
  spoAbstainPower: number | null;
  /** Raw lovelace string (exceeds 2^53), never parse to a JS number. */
  spoAlwaysAbstainPower: string | null;
  /** Raw lovelace string (exceeds 2^53), never parse to a JS number. */
  spoNoSidePower: string | null;
}

interface DecidedOutcomeD1Row {
  id: string;
  title: string | null;
  topic_slug: string | null;
  type: string;
  status: string;
  submitted_epoch: number | null;
  decided_epoch: number;
  thresholds_json: string | null;
  drep_yes_pct: number | null;
  spo_yes_pct: number | null;
  spo_yes_power: number | null;
  spo_no_power: number | null;
  spo_abstain_power: number | null;
  spo_always_abstain_power: string | null;
  spo_no_side_power: string | null;
}

/** All decided governance actions, with their thresholds and SPO tally, for outcome analysis. */
export async function listDecidedOutcomeRows(db: D1Database): Promise<DecidedOutcomeRow[]> {
  const rows =
    (
      await db
        .prepare(
          `SELECT g.id AS id, g.title AS title, t.slug AS topic_slug, g.type AS type, g.status AS status,
                  g.submitted_epoch AS submitted_epoch, g.decided_epoch AS decided_epoch, g.thresholds_json AS thresholds_json,
                  g.drep_yes_pct AS drep_yes_pct, g.spo_yes_pct AS spo_yes_pct, g.spo_yes_power AS spo_yes_power,
                  g.spo_no_power AS spo_no_power, g.spo_abstain_power AS spo_abstain_power,
                  g.spo_always_abstain_power AS spo_always_abstain_power, g.spo_no_side_power AS spo_no_side_power
             FROM governance_actions g
             LEFT JOIN topics t ON t.id = g.topic_id
            WHERE g.decided_epoch IS NOT NULL
              AND g.status IN ('enacted', 'ratified', 'expired', 'closed')`,
        )
        .all<DecidedOutcomeD1Row>()
    ).results ?? [];
  return rows.map((r) => ({
    gaId: r.id,
    title: r.title,
    topicSlug: r.topic_slug,
    type: r.type,
    status: r.status,
    submittedEpoch: r.submitted_epoch,
    decidedEpoch: r.decided_epoch,
    thresholdsJson: r.thresholds_json,
    drepYesPct: r.drep_yes_pct,
    spoYesPct: r.spo_yes_pct,
    spoYesPower: r.spo_yes_power,
    spoNoPower: r.spo_no_power,
    spoAbstainPower: r.spo_abstain_power,
    spoAlwaysAbstainPower: r.spo_always_abstain_power,
    spoNoSidePower: r.spo_no_side_power,
  }));
}

/** Count of actions submitted at or after the given epoch, of any status. */
export async function countSubmittedSince(db: D1Database, epoch: number): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM governance_actions WHERE submitted_epoch >= ?')
    .bind(epoch)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Count of all actions grouped by status. Statuses with no rows are absent from the result. */
export async function countActionsByStatus(db: D1Database): Promise<Record<string, number>> {
  const rows =
    (
      await db
        .prepare('SELECT status, COUNT(*) AS n FROM governance_actions GROUP BY status')
        .all<{ status: string; n: number }>()
    ).results ?? [];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = r.n;
  return out;
}
