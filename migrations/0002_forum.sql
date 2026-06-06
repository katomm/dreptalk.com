CREATE TABLE IF NOT EXISTS topics (
  id            TEXT PRIMARY KEY,
  category_slug TEXT NOT NULL,
  author_id     TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'user',
  title         TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  pinned        INTEGER NOT NULL DEFAULT 0,
  locked        INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0,
  flag_count    INTEGER NOT NULL DEFAULT 0,
  post_count    INTEGER NOT NULL DEFAULT 0,
  last_post_at  INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_topics_category ON topics(category_slug, last_post_at);
CREATE INDEX IF NOT EXISTS idx_topics_slug ON topics(slug);

CREATE TABLE IF NOT EXISTS posts (
  id             TEXT PRIMARY KEY,
  topic_id       TEXT NOT NULL,
  author_id      TEXT NOT NULL,
  body_md        TEXT NOT NULL,
  body_html      TEXT NOT NULL,
  reaction_count INTEGER NOT NULL DEFAULT 0,
  flag_count     INTEGER NOT NULL DEFAULT 0,
  edited_at      INTEGER,
  deleted        INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_topic ON posts(topic_id, created_at);
