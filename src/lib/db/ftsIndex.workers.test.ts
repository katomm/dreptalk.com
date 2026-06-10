/// <reference types="@cloudflare/workers-types" />
// FTS5 index maintenance tests: the 0019 triggers must index inserts, follow
// updates of indexed columns, drop deletions, and stay untouched by tally-only
// updates. Runs in real workerd via vitest-pool-workers.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

const db = () => env.DB;
const NOW = 1_749_000_000_000;
const GA_ID = `${'a'.repeat(64)}#0`;

async function seedGa(o: { id?: string; proposalId?: string; title?: string | null; abstract?: string | null }) {
  await db()
    .prepare(
      `INSERT INTO governance_actions (id, proposal_id, type, title, abstract, status, created_at, last_synced_at)
       VALUES (?, ?, 'InfoAction', ?, ?, 'active', ?, ?)`,
    )
    .bind(o.id ?? GA_ID, o.proposalId ?? 'gov_action1spike', o.title ?? null, o.abstract ?? null, NOW, NOW)
    .run();
}

async function gaFtsMatch(match: string): Promise<string[]> {
  const { results } = await db()
    .prepare(
      `SELECT ga.id FROM governance_actions_fts
       JOIN governance_actions ga ON ga.rowid = governance_actions_fts.rowid
       WHERE governance_actions_fts MATCH ?`,
    )
    .bind(match)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

describe('governance_actions FTS triggers', () => {
  it('indexes a new action and matches a prefix of an abstract term', async () => {
    await seedGa({ title: 'Increase treasury cap', abstract: 'Raise the net change limit.' });
    expect(await gaFtsMatch('"treas"*')).toEqual([GA_ID]);
    expect(await gaFtsMatch('"net" "change"')).toEqual([GA_ID]);
  });

  it('follows a metadata update', async () => {
    await seedGa({ title: 'Old title here' });
    await db()
      .prepare('UPDATE governance_actions SET title = ?, abstract = ?, rationale_html = ?, meta_version = 2 WHERE id = ?')
      .bind('Completely new words', 'fresh abstract', null, GA_ID)
      .run();
    expect(await gaFtsMatch('"old"')).toEqual([]);
    expect(await gaFtsMatch('"completely"')).toEqual([GA_ID]);
  });

  it('drops a deleted row from the index', async () => {
    await seedGa({ title: 'Ephemeral action' });
    await db().prepare('DELETE FROM governance_actions WHERE id = ?').bind(GA_ID).run();
    expect(await gaFtsMatch('"ephemeral"')).toEqual([]);
  });

  it('tally-only updates write fewer rows than metadata updates (trigger scoping)', async () => {
    await seedGa({ title: 'Scoped trigger check' });
    const tally = await db()
      .prepare('UPDATE governance_actions SET drep_yes = 5, last_synced_at = ? WHERE id = ?')
      .bind(NOW + 1, GA_ID)
      .run();
    const meta = await db()
      .prepare('UPDATE governance_actions SET title = ? WHERE id = ?')
      .bind('Renamed for scope test', GA_ID)
      .run();
    // The metadata update fires the FTS delete+insert pair (shadow-table
    // writes); the tally update must not. Comparative assertion so the exact
    // shadow-write count never matters.
    expect(meta.meta.rows_written).toBeGreaterThan(tally.meta.rows_written);
  });
});

describe('topics and posts FTS triggers', () => {
  it('indexes topic titles and post bodies on insert', async () => {
    await db()
      .prepare(
        `INSERT INTO topics (id, category_slug, author_id, source, title, slug, post_count, last_post_at, created_at)
         VALUES ('top1', 'general', 'system', 'user', 'Wonderful governance debate', 'wonderful-debate', 1, ?, ?)`,
      )
      .bind(NOW, NOW)
      .run();
    await db()
      .prepare(
        `INSERT INTO posts (id, topic_id, author_id, body_md, body_html, created_at)
         VALUES ('post1', 'top1', 'system', 'I disagree about the treasury.', '<p>I disagree about the treasury.</p>', ?)`,
      )
      .bind(NOW)
      .run();

    const topics = await db()
      .prepare('SELECT rowid FROM topics_fts WHERE topics_fts MATCH ?')
      .bind('"wonderful"')
      .all();
    const posts = await db()
      .prepare('SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?')
      .bind('"disagree"')
      .all();
    expect(topics.results).toHaveLength(1);
    expect(posts.results).toHaveLength(1);
  });
});
