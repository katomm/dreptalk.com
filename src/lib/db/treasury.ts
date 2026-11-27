/// <reference types="@cloudflare/workers-types" />
// Read-only D1 access for the NCL Treasury Overview: enacted withdrawal totals
// and links back to the underlying governance actions on DRepTalk.

import { sqlPlaceholders } from './sql.js';
import { treasuryTotalLovelace } from '../governance/onchain.js';
import type { HistorySourceRow } from '../treasury/recipientHistory.js';

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

/**
 * Every other TreasuryWithdrawals row with a stored payload, any status, newest
 * first, for the recipient history on a withdrawal's detail page. The payload
 * stays raw text, the pure builder parses and skips what does not parse. The
 * slug only comes from a live topic, so an action without one is listed unlinked.
 * A full scan on purpose: about a hundred rows on mainnet, the same pattern as
 * getEnactedTreasuryWithdrawals. A recipient table pays off only at thousands.
 */
export async function listTreasuryHistoryRows(db: D1Database, excludeId: string): Promise<HistorySourceRow[]> {
  const { results } = await db
    .prepare(
      `SELECT g.id, g.title, g.status, g.return_address AS returnAddress,
              g.submitted_epoch AS submittedEpoch, g.submitted_at AS submittedAt, g.onchain_payload AS payload, t.slug
         FROM governance_actions g
         LEFT JOIN topics t ON t.id = g.topic_id AND t.deleted = 0
        WHERE g.type = 'TreasuryWithdrawals' AND g.onchain_payload IS NOT NULL AND g.id != ?1
        ORDER BY g.submitted_at IS NULL, g.submitted_at DESC, g.submitted_epoch DESC, g.id ASC`,
    )
    .bind(excludeId)
    .all<HistorySourceRow>();
  return results;
}

/** How many governance actions of any type and status a return address submitted, null without an address. */
export async function countActionsByReturnAddress(db: D1Database, returnAddress: string | null): Promise<number | null> {
  if (!returnAddress) return null;
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM governance_actions WHERE return_address = ?1')
    .bind(returnAddress)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
