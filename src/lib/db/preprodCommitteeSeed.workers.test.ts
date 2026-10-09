// Migration 0119 seeds the preprod committee from epoch 304 and is gated on the
// preprod hot key, so it must change nothing in a database without it. The
// suite setup has already applied it to the mainnet-shaped seed, so this test
// replays the migration's own statements from the same migration payload.
import { describe, it, expect } from 'vitest';
import { env, type D1Migration } from 'cloudflare:test';
import { getCommitteeTimeline } from './committee.js';
import { activeCommitteeSizeAtBoundary, committeeTimelineDrift } from '../koios/committeeTimeline.js';

const MIGRATION = '0119_preprod_committee_version_304.sql';
const PREPROD_HOT = '5bfa7d850280c54110534065fa91a3635bbcc0eadc69c5c792c35e1e';
const PREPROD_COLD = '615b54137e73f090d2dddb04317bee41624f4013e5cfe4a5efa76d76';

function seedQueries(): string[] {
  const migrations = JSON.parse(env.TEST_D1_MIGRATIONS) as D1Migration[];
  const found = migrations.find((m) => m.name === MIGRATION);
  if (!found) throw new Error(`${MIGRATION} not in the migration payload`);
  return found.queries;
}

const replay = () => env.DB.batch(seedQueries().map((q) => env.DB.prepare(q)));

describe('migration 0119 preprod committee seed', () => {
  it('leaves a database without the preprod hot key untouched', async () => {
    const before = await getCommitteeTimeline(env.DB);
    expect(before.members.length).toBeGreaterThan(0);
    await replay();
    const after = await getCommitteeTimeline(env.DB);
    expect(after.members).toEqual(before.members);
    expect(after.hotToCold).toEqual(before.hotToCold);
  });

  it('replaces the mainnet rows with the three seats from epoch 304 once the live sync stored the preprod hot key', async () => {
    await env.DB.prepare('INSERT OR IGNORE INTO committee_hot_key (hot_key_hex, cold_key_hex) VALUES (?, ?)')
      .bind(PREPROD_HOT, PREPROD_COLD)
      .run();
    await replay();

    const { members, hotToCold } = await getCommitteeTimeline(env.DB);
    expect(members.map((m) => m.coldKeyHex).sort()).toEqual([
      PREPROD_COLD,
      'e36d5e45b277bff4962d6c63be2375af8e68e558e6a373137a0ad6f2',
      'e883ad4599af7b01fe9d01c92bfa405151226db53982931d445b4a96',
    ]);
    expect(members.every((m) => m.versionFrom === 304 && m.versionTo === null && m.termExpiration === 372)).toBe(true);
    expect(hotToCold.size).toBe(3);
    expect(committeeTimelineDrift(members, 3, 318)).toBeNull();
    expect(activeCommitteeSizeAtBoundary(members, 304)).toBe(3);
    expect(activeCommitteeSizeAtBoundary(members, 303)).toBe(0);

    // A second run changes nothing.
    await replay();
    expect((await getCommitteeTimeline(env.DB)).members).toHaveLength(3);
  });
});
