import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadBasisData } from './paramBasisData.js';

afterEach(() => vi.restoreAllMocks());

describe('loadBasisData', () => {
  it('answers with no row and no pool data when D1 throws, logging once', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing: Record<string, unknown> = { first: () => Promise.reject(new Error('no such table: param_changes')), all: () => Promise.reject(new Error('no such table: param_changes')), bind: () => failing };
    const db = { prepare: () => failing } as unknown as D1Database;
    expect(await loadBasisData(db, 613)).toEqual({ basisRow: null, poolDataStored: false });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
