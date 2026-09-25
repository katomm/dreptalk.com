// One-time launch seed for drep.link. Reads registered, named DReps from the
// chosen network's D1 (read only), plans the handles against the 2026-09-25
// baseline, prints a review report and writes a SQL file. It never writes to
// D1 itself. Usage:
//   npm run drep-link:seed -- --network mainnet --baseline <path> --overrides <path> --out <dir>
// --network preprod only serves as a read source for a local test run.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { planSeed, type Baseline, type SeedOverrides } from '../src/lib/drepLink/assign.js';
import { validateHandle } from '../src/lib/drepLink/handle.js';
import { parseDrepId } from '../src/lib/cardano/identity.js';

const { values } = parseArgs({
  options: {
    network: { type: 'string' },
    baseline: { type: 'string' },
    overrides: { type: 'string' },
    out: { type: 'string' },
  },
});
const network = values.network;
if (network !== 'mainnet' && network !== 'preprod') throw new Error('--network mainnet|preprod');
if (!values.baseline || !values.out) throw new Error('--baseline and --out are required');

const wranglerArgs =
  network === 'preprod'
    ? ['d1', 'execute', 'DB', '-c', 'workers/gov-sync/wrangler.toml', '--env', 'preprod', '--remote', '--json']
    : ['d1', 'execute', 'DB', '--remote', '--json'];
// Pseudo-DReps (drep_always_*) never carry a name, the prefix filter is a guard.
const sql = `SELECT drep_id, name, registered_at FROM dreps
  WHERE status = 'registered' AND name IS NOT NULL AND drep_id LIKE 'drep1%'`;
const raw = execFileSync('npx', ['wrangler', ...wranglerArgs, '--command', sql], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const rows = (JSON.parse(raw)[0].results as { drep_id: string; name: string | null; registered_at: number | null }[]).map(
  (r) => ({ drepId: r.drep_id, name: r.name, registeredAt: r.registered_at }),
);

// The baseline is a mainnet snapshot. Preprod runs without one.
const baseline = JSON.parse(readFileSync(values.baseline, 'utf8')) as Baseline;
const overrides: SeedOverrides = values.overrides
  ? JSON.parse(readFileSync(values.overrides, 'utf8'))
  : { assign: {}, skip: [] };
const plan = planSeed(rows, network === 'mainnet' ? baseline : { bases: {} }, overrides);

// Everything that goes into the SQL is re-checked here: handles against the
// rules (overrides may take reserved names), ids as checksummed CIP-129 drep1.
const isDrepId = (id: string) => id.startsWith('drep1') && parseDrepId(id) !== null;
for (const a of plan.assigned) {
  if (!isDrepId(a.drepId)) throw new Error(`bad drep id ${a.drepId}`);
  const check = validateHandle(a.handle, a.drepId);
  if (!check.ok && !(a.source === 'manual' && check.reason === 'reserved')) {
    throw new Error(`bad handle ${a.handle}: ${check.reason}`);
  }
}
for (const id of plan.decided) if (!isDrepId(id)) throw new Error(`bad drep id ${id}`);

const now = Math.floor(Date.now() / 1000);
const lines = [
  '-- drep.link launch seed. The marker insert comes first: a second run fails',
  '-- on its CHECK/PRIMARY KEY before anything else is written.',
  `INSERT INTO drep_handle_seed (id, seeded_at) VALUES (1, ${now});`,
  ...plan.assigned.map(
    (a) =>
      `INSERT INTO drep_handles (handle, drep_id, source, is_primary, released_at, created_at, updated_at) VALUES ('${a.handle}', '${a.drepId}', '${a.source}', 1, NULL, ${now}, ${now});`,
  ),
  ...plan.decided.map((id) => `UPDATE dreps SET handle_auto_at = ${now} WHERE drep_id = '${id}';`),
];
const sqlPath = join(values.out, `drep-link-seed-${network}.sql`);
writeFileSync(sqlPath, `${lines.join('\n')}\n`);

const report = [
  `# drep.link seed report (${network})`,
  '',
  `- Candidates: ${rows.length}`,
  `- Handles: ${plan.assigned.length} (${plan.assigned.filter((a) => a.source === 'manual').length} manual)`,
  `- Decided (stamped): ${plan.decided.length}`,
  '',
  '## Flags',
  '',
  ...plan.flags.filter((f) => f.kind !== 'not_in_baseline' || network === 'mainnet').map((f) => `- \`${f.handle}\` ${f.kind}${f.kind === 'skipped' ? ` (${f.reason})` : ''}: ${f.drepIds.join(', ')}`),
  '',
  `SQL: ${sqlPath}`,
];
const reportPath = join(values.out, `drep-link-seed-${network}.md`);
writeFileSync(reportPath, `${report.join('\n')}\n`);
console.log(report.join('\n'));
