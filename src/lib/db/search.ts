/// <reference types="@cloudflare/workers-types" />
// Search reads: identifier point lookups and the grouped full-text batch.
// All queries are parameterized; the MATCH string itself is built by
// lib/search/match.ts (never raw user input) and bound as a parameter.
import { decodeBech32 } from '../crypto/bech32.js';
import { drepPath } from '../dreps/profile.js';
import type { IdentifierQuery } from '../search/identifiers.js';
import { PAGE_SIZE } from '../search/scopes.js';
import { pageToOffset } from '../forum/view.js';

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
  imageHash: string | null;
}

export interface SearchGroups {
  governanceActions: GaHit[];
  discussions: TopicHit[];
  dreps: DrepHit[];
  rationales: RationaleHit[];
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
           LEFT JOIN topics t ON t.id = ga.topic_id AND t.deleted = 0
           WHERE ga.proposal_id = ?1
           LIMIT 1`,
        )
        .bind(ident.value);
    } else if (ident.by === 'id') {
      stmt = db
        .prepare(
          `SELECT ga.id, ga.title, t.slug
           FROM governance_actions ga
           LEFT JOIN topics t ON t.id = ga.topic_id AND t.deleted = 0
           WHERE ga.id = ?1
           LIMIT 1`,
        )
        .bind(ident.value);
    } else {
      // id-prefix: value is the bare "<64-hex>#" prefix from identifiers.ts.
      // SUBSTR gives byte-exact, case-sensitive comparison without wildcard
      // semantics. LIKE is ASCII case-insensitive and carries pattern-matching
      // we do not want here (it also failed in workerd with "LIKE or GLOB
      // pattern too complex" on full 65-char patterns).
      // ORDER BY ga.id for a deterministic pick (lexicographic); multi-action
      // transactions are rare and any stable pick is fine.
      stmt = db
        .prepare(
          `SELECT ga.id, ga.title, t.slug
           FROM governance_actions ga
           LEFT JOIN topics t ON t.id = ga.topic_id AND t.deleted = 0
           WHERE SUBSTR(ga.id, 1, ?2) = ?1
           ORDER BY ga.id
           LIMIT 1`,
        )
        .bind(ident.value, ident.value.length);
    }
    const row = await stmt.first<{ id: string; title: string | null; slug: string | null }>();
    if (!row?.slug) return null;
    return { kind: 'governance-action', href: `/t/${row.slug}/`, label: row.title ?? row.id };
  }

  const direct = await db
    .prepare('SELECT drep_id, name, slug FROM dreps WHERE drep_id = ?1 LIMIT 1')
    .bind(ident.drepId)
    .first<{ drep_id: string; name: string | null; slug: string | null }>();
  if (direct) {
    return { kind: 'drep', href: drepPath({ drepId: direct.drep_id, slug: direct.slug }), label: direct.name ?? direct.drep_id };
  }

  // The pasted id may be the other bech32 flavor (CIP-105 vs CIP-129) of a
  // stored DRep. The hex column stores the raw 28-byte credential, so decode
  // and look it up by hash: 29-byte payloads carry a CIP-129 header byte.
  let hex: string | null = null;
  try {
    const { prefix, data } = decodeBech32(ident.drepId);
    if (prefix === 'drep' || prefix === 'drep_script') {
      // 29-byte payloads carry a CIP-129 header byte; only 0x22 (key) or 0x23
      // (script) are valid DRep credential headers.
      const hash =
        data.length === 29 && (data[0] === 0x22 || data[0] === 0x23)
          ? data.subarray(1)
          : data.length === 28
            ? data
            : null;
      if (hash) hex = toHex(hash);
    }
  } catch {
    return null;
  }
  if (!hex) return null;
  const byHex = await db
    .prepare('SELECT drep_id, name, slug FROM dreps WHERE hex = ?1 LIMIT 1')
    .bind(hex)
    .first<{ drep_id: string; name: string | null; slug: string | null }>();
  if (!byHex) return null;
  return { kind: 'drep', href: drepPath({ drepId: byHex.drep_id, slug: byHex.slug }), label: byHex.name ?? byHex.drep_id };
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
  slug: string | null;
  status: string;
  voting_power: string | null;
  image_content_hash: string | null;
  snip: string | null;
}

/**
 * Runs the four FTS queries in one D1 batch and merges forum hits per topic:
 * hits in governance topics join the GA group (annotated as discussion
 * matches, deduplicated against direct GA hits), everything else lands in
 * Discussions. Soft-deleted rows are filtered here, at query time.
 */
export async function searchAll(db: D1Database, match: string): Promise<SearchGroups> {
  const [gaRes, topicRes, postRes, drepRes, ratRes] = await db.batch([
    db
      .prepare(
        `SELECT ga.id AS ga_id, ga.title, ga.type, ga.status, t.slug,
                snippet(governance_actions_fts, 1, char(1), char(2), '…', 12) AS snip
         FROM governance_actions_fts
         JOIN governance_actions ga ON ga.rowid = governance_actions_fts.rowid
         LEFT JOIN topics t ON t.id = ga.topic_id AND t.deleted = 0
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
         WHERE posts_fts MATCH ?1 AND p.deleted = 0 AND p.hidden = 0 AND t.deleted = 0
         ORDER BY bm25(posts_fts)
         LIMIT 12`,
      )
      .bind(match),
    db
      .prepare(
        `SELECT d.drep_id, d.name, d.slug, d.status, d.voting_power, d.image_content_hash,
                snippet(dreps_fts, 1, char(1), char(2), '…', 12) AS snip
         FROM dreps_fts
         JOIN dreps d ON d.rowid = dreps_fts.rowid
         WHERE dreps_fts MATCH ?1
         ORDER BY bm25(dreps_fts, 5.0, 1.0)
         LIMIT ${GROUP_LIMIT}`,
      )
      .bind(match),
    db.prepare(`${RATIONALE_SELECT} LIMIT ${GROUP_LIMIT}`).bind(match),
  ]);

  const gaRows = (gaRes.results ?? []) as unknown as GaRow[];
  const topicRows = (topicRes.results ?? []) as unknown as TopicRow[];
  const postRows = (postRes.results ?? []) as unknown as TopicRow[];
  const drepRows = (drepRes.results ?? []) as unknown as DrepRow[];
  const ratRows = (ratRes.results ?? []) as unknown as RationaleRow[];

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
      href: `/t/${ga.slug}/`,
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
      const direct = governanceActions.find((g) => g.href === `/t/${thread.slug}/`);
      if (direct) {
        direct.discussionMatches = thread.postMatches;
      } else if (governanceActions.length < GROUP_LIMIT) {
        governanceActions.push({
          href: `/t/${thread.slug}/`,
          title: thread.ga_title ?? thread.ga_id,
          type: thread.ga_type ?? 'InfoAction',
          status: thread.ga_status ?? 'active',
          snippet: thread.snip,
          discussionMatches: thread.postMatches,
        });
      }
    } else if (discussions.length < GROUP_LIMIT) {
      discussions.push({
        href: `/t/${thread.slug}/`,
        title: thread.title,
        categorySlug: thread.category_slug,
        postCount: thread.post_count,
        snippet: thread.snip,
      });
    }
  }

  const dreps: DrepHit[] = drepRows.map((d) => ({
    href: drepPath({ drepId: d.drep_id, slug: d.slug }),
    drepId: d.drep_id,
    name: d.name,
    status: d.status,
    votingPower: d.voting_power,
    snippet: d.snip,
    imageHash: d.image_content_hash,
  }));

  return {
    governanceActions: governanceActions.slice(0, GROUP_LIMIT),
    discussions,
    dreps,
    rationales: ratRows.map(toRationaleHit),
  };
}

// Scoped, paginated reads for the dedicated /search page. Unlike searchAll
// (small per-group typeahead limits for the palette), these return one entity
// type at a time with a total count so the page can render facets and pages.
export { PAGE_SIZE };

export interface ScopeCounts {
  forum: number;
  governance: number;
  dreps: number;
  rationales: number;
}

export interface ScopedResult<T> {
  hits: T[];
  total: number;
}

/** A vote-rationale hit: who said it (DRep, SPO or CC member), how they voted,
 *  on which action. The href deep-links to the voter's row on the Positions
 *  tab, with the role appended so the tab opens the right sub-section. For
 *  paginated roles (DRep/SPO) it carries voter=<id>, which the tab resolves to
 *  the page that actually renders the row (getActionVoterRank); the CC list is
 *  unpaginated, so the plain anchor suffices there. */
export interface RationaleHit {
  href: string; // /t/<slug>?tab=positions[&role=…][&voter=<voterId>]#voter-<voterId>
  voterId: string;
  name: string | null;
  imageHash: string | null;
  vote: string; // 'Yes' | 'No' | 'Abstain'
  actionTitle: string;
  snippet: string | null;
}

function countOf(res: D1Result): number {
  return (res.results?.[0] as { n: number } | undefined)?.n ?? 0;
}

// Rationale FTS row shape and the shared join used by both the page query and
// the palette typeahead. INNER JOIN topics so a slug-less (unlinkable) rationale
// is excluded from both hits and count, keeping the facet number honest.
// voter_role tells DRep hits from CC hits apart so the name resolves from the
// right table and the href links to the right Positions sub-section.
interface RationaleRow {
  voter_id: string;
  voter_role: string;
  vote: string;
  name: string | null;
  image_content_hash: string | null;
  action_title: string | null;
  topic_slug: string;
  snip: string | null;
}

const RATIONALE_SELECT = `
  SELECT r.voter_id, v.voter_role, v.vote,
         COALESCE(d.name, cn.name) AS name, d.image_content_hash,
         ga.title AS action_title, t.slug AS topic_slug,
         snippet(action_rationale_fts, 0, char(1), char(2), '…', 12) AS snip
  FROM action_rationale_fts
  JOIN action_rationale r ON r.rowid = action_rationale_fts.rowid
  JOIN drep_votes v ON v.ga_id = r.ga_id AND v.voter_id = r.voter_id
  JOIN governance_actions ga ON ga.id = r.ga_id
  JOIN topics t ON t.id = ga.topic_id AND t.deleted = 0
  LEFT JOIN dreps d ON d.drep_id = r.voter_id
  LEFT JOIN cc_member_name cn ON cn.hot_key_hex = lower(v.voter_hex)
  WHERE action_rationale_fts MATCH ?1 AND r.status = 'ok'
  ORDER BY bm25(action_rationale_fts)`;

function toRationaleHit(r: RationaleRow): RationaleHit {
  const cc = r.voter_role === 'ConstitutionalCommittee';
  const role = cc ? '&role=cc' : r.voter_role === 'SPO' ? '&role=spo' : '';
  const deep = cc ? '' : `&voter=${r.voter_id}`;
  return {
    href: `/t/${r.topic_slug}/?tab=positions${role}${deep}#voter-${r.voter_id}`,
    voterId: r.voter_id,
    name: r.name,
    imageHash: cc ? null : r.image_content_hash, // CC members have no stored avatar, identicon renders from voterId
    vote: r.vote,
    actionTitle: r.action_title ?? r.topic_slug,
    snippet: r.snip,
  };
}

/** One page of governance-action hits plus the total match count. */
export async function searchGovernancePage(db: D1Database, match: string, page: number): Promise<ScopedResult<GaHit>> {
  const offset = pageToOffset(Math.max(1, page), PAGE_SIZE);
  const [rowsRes, countRes] = await db.batch([
    db
      .prepare(
        `SELECT ga.id AS ga_id, ga.title, ga.type, ga.status, t.slug,
                snippet(governance_actions_fts, 1, char(1), char(2), '…', 12) AS snip
         FROM governance_actions_fts
         JOIN governance_actions ga ON ga.rowid = governance_actions_fts.rowid
         LEFT JOIN topics t ON t.id = ga.topic_id AND t.deleted = 0
         WHERE governance_actions_fts MATCH ?1
         ORDER BY bm25(governance_actions_fts, 5.0, 1.0)
         LIMIT ${PAGE_SIZE} OFFSET ?2`,
      )
      .bind(match, offset),
    db.prepare('SELECT COUNT(*) AS n FROM governance_actions_fts WHERE governance_actions_fts MATCH ?1').bind(match),
  ]);
  const rows = (rowsRes.results ?? []) as unknown as GaRow[];
  const hits: GaHit[] = rows
    .filter((r) => r.slug)
    .map((r) => ({
      href: `/t/${r.slug}/`,
      title: r.title ?? r.ga_id,
      type: r.type,
      status: r.status,
      snippet: r.snip,
      discussionMatches: 0,
    }));
  return { hits, total: countOf(countRes) };
}

/** One page of DRep hits plus the total match count. */
export async function searchDrepsPage(db: D1Database, match: string, page: number): Promise<ScopedResult<DrepHit>> {
  const offset = pageToOffset(Math.max(1, page), PAGE_SIZE);
  const [rowsRes, countRes] = await db.batch([
    db
      .prepare(
        `SELECT d.drep_id, d.name, d.slug, d.status, d.voting_power, d.image_content_hash,
                snippet(dreps_fts, 1, char(1), char(2), '…', 12) AS snip
         FROM dreps_fts
         JOIN dreps d ON d.rowid = dreps_fts.rowid
         WHERE dreps_fts MATCH ?1
         ORDER BY bm25(dreps_fts, 5.0, 1.0)
         LIMIT ${PAGE_SIZE} OFFSET ?2`,
      )
      .bind(match, offset),
    db.prepare('SELECT COUNT(*) AS n FROM dreps_fts WHERE dreps_fts MATCH ?1').bind(match),
  ]);
  const rows = (rowsRes.results ?? []) as unknown as DrepRow[];
  const hits: DrepHit[] = rows.map((d) => ({
    href: drepPath({ drepId: d.drep_id, slug: d.slug }),
    drepId: d.drep_id,
    name: d.name,
    status: d.status,
    votingPower: d.voting_power,
    snippet: d.snip,
    imageHash: d.image_content_hash,
  }));
  return { hits, total: countOf(countRes) };
}

// Forum = user topics matched by title OR by a visible post, ranked by best
// bm25 across both. Governance-synced topics (source = 'governance') belong to
// the Governance scope, so they are excluded here, mirroring how searchAll
// routes GA-linked threads to the GA group. bm25() is evaluated inside each
// UNION branch, where its FTS table is in scope; the outer query aggregates per
// topic. UNION ALL is fine here because we GROUP BY topic_id afterwards.
const FORUM_MATCHED_ROWS = `
  SELECT t.id AS topic_id, bm25(topics_fts) AS rank, NULL AS snip
  FROM topics_fts JOIN topics t ON t.rowid = topics_fts.rowid
  WHERE topics_fts MATCH ?1 AND t.deleted = 0 AND t.source = 'user'
  UNION ALL
  SELECT p.topic_id AS topic_id, bm25(posts_fts) AS rank,
         snippet(posts_fts, 0, char(1), char(2), '…', 12) AS snip
  FROM posts_fts JOIN posts p ON p.rowid = posts_fts.rowid
  JOIN topics t ON t.id = p.topic_id
  WHERE posts_fts MATCH ?1 AND p.deleted = 0 AND p.hidden = 0 AND t.deleted = 0 AND t.source = 'user'`;

interface ForumRow {
  slug: string;
  title: string;
  category_slug: string;
  post_count: number;
  snip: string | null;
}

/** One page of distinct forum topics (title + post matches merged) plus total. */
export async function searchForumPage(db: D1Database, match: string, page: number): Promise<ScopedResult<TopicHit>> {
  const offset = pageToOffset(Math.max(1, page), PAGE_SIZE);
  const [rowsRes, countRes] = await db.batch([
    db
      .prepare(
        `WITH m AS (${FORUM_MATCHED_ROWS})
         SELECT t.slug, t.title, t.category_slug, t.post_count,
                MIN(m.rank) AS best_rank, MAX(m.snip) AS snip
         FROM m JOIN topics t ON t.id = m.topic_id
         GROUP BY m.topic_id
         ORDER BY best_rank
         LIMIT ${PAGE_SIZE} OFFSET ?2`,
      )
      .bind(match, offset),
    db
      .prepare(
        `WITH m AS (${FORUM_MATCHED_ROWS})
         SELECT COUNT(*) AS n FROM (SELECT m.topic_id FROM m GROUP BY m.topic_id)`,
      )
      .bind(match),
  ]);
  const rows = (rowsRes.results ?? []) as unknown as ForumRow[];
  const hits: TopicHit[] = rows.map((r) => ({
    href: `/t/${r.slug}/`,
    title: r.title,
    categorySlug: r.category_slug,
    postCount: r.post_count,
    snippet: r.snip,
  }));
  return { hits, total: countOf(countRes) };
}

// Count over the same row set as RATIONALE_SELECT (INNER topics + status ok), so
// the facet number equals the result list. drep_votes/dreps joins do not change
// the count (drep_votes PK is one row per (ga_id, voter_id); dreps is LEFT).
const RATIONALE_COUNT = `
  SELECT COUNT(*) AS n
  FROM action_rationale_fts
  JOIN action_rationale r ON r.rowid = action_rationale_fts.rowid
  JOIN governance_actions ga ON ga.id = r.ga_id
  JOIN topics t ON t.id = ga.topic_id AND t.deleted = 0
  WHERE action_rationale_fts MATCH ?1 AND r.status = 'ok'`;

/** One page of rationale hits (DRep, vote, action, snippet) plus the total. */
export async function searchRationalesPage(db: D1Database, match: string, page: number): Promise<ScopedResult<RationaleHit>> {
  const offset = pageToOffset(Math.max(1, page), PAGE_SIZE);
  const [rowsRes, countRes] = await db.batch([
    db.prepare(`${RATIONALE_SELECT} LIMIT ${PAGE_SIZE} OFFSET ?2`).bind(match, offset),
    db.prepare(RATIONALE_COUNT).bind(match),
  ]);
  const rows = (rowsRes.results ?? []) as unknown as RationaleRow[];
  return { hits: rows.map(toRationaleHit), total: countOf(countRes) };
}

/** Match counts per D1 scope for the facet column. A topic matched by both its
 *  title and a post counts once (UNION, not UNION ALL). */
export async function countScopes(db: D1Database, match: string): Promise<ScopeCounts> {
  const forumMatched = `
    SELECT t.id AS topic_id FROM topics_fts JOIN topics t ON t.rowid = topics_fts.rowid
    WHERE topics_fts MATCH ?1 AND t.deleted = 0 AND t.source = 'user'
    UNION
    SELECT p.topic_id FROM posts_fts JOIN posts p ON p.rowid = posts_fts.rowid
    JOIN topics t ON t.id = p.topic_id
    WHERE posts_fts MATCH ?1 AND p.deleted = 0 AND p.hidden = 0 AND t.deleted = 0 AND t.source = 'user'`;
  const [forumRes, govRes, drepRes, ratRes] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS n FROM (${forumMatched})`).bind(match),
    db.prepare('SELECT COUNT(*) AS n FROM governance_actions_fts WHERE governance_actions_fts MATCH ?1').bind(match),
    db.prepare('SELECT COUNT(*) AS n FROM dreps_fts WHERE dreps_fts MATCH ?1').bind(match),
    db.prepare(RATIONALE_COUNT).bind(match),
  ]);
  return { forum: countOf(forumRes), governance: countOf(govRes), dreps: countOf(drepRes), rationales: countOf(ratRes) };
}
