-- 0031: listings, the funder-side object of the payout rail.
-- Any citizen posts a task with its acceptance condition, amount and expiry;
-- a payee binds against listing-<id> the way #103 binds against a docket id.
-- Immutable once posted; a bad listing expires, it is not edited.
CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  condition TEXT NOT NULL CHECK (length(condition) BETWEEN 40 AND 8000),
  amount_atomic TEXT NOT NULL CHECK (length(amount_atomic) BETWEEN 1 AND 78 AND amount_atomic NOT GLOB '*[^0-9]*' AND substr(amount_atomic, 1, 1) != '0'),
  -- Optional second price for a citizen who is neither funder nor worker and
  -- re-runs the condition. Same fee for pass and fail. NULL means unpaid.
  verifier_price_atomic TEXT CHECK (verifier_price_atomic IS NULL OR (length(verifier_price_atomic) BETWEEN 1 AND 78 AND verifier_price_atomic NOT GLOB '*[^0-9]*' AND substr(verifier_price_atomic, 1, 1) != '0')),
  max_verifiers INTEGER NOT NULL DEFAULT 0 CHECK (max_verifiers BETWEEN 0 AND 10 AND ((max_verifiers = 0) = (verifier_price_atomic IS NULL))),
  chain_id INTEGER NOT NULL CHECK (chain_id = 8453),
  token TEXT NOT NULL CHECK (token = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'),
  expiry INTEGER NOT NULL,
  -- Proof of funds, optional: the paying wallet, proven by EIP-191 signature
  -- over the listing preimage, and its USDC balance as two agreeing providers
  -- reported it at posting time. A snapshot, never a hold. When named, every
  -- receipt on the listing must come from this address.
  funder_address TEXT CHECK (funder_address IS NULL OR (length(funder_address) = 42 AND funder_address = lower(funder_address))),
  funder_signature TEXT CHECK (funder_signature IS NULL OR length(funder_signature) = 132),
  funds_seen_atomic TEXT CHECK (funds_seen_atomic IS NULL OR funds_seen_atomic NOT GLOB '*[^0-9]*'),
  funds_checked_at INTEGER,
  funds_block_number INTEGER,
  payload_hash TEXT NOT NULL UNIQUE,
  commit_nonce TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  -- The two ways a listing stops: its funder withdraws it (public reason,
  -- chained), or the maintainer moderates it like a post (mod_state, logged
  -- under kind 'moderation' and replayable at /api/moderation-state). Neither
  -- edits the listing; the payload hash still commits to what was posted.
  withdrawn_at INTEGER,
  withdraw_reason TEXT CHECK (withdraw_reason IS NULL OR length(withdraw_reason) BETWEEN 3 AND 1000),
  mod_state TEXT CHECK (mod_state IS NULL OR mod_state IN ('collapsed', 'removed')),
  -- The listing's discussion thread: a post under the funder's name, tagged
  -- bounty, cap-exempt (it is the listing's own room, not the funder's daily
  -- post). Written right after the listing commits; NULL only if that write
  -- failed, in which case the listing still stands and says so.
  post_id INTEGER REFERENCES posts(id),
  CHECK ((funder_address IS NULL) = (funder_signature IS NULL) AND (funder_address IS NULL) = (funds_seen_atomic IS NULL)),
  CHECK ((withdrawn_at IS NULL) = (withdraw_reason IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_listings_citizen ON listings(citizen_id, created_at);
CREATE INDEX IF NOT EXISTS idx_listings_expiry ON listings(expiry, id);

-- Submissions: work handed in against an open listing. No claiming and no
-- assignment: while a listing is open anyone may submit, and the funder picks
-- whom to pay by paying them. A submission is also the record that someone
-- delivered, whether or not a receipt ever follows.
CREATE TABLE IF NOT EXISTS listing_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  artifact TEXT NOT NULL CHECK (length(artifact) BETWEEN 8 AND 2000),
  note TEXT CHECK (note IS NULL OR length(note) <= 4000),
  payload_hash TEXT NOT NULL UNIQUE,
  commit_nonce TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_listing_submissions_listing ON listing_submissions(listing_id, id);
CREATE INDEX IF NOT EXISTS idx_listing_submissions_citizen ON listing_submissions(citizen_id, created_at);
