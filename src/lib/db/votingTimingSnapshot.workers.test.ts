import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  writeVotingTimingSnapshot,
  readVotingTimingSnapshot,
  type VotingTimingSnapshotPayload,
} from './votingTimingSnapshot.js';

const payload: VotingTimingSnapshotPayload = {
  drepByType: [{ type: 'InfoAction', medianDay: 3.5, timedVotes: 42 }],
  spoByType: [],
  drepOverall: { medianDay: 4, timedVotes: 100 },
  spoOverall: null,
  half: { medianDay: 2.5, basis: 8 },
  thirds: { early: 10, middle: 20, late: 5, afterClose: 2, basis: 35 },
};

async function writeRaw(raw: string) {
  await env.DB.prepare(
    'INSERT OR REPLACE INTO voting_timing_snapshot (id, payload, computed_at, epoch) VALUES (1, ?, ?, ?)',
  ).bind(raw, 1000, 500).run();
}

describe('voting timing snapshot storage', () => {
  it('returns null when no row exists', async () => {
    expect(await readVotingTimingSnapshot(env.DB)).toBeNull();
  });

  it('roundtrips a payload with its metadata', async () => {
    await writeVotingTimingSnapshot(env.DB, payload, 1234, 567);
    expect(await readVotingTimingSnapshot(env.DB)).toEqual({ payload, computedAt: 1234, epoch: 567 });
  });

  it('overwrites in place rather than appending', async () => {
    await writeVotingTimingSnapshot(env.DB, payload, 1, 1);
    await writeVotingTimingSnapshot(env.DB, { ...payload, half: { medianDay: 9, basis: 1 } }, 2, 2);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM voting_timing_snapshot').first<{ n: number }>();
    expect(count?.n).toBe(1);
    const got = await readVotingTimingSnapshot(env.DB);
    expect(got?.payload?.half).toEqual({ medianDay: 9, basis: 1 });
    expect(got?.computedAt).toBe(2);
  });

  it('reports a null payload on syntactically invalid JSON, keeping the metadata', async () => {
    await writeRaw('{not json');
    expect(await readVotingTimingSnapshot(env.DB)).toEqual({ payload: null, computedAt: 1000, epoch: 500 });
  });

  it('reports a null payload on valid JSON with the wrong structure', async () => {
    for (const raw of [
      '{}',
      JSON.stringify({ ...payload, drepByType: null }),
      JSON.stringify({ ...payload, spoByType: [{ type: 'X', medianDay: 1 }] }),
      JSON.stringify({ ...payload, drepOverall: { medianDay: 'x', timedVotes: 1 } }),
      JSON.stringify({ ...payload, drepOverall: { medianDay: Number.NaN, timedVotes: 1 } }),
      JSON.stringify({ ...payload, half: { medianDay: 1, basis: -1 } }),
      JSON.stringify({ ...payload, thirds: { early: 1, middle: 1, late: 1, afterClose: 1 } }),
    ]) {
      await writeRaw(raw);
      expect((await readVotingTimingSnapshot(env.DB))?.payload).toBeNull();
    }
  });

  it('treats a valid but empty payload as usable, not as a miss', async () => {
    const empty: VotingTimingSnapshotPayload = {
      drepByType: [], spoByType: [], drepOverall: null, spoOverall: null,
      half: { medianDay: null, basis: 0 },
      thirds: { early: 0, middle: 0, late: 0, afterClose: 0, basis: 0 },
    };
    await writeVotingTimingSnapshot(env.DB, empty, 5, 5);
    expect((await readVotingTimingSnapshot(env.DB))?.payload).toEqual(empty);
  });
});
