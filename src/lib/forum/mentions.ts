/// <reference types="@cloudflare/workers-types" />
// @slug mentions: extraction from markdown (marked token walk, so code spans
// and fences never produce mentions) and resolution of slugs to profile hrefs
// plus the linked forum user (for the mention notification). Slugs are the
// assigned DRep / pool profile slugs; on a collision the DRep wins, matching
// authorProfileHref's precedence.

import { lexer } from 'marked';
import { sqlPlaceholders } from '../db/sql.js';
import { drepPath } from '../dreps/profile.js';
import { poolPath } from '../pools/profile.js';

/** Upper bound on mentions processed per post; the rest are plain text. */
export const MAX_MENTIONS_PER_POST = 20;

// Shared syntax contract with the markdown tokenizer (markdown.ts): '@'
// preceded by start / whitespace / '(' / '>', slug = [a-z0-9][a-z0-9-]{1,63}.
// The '^' anchor is matched per text segment, not per document: marked splits
// inline content into a text token at every inline element boundary (bold,
// code, link, ...), so '@bob' right after '**foo**' or a link is at the start
// of its own text token and counts as matching '^'. This is intentional, not
// an escape hatch: Task 5's marked inline tokenizer sees the exact same
// per-segment '@bob' once the preceding inline token is consumed, so
// extraction and rendering always agree on what counts as a mention. Emails
// stay safe under this rule because 'foo@bar.com' never splits into a
// segment that starts at '@'; the '@' always has 'foo' immediately before it
// in the same text token.
const MENTION_RE = /(^|[\s(>])@([a-z0-9][a-z0-9-]{1,63})/g;

/** Unique mention slug candidates from markdown, in order of appearance. */
export function extractMentionSlugs(md: string): string[] {
  const found = new Set<string>();
  // biome-ignore lint/suspicious/noExplicitAny: marked token unions are unwieldy for a structural walk
  const walk = (tokens: any[]): void => {
    for (const t of tokens) {
      if (!t || t.type === 'code' || t.type === 'codespan') continue;
      if (Array.isArray(t.tokens)) {
        walk(t.tokens);
        continue;
      }
      if (Array.isArray(t.items)) {
        // Lists carry their children under items.
        walk(t.items);
        continue;
      }
      if (t.type === 'table') {
        for (const cell of t.header ?? []) walk(cell.tokens ?? []);
        for (const row of t.rows ?? []) for (const cell of row) walk(cell.tokens ?? []);
        continue;
      }
      if (t.type === 'text' && typeof t.raw === 'string') {
        for (const m of t.raw.matchAll(MENTION_RE)) found.add(m[2]);
      }
    }
  };
  walk(lexer(md, { gfm: true, breaks: true }));
  return [...found].slice(0, MAX_MENTIONS_PER_POST);
}

export interface ResolvedMention {
  slug: string;
  /** Internal profile path, e.g. /dreps/alice-drep/. */
  href: string;
  /** Display name for the rendered link text; falls back to the slug. */
  label: string;
  /** The forum user linked to this profile, or null when none has signed up. */
  userId: string | null;
}

/**
 * Resolves slug candidates against the dreps and pools tables and maps each
 * hit to its profile href and (when one exists) the linked forum user id.
 * Unresolved slugs are absent from the result. At most MAX_MENTIONS_PER_POST
 * slugs are looked up, so the IN lists stay far under the bind-param limit.
 */
export async function resolveMentions(
  db: D1Database,
  slugs: string[],
): Promise<Map<string, ResolvedMention>> {
  const out = new Map<string, ResolvedMention>();
  const unique = [...new Set(slugs)].slice(0, MAX_MENTIONS_PER_POST);
  if (unique.length === 0) return out;

  const ph = sqlPlaceholders(unique);
  const [dreps, pools] = await Promise.all([
    db
      .prepare(`SELECT slug, drep_id, name FROM dreps WHERE slug IN (${ph})`)
      .bind(...unique)
      .all<{ slug: string; drep_id: string; name: string | null }>(),
    db
      .prepare(`SELECT slug, pool_id, name, ticker FROM pools WHERE slug IN (${ph})`)
      .bind(...unique)
      .all<{ slug: string; pool_id: string; name: string | null; ticker: string | null }>(),
  ]);

  const drepIds = dreps.results.map((r) => r.drep_id);
  const poolIds = pools.results.map((r) => r.pool_id);
  const [userByDrep, userByPool] = await Promise.all([
    drepIds.length
      ? db
          .prepare(`SELECT id, drep_id FROM users WHERE drep_id IN (${sqlPlaceholders(drepIds)})`)
          .bind(...drepIds)
          .all<{ id: string; drep_id: string }>()
          .then((r) => new Map(r.results.map((u) => [u.drep_id, u.id])))
      : new Map<string, string>(),
    poolIds.length
      ? db
          .prepare(`SELECT id, pool_id FROM users WHERE pool_id IN (${sqlPlaceholders(poolIds)})`)
          .bind(...poolIds)
          .all<{ id: string; pool_id: string }>()
          .then((r) => new Map(r.results.map((u) => [u.pool_id, u.id])))
      : new Map<string, string>(),
  ]);

  // Pools first so a colliding DRep slug overwrites: DRep wins.
  for (const r of pools.results) {
    out.set(r.slug, {
      slug: r.slug,
      href: poolPath({ poolId: r.pool_id, slug: r.slug }),
      label: r.name ?? r.ticker ?? r.slug,
      userId: userByPool.get(r.pool_id) ?? null,
    });
  }
  for (const r of dreps.results) {
    out.set(r.slug, {
      slug: r.slug,
      href: drepPath({ drepId: r.drep_id, slug: r.slug }),
      label: r.name ?? r.slug,
      userId: userByDrep.get(r.drep_id) ?? null,
    });
  }
  return out;
}
