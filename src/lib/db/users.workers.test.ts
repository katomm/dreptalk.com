// Users D1 access tests -- runs in real workerd via @cloudflare/vitest-pool-workers.
// Exercises upsertUserFromAuth and getUserById against the real miniflare D1 binding.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { getUserById, getUsersByIds, upsertUserFromAuth, getUserByDrepId, getSelfDrepId, getUserByStakeAddr } from './users.js';
import { bindCountingDb } from './__tests__/bindCountingDb.js';

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

    // A new account starts with the gov backlog marked seen.
    const row = await db()
      .prepare('SELECT notif_seen_at FROM users WHERE id = ?')
      .bind(drepId)
      .first<{ notif_seen_at: number }>();
    expect(row?.notif_seen_at).toBe(NOW);
  });

  it('re-auth updates last_verified_at but keeps created_at', async () => {
    const drepId = `drep1-test-reauth-${NOW}`;
    await upsertUserFromAuth(db(), { drepId, roles: ['drep'], now: NOW });

    const laterNow = NOW + 600;
    const updated = await upsertUserFromAuth(db(), { drepId, roles: ['drep'], now: laterNow });

    expect(updated.created_at).toBe(NOW);
    expect(updated.last_verified_at).toBe(laterNow);
  });

  it('a proposer and a later drep login are separate accounts (each credential is its own account)', async () => {
    const stakeAddr = `stake_test1-proposer-then-drep-${NOW}`;
    const drepId = `drep1-proposer-then-drep-${NOW}`;

    // First auth as proposer (using stakeAddr as id).
    await upsertUserFromAuth(db(), { stakeAddr, roles: ['proposer'], now: NOW });
    const afterProposer = await getUserById(db(), stakeAddr);
    expect(afterProposer).not.toBeNull();
    expect(afterProposer!.is_proposer).toBe(true);
    expect(afterProposer!.is_drep).toBe(false);

    // Later, the same person logs in as a DRep the way the real DRep login path
    // does: drepId only, no stakeAddr. This is a distinct on-chain credential,
    // so it creates a separate account rather than merging into the proposer row.
    const drepUser = await upsertUserFromAuth(db(), {
      drepId,
      roles: ['drep'],
      now: NOW + 600,
    });

    expect(drepUser.id).toBe(drepId);
    expect(drepUser.is_drep).toBe(true);
    expect(drepUser.is_proposer).toBe(false);
    expect(drepUser.stake_addr).toBeNull();

    // The proposer account is untouched: still its own row, still proposer-only.
    const proposerAfter = await getUserById(db(), stakeAddr);
    expect(proposerAfter).not.toBeNull();
    expect(proposerAfter!.is_proposer).toBe(true);
    expect(proposerAfter!.is_drep).toBe(false);
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

describe('getSelfDrepId', () => {
  it('returns null when there is no session', async () => {
    expect(await getSelfDrepId(db(), null)).toBeNull();
  });

  it('returns null when the session lacks the drep role', async () => {
    const stakeAddr = `stake_test1-self-nondrep-${NOW}`;
    await upsertUserFromAuth(db(), { stakeAddr, roles: ['proposer'], now: NOW });
    expect(await getSelfDrepId(db(), { id: stakeAddr, roles: ['proposer'] })).toBeNull();
  });

  it('returns the drep_id from the user row for a signed-in DRep', async () => {
    const drepId = `drep1-self-drep-${NOW}`;
    const user = await upsertUserFromAuth(db(), { drepId, roles: ['drep'], now: NOW });
    expect(await getSelfDrepId(db(), { id: user.id, roles: ['drep'] })).toBe(drepId);
  });

  it('returns null when the session claims drep but the user row has no drep_id', async () => {
    // Defensive: a role without the authoritative id column yields no self drep.
    const stakeAddr = `stake_test1-self-nodrepid-${NOW}`;
    const user = await upsertUserFromAuth(db(), { stakeAddr, roles: ['proposer'], now: NOW });
    expect(await getSelfDrepId(db(), { id: user.id, roles: ['drep'] })).toBeNull();
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

describe('getSelfDrepId (session fast-path)', () => {
  it('returns the session drepId without a DB read when present', async () => {
    // id intentionally absent from the DB: the value must come from the session.
    expect(
      await getSelfDrepId(db(), { id: 'no-such-row', roles: ['drep'], drepId: 'drep1fromsession' }),
    ).toBe('drep1fromsession');
  });

  it('returns null when the session carries drepId: null (no DB fallback)', async () => {
    // A DB row with a drep_id exists, but the session says the user has none.
    const id = `self-null-${NOW}`;
    await upsertUserFromAuth(db(), { drepId: id, roles: ['drep'], now: NOW });
    expect(await getSelfDrepId(db(), { id, roles: ['drep'], drepId: null })).toBeNull();
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

describe('upsertUserFromAuth (spo)', () => {
  it('inserts a new spo user keyed by poolId with pool_id set and is_spo true', async () => {
    const poolId = `pool1-insert-spo-${NOW}`;
    const user = await upsertUserFromAuth(db(), {
      poolId,
      roles: ['spo'],
      now: NOW,
    });

    expect(user.id).toBe(poolId);
    expect(user.pool_id).toBe(poolId);
    expect(user.is_spo).toBe(true);
    expect(user.is_drep).toBe(false);
    expect(user.is_cc).toBe(false);
    expect(user.drep_id).toBeNull();
    expect(user.stake_addr).toBeNull();
    expect(user.role).toBe('member');
    expect(user.created_at).toBe(NOW);
  });

  it('re-auth keeps created_at and updates last_verified_at', async () => {
    const poolId = `pool1-reauth-spo-${NOW}`;
    await upsertUserFromAuth(db(), { poolId, roles: ['spo'], now: NOW });
    const updated = await upsertUserFromAuth(db(), { poolId, roles: ['spo'], now: NOW + 600 });
    expect(updated.created_at).toBe(NOW);
    expect(updated.last_verified_at).toBe(NOW + 600);
    expect(updated.is_spo).toBe(true);
  });
});

describe('upsertUserFromAuth (cc)', () => {
  it('inserts a new cc user keyed by ccCred with cc_cred set and is_cc true', async () => {
    const ccCred = `cc_cold1-insert-cc-${NOW}`;
    const user = await upsertUserFromAuth(db(), {
      ccCred,
      roles: ['cc'],
      now: NOW,
    });

    expect(user.id).toBe(ccCred);
    expect(user.cc_cred).toBe(ccCred);
    expect(user.is_cc).toBe(true);
    expect(user.is_drep).toBe(false);
    expect(user.is_spo).toBe(false);
    expect(user.is_proposer).toBe(false);
  });
});

describe('getUserByDrepId', () => {
  it('returns the user whose drep_id matches', async () => {
    await upsertUserFromAuth(env.DB, { drepId: 'drep1find', roles: ['drep'], now: 1 });
    const u = await getUserByDrepId(env.DB, 'drep1find');
    expect(u?.drep_id).toBe('drep1find');
  });

  it('returns null when no user has that drep_id', async () => {
    expect(await getUserByDrepId(env.DB, 'drep1none')).toBeNull();
  });
});

async function insertUser(id: string, stakeAddr: string | null) {
  await db()
    .prepare(
      `INSERT INTO users (id, stake_addr, role, status, created_at, last_verified_at, notif_seen_at)
       VALUES (?, ?, 'member', 'active', 0, 0, 0)`,
    )
    .bind(id, stakeAddr)
    .run();
}

describe('users.stake_addr uniqueness (migration 0061)', () => {
  it('rejects a second account with the same stake address', async () => {
    await insertUser('acct-a', 'stake_test1uniqueA');
    await expect(insertUser('acct-b', 'stake_test1uniqueA')).rejects.toThrow();
  });

  it('allows multiple accounts with NULL stake address', async () => {
    await insertUser('acct-null-1', null);
    await expect(insertUser('acct-null-2', null)).resolves.toBeUndefined();
  });
});

describe('getUserByStakeAddr', () => {
  it('returns the account owning the stake address, else null', async () => {
    await db()
      .prepare(
        `INSERT INTO users (id, stake_addr, role, status, created_at, last_verified_at, notif_seen_at)
         VALUES ('acct-lookup', 'stake_test1lookup', 'member', 'active', 0, 0, 0)`,
      )
      .run();
    const found = await getUserByStakeAddr(db(), 'stake_test1lookup');
    expect(found?.id).toBe('acct-lookup');
    const missing = await getUserByStakeAddr(db(), 'stake_test1absent');
    expect(missing).toBeNull();
  });
});

describe('getUsersByIds bind cap', () => {
  it('stays under the D1 100-bind cap and still finds users beyond the first chunk', async () => {
    // Five real users placed at the END of a 205-id lookup, so they land past
    // the first chunk boundary. A single IN (...) would bind 205 parameters:
    // production D1 rejects that, miniflare does not, hence the bind counter.
    const real = Array.from({ length: 5 }, (_, i) => `drep1-bindcap-${NOW}-${i}`);
    for (const id of real) {
      await upsertUserFromAuth(db(), { drepId: id, roles: ['drep'], now: NOW });
    }
    const missing = Array.from({ length: 200 }, (_, i) => `drep1-bindcap-missing-${i}`);
    const ids = [...missing, ...real];

    const counted = bindCountingDb(db());
    const found = await getUsersByIds(counted.db, ids);

    expect(found.size).toBe(5);
    for (const id of real) expect(found.get(id)?.drep_id).toBe(id);
    expect(counted.maxBinds()).toBeLessThanOrEqual(100);
  });
});
