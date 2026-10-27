/// <reference types="@cloudflare/workers-types" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getGroup, groupsForDrep, listGroupIdsForSitemap, listListedGroups } from './drepGroups.js';
import { groupIdString } from '../groups/ids.js';

// A database whose every statement fails with the message.
const failing = (message: string): D1Database => {
  const fail = () => {
    throw new Error(message);
  };
  return { prepare: () => ({ bind: () => ({ all: fail, first: fail }), all: fail, first: fail }) } as unknown as D1Database;
};
// A database without the groups tables, as before their migration is applied.
const missing = (): D1Database => failing('D1_ERROR: no such table: drep_groups: SQLITE_ERROR');

describe('page readers without the groups tables', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fall back to an empty answer and log one line each', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = missing();
    const id = groupIdString({ txHash: 'ab'.repeat(32), index: 0 });
    expect(await groupsForDrep(db, 'drep1x', 20)).toEqual([]);
    expect(await listGroupIdsForSitemap(db, 500)).toEqual([]);
    expect(await listListedGroups(db, null, 50)).toEqual([]);
    // A failed read stays apart from an unknown group, which is null.
    expect(await getGroup(db, id)).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(4);
    expect(String(log.mock.calls[0][0])).toContain('no such table');
  });

  it('rethrow any other error', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = failing('D1_ERROR: no such column: g.nope: SQLITE_ERROR');
    const id = groupIdString({ txHash: 'ab'.repeat(32), index: 0 });
    await expect(groupsForDrep(db, 'drep1x', 20)).rejects.toThrow('no such column');
    await expect(listGroupIdsForSitemap(db, 500)).rejects.toThrow('no such column');
    await expect(listListedGroups(db, null, 50)).rejects.toThrow('no such column');
    await expect(getGroup(db, id)).rejects.toThrow('no such column');
    expect(log).not.toHaveBeenCalled();
  });
});
