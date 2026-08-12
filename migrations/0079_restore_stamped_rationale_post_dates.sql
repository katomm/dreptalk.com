-- One-time repair of vote-rationale cross-posts whose date was overwritten by the
-- governance post-date backfill. That sweep identified a governance topic's opening
-- post as the topic's oldest post, but a cross-post is top-level too and is dated at
-- the moment its DRep submitted the vote, so a cross-post that happened to predate
-- the opening post was stamped with the action's submission time instead. The sweep
-- now identifies the opening post by authorship and can no longer reach a cross-post,
-- but the dates it already moved stay wrong on their own: the stamp also moved each
-- topic to its target, so the sweep reads those topics as corrected and never
-- revisits them.
--
-- The original creation time is gone from the row, and these posts are old enough to
-- have no activity event to recover it from, so each is restored to its vote's
-- on-chain block_time. That is the vote time the post reports on its face, and it
-- sits within seconds of the wall-clock value that was overwritten (a cross-post is
-- written when the DRep submits, the block follows shortly after).
-- drep_votes.block_time is unix seconds while posts.created_at is unix milliseconds.
--
-- Self-selecting, so it is safe to run on every network. It matches only a cross-post
-- carrying its topic's exact date, which is the stamp's signature: a topic date is
-- always whole-second (a block time or an epoch start) while a real cross-post date
-- carries milliseconds. Mainnet holds no such row, since its actions all have an
-- exact block_time and the opening post therefore always predates any vote, so this
-- is a no-op there. The block_time <> created_at term keeps a re-run from writing.
UPDATE posts
SET created_at = (
  SELECT v.block_time * 1000
    FROM topics t
    JOIN users u ON u.id = posts.author_id
    JOIN governance_actions g ON g.topic_id = t.id
    JOIN drep_votes v ON v.ga_id = g.id AND v.voter_id = u.drep_id
   WHERE t.id = posts.topic_id AND v.block_time IS NOT NULL
)
WHERE source = 'vote_rationale'
  AND EXISTS (
    SELECT 1
      FROM topics t
      JOIN users u ON u.id = posts.author_id
      JOIN governance_actions g ON g.topic_id = t.id
      JOIN drep_votes v ON v.ga_id = g.id AND v.voter_id = u.drep_id
     WHERE t.id = posts.topic_id
       AND t.source = 'governance'
       AND posts.created_at = t.created_at
       AND v.block_time IS NOT NULL
       AND v.block_time * 1000 <> posts.created_at
  );
