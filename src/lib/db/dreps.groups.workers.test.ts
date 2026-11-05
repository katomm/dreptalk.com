/// <reference types="@cloudflare/workers-types" />
import { env } from 'cloudflare:test';
import type { EventRef } from 'drep-groups';
import { describe, expect, it } from 'vitest';
import { type GroupSeed, seedGroup as seedGroupRow } from '../groups/__tests__/engineFixtures.js';
import { keyHex as keyOf, txHex as txOf } from '../groups/__tests__/loadFixtures.js';
import { credBytes, hashBytes } from '../groups/codec.js';
import { LISTED_MIN_MEMBERS } from '../groups/constants.js';
import { drepIdForCredential } from '../groups/ids.js';
import { listGroupIdsForSitemap } from './drepGroups.js';
import { listDreps } from './dreps.js';

const db = env.DB as D1Database;
const seedGroup = (n: number, o?: GroupSeed): Promise<void> => seedGroupRow(db, n, o);
const refOf = (n: number): EventRef => ({ txHash: txOf(n), index: 0 });
const drepOf = (n: number): string => drepIdForCredential({ kind: 'key', hash: keyOf(n) });
const pos = (h: number): string => `${h}, 0, 2, 0, X'${txOf(h)}'`;

async function seedMember(group: number, member: number, counted: 'open' | 'former'): Promise<void> {
  await db
    .prepare(
      `INSERT INTO drep_group_instances (join_tx, join_ix, group_tx, group_ix, cred, drep_id, mode, joined_h, joined_ti, joined_ph,
        joined_ix, joined_tx, counted_as)
       VALUES (?1, 0, ?2, 0, ?3, ?4, 'open', ${pos(10)}, ?5)`,
    )
    .bind(hashBytes(txOf(1000 + member)), hashBytes(txOf(group)), credBytes(`key:${keyOf(member)}`), drepOf(member), counted)
    .run();
}

async function seedDrep(n: number): Promise<void> {
  await db
    .prepare("INSERT INTO dreps (drep_id, status, voting_power, last_synced_at, created_at) VALUES (?, 'registered', '1000', 0, 0)")
    .bind(drepOf(n))
    .run();
}

describe('listDreps group filter', () => {
  it('lists only open members, none while the group is closing, and everyone without a group', async () => {
    for (const n of [1, 2, 3]) await seedDrep(n);
    await seedGroup(1, { members: 1 });
    await seedMember(1, 1, 'open');
    await seedMember(1, 2, 'former');
    expect((await listDreps(db, { group: refOf(1) })).map((d) => d.drepId)).toEqual([drepOf(1)]);
    expect((await listDreps(db, {})).length).toBe(3);

    // A dissolved group whose job has not finished still has open caches, but lists no member.
    await seedGroup(2, { members: 1, closing: 1 });
    await seedMember(2, 3, 'open');
    expect(await listDreps(db, { group: refOf(2) })).toEqual([]);
    expect(await listDreps(db, { group: refOf(9) })).toEqual([]);
  });

  it('keeps the group filter with all DReps, a sort and an offset', async () => {
    // Members 1 to 3, member 3 inactive. Member 4 is outside the group.
    const rows: Array<[number, number, string, number]> = [
      [1, 1, '3000', 5],
      [2, 1, '2000', 9],
      [3, 0, '1000', 7],
      [4, 1, '9000', 99],
    ];
    for (const [n, active, power, delegators] of rows) {
      await db
        .prepare("INSERT INTO dreps (drep_id, status, active, voting_power, delegator_count, last_synced_at, created_at) VALUES (?, 'registered', ?, ?, ?, 0, 0)")
        .bind(drepOf(n), active, power, delegators)
        .run();
    }
    await seedGroup(1, { members: 3 });
    for (const n of [1, 2, 3]) await seedMember(1, n, 'open');
    const page = (o: Parameters<typeof listDreps>[1]) => listDreps(db, { group: refOf(1), ...o }).then((r) => r.map((d) => d.drepId));
    expect(await page({ activeOnly: false, sort: 'delegators' })).toEqual([drepOf(2), drepOf(3), drepOf(1)]);
    expect(await page({ activeOnly: false, sort: 'delegators', offset: 1, limit: 1 })).toEqual([drepOf(3)]);
    expect(await page({ activeOnly: false, sort: 'power', offset: 2 })).toEqual([drepOf(3)]);
    expect(await page({ activeOnly: true, sort: 'delegators', offset: 1 })).toEqual([drepOf(1)]);
  });

  it('lists a group in the sitemap from LISTED_MIN_MEMBERS members', async () => {
    await seedGroup(1, { members: LISTED_MIN_MEMBERS - 1 });
    expect(await listGroupIdsForSitemap(db, 500)).toEqual([]);
    await seedGroup(2, { members: LISTED_MIN_MEMBERS });
    expect(await listGroupIdsForSitemap(db, 500)).toHaveLength(1);
  });
});
