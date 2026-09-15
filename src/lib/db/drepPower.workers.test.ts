import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { loadPowerLookup, newestPowerEpoch } from './drepPower.js';

const db = env.DB as D1Database;
const HEX_A = '11'.repeat(28);
const HEX_B = '22'.repeat(28);
const HEX_SCRIPT = '33'.repeat(28);

async function seed(): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO dreps (drep_id, hex, has_script, status, active, last_synced_at, created_at)
         VALUES ('drep_a', ?, 0, 'active', 1, 0, 0)`,
      )
      .bind(HEX_A),
    db
      .prepare(
        `INSERT INTO dreps (drep_id, hex, has_script, status, active, last_synced_at, created_at)
         VALUES ('drep_b', ?, 0, 'active', 1, 0, 0)`,
      )
      .bind(HEX_B),
    db
      .prepare(
        `INSERT INTO dreps (drep_id, hex, has_script, status, active, last_synced_at, created_at)
         VALUES ('drep_script', ?, 1, 'active', 1, 0, 0)`,
      )
      .bind(HEX_SCRIPT),
    db.prepare(
      `INSERT INTO drep_voting_power_history (drep_id, epoch, amount)
       VALUES ('drep_a', 312, '9007199254740993'), ('drep_b', 312, '0'),
              ('drep_script', 312, '500'), ('drep_a', 311, '1')`,
    ),
    db.prepare(
      `INSERT INTO governance_epoch_stats
         (epoch, total_drep_power, powered_drep_count, recently_voting_drep_count,
          gini, top10_share_pct, min_coalition_50, min_coalition_67, votes_cast,
          vote_data_complete, computed_at)
       VALUES (312, '20000000000000', 3, 1, 0.5, 10.0, 5, 9, 2, 0, 0)`,
    ),
  ]);
}

describe('drep power lookup', () => {
  it('reports the newest epoch in the history table', async () => {
    await seed();
    expect(await newestPowerEpoch(db)).toBe(312);
  });

  it('returns null when the history table is empty', async () => {
    expect(await newestPowerEpoch(db)).toBeNull();
    expect(await loadPowerLookup(db, [{ hex: HEX_A, isScript: false }])).toBeNull();
  });

  it('resolves a key credential to an exact bigint weight past 2^53', async () => {
    await seed();
    const p = (await loadPowerLookup(db, [{ hex: HEX_A, isScript: false }]))!;
    expect(p.epoch).toBe(312);
    expect(p.weightOf(HEX_A, false)).toBe(9_007_199_254_740_993n);
  });

  it('distinguishes a registered DRep with no power from an unresolvable one', async () => {
    await seed();
    const p = (await loadPowerLookup(db, [
      { hex: HEX_B, isScript: false },
      { hex: '99'.repeat(28), isScript: false },
    ]))!;
    expect(p.weightOf(HEX_B, false)).toBe(0n);
    expect(p.weightOf('99'.repeat(28), false)).toBeNull();
  });

  it('does not match a key credential against a script DRep of the same hash', async () => {
    await seed();
    const p = (await loadPowerLookup(db, [{ hex: HEX_SCRIPT, isScript: true }]))!;
    expect(p.weightOf(HEX_SCRIPT, true)).toBe(500n);
    expect(p.weightOf(HEX_SCRIPT, false)).toBeNull();
  });

  it('carries the epoch total as an exact decimal string', async () => {
    await seed();
    const p = (await loadPowerLookup(db, [{ hex: HEX_A, isScript: false }]))!;
    expect(p.totalPower).toBe('20000000000000');
  });

  it('leaves the total null when the epoch has no stats row, never zero', async () => {
    await db.prepare(
      `INSERT INTO drep_voting_power_history (drep_id, epoch, amount) VALUES ('drep_a', 400, '5')`,
    ).run();
    const p = (await loadPowerLookup(db, [{ hex: HEX_A, isScript: false }]))!;
    expect(p.epoch).toBe(400);
    expect(p.totalPower).toBeNull();
  });
});
