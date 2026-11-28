// One-off backfill of governance_epoch_stats.reserves_lovelace from Koios
// /totals. Writes a SQL file and never executes anything itself. Each UPDATE
// only matches a row whose stored treasury equals Koios's value for that epoch,
// so a file applied to the other network's database writes nothing.
//
//   node scripts/backfill-epoch-reserves.mjs mainnet   (or preprod)
//   local:   npx wrangler d1 execute DB --local --file .wrangler/backfill-epoch-reserves-mainnet.sql
//   remote:  npx wrangler d1 execute dreptalk --remote --file .wrangler/backfill-epoch-reserves-mainnet.sql
//            npx wrangler d1 execute dreptalk-preprod --remote --file .wrangler/backfill-epoch-reserves-preprod.sql
import { mkdirSync, writeFileSync } from 'node:fs';
import { reservesBackfillSql } from '../src/lib/analytics/reservesBackfill.ts';

const KOIOS = {
  mainnet: 'https://api.koios.rest/api/v1',
  preprod: 'https://preprod.koios.rest/api/v1',
};

const network = process.argv[2];
if (!(network in KOIOS)) {
  console.error('Usage: node scripts/backfill-epoch-reserves.mjs <mainnet|preprod>');
  process.exit(1);
}
const base = KOIOS[network];

const rows = [];
for (let offset = 0; ; offset += 1000) {
  const res = await fetch(`${base}/totals?select=epoch_no,treasury,reserves&order=epoch_no.asc&limit=1000&offset=${offset}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Koios ${res.status} at offset ${offset}`);
  const page = await res.json();
  rows.push(...page);
  if (page.length < 1000) break;
}

mkdirSync('.wrangler', { recursive: true });
const out = `.wrangler/backfill-epoch-reserves-${network}.sql`;
writeFileSync(out, reservesBackfillSql(network, rows));
console.log(`network=${network} source=${base} epochs=${rows.length} first=${rows[0]?.epoch_no} last=${rows.at(-1)?.epoch_no} file=${out}`);
