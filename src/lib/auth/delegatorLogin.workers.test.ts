/// <reference types="@cloudflare/workers-types" />
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { resolveDelegatorAccount } from './delegatorLogin.js';
import { getUserById } from '../db/users.js';

const db = () => env.DB as D1Database;

describe('resolveDelegatorAccount', () => {
  it('creates a member-only account keyed by the stake address', async () => {
    const user = await resolveDelegatorAccount(db(), 'stake_test1newdeleg', 1000);
    expect(user.id).toBe('stake_test1newdeleg');
    expect(user.stake_addr).toBe('stake_test1newdeleg');
    expect(user.is_drep).toBe(false);
    expect(user.is_proposer).toBe(false);
    expect(user.last_verified_at).toBe(1000);
  });

  it('routes to an existing account and refreshes last_verified_at', async () => {
    // A writer account whose id is a drep_id but which has linked this stake wallet.
    await db()
      .prepare(
        `INSERT INTO users (id, drep_id, stake_addr, is_drep, role, status, created_at, last_verified_at, notif_seen_at)
         VALUES ('drep1writer', 'drep1writer', 'stake_test1linked', 1, 'member', 'active', 0, 0, 0)`,
      )
      .run();
    const user = await resolveDelegatorAccount(db(), 'stake_test1linked', 2000);
    expect(user.id).toBe('drep1writer'); // existing account reused, NOT a new stake-keyed row
    expect(user.is_drep).toBe(true);
    expect(user.last_verified_at).toBe(2000); // credential proof recorded
    // No second account was minted for the stake address.
    expect(await getUserById(db(), 'stake_test1linked')).toBeNull();
  });

  it('is safe under concurrent first logins for the same stake address', async () => {
    const [first, second] = await Promise.all([
      resolveDelegatorAccount(db(), 'stake_test1concurrent', 1000),
      resolveDelegatorAccount(db(), 'stake_test1concurrent', 1000),
    ]);
    expect(first.id).toBe(second.id);
  });
});
