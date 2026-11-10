-- DRep groups library 0.5.0: keys can resign from the roles whose policy lists them. Every version
-- and the current version on the group row keep the resigned keys of each role as a key hash list
-- (the 28 byte hashes concatenated, ascending). Rows stored before this change had no resign
-- event, so the empty list is their exact value.
ALTER TABLE drep_group_versions ADD COLUMN resigned_control BLOB NOT NULL DEFAULT x'';
ALTER TABLE drep_group_versions ADD COLUMN resigned_admission BLOB NOT NULL DEFAULT x'';
ALTER TABLE drep_groups ADD COLUMN resigned_control BLOB NOT NULL DEFAULT x'';
ALTER TABLE drep_groups ADD COLUMN resigned_admission BLOB NOT NULL DEFAULT x'';

-- Progress of the reference script search of a script DRep registration: the index into the sorted
-- list of transactions that produced the registration's inputs and reference inputs.
ALTER TABLE drep_group_ledger ADD COLUMN ref_search_pos INTEGER NOT NULL DEFAULT 0;
