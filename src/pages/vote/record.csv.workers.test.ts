/// <reference types="@cloudflare/workers-types" />
// Workers-runtime tests for GET /vote/record.csv.
// Calls the exported GET handler directly with a synthetic APIContext so the
// test runs inside the real Workers runtime (D1 via cloudflare:test) without an
// HTTP server or the Astro middleware chain.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { GET } from './record.csv';

const NOW = 1_752_000_000;
const DREP_ID = `drep1${'a'.repeat(50)}`;
const USER_ID = 'user-csv-drep-1';
const GA_ID = `${'d'.repeat(64)}#0`;

async function seedVote() {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO governance_actions (id, type, title, status, decided_epoch, topic_id, created_at, last_synced_at)
     VALUES (?, 'TreasuryWithdrawals', 'Bifrost, phase 1', 'enacted', 657, NULL, ?, ?)`,
  )
    .bind(GA_ID, NOW, NOW)
    .run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO drep_votes (ga_id, voter_role, voter_id, voter_hex, vote, meta_url, meta_hash, block_time, synced_at, voted_power, local_status, tx_hash)
     VALUES (?, 'DRep', ?, NULL, 'yes', NULL, NULL, ?, ?, NULL, NULL, NULL)`,
  )
    .bind(GA_ID, DREP_ID, NOW, NOW)
    .run();
}

// Minimal APIContext: the handler reads { locals, request, redirect }.
function makeCtx(user: { id: string; roles: string[]; drepId?: string | null } | null) {
  const request = new Request('https://dreptalk.com/vote/record.csv');
  const locals = { user, runtime: { env } } as unknown as App.Locals;
  const redirect = (path: string, status = 302) =>
    new Response(null, { status, headers: { location: path } });
  return { request, locals, redirect } as unknown as Parameters<typeof GET>[0];
}

describe('GET /vote/record.csv', () => {
  it('redirects a logged-out caller to /login', async () => {
    const res = await GET(makeCtx(null));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login/');
  });

  it('redirects a logged-in non-DRep to /login', async () => {
    const res = await GET(makeCtx({ id: USER_ID, roles: ['proposer'] }));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login/');
  });

  it('returns the DRep record as a CSV attachment', async () => {
    await seedVote();
    const res = await GET(makeCtx({ id: USER_ID, roles: ['drep'], drepId: DREP_ID }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('dreptalk-voting-record.csv');
    // The viewer's own record must not be cached by shared caches.
    expect(res.headers.get('cache-control')).toContain('private');

    const body = await res.text();
    const lines = body.split('\r\n');
    expect(lines[0]).toBe('Epoch,Date,Type,Vote,Title,Rationale URL');
    // The seeded vote: epoch 657, readable type, a comma-quoted title.
    expect(body).toContain('657,2025-07-08,Treasury Withdrawals,yes,"Bifrost, phase 1"');
  });
});
