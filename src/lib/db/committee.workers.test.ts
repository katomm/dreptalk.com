// Committee membership accessors, run in workerd against the real miniflare D1
// with migrations applied.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { getCommitteeTimeline, upsertCommitteeMembers, upsertCommitteeHotKeys } from './committee.js';
import { activeCommitteeSizeAt, type CommitteeMemberTerm } from '../koios/committeeTimeline.js';

const db = () => env.DB;

describe('committee membership accessors', () => {
  it('round-trips members and hot keys and resolves active size across the resignation boundary', async () => {
    const members: CommitteeMemberTerm[] = [
      { coldKeyHex: 'aa', versionFrom: 581, versionTo: 601, termExpiration: 653, authorizedFrom: 507, resignedAt: 597 },
      { coldKeyHex: 'bb', versionFrom: 581, versionTo: 601, termExpiration: 653, authorizedFrom: 507, resignedAt: null },
    ];
    await upsertCommitteeMembers(db(), members);
    await upsertCommitteeHotKeys(db(), [
      { hotKeyHex: 'h_aa', coldKeyHex: 'aa' },
      { hotKeyHex: 'h_bb', coldKeyHex: 'bb' },
    ]);

    const { members: loaded, hotToCold } = await getCommitteeTimeline(db());
    expect(loaded).toHaveLength(2);
    expect(loaded).toEqual(expect.arrayContaining(members));
    expect(hotToCold.get('h_aa')).toBe('aa');
    expect(hotToCold.get('h_bb')).toBe('bb');

    // The resignation boundary survives the DB round-trip.
    expect(activeCommitteeSizeAt(loaded, 596)).toBe(2);
    expect(activeCommitteeSizeAt(loaded, 597)).toBe(1);
  });

  it('upsert replaces a member in place (same cold key + version)', async () => {
    await upsertCommitteeMembers(db(), [
      { coldKeyHex: 'cc', versionFrom: 602, versionTo: null, termExpiration: 653, authorizedFrom: 507, resignedAt: null },
    ]);
    await upsertCommitteeMembers(db(), [
      { coldKeyHex: 'cc', versionFrom: 602, versionTo: null, termExpiration: 726, authorizedFrom: 507, resignedAt: null },
    ]);
    const { members } = await getCommitteeTimeline(db());
    const cc = members.filter((m) => m.coldKeyHex === 'cc');
    expect(cc).toHaveLength(1);
    expect(cc[0].termExpiration).toBe(726);
  });
});
