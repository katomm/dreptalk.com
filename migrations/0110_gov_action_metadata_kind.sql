-- What a gov_action_metadata row hosts: 'cip108' for InfoAction metadata
-- documents, 'constitution' for NewConstitution documents. Hash stays the
-- key, so a constitution and a metadata document with identical bytes are
-- still one row, and kind is informational only, never part of the dedup.
ALTER TABLE gov_action_metadata ADD COLUMN kind TEXT NOT NULL DEFAULT 'cip108';
