/// <reference types="@cloudflare/workers-types" />
// Every registered statement of the DRep groups store seeks through an index: no table scan
// outside a declared keyset walk and no sort in a temp b-tree.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { declaredCtes, planOf, unboundedScans } from '../__tests__/queryPlan.js';
import { Q, Q_SAMPLE_BINDS } from './queries.js';

describe('query plans of the DRep groups store', () => {
  it('flags an aliased unbounded scan', async () => {
    const sql = 'SELECT v.tx_hash FROM drep_group_verdicts v WHERE v.reason = ?';
    const plan = await planOf(env.DB, sql, ['x']);
    expect(unboundedScans({ sql }, plan)).toHaveLength(1);
    // Without ORDER BY and LIMIT a declared bounded scan does not apply.
    expect(unboundedScans({ sql, boundedScan: 'drep_groups_listed' }, plan)).toHaveLength(1);
  });

  it('accepts the first listed groups page as a bounded keyset scan', async () => {
    const q = {
      sql: 'SELECT group_tx, group_ix FROM drep_groups WHERE members >= 2 ORDER BY member_power DESC, group_id LIMIT ?',
      boundedScan: 'drep_groups_listed',
    };
    const plan = await planOf(env.DB, q.sql, [50]);
    expect(plan.some((d) => d.startsWith('SCAN'))).toBe(true);
    expect(unboundedScans(q, plan)).toEqual([]);
    // The same walk without the declaration fails.
    expect(unboundedScans({ sql: q.sql }, plan)).toHaveLength(1);
  });

  it('accepts a scan over a declared key list', async () => {
    const sql = `WITH k(tx, ix) AS (VALUES (?, ?), (?, ?))
      SELECT v.tx_hash FROM k JOIN drep_group_verdicts v ON v.tx_hash = k.tx AND v.idx = k.ix`;
    expect(declaredCtes(sql)).toEqual(new Set(['k']));
    const plan = await planOf(env.DB, sql, ['a', 0, 'b', 1]);
    expect(unboundedScans({ sql }, plan)).toEqual([]);
  });

  it('flags a keyset whose order needs a temp b-tree', async () => {
    const pending = "witness_state = 'pending' AND witness_retry_at <= ?";
    const byHeight = {
      sql: `SELECT tx_hash, cert_index FROM drep_group_ledger WHERE ${pending}
        ORDER BY block_height, tx_index, cert_index LIMIT 50`,
    };
    expect(unboundedScans(byHeight, await planOf(env.DB, byHeight.sql, [0]))).toHaveLength(1);
    const byRetry = {
      sql: `SELECT tx_hash, cert_index FROM drep_group_ledger WHERE ${pending}
        ORDER BY witness_retry_at, block_height, tx_index, cert_index LIMIT 50`,
    };
    expect(unboundedScans(byRetry, await planOf(env.DB, byRetry.sql, [0]))).toEqual([]);
  });

  it('uses an index for every registered query', { timeout: 30_000 }, async () => {
    const failures: Record<string, string[]> = {};
    for (const [name, q] of Object.entries(Q)) {
      const binds = Q_SAMPLE_BINDS[name as keyof typeof Q];
      const plan = await planOf(env.DB, q.sql, binds);
      const bad = unboundedScans(q, plan);
      if (bad.length > 0) failures[name] = bad;
    }
    expect(failures).toEqual({});
  });
});
