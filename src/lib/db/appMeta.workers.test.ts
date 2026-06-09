// app_meta D1 access tests; run in real workerd via @cloudflare/vitest-pool-workers
// with all migrations applied (so 0016 creates the table).
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { getAppMeta, setAppMeta } from './appMeta.js';

const db = () => env.DB;

describe('appMeta', () => {
  it('returns null for a missing key', async () => {
    expect(await getAppMeta(db(), 'nope')).toBeNull();
  });

  it('round-trips a value and its updated_at', async () => {
    await setAppMeta(db(), 'k1', '{"a":1}', 1_700_000_000);
    expect(await getAppMeta(db(), 'k1')).toEqual({ value: '{"a":1}', updatedAt: 1_700_000_000 });
  });

  it('overwrites an existing key', async () => {
    await setAppMeta(db(), 'k2', 'first', 1);
    await setAppMeta(db(), 'k2', 'second', 2);
    expect(await getAppMeta(db(), 'k2')).toEqual({ value: 'second', updatedAt: 2 });
  });
});
