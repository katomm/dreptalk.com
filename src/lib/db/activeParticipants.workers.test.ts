import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { countActiveByRole, listActiveGovFaces } from './activeParticipants.js';

const NOW = 1_700_000_000_000;
const CUTOFF = NOW - 30 * 24 * 60 * 60 * 1000;

async function seedUser(
  id: string,
  o: {
    isDrep?: boolean;
    isSpo?: boolean;
    isCc?: boolean;
    isProposer?: boolean;
    status?: string;
    lastSeen?: number | null;
  } = {},
) {
  await env.DB.prepare(
    `INSERT INTO users (id, is_drep, is_spo, is_cc, is_proposer, role, status, created_at, last_verified_at, last_seen)
     VALUES (?, ?, ?, ?, ?, 'member', ?, 0, 0, ?)`,
  )
    .bind(id, o.isDrep ? 1 : 0, o.isSpo ? 1 : 0, o.isCc ? 1 : 0, o.isProposer ? 1 : 0, o.status ?? 'active', o.lastSeen ?? null)
    .run();
}
async function seedFollow(userId: string, stakeAddr: string) {
  await env.DB.prepare(
    `INSERT INTO delegator_follows (user_id, stake_addr, resolution_status, delegation_type, drep_id, refresh_attempted_at)
     VALUES (?, ?, 'resolved', 'drep', 'drep1x', ?)`,
  )
    .bind(userId, stakeAddr, NOW)
    .run();
}

describe('activeParticipants', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM delegator_follows');
    await env.DB.exec('DELETE FROM users');
  });

  it('lists gov actors seen within the window, newest first, excluding stale/at-cutoff/inactive/reserved/members', async () => {
    await seedUser('drepNew', { isDrep: true, lastSeen: NOW - 1000 });
    await seedUser('spoOld', { isSpo: true, lastSeen: NOW - 2000 });
    await seedUser('drepAtCutoff', { isDrep: true, lastSeen: CUTOFF }); // exactly at cutoff: excluded (strict >)
    await seedUser('drepStale', { isDrep: true, lastSeen: CUTOFF - 1 }); // before window
    await seedUser('drepDisabled', { isDrep: true, status: 'disabled', lastSeen: NOW });
    await seedUser('memberActive', { lastSeen: NOW }); // no gov role
    await seedUser('system', { isDrep: true, lastSeen: NOW }); // reserved
    await seedUser('gov-sync', { isSpo: true, lastSeen: NOW }); // reserved
    const ids = (await listActiveGovFaces(env.DB, CUTOFF, 10)).map((r) => r.id);
    expect(ids).toEqual(['drepNew', 'spoOld']);
  });

  it('breaks ties by id for a stable order', async () => {
    await seedUser('bbb', { isDrep: true, lastSeen: NOW });
    await seedUser('aaa', { isDrep: true, lastSeen: NOW });
    expect((await listActiveGovFaces(env.DB, CUTOFF, 10)).map((r) => r.id)).toEqual(['aaa', 'bbb']);
  });

  it('clamps the limit to at least 1 and does not throw far above 50', async () => {
    for (let i = 0; i < 3; i++) await seedUser(`d${i}`, { isDrep: true, lastSeen: NOW - i });
    expect((await listActiveGovFaces(env.DB, CUTOFF, 0)).length).toBe(1); // clamp up to 1
    expect((await listActiveGovFaces(env.DB, CUTOFF, 999)).length).toBe(3); // clamp down to 50, returns all 3
  });

  it('counts distinct actors, dreps+spos (dual role in both), and pure active delegators', async () => {
    await seedUser('drepA', { isDrep: true, lastSeen: NOW });
    await seedUser('dual', { isDrep: true, isSpo: true, lastSeen: NOW }); // one actor, both roles
    await seedUser('spoB', { isSpo: true, lastSeen: NOW });
    await seedUser('delA', { lastSeen: NOW });
    await seedFollow('delA', 'stake1');
    await seedUser('delB', { lastSeen: NOW });
    await seedFollow('delB', 'stake2');
    await seedUser('drepC', { isDrep: true, lastSeen: NOW });
    await seedFollow('drepC', 'stake3'); // gov actor, not a delegator
    await seedUser('delStale', { lastSeen: CUTOFF - 1 });
    await seedFollow('delStale', 'stake4'); // before window
    const c = await countActiveByRole(env.DB, CUTOFF);
    expect(c).toEqual({ actors: 4, dreps: 3, spos: 2, delegators: 2 });
  });
});

describe('listActiveGovFaces', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM dreps');
    await env.DB.exec('DELETE FROM pools');
    await env.DB.exec('DELETE FROM users');
  });

  it('carries the per-role stats (DRep power/delegators, SPO ticker) newest first', async () => {
    await seedUser('drepA', { isDrep: true, lastSeen: NOW - 10 });
    await env.DB.prepare("UPDATE users SET drep_id = 'drep1a' WHERE id = 'drepA'").run();
    await env.DB.prepare(
      "INSERT INTO dreps (drep_id, status, last_synced_at, created_at, voting_power, delegator_count) VALUES ('drep1a', 'active', ?, ?, '42000000', 7)",
    )
      .bind(NOW, NOW)
      .run();
    await seedUser('spoB', { isSpo: true, lastSeen: NOW - 20 });
    await env.DB.prepare("UPDATE users SET pool_id = 'pool1b' WHERE id = 'spoB'").run();
    await env.DB.prepare("INSERT INTO pools (pool_id, ticker) VALUES ('pool1b', 'ABC')").run();

    const rows = await listActiveGovFaces(env.DB, CUTOFF, 10);
    expect(rows.map((r) => r.id)).toEqual(['drepA', 'spoB']);
    expect(rows[0]).toMatchObject({ isDrep: true, isSpo: false, votingPower: '42000000', delegatorCount: 7, poolTicker: null });
    expect(rows[1]).toMatchObject({ isDrep: false, isSpo: true, votingPower: null, delegatorCount: null, poolTicker: 'ABC' });
  });
});
