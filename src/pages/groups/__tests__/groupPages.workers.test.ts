/// <reference types="@cloudflare/workers-types" />
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { getGroup, listListedGroups, listMembers, listVerdicts, scriptDisplays, treasuryScripts } from '../../../lib/db/drepGroups.js';
import { groupIdParam, groupIdString } from '../../../lib/groups/ids.js';
import seedSql from './twoMemberGroup.sql?raw';

const db = env.DB as D1Database;
const SEEDED = 'group17rc0pu8s7rc0pu8s7rc0pu8s7rc0pu8s7rc0pu8s7rc0pu8s7rcqqqqwf5cvh';

async function seedTwoMemberGroup(): Promise<void> {
  const statements = seedSql
    .split('\n')
    .filter((l) => !l.startsWith('--'))
    .join('\n')
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  await db.batch(statements.map((s) => db.prepare(s)));
}

describe('group detail lookup', () => {
  it('finds nothing for an unknown or malformed group id', async () => {
    expect(groupIdParam('garbage')).toBeNull();
    expect(groupIdParam('group1qqq')).toBeNull();
    expect(await getGroup(db, 'group1qqq')).toBeNull();
    const id = groupIdString({ txHash: 'ab'.repeat(32), index: 0 });
    expect(groupIdParam(id.toUpperCase())).toEqual({ txHash: 'ab'.repeat(32), index: 0 });
    expect(await getGroup(db, id)).toBeNull();
  });

  it('reads the local seed as a listed group with two members', async () => {
    await seedTwoMemberGroup();
    const group = await getGroup(db, SEEDED.toUpperCase());
    expect(group?.groupId).toBe(SEEDED);
    expect(group?.members).toBe(2);
    expect(group?.profile?.name).toBe('Example Council');
    const listed = await listListedGroups(db, null, 50);
    expect(listed.map((g) => g.groupId)).toEqual([SEEDED]);
    const ref = group?.ref ?? { txHash: '', index: 0 };
    const members = await listMembers(db, ref, 'active', null, 50);
    expect(members.map((m) => m.drepName)).toEqual(['Alice Example', 'Bob Example']);
    expect((await listVerdicts(db, ref, true, 200)).map((v) => v.tag)).toEqual(['join', 'join', 'create']);
    const treasury = 'c3'.repeat(28);
    expect((await scriptDisplays(db, [group?.controlHash ?? '', treasury])).size).toBe(2);
    const read = await treasuryScripts(db, [treasury, 'ee'.repeat(28)]);
    expect([...read.scripts.keys()]).toEqual([treasury]);
    expect([...read.displays.keys()]).toEqual([treasury]);
  });
});
