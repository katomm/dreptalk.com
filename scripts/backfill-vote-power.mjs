#!/usr/bin/env node
// Historical voted_power backfill for the governance voting-trend chart.
//
// Reads a LOCAL prod-D1 snapshot (from `npm run db:pull:mainnet`) for the terminal
// governance actions whose DRep/SPO votes still lack voted_power, looks up each
// voter's voting power at the action's decision epoch in cardano-db-sync (reached
// through an SSH tunnel), and EMITS a reviewable .sql file of chunked UPDATEs. It
// never writes to D1 itself, so the production write stays under your control and
// inspectable.
//
// Requires `sqlite3` and `psql` on PATH. db-sync connection comes from the
// environment (open an SSH tunnel first, then export these), no host or credentials
// are baked in:
//   DB_HOST=127.0.0.1 DB_PORT=15432 DB_NAME=dbsync DB_USER=readonly DB_PASSWORD=readonly
//
// Usage:
//   node scripts/backfill-vote-power.mjs --d1 <local-d1.sqlite> --out backfill-vote-power.sql [--limit-actions N]
//   node scripts/backfill-vote-power.mjs --d1 <local-d1.sqlite> --dry-sample 3   # inspect a tiny sample, no file written
//
// The emitted UPDATEs are idempotent (guarded by `voted_power IS NULL`), so a
// re-run after a partial apply, or after the cron filled some rows, is safe.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

function parseArgs(argv) {
  const args = {
    d1: null,
    out: 'backfill-vote-power.sql',
    limitActions: null,
    drySample: null,
    plan: false,
    chunkSize: 5000,
    epochOffset: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--d1') args.d1 = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--limit-actions') args.limitActions = Number(argv[++i]);
    else if (a === '--dry-sample') args.drySample = Number(argv[++i]);
    else if (a === '--plan') args.plan = true;
    else if (a === '--chunk-size') args.chunkSize = Number(argv[++i]);
    else if (a === '--epoch-offset') args.epochOffset = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!Number.isFinite(args.chunkSize) || args.chunkSize < 1) throw new Error('--chunk-size must be a positive integer');
  if (!args.d1) throw new Error('Missing --d1 <path to local prod-D1 sqlite snapshot>');
  return args;
}

function dbEnv() {
  const need = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
  const missing = need.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `Missing db-sync env: ${missing.join(', ')}. Open the SSH tunnel and export them, e.g.\n` +
        '  ssh -f -N -L 15432:<db-host>:5432 <jump-host>\n' +
        '  export DB_HOST=127.0.0.1 DB_PORT=15432 DB_NAME=dbsync DB_USER=readonly DB_PASSWORD=readonly',
    );
  }
  return {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    name: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  };
}

// Runs a query against the local D1 sqlite snapshot, returns parsed rows. Opened
// read-write (SQLite refuses -readonly on a WAL-mode file without its -wal sidecar),
// but every query here is a plain SELECT, so the snapshot is never modified.
function sqlite(d1Path, sql) {
  const out = execFileSync('sqlite3', ['-json', d1Path, sql], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 256,
  }).trim();
  return out ? JSON.parse(out) : [];
}

// Runs a query against db-sync via psql, returns rows as arrays of column strings
// (tab-separated, unaligned). LC_ALL=C silences harmless perl locale warnings.
function psql(cfg, sql) {
  const out = execFileSync(
    'psql',
    [
      '--host', cfg.host, '--port', String(cfg.port), '--dbname', cfg.name, '--user', cfg.user,
      '-P', 'pager=off', '-tA', '-F', '\t', '-c', sql,
    ],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 512, env: { ...process.env, PGPASSWORD: cfg.password, LC_ALL: 'C' } },
  ).trim();
  return out ? out.split('\n').map((line) => line.split('\t')) : [];
}

// A SQL string literal for values that are bech32/hex ids (defensively escape quotes).
function lit(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// Postgres array literal of lowercase hex strings, for `= ANY(...)` filters.
function hexArray(hexes) {
  return `ARRAY[${hexes.map((h) => lit(h)).join(',')}]::text[]`;
}

// Splits an array into chunks of at most `size`.
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// DRep voting power (lovelace) at one epoch for a set of credential hexes.
// Keyed by lowercase hex of the drep credential (drep_hash.raw), matching
// drep_votes.voter_hex. Predefined DReps (raw NULL) are naturally excluded.
function drepPowerAtEpoch(cfg, epoch, hexes) {
  const map = new Map();
  for (const part of chunk(hexes, 1000)) {
    const rows = psql(
      cfg,
      `SELECT lower(encode(dh.raw, 'hex')) AS hex, dd.amount
         FROM drep_distr dd
         JOIN drep_hash dh ON dh.id = dd.hash_id
        WHERE dd.epoch_no = ${epoch}
          AND dh.raw IS NOT NULL
          AND lower(encode(dh.raw, 'hex')) = ANY(${hexArray(part)})`,
    );
    for (const [hex, amount] of rows) map.set(hex, amount);
  }
  return map;
}

// SPO active stake (lovelace) at one epoch for a set of pool hash hexes, summed
// over epoch_stake and tightly filtered to the voting pools (epoch_stake is huge).
// Keyed by lowercase hex of the pool hash (pool_hash.hash_raw), matching
// drep_votes.voter_hex.
function poolStakeAtEpoch(cfg, epoch, hexes) {
  const map = new Map();
  for (const part of chunk(hexes, 1000)) {
    const rows = psql(
      cfg,
      `SELECT lower(encode(ph.hash_raw, 'hex')) AS hex, sum(es.amount) AS amt
         FROM epoch_stake es
         JOIN pool_hash ph ON ph.id = es.pool_id
        WHERE es.epoch_no = ${epoch}
          AND es.pool_id = ANY(
                SELECT id FROM pool_hash WHERE lower(encode(hash_raw, 'hex')) = ANY(${hexArray(part)}))
        GROUP BY ph.hash_raw`,
    );
    for (const [hex, amt] of rows) map.set(hex, amt);
  }
  return map;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  // Votes on terminal actions still missing voted_power, with the action's decision
  // epoch (decided, else the expiry epoch). Only DRep/SPO (CC is count-weighted).
  const limit = args.drySample ?? args.limitActions;
  const actionFilter = limit
    ? `AND v.ga_id IN (
         SELECT id FROM governance_actions
          WHERE status NOT IN ('active','pending')
            AND COALESCE(decided_epoch, expiry_epoch) IS NOT NULL
          ORDER BY COALESCE(decided_epoch, expiry_epoch) DESC
          LIMIT ${limit})`
    : '';
  const votes = sqlite(
    args.d1,
    `SELECT v.ga_id AS ga_id, v.voter_role AS role, v.voter_id AS voter_id,
            lower(v.voter_hex) AS hex, COALESCE(g.decided_epoch, g.expiry_epoch) AS epoch
       FROM drep_votes v
       JOIN governance_actions g ON g.id = v.ga_id
      WHERE v.voted_power IS NULL
        AND v.voter_role IN ('DRep','SPO')
        AND v.voter_hex IS NOT NULL
        AND g.status NOT IN ('active','pending')
        AND COALESCE(g.decided_epoch, g.expiry_epoch) IS NOT NULL
        ${actionFilter}`,
  );

  if (votes.length === 0) {
    console.log('Nothing to backfill: no terminal DRep/SPO votes with a null voted_power and a known decision epoch.');
    return;
  }

  // Group hexes by epoch and role so db-sync is queried once per (epoch, role).
  const byEpoch = new Map(); // epoch -> { drep:Set, spo:Set }
  for (const v of votes) {
    const e = Number(v.epoch);
    if (!byEpoch.has(e)) byEpoch.set(e, { drep: new Set(), spo: new Set() });
    byEpoch.get(e)[v.role === 'DRep' ? 'drep' : 'spo'].add(v.hex);
  }

  // --plan: report the scope from the local snapshot only, no db-sync, nothing written.
  if (args.plan) {
    let dreps = 0;
    let spos = 0;
    const lines = [...byEpoch.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([e, s]) => {
        dreps += s.drep.size;
        spos += s.spo.size;
        return `  epoch ${e}: dreps=${s.drep.size} spos=${s.spo.size}`;
      });
    console.log(`Plan (local snapshot only, no db-sync):`);
    console.log(lines.join('\n'));
    console.log(`\nTotals: votes=${votes.length}, distinct dreps=${dreps}, distinct spos=${spos}, epochs=${byEpoch.size}`);
    console.log('Next: open the SSH tunnel, export DB_* env, then run with --dry-sample 3 to validate amounts.');
    return;
  }

  const cfg = dbEnv();
  const off = args.epochOffset;
  // Power keyed by the vote's own epoch; the db-sync lookup uses epoch + offset
  // (offset is an escape hatch, default 0, in case validation shows a snapshot shift).
  const power = new Map(); // `${epoch}:${hex}` -> lovelace string
  for (const [epoch, sets] of [...byEpoch.entries()].sort((a, b) => a[0] - b[0])) {
    if (sets.drep.size) {
      const m = drepPowerAtEpoch(cfg, epoch + off, [...sets.drep]);
      for (const [hex, amt] of m) power.set(`${epoch}:${hex}`, amt);
    }
    if (sets.spo.size) {
      const m = poolStakeAtEpoch(cfg, epoch + off, [...sets.spo]);
      for (const [hex, amt] of m) power.set(`${epoch}:${hex}`, amt);
    }
    console.log(`epoch ${epoch}${off ? ` (lookup ${epoch + off})` : ''}: dreps=${sets.drep.size} spos=${sets.spo.size} resolved`);
  }

  // Build the UPDATEs. voted_power is INTEGER (SQLite 64-bit) and lovelace fits.
  const updates = [];
  const unmatched = { DRep: 0, SPO: 0 };
  for (const v of votes) {
    const amt = power.get(`${Number(v.epoch)}:${v.hex}`);
    if (amt == null) {
      unmatched[v.role]++;
      continue;
    }
    const n = String(amt).split('.')[0]; // lovelace is integer; drop any decimal tail
    updates.push(
      `UPDATE drep_votes SET voted_power = ${n} WHERE ga_id = ${lit(v.ga_id)} AND voter_id = ${lit(v.voter_id)} AND voted_power IS NULL;`,
    );
  }

  console.log(
    `\nvotes needing power: ${votes.length} | updates: ${updates.length} | ` +
      `unmatched DRep: ${unmatched.DRep} SPO: ${unmatched.SPO} | epochs: ${byEpoch.size}`,
  );

  if (args.drySample != null) {
    console.log('\n--- dry sample (first 20 UPDATEs, nothing written) ---');
    console.log(updates.slice(0, 20).join('\n'));
    console.log('\nValidate a couple of these amounts against Koios or gov.tools before the full run.');
    return;
  }

  if (updates.length === 0) {
    console.log('No UPDATEs to write (every needed voter was unmatched in db-sync). Nothing emitted.');
    return;
  }

  // Split into chunk files so each stays small enough to apply (and review) on its
  // own; the voted_power IS NULL guard keeps every chunk independently re-runnable.
  const parts = chunk(updates, args.chunkSize);
  const base = args.out.replace(/\.sql$/i, '');
  const single = parts.length === 1;
  const files = [];
  parts.forEach((part, i) => {
    const file = single ? `${base}.sql` : `${base}.${String(i + 1).padStart(3, '0')}.sql`;
    const header =
      '-- Historical voted_power backfill for the voting-trend chart. Generated, review before applying.\n' +
      `-- Part ${i + 1}/${parts.length}, ${part.length} UPDATEs. Idempotent (voted_power IS NULL). Apply parts in order.\n`;
    writeFileSync(file, header + part.join('\n') + '\n');
    files.push(file);
  });

  console.log(`\nWrote ${updates.length} UPDATEs across ${files.length} file(s):`);
  for (const f of files) console.log(`  ${f}`);
  console.log('\nReview, then apply each in order:');
  for (const f of files) console.log(`  wrangler d1 execute DB --remote --file ${f}`);
}

main();
