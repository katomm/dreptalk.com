-- Full-text search over vote-rationale text. body_text is plain text stripped
-- from the sanitized body_html (there is no other plain-text form; vote_rationale
-- holds canonical CIP-100 JSON, not display text). NOT NULL DEFAULT '' so every
-- row has a defined, indexed value: the external-content _au trigger deletes the
-- OLD value from the index before inserting the new one, and deleting a rowid that
-- was never indexed corrupts FTS5. The seed at the bottom registers every existing
-- row (as an empty document), so the later body_text backfill's ''->text UPDATE
-- has a valid old entry to delete.
ALTER TABLE action_rationale ADD COLUMN body_text TEXT NOT NULL DEFAULT '';

CREATE VIRTUAL TABLE action_rationale_fts USING fts5(
  body_text,
  content='action_rationale',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2',
  prefix='2 3'
);

CREATE TRIGGER action_rationale_fts_ai AFTER INSERT ON action_rationale BEGIN
  INSERT INTO action_rationale_fts(rowid, body_text) VALUES (new.rowid, new.body_text);
END;
CREATE TRIGGER action_rationale_fts_au AFTER UPDATE OF body_text ON action_rationale
WHEN old.body_text IS NOT new.body_text
BEGIN
  INSERT INTO action_rationale_fts(action_rationale_fts, rowid, body_text) VALUES ('delete', old.rowid, old.body_text);
  INSERT INTO action_rationale_fts(rowid, body_text) VALUES (new.rowid, new.body_text);
END;
CREATE TRIGGER action_rationale_fts_ad AFTER DELETE ON action_rationale BEGIN
  INSERT INTO action_rationale_fts(action_rationale_fts, rowid, body_text) VALUES ('delete', old.rowid, old.body_text);
END;

INSERT INTO action_rationale_fts(rowid, body_text)
  SELECT rowid, body_text FROM action_rationale;
