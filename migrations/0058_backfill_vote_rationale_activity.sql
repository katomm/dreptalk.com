-- Backfill activity feed events for opted-in vote_rationale cross-posts.
--
-- Cross-posting a vote rationale into a discussion is opt-in: a live
-- vote_rationale post exists only because a DRep chose to show it there. Until
-- now the upsert never wrote an activity row, so these posts were missing from
-- the "Latest activity" feed even though they are real, counted posts in the
-- thread. Going forward the upsert emits the event itself; this backfills the
-- ones already in the database.
--
-- The id reuses the 0030 'reply_created:<post-id>' convention, so the row is
-- idempotent (the same id can never be inserted twice) and the NOT EXISTS guard
-- avoids duplicating an event should one already exist. Only live posts in live
-- topics are surfaced; opted-out (deleted) cross-posts stay out of the feed.
INSERT INTO activity (id, type, actor_id, topic_id, ref_post_id, payload, created_at)
SELECT 'reply_created:' || p.id, 'reply_created', p.author_id, p.topic_id, p.id, NULL, p.created_at
FROM posts p
JOIN topics t ON t.id = p.topic_id
WHERE p.source = 'vote_rationale' AND p.deleted = 0 AND t.deleted = 0
  AND NOT EXISTS (
    SELECT 1 FROM activity a WHERE a.type = 'reply_created' AND a.ref_post_id = p.id
  );
