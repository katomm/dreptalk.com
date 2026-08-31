// POST /api/survey/response/record
// Optimistic local record of a just-submitted CIP-179 survey answer, the
// survey twin of api/vote/record.ts. The tx is built and submitted by the
// wallet, NOT here; this only mirrors the submission so the survey card can
// show "confirming…" before the sync sees the transaction. Gated to the
// logged-in DRep, and the recorded credential is derived from the session's
// drep_id — never trusted from the client — so the sync settles the row
// against the credential this account actually is.
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { parseDrepId } from '@/lib/cardano/identity';
import { recordLocalSurveyResponse, surveyRefExists } from '@/lib/db/surveys';
import { getSelfDrepId } from '@/lib/db/users';

export const prerender = false;

const schema = z.object({
  // Canonical survey key, as the survey table stores it (index without
  // leading zeros — the same shape the Tessera client enforces).
  surveyRef: z.string().regex(/^[0-9a-f]{64}:(0|[1-9][0-9]*)$/),
  txHash: z.string().regex(/^[0-9a-fA-F]{64}$/),
});

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as App.Locals).user;
  if (!user?.roles.includes('drep')) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  if (!db) return jsonResponse({ error: 'service unavailable' }, 503);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid JSON' }, 400);
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) return jsonResponse({ error: 'invalid input' }, 400);

  const drepId = await getSelfDrepId(db, user);
  if (!drepId) return jsonResponse({ error: 'not a drep' }, 403);
  // Only key-credential DReps can answer (mechanism A needs a key witness and
  // the panel is key-only); a script DRep session recording a row would leave
  // a pending marker no transaction can ever settle.
  const cred = parseDrepId(drepId);
  if (!cred || cred.kind !== 'key') return jsonResponse({ error: 'not a key DRep' }, 403);

  if (!(await surveyRefExists(db, parsed.data.surveyRef))) {
    return jsonResponse({ error: 'unknown survey' }, 404);
  }

  await recordLocalSurveyResponse(db, {
    surveyRef: parsed.data.surveyRef,
    userId: user.id,
    txHash: parsed.data.txHash.toLowerCase(),
    credential: `key:${cred.hashHex}`,
    now: Date.now(),
  });

  return jsonResponse({ ok: true });
};
