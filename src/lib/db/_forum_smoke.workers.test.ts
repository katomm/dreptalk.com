// Smoke test: verifies that the 0002_forum migration created the topics and
// posts tables and that parameterized inserts and reads work correctly.
import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('forum tables smoke test', () => {
  it('inserts and reads back a topics row', async () => {
    const now = Date.now();
    const id = `smoke-topic-${now}`;
    const slug = `smoke-topic-slug-${now}`;

    await env.DB
      .prepare(
        `INSERT INTO topics
           (id, category_slug, author_id, source, title, slug, last_post_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, 'general', 'system', 'user', 'Smoke Topic Title', slug, now, now)
      .run();

    const row = await env.DB
      .prepare('SELECT id, category_slug, title, slug, pinned, locked, deleted, post_count FROM topics WHERE id = ?')
      .bind(id)
      .first<{
        id: string;
        category_slug: string;
        title: string;
        slug: string;
        pinned: number;
        locked: number;
        deleted: number;
        post_count: number;
      }>();

    expect(row).not.toBeNull();
    expect(row!.id).toBe(id);
    expect(row!.category_slug).toBe('general');
    expect(row!.title).toBe('Smoke Topic Title');
    expect(row!.slug).toBe(slug);
    expect(row!.pinned).toBe(0);
    expect(row!.locked).toBe(0);
    expect(row!.deleted).toBe(0);
    expect(row!.post_count).toBe(0);
  });

  it('inserts and reads back a posts row', async () => {
    const now = Date.now();
    const topicId = `smoke-topic-for-post-${now}`;
    const topicSlug = `smoke-topic-for-post-slug-${now}`;
    const postId = `smoke-post-${now}`;

    // Insert a parent topic first to satisfy foreign key conventions.
    await env.DB
      .prepare(
        `INSERT INTO topics
           (id, category_slug, author_id, source, title, slug, last_post_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(topicId, 'general', 'system', 'user', 'Parent Topic', topicSlug, now, now)
      .run();

    await env.DB
      .prepare(
        `INSERT INTO posts
           (id, topic_id, author_id, body_md, body_html, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(postId, topicId, 'system', '**Hello**', '<p><strong>Hello</strong></p>', now)
      .run();

    const row = await env.DB
      .prepare(
        `SELECT id, topic_id, author_id, body_md, body_html,
                up_count, down_count, flag_count, deleted, created_at
         FROM posts WHERE id = ?`,
      )
      .bind(postId)
      .first<{
        id: string;
        topic_id: string;
        author_id: string;
        body_md: string;
        body_html: string;
        up_count: number;
        down_count: number;
        flag_count: number;
        deleted: number;
        created_at: number;
      }>();

    expect(row).not.toBeNull();
    expect(row!.id).toBe(postId);
    expect(row!.topic_id).toBe(topicId);
    expect(row!.author_id).toBe('system');
    expect(row!.body_md).toBe('**Hello**');
    expect(row!.body_html).toBe('<p><strong>Hello</strong></p>');
    expect(row!.up_count).toBe(0);
    expect(row!.down_count).toBe(0);
    expect(row!.flag_count).toBe(0);
    expect(row!.deleted).toBe(0);
  });
});
