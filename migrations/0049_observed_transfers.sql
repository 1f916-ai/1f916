-- 0049: paid is observed, not filed.
--
-- Measured 2026-09-08 (RAIL-LEAK-RESEARCH): 26 real USDC payments from
-- funder wallets to bound payout addresses since 08-16, and 8 receipts.
-- The other 18 were invisible because a receipt needs the payer's signed
-- statement, which payees could not get (c17257, c17934). The rail published
-- $1.20 of outside money paid; the chain says $7.15.
--
-- So the cron now reads the chain itself. For every wallet a listing names
-- as its funder, it walks the USDC Transfer logs from that wallet, requires
-- two independently operated providers to return the SAME logs for the same
-- block range, and records each transfer. A transfer to an address some
-- citizen bound on one of that funder's listings is an OBSERVED PAYMENT:
-- weaker than a receipt (no funder statement, no chosen log index) and
-- served as its own tier, never as a receipt. A zero-value transfer to any
-- address is recorded as poisoning evidence (70 such rows found on 2026-09-08,
-- 63 against the treasury's funding wallet), so the funder's own page can
-- warn them.
CREATE TABLE IF NOT EXISTS observed_transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  funder_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  token TEXT NOT NULL,
  amount_atomic TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  -- 'payment': to an address bound by a citizen on one of this funder's
  -- listings (binding_id/listing_id/citizen_id filled). 'zero_value': the
  -- poisoning pattern. 'other': a real transfer to an address the rail does
  -- not know; recorded so the funder's spend is a complete series.
  kind TEXT NOT NULL CHECK (kind IN ('payment', 'zero_value', 'other')),
  binding_id INTEGER REFERENCES payout_bindings(id),
  listing_id INTEGER REFERENCES listings(id),
  citizen_id INTEGER REFERENCES citizens(id),
  sources INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  UNIQUE (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_observed_transfers_funder ON observed_transfers(funder_address, block_number);
CREATE INDEX IF NOT EXISTS idx_observed_transfers_listing ON observed_transfers(listing_id, id);
CREATE INDEX IF NOT EXISTS idx_observed_transfers_binding ON observed_transfers(binding_id);
-- One row per watched wallet: the last block the observer has walked past.
CREATE TABLE IF NOT EXISTS observer_marks (
  funder_address TEXT PRIMARY KEY,
  -- NULL until the first successful walk: the start rule (block at the
  -- funder's earliest listing, minus a margin) applies until then. A failed
  -- cycle must never set this to 0, or the next cycle walks from genesis.
  last_block INTEGER,
  updated_at INTEGER NOT NULL,
  last_error TEXT,
  -- The last range actually walked and how many rows it held, served so a
  -- reader can see a walk that stalls or a range that agreed on nothing, and
  -- so a maintainer can rewind last_block by hand if a range was lost.
  last_range_from INTEGER,
  last_range_to INTEGER,
  last_range_rows INTEGER
);
