/// <reference types="@cloudflare/workers-types" />
// Workers-runtime tests for GET /api/drep/multisig/list.
// Calls the exported GET handler directly with a synthetic APIContext so
// the test runs inside the real Workers runtime (D1 via cloudflare:test)
// without needing an HTTP server or the Astro middleware chain.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createPendingMultisig } from '@/lib/db/pendingMultisigTx';
import { GET } from '../list';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Use a seeded "current time" well in the past for row timestamps, but choose
// FUTURE relative to a value large enough to exceed any real Date.now() for
// several decades. This avoids the test breaking when the real clock overtakes
// a fixed FUTURE constant.
const NOW = Math.floor(Date.now() / 1000);
const FUTURE = NOW + 86400; // 24 h from now, not expired (uses real clock)
const PAST = NOW - 1; // already expired

const DREP_A = 'drep-script-aaaa0000';
const DREP_B = 'drep-script-bbbb1111';

const USER_A = 'user-drep-a';
const USER_B = 'user-drep-b';
const USER_NO_DREP = 'user-no-drep';

const GA_ID = `${'d'.repeat(64)}#0`;
const VOTE = 'yes';
const TX_CBOR = 'e'.repeat(128);
const BODY_HASH = 'f'.repeat(64);
const SCRIPT_JSON = JSON.stringify({ type: 'any', scripts: [{ type: 'sig', keyHash: 'a'.repeat(56) }] });

// Seed a user into the DB directly so getUserById works.
async function seedUser(userId: string, drepId: string | null) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users
       (id, drep_id, is_drep, is_spo, is_cc, is_proposer, role, status, created_at, last_verified_at)
     VALUES (?, ?, ?, 0, 0, 0, ?, 'active', ?, ?)`,
  )
    .bind(userId, drepId, drepId ? 1 : 0, drepId ? 'drep' : 'proposer', NOW, NOW)
    .run();
}

async function seedPending(
  id: string,
  drepId: string,
  expiresAt: number,
  gaId = GA_ID,
  vote = VOTE,
) {
  await createPendingMultisig(env.DB, {
    id,
    drepId,
    action: 'vote',
    actionParams: JSON.stringify({ gaId, vote }),
    unsignedTxCbor: TX_CBOR,
    bodyHash: BODY_HASH,
    nativeScript: SCRIPT_JSON,
    createdBy: 'creator',
    createdAt: NOW - 100,
    expiresAt,
  });
}

// Build a synthetic APIContext for GET /api/drep/multisig/list.
function makeCtx(user: { id: string; roles: string[] } | null) {
  const request = new Request('https://dreptalk.com/api/drep/multisig/list', {
    method: 'GET',
  });
  const locals = { user } as unknown as App.Locals;
  return { request, locals } as Parameters<typeof GET>[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/drep/multisig/list', () => {
  it('returns 401 when caller is not logged in', async () => {
    const res = await GET(makeCtx(null));
    expect(res.status).toBe(401);
  });

  it('returns 401 when caller lacks the drep role', async () => {
    const res = await GET(makeCtx({ id: USER_NO_DREP, roles: ['proposer'] }));
    expect(res.status).toBe(401);
  });

  it('returns empty items when the session user has no drep_id', async () => {
    await seedUser(USER_NO_DREP, null);
    const res = await GET(makeCtx({ id: USER_NO_DREP, roles: ['drep'] }));
    expect(res.status).toBe(200);
    const body = await res.json() as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBe(0);
  });

  it('returns only non-expired collecting rows for the session drep, not for another drep', async () => {
    await seedUser(USER_A, DREP_A);
    await seedUser(USER_B, DREP_B);

    // Two rows for drep A: one active, one expired.
    await seedPending('row-a-active', DREP_A, FUTURE);
    await seedPending('row-a-expired', DREP_A, PAST);

    // One row for drep B (should never appear for user A).
    await seedPending('row-b-active', DREP_B, FUTURE);

    const res = await GET(makeCtx({ id: USER_A, roles: ['drep'] }));
    expect(res.status).toBe(200);

    const body = await res.json() as {
      items: Array<{ id: string; gaId: string; vote: string; createdAt: number; expiresAt: number }>;
    };
    expect(Array.isArray(body.items)).toBe(true);

    // Exactly one item: the active drep-A row.
    expect(body.items.length).toBe(1);
    const item = body.items[0];
    expect(item.id).toBe('row-a-active');
    expect(item.gaId).toBe(GA_ID);
    expect(item.vote).toBe(VOTE);
    expect(typeof item.createdAt).toBe('number');
    expect(typeof item.expiresAt).toBe('number');
  });

  it('decodes gaId and vote from action_params correctly', async () => {
    await seedUser(USER_A, DREP_A);
    const specialGaId = `${'a'.repeat(64)}#3`;
    await seedPending('row-a-special', DREP_A, FUTURE, specialGaId, 'abstain');

    const res = await GET(makeCtx({ id: USER_A, roles: ['drep'] }));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      items: Array<{ id: string; gaId: string; vote: string }>;
    };
    const found = body.items.find((i) => i.id === 'row-a-special');
    expect(found).toBeDefined();
    expect(found!.gaId).toBe(specialGaId);
    expect(found!.vote).toBe('abstain');
  });

  it('skips a row with corrupt action_params and returns the rest', async () => {
    await seedUser(USER_A, DREP_A);
    // Insert a row with broken JSON in action_params directly.
    await env.DB.prepare(
      `INSERT INTO pending_multisig_tx
         (id, drep_id, action, action_params, unsigned_tx_cbor, body_hash, native_script, witnesses, status, tx_hash, created_by, created_at, expires_at)
       VALUES ('row-a-corrupt', ?, 'vote', 'NOT_VALID_JSON', ?, ?, ?, '[]', 'collecting', NULL, 'creator', ?, ?)`,
    )
      .bind(DREP_A, TX_CBOR, BODY_HASH, SCRIPT_JSON, NOW - 50, FUTURE)
      .run();
    await seedPending('row-a-ok', DREP_A, FUTURE);

    const res = await GET(makeCtx({ id: USER_A, roles: ['drep'] }));
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ id: string }> };
    // The corrupt row is skipped; the valid row still appears.
    const ids = body.items.map((i) => i.id);
    expect(ids).not.toContain('row-a-corrupt');
    expect(ids).toContain('row-a-ok');
  });
});
