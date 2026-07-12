/// <reference types="@cloudflare/workers-types" />
// Read-only D1 access for the NCL Treasury Overview: enacted withdrawal totals
// and links back to the underlying governance actions on DRepTalk.

import { sqlPlaceholders } from './sql.js';
import { treasuryTotalLovelace } from '../governance/onchain.js';

// A pasted bech32 proposal_id resolves to its canonical topic via /t/[slug]'s
// redirect, so actions link by proposal_id without a topic join.
const toTopicHref = (proposalId: string) => `/t/${proposalId}/`;

export interface EnactedWithdrawal {
  id: string;
  title: string;
  enactedEpoch: number;
  lovelace: bigint;
  href: string | null;
}

/**
 * All enacted TreasuryWithdrawals with their total lovelace, decoded from the
 * stored on-chain payload. Ordered by enactment epoch. `enacted_epoch` is
 * populated by the gov-sync backfill; rows without it are not yet attributable
 * and are excluded.
 */
export async function getEnactedTreasuryWithdrawals(db: D1Database): Promise<EnactedWithdrawal[]> {
  const { results } = await db
    .prepare(
      `SELECT id, title, enacted_epoch AS enactedEpoch, onchain_payload AS payload, proposal_id AS proposalId
         FROM governance_actions
        WHERE type = 'TreasuryWithdrawals' AND enacted_epoch IS NOT NULL
        ORDER BY enacted_epoch`,
    )
    .all<{ id: string; title: string; enactedEpoch: number; payload: string | null; proposalId: string | null }>();
  const out: EnactedWithdrawal[] = [];
  for (const r of results) {
    let payload: unknown = null;
    if (r.payload) {
      try {
        payload = JSON.parse(r.payload);
      } catch {
        payload = null;
      }
    }
    out.push({
      id: r.id,
      title: r.title,
      enactedEpoch: r.enactedEpoch,
      lovelace: treasuryTotalLovelace(payload),
      href: r.proposalId ? toTopicHref(r.proposalId) : null,
    });
  }
  return out;
}

export interface NclActionLink {
  id: string;
  title: string;
  status: string;
  href: string;
}

/**
 * Resolve NCL defining/related action ids to a title, live status, and a
 * DRepTalk link. The link uses the bech32 proposal_id against /t/[slug], which
 * 301-redirects a pasted gov action id to its canonical topic, so no topic
 * join is needed. `ids` is always small (curated), well under the 100-param cap.
 */
export async function getNclActionLinks(db: D1Database, ids: string[]): Promise<Map<string, NclActionLink>> {
  const out = new Map<string, NclActionLink>();
  if (ids.length === 0) return out;
  const placeholders = sqlPlaceholders(ids);
  const { results } = await db
    .prepare(`SELECT id, title, status, proposal_id AS proposalId FROM governance_actions WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<{ id: string; title: string; status: string; proposalId: string }>();
  for (const r of results) {
    out.set(r.id, { id: r.id, title: r.title, status: r.status, href: toTopicHref(r.proposalId) });
  }
  return out;
}
