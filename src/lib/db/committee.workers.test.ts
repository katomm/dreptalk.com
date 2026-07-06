// Committee membership accessors, run in workerd against the real miniflare D1
// with migrations applied.
import { beforeEach, describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  getCommitteeTimeline,
  upsertCommitteeMembers,
  upsertCommitteeHotKeys,
  syncCurrentCommitteeMembership,
  recomputeCommitteePct,
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

describe('recomputeCommitteePct', () => {
  it('replaces the stored Koios pct with the ledger-exact value from seeded membership', async () => {
    // Action ratified in epoch 633 (committee v3, active size 7 after the resignation).
    // Koios stored an inflated 87.5; the 7 active members all voted Yes -> 100 %.
    await db()
      .prepare(
        `INSERT INTO governance_actions (id, type, title, status, decided_epoch, cc_yes_pct, cc_no_pct, created_at, last_synced_at)
         VALUES ('ccAction', 'TreasuryWithdrawals', 'CC test', 'enacted', 633, 87.5, 12.5, 0, 0)`,
      )
      .run();

    const hotKeys = [
      '68bb0b4276021f82364056aa9f4d38ba5ac59b26c166cbeaa9408746',
      '84feba943c574d25984175cf8257959e6b3a1c64143d85e64fef6bd5',
      '646d1b3ac94568a422b687db6c47acdf849f1674982ae4f9a494be43',
      '4a8227024748d7ff9d52cb0ed38b715b8c41833ddfd13c0ddca93d76',
      '71aa5b3a9240a02a89c4e2839579ec5eb60c410af0a5bb483e1b8f04',
      '725d4d44499865071536d54674b080322bd366be15338db221807b31',
      '64f97568e72ff7e0035b4bae7bb080a10ec6fae5c0f381ed40053a49',
    ];
    for (const hk of hotKeys) {
      await db()
        .prepare(
          `INSERT INTO drep_votes (ga_id, voter_role, voter_id, voter_hex, vote, block_time, synced_at)
           VALUES ('ccAction', 'ConstitutionalCommittee', ?, ?, 'Yes', 1, 0)`,
        )
        .bind(hk, hk)
        .run();
    }

    const res = await recomputeCommitteePct(db(), 641, 100);
    expect(res.updated).toBe(1);

    const row = await db()
      .prepare('SELECT cc_yes_pct, cc_no_pct FROM governance_actions WHERE id = ?')
      .bind('ccAction')
      .first<{ cc_yes_pct: number; cc_no_pct: number }>();
    expect(row?.cc_yes_pct).toBe(100); // 7 yes / 7 active, not Koios' 87.5
    expect(row?.cc_no_pct).toBe(0);

    // Second pass is a no-op (only-changed).
    const again = await recomputeCommitteePct(db(), 641, 100);
    expect(again.updated).toBe(0);
  });
});
