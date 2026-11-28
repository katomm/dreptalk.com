// SQL for the one-off reserves backfill (scripts/backfill-epoch-reserves.mjs).
// Each UPDATE also requires the stored treasury of that epoch to equal Koios's
// value from the same /totals row. Applied to a database of the other network,
// the epochs overlap but the treasuries do not, so no row matches and nothing
// is written. Rows that already hold reserves are left alone.

export interface TotalsRow {
  epoch_no: number;
  treasury: string;
  reserves: string;
}

export function reservesBackfillSql(network: 'mainnet' | 'preprod', rows: TotalsRow[]): string {
  const lines = [`-- network=${network}, apply to the ${network} D1 only`];
  for (const r of rows) {
    if (!Number.isInteger(r.epoch_no) || !/^\d+$/.test(String(r.treasury)) || !/^\d+$/.test(String(r.reserves))) {
      throw new Error(`Unexpected totals row ${JSON.stringify(r)}`);
    }
    lines.push(
      `UPDATE governance_epoch_stats SET reserves_lovelace = '${r.reserves}' WHERE epoch = ${r.epoch_no} AND reserves_lovelace IS NULL AND treasury_lovelace = '${r.treasury}';`,
    );
  }
  return `${lines.join('\n')}\n`;
}
