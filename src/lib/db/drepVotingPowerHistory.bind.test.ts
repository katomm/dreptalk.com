import { describe, it, expect } from 'vitest';
import { insertVotingPowerHistory } from './drepVotingPowerHistory.js';

// D1 caps bound parameters per query at 100. Miniflare (the test runtime for the
// .workers.test.ts suite) does not enforce this, so a too-large multi-row INSERT
// passes locally but fails on the real database with "too many SQL variables".
// This pure-node test pins the invariant by recording the bind count of every
// prepared statement insertVotingPowerHistory builds.
describe('insertVotingPowerHistory bound-parameter safety', () => {
  it('keeps every insert statement within the D1 bound-parameter limit', async () => {
    const bindCounts: number[] = [];
    const stmt = {
      bind: (...args: unknown[]) => {
        bindCounts.push(args.length);
        return stmt;
      },
    };
    const db = {
      prepare: () => stmt,
      batch: async () => [],
    } as unknown as Parameters<typeof insertVotingPowerHistory>[0];

    const rows = Array.from({ length: 500 }, (_, i) => ({ drepId: `drep${i}`, epoch: 540, amount: '1' }));
    await insertVotingPowerHistory(db, rows);

    expect(bindCounts.length).toBeGreaterThan(0);
    expect(Math.max(...bindCounts)).toBeLessThanOrEqual(100);
  });
});
