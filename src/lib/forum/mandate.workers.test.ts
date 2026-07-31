// Real-D1 coverage for loadMandates' default getGrantsByIds path, reusing the
// same proposer/co-user fixtures as proposerGrants.workers.test.ts (Task 1).
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { loadMandates } from './mandate.js';
import { createGrantInvite, redeemGrant, revokeGrant } from '../db/proposerGrants.js';
import { upsertUserFromAuth } from '../db/users.js';

const db = () => env.DB as D1Database;
const NOW = 1_700_000_000;

// Real curated address (config/proposers.ts).
const INTERSECT_ADDR = 'stake1uyvjdz9rxsfsmv44rtk75k2rqyqskrga96dgdfrqjvjjpwsefcjnp';

let seq = 0;
function nextId(): string {
  seq += 1;
  return `${NOW}-${seq}`;
}

async function activeGrant(proposerStakeAddr: string): Promise<string> {
  const proposer = await upsertUserFromAuth(db(), { stakeAddr: proposerStakeAddr, roles: ['proposer'], now: NOW });
  const coStakeAddr = `stake_test1-co-${nextId()}`;
  const coUser = await upsertUserFromAuth(db(), { stakeAddr: coStakeAddr, roles: [], now: NOW });
  const invite = await createGrantInvite(db(), {
    proposerUserId: proposer.id,
    proposerStakeAddr,
    now: NOW,
  });
  const redeemed = await redeemGrant(db(), {
    grantId: invite!.grantId,
    coUserId: coUser.id,
    coStakeAddr,
    displayName: 'Co Proposer',
    now: NOW,
  });
  expect(redeemed.ok).toBe(true);
  return invite!.grantId;
}

describe('loadMandates (D1)', () => {
  it('resolves a real grant through getGrantsByIds to a curated label', async () => {
    const grantId = await activeGrant(INTERSECT_ADDR);
    const map = await loadMandates(db(), [grantId]);
    expect(map.get(grantId)).toBe('for Intersect');
  });

  it('still resolves after the grant is revoked', async () => {
    const proposerStakeAddr = `stake_test1-proposer-${nextId()}`;
    const grantId = await activeGrant(proposerStakeAddr);
    const before = await loadMandates(db(), [grantId]);
    expect(before.get(grantId)).toBeDefined();

    const proposer = await db()
      .prepare('SELECT proposer_user_id FROM proposer_grants WHERE id = ?1')
      .bind(grantId)
      .first<{ proposer_user_id: string }>();
    const revoked = await revokeGrant(db(), { grantId, proposerUserId: proposer!.proposer_user_id, now: NOW });
    expect(revoked).toBe(true);

    const after = await loadMandates(db(), [grantId]);
    expect(after.get(grantId)).toBe(before.get(grantId));
  });
});
