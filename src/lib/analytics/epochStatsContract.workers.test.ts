import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { EPOCH_STATS_METRICS } from './epochStatsContract.js';

describe('metric contract', () => {
  it('covers every table column exactly once', async () => {
    const info = (
      await env.DB.prepare(`PRAGMA table_info('governance_epoch_stats')`).all<{ name: string }>()
    ).results ?? [];
    const tableCols = info.map((r) => r.name).filter((n) => !['epoch', 'computed_at', 'vote_data_complete'].includes(n));
    const contractCols = Object.values(EPOCH_STATS_METRICS).map((m) => m.column).sort();
    expect(contractCols).toEqual([...tableCols].sort());
  });
});
