/// <reference types="@cloudflare/workers-types" />
// Workers-runtime tests for POST /api/survey/response/record, calling the
// exported handler with a synthetic APIContext (real D1, no HTTP server) —
// the same harness shape as api/vote/__tests__/record.workers.test.ts.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { drepIdFromKeyHash } from '@/lib/cardano/identity';
import { encodeBech32 } from '@/lib/crypto/bech32';
import { bytesToHex } from '@/lib/crypto/hex';
import { getViewerSurveyResponse } from '@/lib/db/surveys';
import { POST } from '../record';

const NOW = 1_780_000_000_000;
const KEY_HASH = new Uint8Array(28).fill(0xab);
const DREP_ID = drepIdFromKeyHash(KEY_HASH);
const USER_ID = 'user-survey-drep';
const SURVEY_REF = `${'a'.repeat(64)}:0`;
const TX_HASH = 'b'.repeat(64);

// A CIP-129 script-credential DRep id (header 0x23): a valid session identity
// for voting flows elsewhere, but one no key witness can prove — the endpoint
// must refuse to record for it.
const SCRIPT_DREP_ID = encodeBech32(
  'drep',
  new Uint8Array([0x23, ...new Uint8Array(28).fill(0xcd)]),
);

async function seedUser(drepId = DREP_ID, userId = USER_ID) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (id, drep_id, is_drep, is_spo, is_cc, is_proposer, role, status, created_at, last_verified_at)
     VALUES (?, ?, 1, 0, 0, 0, 'drep', 'active', ?, ?)`,
  )
    .bind(userId, drepId, NOW, NOW)
    .run();
}

async function seedSurvey(ref = SURVEY_REF) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO topics (id, category_slug, author_id, title, slug, created_at, last_post_at)
     VALUES ('topic-survey-record', 'surveys', ?, 'Survey', 'survey-record-topic', ?, ?)`,
  )
    .bind(USER_ID, NOW, NOW)
    .run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO survey
       (ref, topic_id, title, end_epoch, eligible_roles, sealed, cancelled, external_content,
        definition, counted_dreps, final_state, unavailable, submitted_at, synced_at)
     VALUES (?, 'topic-survey-record', 'Survey', 300, '[0]', 0, 0, 0, '{}', NULL, NULL, 0, ?, ?)`,
  )
    .bind(ref, NOW, NOW)
    .run();
}

function makeCtx(opts: { user: { id: string; roles: string[] } | null; body: unknown }) {
  const request = new Request('https://dreptalk.com/api/survey/response/record', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts.body),
  });
  const locals = { user: opts.user } as unknown as App.Locals;
  return { request, locals } as Parameters<typeof POST>[0];
}

describe('POST /api/survey/response/record', () => {
  // A deployment that mirrors surveys has the backend configured; the pool
  // binds no vars of its own, so every test that expects the endpoint to work
  // must say so.
  beforeEach(() => {
    (env as unknown as Record<string, unknown>).TESSERA_BACKEND_URL = 'https://tessera.test';
  });

  it('refuses when no Tessera mirror is configured, before touching the database', async () => {
    // Nothing settles an optimistic row but the sync, and the sync runs only
    // where this var is set: recording one here would strand a permanent
    // "confirming…" on a card nothing refreshes.
    await seedUser();
    await seedSurvey();
    (env as unknown as Record<string, unknown>).TESSERA_BACKEND_URL = undefined;
    const res = await POST(
      makeCtx({
        user: { id: USER_ID, roles: ['drep'] },
        body: { surveyRef: SURVEY_REF, txHash: TX_HASH },
      }),
    );
    expect(res.status).toBe(503);
    expect(await getViewerSurveyResponse(env.DB, SURVEY_REF, USER_ID)).toBeNull();
  });

  it('rejects a caller without the drep role', async () => {
    const body = { surveyRef: SURVEY_REF, txHash: TX_HASH };
    expect((await POST(makeCtx({ user: null, body }))).status).toBe(401);
    expect((await POST(makeCtx({ user: { id: USER_ID, roles: ['proposer'] }, body }))).status).toBe(
      401,
    );
  });

  it('rejects a malformed ref or tx hash without writing', async () => {
    await seedUser();
    await seedSurvey();
    const user = { id: USER_ID, roles: ['drep'] };
    // `:00` is not the canonical key form the survey table stores.
    const bad1 = await POST(
      makeCtx({ user, body: { surveyRef: `${'a'.repeat(64)}:00`, txHash: TX_HASH } }),
    );
    const bad2 = await POST(makeCtx({ user, body: { surveyRef: SURVEY_REF, txHash: 'beef' } }));
    expect(bad1.status).toBe(400);
    expect(bad2.status).toBe(400);
    expect(await getViewerSurveyResponse(env.DB, SURVEY_REF, USER_ID)).toBeNull();
  });

  it('rejects a survey this mirror does not hold', async () => {
    await seedUser();
    const res = await POST(
      makeCtx({
        user: { id: USER_ID, roles: ['drep'] },
        body: { surveyRef: `${'f'.repeat(64)}:0`, txHash: TX_HASH },
      }),
    );
    expect(res.status).toBe(404);
  });

  it('refuses a script-credential DRep — no key witness could ever settle the row', async () => {
    await seedUser(SCRIPT_DREP_ID, 'user-script-drep');
    await seedSurvey();
    const res = await POST(
      makeCtx({
        user: { id: 'user-script-drep', roles: ['drep'] },
        body: { surveyRef: SURVEY_REF, txHash: TX_HASH },
      }),
    );
    expect(res.status).toBe(403);
  });

  it('records a pending row with the credential derived from the session, never the client', async () => {
    await seedUser();
    await seedSurvey();
    const res = await POST(
      makeCtx({
        user: { id: USER_ID, roles: ['drep'] },
        // An injected credential field must be ignored (schema strips it).
        body: { surveyRef: SURVEY_REF, txHash: TX_HASH.toUpperCase(), credential: 'key:attacker' },
      }),
    );
    expect(res.status).toBe(200);
    const row = await getViewerSurveyResponse(env.DB, SURVEY_REF, USER_ID);
    expect(row).toMatchObject({ status: 'pending', txHash: TX_HASH });
    const stored = await env.DB.prepare(
      'SELECT credential FROM survey_response_local WHERE survey_ref = ? AND user_id = ?',
    )
      .bind(SURVEY_REF, USER_ID)
      .first<{ credential: string }>();
    expect(stored?.credential).toBe(`key:${bytesToHex(KEY_HASH)}`);
  });
});
