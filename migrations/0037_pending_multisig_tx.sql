-- Server-side coordination of multisig (native-script) DRep transactions.
-- Records are small and short-lived, bounded by the tx validity interval.
CREATE TABLE pending_multisig_tx (
  id               TEXT PRIMARY KEY,           -- shareable token (also the link id)
  drep_id          TEXT NOT NULL,              -- the script DRep this acts for
  action           TEXT NOT NULL,              -- 'vote' (update/retire are future)
  action_params    TEXT NOT NULL,              -- json: { gaId, vote, anchorUrl?, anchorHashHex? }
  unsigned_tx_cbor TEXT NOT NULL,              -- the unsigned tx hex
  body_hash        TEXT NOT NULL,              -- 64-hex blake2b-256 of the tx body, signed by each witness
  native_script    TEXT NOT NULL,              -- json native script tree
  witnesses        TEXT NOT NULL DEFAULT '[]', -- json array of { key_hash, witness_hex }
  status           TEXT NOT NULL DEFAULT 'collecting', -- collecting | submitted | expired
  tx_hash          TEXT,                       -- set on submit
  created_by       TEXT NOT NULL,              -- user id
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL
);

CREATE INDEX pending_multisig_tx_drep ON pending_multisig_tx (drep_id, status);
