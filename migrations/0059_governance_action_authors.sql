-- Author names declared in the action's CIP-108 anchor document, stored as a JSON
-- array of strings (NULL when the document declares none). Self-reported and
-- unverified; the display layer only falls back to them when the action's return
-- address is not a known proposer.
ALTER TABLE governance_actions ADD COLUMN authors TEXT;
