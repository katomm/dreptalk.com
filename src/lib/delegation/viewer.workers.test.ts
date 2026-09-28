/// <reference types="@cloudflare/workers-types" />
// The viewer state the delegation dialog is mounted with, read from D1 by the
// pages that mount it.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { loadTrackingViewer } from './viewer.js';

async function insertUser(id: string, stakeAddr: string | null) {
  await env.DB.prepare(
    `INSERT INTO users (id, stake_addr, is_drep, role, status, created_at, last_verified_at)
     VALUES (?, ?, 0, 'member', 'active', 0, 0)`,
  )
    .bind(id, stakeAddr)
    .run();
}

describe('loadTrackingViewer', () => {
  it('reports an anonymous viewer when there is no session', async () => {
    expect(await loadTrackingViewer(env.DB, null)).toEqual({ signedIn: false, hasStakeAddr: false });
  });

  it('reports a linked stake wallet', async () => {
    await insertUser('viewer-1', 'stake_test1viewer1');
    expect(await loadTrackingViewer(env.DB, 'viewer-1')).toEqual({ signedIn: true, hasStakeAddr: true });
  });

  it('reports a signed-in account without a stake wallet', async () => {
    await insertUser('viewer-2', null);
    expect(await loadTrackingViewer(env.DB, 'viewer-2')).toEqual({ signedIn: true, hasStakeAddr: false });
  });

  it('treats a missing database as anonymous rather than failing the page', async () => {
    expect(await loadTrackingViewer(undefined, 'viewer-1')).toEqual({ signedIn: true, hasStakeAddr: false });
  });
});
