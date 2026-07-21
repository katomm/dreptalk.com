/// <reference types="@cloudflare/workers-types" />
// Lists every mentionable profile (dreps and pools that have an assigned
// profile slug) for the @mention autocomplete. Read-only, public data; the
// API route in src/pages/api/mention-candidates.ts edge-caches the result.

export interface MentionCandidate {
  slug: string;
  name: string;
  kind: 'drep' | 'pool';
}

/** All profiles with a slug, sorted by display name (case-insensitive). */
export async function listMentionCandidates(db: D1Database): Promise<MentionCandidate[]> {
  const { results } = await db
    .prepare(
      `SELECT slug, COALESCE(name, slug) AS name, 'drep' AS kind
         FROM dreps WHERE slug IS NOT NULL
       UNION ALL
       SELECT slug, COALESCE(name, ticker, slug) AS name, 'pool' AS kind
         FROM pools WHERE slug IS NOT NULL
       ORDER BY name COLLATE NOCASE`,
    )
    .all<MentionCandidate>();
  return results;
}
