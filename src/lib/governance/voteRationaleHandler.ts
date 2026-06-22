/// <reference types="@cloudflare/workers-types" />
// Hosting handler for CIP-100 vote rationale documents. Unauthenticated by
// design (mirrors drepMetadataHandler): authenticity is bound on-chain by the
// vote anchor hash; this table is just a CDN. Storage is content-addressed.

import { z } from 'zod';
import { buildVoteRationale, MAX_VOTE_RATIONALE } from './voteRationale.js';
import { putVoteRationale } from '../db/voteRationale.js';

const DREP_ID_RE = /^drep1[0-9a-z]{10,120}$/;
const GA_ID_RE = /^[0-9a-fA-F]{64}#\d{1,5}$/;

const bodySchema = z.object({
  drepId: z.string().regex(DREP_ID_RE, 'invalid drep id'),
  gaId: z.string().regex(GA_ID_RE, 'invalid governance action id'),
  rationale: z.string().min(1).max(MAX_VOTE_RATIONALE + 1000),
});

export interface VoteRationaleHandlerInput {
  body: unknown;
  db: D1Database;
  origin: string;
  now: number; // milliseconds
}

export interface VoteRationaleHandlerResult {
  status: number;
  json: unknown;
}

/** Never throws; unexpected errors become a generic 500. */
export async function handleVoteRationale(
  input: VoteRationaleHandlerInput,
): Promise<VoteRationaleHandlerResult> {
  try {
    const parsed = bodySchema.safeParse(input.body);
    if (!parsed.success) {
      return { status: 400, json: { error: parsed.error.issues[0]?.message ?? 'invalid input' } };
    }
    const { drepId, gaId, rationale } = parsed.data;
    const built = buildVoteRationale({ rationale });
    if (built.rationale.length === 0) {
      return { status: 400, json: { error: 'empty rationale' } };
    }
    const url = `${input.origin}/vote-rationale/${built.hash}.json`;
    await putVoteRationale(input.db, {
      hash: built.hash,
      body: built.body,
      drepId,
      gaId,
      createdAt: Math.floor(input.now / 1000),
    });
    return { status: 200, json: { url, hash: built.hash } };
  } catch {
    return { status: 500, json: { error: 'internal error' } };
  }
}
