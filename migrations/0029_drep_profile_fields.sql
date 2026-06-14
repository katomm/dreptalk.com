-- Additional editable CIP-119 profile fields, round-tripped on-chain.
-- do_not_list is stored but NOT honored by the /dreps listing (round-trip only).
ALTER TABLE dreps ADD COLUMN motivations TEXT;
ALTER TABLE dreps ADD COLUMN qualifications TEXT;
ALTER TABLE dreps ADD COLUMN payment_address TEXT;
ALTER TABLE dreps ADD COLUMN do_not_list INTEGER NOT NULL DEFAULT 0;
