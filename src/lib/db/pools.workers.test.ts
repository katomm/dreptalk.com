import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('pools table', () => {
  it('round-trips a row', async () => {
    await env.DB.prepare(
      `INSERT INTO pools (pool_id, pool_hash, ticker, name, synced_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind('pool1abc', 'deadbeef', 'HEPHY', 'Hephaestus Stake Pool', 1)
      .run();
    const row = await env.DB.prepare('SELECT name, ticker FROM pools WHERE pool_id = ?')
      .bind('pool1abc')
      .first<{ name: string; ticker: string }>();
    expect(row?.name).toBe('Hephaestus Stake Pool');
    expect(row?.ticker).toBe('HEPHY');
  });
});
