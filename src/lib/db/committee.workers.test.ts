// Committee membership accessors, run in workerd against the real miniflare D1
// with migrations applied.
import { beforeEach, describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  getCommitteeTimeline,
  upsertCommitteeMembers,
  upsertCommitteeHotKeys,
  syncCurrentCommitteeMembership,
} from './committee.js';
import { activeCommitteeSizeAt, type CommitteeMemberTerm } from '../koios/committeeTimeline.js';
import type { CommitteeMember } from '../koios/client.js';

const db = () => env.DB;

describe('committee membership accessors', () => {
  // Start from an empty timeline so these accessor tests are independent of the
  // historical seed migration (which populates the tables in every workers DB).
  beforeEach(async () => {
    await db().prepare('DELETE FROM committee_member').run();
    await db().prepare('DELETE FROM committee_hot_key').run();
  });

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

describe('seeded committee history', () => {
  it('resolves the ledger-active size across versions and the epoch-597 resignation', async () => {
    // Reads the historical seed migration directly (no cleanup).
    const { members, hotToCold } = await getCommitteeTimeline(db());
    expect(members).toHaveLength(22);
    expect(hotToCold.size).toBe(14);
    expect(activeCommitteeSizeAt(members, 550)).toBe(7); // bootstrap
    expect(activeCommitteeSizeAt(members, 596)).toBe(7); // v2, before the resignation
    expect(activeCommitteeSizeAt(members, 597)).toBe(6); // v2, resignation takes effect
    expect(activeCommitteeSizeAt(members, 633)).toBe(7); // v3 (8 listed, resigner not authorized)
  });

  it('live-syncs the current version: rotates hot keys, extends terms, protects the seed', async () => {
    const koios = [
      // existing v3 member with a newly rotated hot key and an extended term
      { status: 'authorized', cc_cold_hex: '13493790d9b03483a1e1e684ea4faf1ee48a58f402574e7f2246f4d4', cc_hot_hex: 'newhot13', expiration_epoch: 800 },
      // the seeded resigner, still shown resigned: its epoch-597 resignation must survive
      { status: 'resigned', cc_cold_hex: '349e55f83e9af24813e6cb368df6a80d38951b2a334dfcdf26815558', cc_hot_hex: null, expiration_epoch: 653 },
      // a member Koios reports that the seed does not know: signals a committee change
      { status: 'authorized', cc_cold_hex: 'ffffnew', cc_hot_hex: 'ffffhot', expiration_epoch: 900 },
    ] as unknown as CommitteeMember[];

    const res = await syncCurrentCommitteeMembership(db(), koios, 641);
    expect(res.hotKeys).toBe(2); // newhot13 + ffffhot (the resigner has no hot key)
    expect(res.unknown).toBe(1); // ffffnew is not part of the current version

    const { members, hotToCold } = await getCommitteeTimeline(db());
    expect(hotToCold.get('newhot13')).toBe('13493790d9b03483a1e1e684ea4faf1ee48a58f402574e7f2246f4d4');
    const m13 = members.find((m) => m.coldKeyHex.startsWith('13493790') && m.versionFrom === 602);
    expect(m13?.termExpiration).toBe(800); // term extended by the live sync
    const resigner = members.find((m) => m.coldKeyHex.startsWith('349e55f8') && m.versionFrom === 602);
    expect(resigner?.resignedAt).toBe(597); // seed protected, not overwritten with 641
  });
});
