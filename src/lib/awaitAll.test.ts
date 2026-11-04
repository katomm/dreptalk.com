import { describe, expect, it } from 'vitest';
import { awaitAll } from './awaitAll';

describe('awaitAll', () => {
  it('resolves promises and plain values under their keys', async () => {
    const out = await awaitAll({ a: Promise.resolve(1), b: 'x', c: Promise.resolve(null) });
    expect(out).toEqual({ a: 1, b: 'x', c: null });
  });

  it('rejects when any promise rejects', async () => {
    await expect(awaitAll({ a: Promise.resolve(1), b: Promise.reject(new Error('boom')) })).rejects.toThrow('boom');
  });
});
