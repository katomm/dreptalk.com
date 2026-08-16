-- migrations/0080_post_erasure_indexes.sql
-- Indexes for the post erasure sweep (src/lib/db/postErasure.ts). The sweep
-- runs on every cron tick and looks for deleted rows whose retention window has
-- passed. It has one branch per deletion kind, each a range scan over
-- deleted_at restricted to deleted rows, so each branch needs its own index.
--
-- Partial, so they cover only deleted rows and stay small. Each branch states
-- `deleted = 1` explicitly, which is the condition for SQLite to consider a
-- partial index at all.
--
-- Migration 0078 already creates idx_posts_deleted ON posts(id) WHERE deleted = 1.
-- It enumerates deleted posts but cannot serve a range predicate on deleted_at,
-- so it does not replace the first index below. It is deliberately left in
-- place: it is already applied on preprod and belongs to the branch this work is
-- stacked on.
CREATE INDEX IF NOT EXISTS idx_posts_deleted_sweep ON posts(deleted_at) WHERE deleted = 1;
CREATE INDEX IF NOT EXISTS idx_topics_deleted_sweep ON topics(deleted_at) WHERE deleted = 1;
