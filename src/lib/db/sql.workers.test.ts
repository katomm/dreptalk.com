/// <reference types="@cloudflare/workers-types" />
// The D1-side clock every delivery-cursor timestamp is written with (see DB_NOW_MS).
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { DB_NOW_MS, readDbNow } from './sql.js';

describe('DB_NOW_MS', () => {
  it('reads the database clock in unix milliseconds', async () => {
    const before = Date.now();
    const dbNow = await readDbNow(env.DB);
    const after = Date.now();
    // The test runtime shares the host clock, so allow a generous window.
    expect(dbNow).toBeGreaterThan(before - 5_000);
    expect(dbNow).toBeLessThan(after + 5_000);
    expect(Number.isInteger(dbNow)).toBe(true);
  });

  it('has sub-second precision', async () => {
    // Wait (bounded) until the clock shows a value that is not a whole second.
    // Whole-second precision never does, so this fails only on missing support,
    // not on scheduling luck.
    const deadline = Date.now() + 3_000;
    let fractional = false;
    while (!fractional && Date.now() < deadline) {
      const row = await env.DB.prepare(`SELECT ${DB_NOW_MS} AS ms`).first<{ ms: number }>();
      fractional = row!.ms % 1000 !== 0;
      if (!fractional) await new Promise((r) => setTimeout(r, 3));
    }
    expect(fractional).toBe(true);
  });
});
