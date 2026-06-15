-- Append only forum activity event log. One row per event (new topic, reply,
-- new governance action, governance status change). The "Latest activity" feed
-- on the homepage and /discussions reads the newest N rows from here.
--
-- Deliberately no denormalized title/category: those would go stale on rename,
-- and the feed hydrates the topic at read time anyway. topic_id is enough to
-- resolve the governance action (via governance_actions.topic_id). payload is
-- NULL for everything except gov_status, where it carries {"from":..,"to":..}.
CREATE TABLE activity (
  id          TEXT PRIMARY KEY,   -- runtime: crypto.randomUUID(); backfill: '<type>:<rowid>'
  type        TEXT NOT NULL,      -- 'topic_created' | 'reply_created' | 'gov_created' | 'gov_status'
  actor_id    TEXT,               -- author wallet/user id; NULL for system events (gov_created, gov_status)
  topic_id    TEXT NOT NULL,
  ref_post_id TEXT,               -- the reply post id for reply_created (deep link); NULL otherwise
  payload     TEXT,               -- JSON; gov_status: {"from":"active","to":"enacted"}; NULL otherwise
  created_at  INTEGER NOT NULL
);

-- The feed's only access pattern: newest first.
CREATE INDEX idx_activity_created ON activity(created_at DESC);

-- Backfill: user-created topics become topic_created events.
INSERT INTO activity (id, type, actor_id, topic_id, ref_post_id, payload, created_at)
SELECT 'topic_created:' || id, 'topic_created', author_id, id, NULL, NULL, created_at
FROM topics
WHERE source = 'user' AND deleted = 0;

-- Backfill: governance topics become gov_created events (system, no actor).
INSERT INTO activity (id, type, actor_id, topic_id, ref_post_id, payload, created_at)
SELECT 'gov_created:' || id, 'gov_created', NULL, id, NULL, NULL, created_at
FROM topics
WHERE source = 'governance' AND deleted = 0;

-- Backfill: every post EXCEPT its topic's opening post becomes a reply_created
-- event. The opening post is the earliest post per topic (created in the same
-- batch as the topic). The created_at ASC, id ASC tiebreaker picks a single
-- deterministic opener even when two posts share a timestamp. Deleted/hidden
-- posts and posts in deleted topics are excluded.
INSERT INTO activity (id, type, actor_id, topic_id, ref_post_id, payload, created_at)
SELECT 'reply_created:' || p.id, 'reply_created', p.author_id, p.topic_id, p.id, NULL, p.created_at
FROM posts p
JOIN topics t ON t.id = p.topic_id
WHERE p.deleted = 0 AND p.hidden = 0 AND t.deleted = 0
  AND p.id <> (
    SELECT id FROM posts
    WHERE topic_id = p.topic_id
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  );
