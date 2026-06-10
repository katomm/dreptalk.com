/// <reference types="@cloudflare/workers-types" />
// Search reads: identifier point lookups and the grouped full-text batch.
// All queries are parameterized; the MATCH string itself is built by
// lib/search/match.ts (never raw user input) and bound as a parameter.
import { decodeBech32 } from '../crypto/bech32.js';
import type { IdentifierQuery } from '../search/identifiers.js';

export interface ExactHit {
  kind: 'governance-action' | 'drep';
  href: string;
  label: string;
}

export interface GaHit {
  href: string;
  title: string;
  type: string;
  status: string;
  snippet: string | null;
  discussionMatches: number;
}

export interface TopicHit {
  href: string;
  title: string;
  categorySlug: string;
  postCount: number;
  snippet: string | null;
}

export interface DrepHit {
  href: string;
  drepId: string;
  name: string | null;
  status: string;
  votingPower: string | null;
  snippet: string | null;
}

export interface SearchGroups {
  governanceActions: GaHit[];
  discussions: TopicHit[];
  dreps: DrepHit[];
}

const GROUP_LIMIT = 5;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Resolves a detected identifier to its exact target, or null. */
export async function resolveIdentifier(db: D1Database, ident: IdentifierQuery): Promise<ExactHit | null> {
  if (ident.kind === 'gov-action') {
    let stmt: D1PreparedStatement;
    if (ident.by === 'proposal_id') {
      stmt = db
        .prepare(
          `SELECT ga.id, ga.title, t.slug
           FROM governance_actions ga
           LEFT JOIN topics t ON t.id = ga.topic_id
           WHERE ga.proposal_id = ?1
           LIMIT 1`,
        )
        .bind(ident.value);
    } else if (ident.by === 'id') {
      stmt = db
        .prepare(
          `SELECT ga.id, ga.title, t.slug
           FROM governance_actions ga
           LEFT JOIN topics t ON t.id = ga.topic_id
           WHERE ga.id = ?1
           LIMIT 1`,
        )
        .bind(ident.value);
    } else {
      // id-prefix: value is "<64-hex>#%" from identifiers.ts; strip the trailing
      // "%" and match via SUBSTR to avoid SQLite LIKE complexity limits on long
      // hex patterns. The prefix is always exactly "<hash>#" (65 chars).
      const prefix = ident.value.endsWith('%') ? ident.value.slice(0, -1) : ident.value;
      stmt = db
        .prepare(
          `SELECT ga.id, ga.title, t.slug
           FROM governance_actions ga
           LEFT JOIN topics t ON t.id = ga.topic_id
           WHERE SUBSTR(ga.id, 1, ?2) = ?1
           LIMIT 1`,
        )
        .bind(prefix, prefix.length);
    }
    const row = await stmt.first<{ id: string; title: string | null; slug: string | null }>();
    if (!row?.slug) return null;
    return { kind: 'governance-action', href: `/t/${row.slug}`, label: row.title ?? row.id };
  }

  const direct = await db
    .prepare('SELECT drep_id, name FROM dreps WHERE drep_id = ?1 LIMIT 1')
    .bind(ident.drepId)
    .first<{ drep_id: string; name: string | null }>();
  if (direct) {
    return { kind: 'drep', href: `/dreps/${direct.drep_id}`, label: direct.name ?? direct.drep_id };
  }

  // The pasted id may be the other bech32 flavor (CIP-105 vs CIP-129) of a
  // stored DRep. The hex column stores the raw 28-byte credential, so decode
  // and look it up by hash: 29-byte payloads carry a CIP-129 header byte.
  let hex: string | null = null;
  try {
    const { prefix, data } = decodeBech32(ident.drepId);
    if (prefix === 'drep' || prefix === 'drep_script') {
      const hash = data.length === 29 ? data.subarray(1) : data.length === 28 ? data : null;
      if (hash) hex = toHex(hash);
    }
  } catch {
    return null;
  }
  if (!hex) return null;
  const byHex = await db
    .prepare('SELECT drep_id, name FROM dreps WHERE hex = ?1 LIMIT 1')
    .bind(hex)
    .first<{ drep_id: string; name: string | null }>();
  if (!byHex) return null;
  return { kind: 'drep', href: `/dreps/${byHex.drep_id}`, label: byHex.name ?? byHex.drep_id };
}

interface GaRow {
  ga_id: string;
  title: string | null;
  type: string;
  status: string;
  slug: string | null;
  snip: string | null;
}

interface TopicRow {
  topic_id: string;
  title: string;
  slug: string;
  category_slug: string;
  post_count: number;
  ga_id: string | null;
  ga_type: string | null;
  ga_status: string | null;
  ga_title: string | null;
  snip: string | null;
}

interface DrepRow {
  drep_id: string;
  name: string | null;
  status: string;
  voting_power: string | null;
  snip: string | null;
}

/**
 * Runs the four FTS queries in one D1 batch and merges forum hits per topic:
 * hits in governance topics join the GA group (annotated as discussion
 * matches, deduplicated against direct GA hits), everything else lands in
 * Discussions. Soft-deleted rows are filtered here, at query time.
 */
export async function searchAll(db: D1Database, match: string): Promise<SearchGroups> {
  const [gaRes, topicRes, postRes, drepRes] = await db.batch([
    db
      .prepare(
        `SELECT ga.id AS ga_id, ga.title, ga.type, ga.status, t.slug,
                snippet(governance_actions_fts, 1, char(1), char(2), '…', 12) AS snip
         FROM governance_actions_fts
         JOIN governance_actions ga ON ga.rowid = governance_actions_fts.rowid
         LEFT JOIN topics t ON t.id = ga.topic_id
         WHERE governance_actions_fts MATCH ?1
         ORDER BY bm25(governance_actions_fts, 5.0, 1.0)
         LIMIT ${GROUP_LIMIT}`,
      )
      .bind(match),
    db
      .prepare(
        `SELECT t.id AS topic_id, t.title, t.slug, t.category_slug, t.post_count,
                ga.id AS ga_id, ga.type AS ga_type, ga.status AS ga_status, ga.title AS ga_title,
                NULL AS snip
         FROM topics_fts
         JOIN topics t ON t.rowid = topics_fts.rowid
         LEFT JOIN governance_actions ga ON ga.topic_id = t.id
         WHERE topics_fts MATCH ?1 AND t.deleted = 0
         ORDER BY bm25(topics_fts)
         LIMIT 8`,
      )
      .bind(match),
    db
      .prepare(
        `SELECT p.topic_id, t.title, t.slug, t.category_slug, t.post_count,
                ga.id AS ga_id, ga.type AS ga_type, ga.status AS ga_status, ga.title AS ga_title,
                snippet(posts_fts, 0, char(1), char(2), '…', 12) AS snip
         FROM posts_fts
         JOIN posts p ON p.rowid = posts_fts.rowid
         JOIN topics t ON t.id = p.topic_id
         LEFT JOIN governance_actions ga ON ga.topic_id = t.id
         WHERE posts_fts MATCH ?1 AND p.deleted = 0 AND t.deleted = 0
         ORDER BY bm25(posts_fts)
         LIMIT 12`,
      )
      .bind(match),
    db
      .prepare(
        `SELECT d.drep_id, d.name, d.status, d.voting_power,
                snippet(dreps_fts, 1, char(1), char(2), '…', 12) AS snip
         FROM dreps_fts
         JOIN dreps d ON d.rowid = dreps_fts.rowid
         WHERE dreps_fts MATCH ?1
         ORDER BY bm25(dreps_fts, 5.0, 1.0)
         LIMIT ${GROUP_LIMIT}`,
      )
      .bind(match),
  ]);

  const gaRows = (gaRes.results ?? []) as unknown as GaRow[];
  const topicRows = (topicRes.results ?? []) as unknown as TopicRow[];
  const postRows = (postRes.results ?? []) as unknown as TopicRow[];
  const drepRows = (drepRes.results ?? []) as unknown as DrepRow[];

  // Merge topic-title hits and post hits per topic; post hits contribute the
  // snippet (best-ranked first) and the discussion-match count.
  const threads = new Map<string, TopicRow & { postMatches: number }>();
  for (const t of topicRows) {
    threads.set(t.topic_id, { ...t, postMatches: 0 });
  }
  for (const p of postRows) {
    const existing = threads.get(p.topic_id);
    if (existing) {
      existing.postMatches += 1;
      if (existing.snip == null) existing.snip = p.snip;
    } else {
      threads.set(p.topic_id, { ...p, postMatches: 1 });
    }
  }

  const governanceActions: GaHit[] = [];
  for (const ga of gaRows) {
    if (!ga.slug) continue; // every synced GA gets a topic; guard only
    governanceActions.push({
      href: `/t/${ga.slug}`,
      title: ga.title ?? ga.ga_id,
      type: ga.type,
      status: ga.status,
      snippet: ga.snip,
      discussionMatches: 0,
    });
  }

  const discussions: TopicHit[] = [];
  for (const thread of threads.values()) {
    if (thread.ga_id != null) {
      const direct = governanceActions.find((g) => g.href === `/t/${thread.slug}`);
      if (direct) {
        direct.discussionMatches = thread.postMatches;
      } else if (governanceActions.length < GROUP_LIMIT) {
        governanceActions.push({
          href: `/t/${thread.slug}`,
          title: thread.ga_title ?? thread.ga_id,
          type: thread.ga_type ?? 'InfoAction',
          status: thread.ga_status ?? 'active',
          snippet: thread.snip,
          discussionMatches: thread.postMatches,
        });
      }
    } else if (discussions.length < GROUP_LIMIT) {
      discussions.push({
        href: `/t/${thread.slug}`,
        title: thread.title,
        categorySlug: thread.category_slug,
        postCount: thread.post_count,
        snippet: thread.snip,
      });
    }
  }

  const dreps: DrepHit[] = drepRows.map((d) => ({
    href: `/dreps/${d.drep_id}`,
    drepId: d.drep_id,
    name: d.name,
    status: d.status,
    votingPower: d.voting_power,
    snippet: d.snip,
  }));

  return {
    governanceActions: governanceActions.slice(0, GROUP_LIMIT),
    discussions,
    dreps,
  };
}
