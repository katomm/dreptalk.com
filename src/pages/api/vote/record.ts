// POST /api/vote/record
// Optimistic local record of a just-submitted DRep vote, plus the frozen
// rationale post. The tx is built and submitted by the wallet, NOT here; this
// only mirrors the result so the UI reflects it before the hourly sync. Gated
// to the logged-in DRep: the drep_id is derived from the session user, never
// trusted from the client.
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { getUserById } from '@/lib/db/users';
import { recordLocalVote } from '@/lib/db/drepVotes';
import { upsertVoteRationalePost, removeVoteRationalePost } from '@/lib/db/voteRationalePost';
import { upsertActionRationale } from '@/lib/db/actionRationale';
import { renderMarkdown } from '@/lib/markdown';
import { buildVoteRationale, MAX_VOTE_RATIONALE } from '@/lib/governance/voteRationale';

export const prerender = false;

const schema = z.object({
  gaId: z.string().regex(/^[0-9a-fA-F]{64}#\d{1,5}$/),
  vote: z.enum(['yes', 'no', 'abstain']),
  txHash: z.string().regex(/^[0-9a-fA-F]{64}$/),
  rationaleUrl: z.string().url().optional(),
  // Cap tied to MAX_VOTE_RATIONALE so the input contract can't drift from the
  // canonical limit. A small buffer above it tolerates whitespace, CRLFs, and
  // control chars that sanitizeExternalMultiline strips before the hard slice;
  // anything past MAX_VOTE_RATIONALE is sliced off when the post is canonicalized.
  rationaleText: z.string().min(1).max(MAX_VOTE_RATIONALE + 1000).optional(),
  // When true, also cross-post the rationale as a frozen post in the action's
  // discussion thread. Omitted/false: the rationale still records on-chain and on
  // the Positions tab, but no discussion post is created (and any stale one is
  // removed).
  crossPost: z.boolean().optional(),
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
  const { gaId, vote, txHash, rationaleUrl, rationaleText, crossPost } = parsed.data;

  // Derive drep_id from the session user: never trust a client-supplied value.
  const dbUser = await getUserById(db, user.id);
  const drepId = dbUser?.drep_id ?? null;
  if (!drepId) return jsonResponse({ error: 'not a drep' }, 403);

  // Two clocks, two conventions: drep_votes.block_time is Unix seconds (matches
  // Koios), while posts.created_at is milliseconds (matches every other forum
  // write). Sharing one value mislabels the rationale post and sorts it before
  // the opening post, so each table gets its own unit.
  const nowSec = Math.floor(Date.now() / 1000);
  const nowMs = Date.now();
  await recordLocalVote(db, {
    gaId,
    drepId,
    voterHex: null,
    vote,
    metaUrl: rationaleUrl ?? null,
    txHash,
    now: nowSec,
  });

  if (rationaleText) {
    const ga = await db
      .prepare(`SELECT topic_id FROM governance_actions WHERE id = ?`)
      .bind(gaId)
      .first<{ topic_id: string | null }>();
    if (ga?.topic_id) {
      const canonical = buildVoteRationale({ rationale: rationaleText }).rationale;
      if (crossPost) {
        await upsertVoteRationalePost(db, {
          topicId: ga.topic_id,
          authorId: user.id,
          vote,
          bodyMd: canonical,
          bodyHtml: renderMarkdown(canonical),
          now: nowMs,
        });
      } else {
        // Opt-out, or a re-vote with the box unchecked: ensure no stale
        // cross-post is left standing in the discussion.
        await removeVoteRationalePost(db, { topicId: ga.topic_id, authorId: user.id });
      }
      await upsertActionRationale(db, {
        gaId, voterId: drepId, bodyHtml: renderMarkdown(canonical),
        source: 'dreptalk', anchorUrl: rationaleUrl ?? null,
        status: 'ok', createdAt: nowMs, now: nowMs,
      });
    }
  }

  return jsonResponse({ ok: true });
};
