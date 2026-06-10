-- Full-text search (SQLite FTS5, external-content pattern).
-- One FTS table per searched entity. The source tables keep the text; the FTS
-- tables hold only the inverted index and read row content through content=.
-- Triggers keep the index in sync inside the same transaction as the source
-- write, so rows are searchable the moment they commit and no app write path
-- changes. Update triggers are scoped to the indexed columns AND guarded on a
-- real value change, so the frequent tally/voting-power sync updates never
-- write to the index (D1 bills rows written).
-- prefix='2 3' additionally indexes 2- and 3-char token prefixes: the search
-- typeahead always sends a trailing prefix query, and short prefixes are the
-- expensive case without it. The option is part of the table definition;
-- adding it later would require an index rebuild.

CREATE VIRTUAL TABLE governance_actions_fts USING fts5(
  title, abstract,
  content='governance_actions',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2',
  prefix='2 3'
);

CREATE TRIGGER governance_actions_fts_ai AFTER INSERT ON governance_actions BEGIN
  INSERT INTO governance_actions_fts(rowid, title, abstract)
  VALUES (new.rowid, new.title, new.abstract);
END;

CREATE TRIGGER governance_actions_fts_au AFTER UPDATE OF title, abstract ON governance_actions
WHEN old.title IS NOT new.title OR old.abstract IS NOT new.abstract
BEGIN
  INSERT INTO governance_actions_fts(governance_actions_fts, rowid, title, abstract)
  VALUES ('delete', old.rowid, old.title, old.abstract);
  INSERT INTO governance_actions_fts(rowid, title, abstract)
  VALUES (new.rowid, new.title, new.abstract);
END;

CREATE TRIGGER governance_actions_fts_ad AFTER DELETE ON governance_actions BEGIN
  INSERT INTO governance_actions_fts(governance_actions_fts, rowid, title, abstract)
  VALUES ('delete', old.rowid, old.title, old.abstract);
END;

CREATE VIRTUAL TABLE topics_fts USING fts5(
  title,
  content='topics',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2',
  prefix='2 3'
);

CREATE TRIGGER topics_fts_ai AFTER INSERT ON topics BEGIN
  INSERT INTO topics_fts(rowid, title) VALUES (new.rowid, new.title);
END;

CREATE TRIGGER topics_fts_au AFTER UPDATE OF title ON topics
WHEN old.title IS NOT new.title
BEGIN
  INSERT INTO topics_fts(topics_fts, rowid, title) VALUES ('delete', old.rowid, old.title);
  INSERT INTO topics_fts(rowid, title) VALUES (new.rowid, new.title);
END;

CREATE TRIGGER topics_fts_ad AFTER DELETE ON topics BEGIN
  INSERT INTO topics_fts(topics_fts, rowid, title) VALUES ('delete', old.rowid, old.title);
END;

CREATE VIRTUAL TABLE posts_fts USING fts5(
  body_md,
  content='posts',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2',
  prefix='2 3'
);

CREATE TRIGGER posts_fts_ai AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts(rowid, body_md) VALUES (new.rowid, new.body_md);
END;

CREATE TRIGGER posts_fts_au AFTER UPDATE OF body_md ON posts
WHEN old.body_md IS NOT new.body_md
BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, body_md) VALUES ('delete', old.rowid, old.body_md);
  INSERT INTO posts_fts(rowid, body_md) VALUES (new.rowid, new.body_md);
END;

CREATE TRIGGER posts_fts_ad AFTER DELETE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, body_md) VALUES ('delete', old.rowid, old.body_md);
END;

CREATE VIRTUAL TABLE dreps_fts USING fts5(
  name, bio,
  content='dreps',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2',
  prefix='2 3'
);

CREATE TRIGGER dreps_fts_ai AFTER INSERT ON dreps BEGIN
  INSERT INTO dreps_fts(rowid, name, bio) VALUES (new.rowid, new.name, new.bio);
END;

CREATE TRIGGER dreps_fts_au AFTER UPDATE OF name, bio ON dreps
WHEN old.name IS NOT new.name OR old.bio IS NOT new.bio
BEGIN
  INSERT INTO dreps_fts(dreps_fts, rowid, name, bio) VALUES ('delete', old.rowid, old.name, old.bio);
  INSERT INTO dreps_fts(rowid, name, bio) VALUES (new.rowid, new.name, new.bio);
END;

CREATE TRIGGER dreps_fts_ad AFTER DELETE ON dreps BEGIN
  INSERT INTO dreps_fts(dreps_fts, rowid, name, bio) VALUES ('delete', old.rowid, old.name, old.bio);
END;

-- Backfill existing rows.
INSERT INTO governance_actions_fts(rowid, title, abstract)
  SELECT rowid, title, abstract FROM governance_actions;
INSERT INTO topics_fts(rowid, title)
  SELECT rowid, title FROM topics;
INSERT INTO posts_fts(rowid, body_md)
  SELECT rowid, body_md FROM posts;
INSERT INTO dreps_fts(rowid, name, bio)
  SELECT rowid, name, bio FROM dreps;
