/// <reference types="@cloudflare/workers-types" />
// Content-addressed store for vote rationale documents. Mirrors db/drepMetadata.

export async function putVoteRationale(
  db: D1Database,
  rec: { hash: string; body: string; drepId: string; gaId: string; createdAt: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO vote_rationale (hash, body, drep_id, ga_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(rec.hash, rec.body, rec.drepId, rec.gaId, rec.createdAt)
    .run();
}

/** Returns the canonical JSON body for a hash, or null. */
export async function getVoteRationaleBody(db: D1Database, hash: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT body FROM vote_rationale WHERE hash = ?`)
    .bind(hash)
    .first<{ body: string }>();
  return row?.body ?? null;
}

// One voter's vote on one action with its rendered rationale. Backs the shareable
// vote page and its preview-image route. Includes pending (just-voted, optimistic)
// and confirmed votes, but not failed ones; requires a real rationale (status ok,
// non-blank body_text), so callers redirect instead of rendering an empty page.
// voted_power is read as TEXT: it is INTEGER lovelace that can exceed JS safe range.
export interface VoteStatementRow {
  vote: string;
  localStatus: 'pending' | null;
  txHash: string | null;
  votingPower: string | null;
  blockTime: number | null;
  rationaleHtml: string;
  bodyText: string;
  source: string;
}

export async function getVoteStatement(
  db: D1Database,
  args: { gaId: string; voterId: string; role: 'DRep' | 'SPO' },
): Promise<VoteStatementRow | null> {
  const row = await db
    .prepare(
      `SELECT v.vote AS vote, v.local_status AS local_status, v.tx_hash AS tx_hash,
              CAST(d.voting_power AS TEXT) AS voting_power, v.block_time AS block_time,
              r.body_html AS rationale_html, r.body_text AS body_text, r.source AS source
         FROM drep_votes v
         JOIN action_rationale r ON r.ga_id = v.ga_id AND r.voter_id = v.voter_id
         LEFT JOIN dreps d ON d.drep_id = v.voter_id
        WHERE v.ga_id = ? AND v.voter_id = ? AND v.voter_role = ?
          AND (v.local_status IS NULL OR v.local_status = 'pending')
          AND r.status = 'ok' AND trim(r.body_text) <> ''`,
    )
    .bind(args.gaId, args.voterId, args.role)
    .first<{
      vote: string; local_status: string | null; tx_hash: string | null;
      voting_power: string | null; block_time: number | null;
      rationale_html: string; body_text: string; source: string;
    }>();
  if (!row) return null;
  return {
    vote: row.vote,
    localStatus: row.local_status === 'pending' ? 'pending' : null,
    txHash: row.tx_hash,
    votingPower: row.voting_power,
    blockTime: row.block_time,
    rationaleHtml: row.rationale_html,
    bodyText: row.body_text,
    source: row.source,
  };
}
