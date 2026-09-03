// POST /api/survey/response/record
// Optimistic local record of a just-submitted CIP-179 survey answer, the
// survey twin of api/vote/record.ts. The tx is built and submitted by the
// wallet, NOT here; this only mirrors the submission so the survey card can
// show "confirming…" before the sync sees the transaction. Gated to the
// logged-in DRep, and the recorded credential is derived from the session's
// drep_id — never trusted from the client — so the sync settles the row
// against the credential this account actually is. The survey must still be
// able to take an answer, by the same rule the page gates its panel on.
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { currentNetwork, jsonResponse, runtimeEnv } from '@/lib/api/response';
import { parseDrepId } from '@/lib/cardano/identity';
import { getSurveyByRef, recordLocalSurveyResponse } from '@/lib/db/surveys';
import { getSelfDrepId } from '@/lib/db/users';
import { surveyState } from '@/lib/surveys/state';
import { SURVEY_KEY_RE } from '@/lib/tessera/client';

export const prerender = false;

const schema = z.object({
  // Canonical survey key, as the survey table stores it: the same constant the
  // Tessera client validates its own calls against.
  surveyRef: z.string().regex(SURVEY_KEY_RE),
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
  // No mirror configured means no sync, and the sync is what settles this row
  // against the chain or ages it to failed. Recording one here would strand a
  // permanent "confirming…" on the card, so refuse before touching the DB —
  // missing deployment configuration, like the binding check above it.
  if (!env.TESSERA_BACKEND_URL) return jsonResponse({ error: 'surveys not indexed' }, 503);

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
  if (cred?.kind !== 'key') return jsonResponse({ error: 'not a key DRep' }, 403);

  const survey = await getSurveyByRef(db, parsed.data.surveyRef);
  if (!survey) return jsonResponse({ error: 'unknown survey' }, 404);
  // A tab left open past the epoch roll can still submit (the chain accepts
  // the transaction; whether it counts is Tessera's call). Recording it would
  // age into "didn't confirm — answer again" on a survey with no panel.
  const now = Date.now();
  if (!surveyState(survey, now, currentNetwork()).answerable) {
    return jsonResponse({ error: 'survey not answerable' }, 409);
  }

  await recordLocalSurveyResponse(db, {
    surveyRef: parsed.data.surveyRef,
    userId: user.id,
    txHash: parsed.data.txHash.toLowerCase(),
    credential: `key:${cred.hashHex}`,
    now,
  });

  return jsonResponse({ ok: true });
};
