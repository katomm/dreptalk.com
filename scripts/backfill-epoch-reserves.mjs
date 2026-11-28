// One-off backfill of governance_epoch_stats.reserves_lovelace from Koios
// /totals. Writes a SQL file of guarded UPDATEs (only rows whose reserves are
// still NULL) and never executes anything itself. Apply the file per network:
//   node scripts/backfill-epoch-reserves.mjs mainnet
//   npx wrangler d1 execute DB --local --file .wrangler/backfill-epoch-reserves-mainnet.sql
// The network argument is required and picks the Koios endpoint, so a preprod
// file can never carry mainnet balances.
import { mkdirSync, writeFileSync } from 'node:fs';

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
  const res = await fetch(`${base}/totals?select=epoch_no,reserves&order=epoch_no.asc&limit=1000&offset=${offset}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Koios ${res.status} at offset ${offset}`);
  const page = await res.json();
  rows.push(...page);
  if (page.length < 1000) break;
}

const lines = [];
for (const r of rows) {
  const epoch = Number(r.epoch_no);
  const reserves = String(r.reserves);
  if (!Number.isInteger(epoch) || !/^\d+$/.test(reserves)) throw new Error(`Unexpected row ${JSON.stringify(r)}`);
  lines.push(`UPDATE governance_epoch_stats SET reserves_lovelace = '${reserves}' WHERE epoch = ${epoch} AND reserves_lovelace IS NULL;`);
}

mkdirSync('.wrangler', { recursive: true });
const out = `.wrangler/backfill-epoch-reserves-${network}.sql`;
writeFileSync(out, `${lines.join('\n')}\n`);
console.log(`network=${network} source=${base} epochs=${rows.length} first=${rows[0]?.epoch_no} last=${rows.at(-1)?.epoch_no} file=${out}`);
