-- CIP-108 body.references (label + uri) from the action's anchor document.
-- Stored as a JSON array of {label, uri} so the detail page can list the
-- proposer's own supporting links. NULL when the document carries none, when
-- the anchor never resolved, or while the row predates the extractor bump.
-- "references" is a SQLite keyword, hence the _json suffix.
ALTER TABLE governance_actions ADD COLUMN references_json TEXT;
