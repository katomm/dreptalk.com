// Users D1 access tests -- runs in real workerd via @cloudflare/vitest-pool-workers.
// Exercises upsertUserFromAuth and getUserById against the real miniflare D1 binding.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { getUserById, getUsersByIds, upsertUserFromAuth } from './users.js';

const db = () => env.DB;
const NOW = 1_700_000_000;

describe('upsertUserFromAuth (drep)', () => {
  it('inserts a new drep user with correct field values', async () => {
    const drepId = `drep1-test-insert-${NOW}`;
    const user = await upsertUserFromAuth(db(), {
      drepId,
      roles: ['drep'],
      now: NOW,
    });

    expect(user.id).toBe(drepId);
    expect(user.drep_id).toBe(drepId);
    expect(user.stake_addr).toBeNull();
    expect(user.is_drep).toBe(true);
    expect(user.is_proposer).toBe(false);
    expect(user.is_spo).toBe(false);
    expect(user.is_cc).toBe(false);
    expect(user.role).toBe('member');
    expect(user.status).toBe('active');
    expect(user.created_at).toBe(NOW);
    expect(user.last_verified_at).toBe(NOW);
  });

  it('re-auth updates last_verified_at but keeps created_at', async () => {
    const drepId = `drep1-test-reauth-${NOW}`;
    await upsertUserFromAuth(db(), { drepId, roles: ['drep'], now: NOW });

    const laterNow = NOW + 600;
    const updated = await upsertUserFromAuth(db(), { drepId, roles: ['drep'], now: laterNow });

    expect(updated.created_at).toBe(NOW);
    expect(updated.last_verified_at).toBe(laterNow);
  });

  it('a proposer who later verifies as drep gains is_drep while keeping is_proposer', async () => {
    const stakeAddr = `stake_test1-proposer-then-drep-${NOW}`;
    const drepId = `drep1-proposer-then-drep-${NOW}`;

    // First auth as proposer (using stakeAddr as id).
    await upsertUserFromAuth(db(), { stakeAddr, roles: ['proposer'], now: NOW });
    const afterProposer = await getUserById(db(), stakeAddr);
    expect(afterProposer).not.toBeNull();
    expect(afterProposer!.is_proposer).toBe(true);
    expect(afterProposer!.is_drep).toBe(false);

    // Second auth on the same id as both drep and proposer.
    const updated = await upsertUserFromAuth(db(), {
      stakeAddr,
      drepId,
      roles: ['drep', 'proposer'],
      now: NOW + 600,
    });

    expect(updated.is_drep).toBe(true);
    expect(updated.is_proposer).toBe(true);
    // drep_id should now be set via COALESCE.
    expect(updated.drep_id).toBe(drepId);
    // stake_addr already set, kept.
    expect(updated.stake_addr).toBe(stakeAddr);
  });
});

describe('getUserById', () => {
  it('returns null for an unknown id', async () => {
    const result = await getUserById(db(), 'definitely-does-not-exist-xyz');
    expect(result).toBeNull();
  });

  it('maps boolean columns correctly (0 -> false, 1 -> true)', async () => {
    const id = `bool-test-${NOW}`;
    await upsertUserFromAuth(db(), { drepId: id, roles: ['drep'], now: NOW });
    const user = await getUserById(db(), id);
    expect(user).not.toBeNull();
    // is_drep should be true (boolean, not number).
    expect(user!.is_drep).toBe(true);
    expect(typeof user!.is_drep).toBe('boolean');
    expect(user!.is_proposer).toBe(false);
    expect(typeof user!.is_proposer).toBe('boolean');
    expect(user!.is_spo).toBe(false);
    expect(typeof user!.is_spo).toBe('boolean');
    expect(user!.is_cc).toBe(false);
    expect(typeof user!.is_cc).toBe('boolean');
  });
});

describe('getUsersByIds', () => {
  it('returns an empty Map for empty input without querying', async () => {
    const result = await getUsersByIds(db(), []);
    expect(result.size).toBe(0);
  });

  it('batch-fetches multiple users keyed by id and skips unknown ids', async () => {
    const a = `batch-a-${NOW}`;
    const b = `batch-b-${NOW}`;
    await upsertUserFromAuth(db(), { drepId: a, roles: ['drep'], now: NOW });
    await upsertUserFromAuth(db(), { stakeAddr: b, roles: ['proposer'], now: NOW });

    const result = await getUsersByIds(db(), [a, b, `missing-${NOW}`]);

    expect(result.size).toBe(2);
    expect(result.get(a)?.is_drep).toBe(true);
    expect(result.get(b)?.is_proposer).toBe(true);
    expect(result.has(`missing-${NOW}`)).toBe(false);
  });
});

describe('upsertUserFromAuth (proposer)', () => {
  it('inserts a new proposer user keyed by stakeAddr', async () => {
    const stakeAddr = `stake_test1-insert-proposer-${NOW}`;
    const user = await upsertUserFromAuth(db(), {
      stakeAddr,
      roles: ['proposer'],
      now: NOW,
    });

    expect(user.id).toBe(stakeAddr);
    expect(user.stake_addr).toBe(stakeAddr);
    expect(user.drep_id).toBeNull();
    expect(user.is_proposer).toBe(true);
    expect(user.is_drep).toBe(false);
  });
});
