/// <reference types="@cloudflare/workers-types" />
import { env } from 'cloudflare:test';
import type { EventRef } from 'drep-groups';
import { describe, expect, it } from 'vitest';
import { credBytes, hashBytes } from '../groups/codec.js';
import { drepIdForCredential } from '../groups/ids.js';
import { listGroupIdsForSitemap } from './drepGroups.js';
import { listDreps } from './dreps.js';

const db = env.DB as D1Database;
const txOf = (n: number): string => n.toString(16).padStart(64, '0');
const keyOf = (n: number): string => n.toString(16).padStart(56, '0');
const refOf = (n: number): EventRef => ({ txHash: txOf(n), index: 0 });
const drepOf = (n: number): string => drepIdForCredential({ kind: 'key', hash: keyOf(n) });
const pos = (h: number): string => `${h}, 0, 2, 0, X'${txOf(h)}'`;

async function seedGroup(n: number, o: { members: number; closing?: number }): Promise<void> {
  await db
    .prepare(
      `INSERT INTO drep_groups (group_tx, group_ix, cur_h, cur_ti, cur_ph, cur_ix, cur_tx, mode, control, profile_url, profile_hash,
        seq, status, created_h, created_ti, created_ph, created_ix, created_tx,
        dissolved_h, dissolved_ti, dissolved_ph, dissolved_ix, dissolved_tx, members, member_power, closing)
       VALUES (?1, 0, ${pos(1)}, 'open', X'aa', NULL, NULL, '0', 'active', ${pos(1)}, NULL, NULL, NULL, NULL, NULL, ?2, 0, ?3)`,
    )
    .bind(hashBytes(txOf(n)), o.members, o.closing ?? 0)
    .run();
}

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

  it('leaves a group below two members out of the sitemap', async () => {
    await seedGroup(1, { members: 1 });
    expect(await listGroupIdsForSitemap(db, 500)).toEqual([]);
  });
});
