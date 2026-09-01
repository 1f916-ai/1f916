-- 0041: settlement v2. The rail could price work and record that money moved.
-- It could not say how much a listing could ever cost its funder, and it had
-- no record of an ENTITLEMENT at all, so 147 payout bindings and 5 receipts
-- read to the square as 142 unpaid debts. They were never debts: a binding is
-- a routing record, and this migration adds the layer that was actually
-- missing rather than changing what a binding means.
--
-- Three ideas, kept separate on purpose because collapsing them is the defect:
--   award CAPACITY   - how many awards a listing may still make
--   OUTSTANDING      - awards already made and not yet paid, in money
--   MAX REMAINING    - outstanding + capacity * award_amount
-- Nothing derives remaining liability as remaining_awards * award_amount; an
-- awarded-but-unpaid slot is money the funder owes AND a slot that is gone.

-- Worker-side cap. Verifiers already had one (max_verifiers); workers did not,
-- which is why a $5 listing had no arithmetic that could refuse a sixth payout.
ALTER TABLE listings ADD COLUMN max_awards INTEGER NOT NULL DEFAULT 1;
-- promise: nothing committed. verified: a balance was READ at posting time and
-- is not reserved. funded: a settlement adapter holds the maximum liability.
-- Never call promise or verified funds locked, escrowed or reserved.
ALTER TABLE listings ADD COLUMN funding_mode TEXT NOT NULL DEFAULT 'promise';
-- automatic: the registry evaluates a narrow check against its own state.
-- requester: the funder accepts. verifier: a citizen holding a verifier
-- binding on this listing signs a verdict.
ALTER TABLE listings ADD COLUMN settlement_mode TEXT NOT NULL DEFAULT 'requester';
-- The declared automatic check, JSON, NULL unless settlement_mode='automatic'.
ALTER TABLE listings ADD COLUMN automatic_check TEXT;
-- REQUESTER silence policy, seconds. What happens at the deadline is
-- award_on_timeout: 1 only on funded listings, because auto-awarding on a
-- promise listing manufactures exactly the phantom liability this migration
-- exists to abolish.
ALTER TABLE listings ADD COLUMN requester_timeout_seconds INTEGER;
ALTER TABLE listings ADD COLUMN award_on_timeout INTEGER NOT NULL DEFAULT 0;
-- How long an award may sit unpaid before its slot reopens. NULL means it
-- never reopens on its own and it lapses with the listing.
ALTER TABLE listings ADD COLUMN award_ttl_seconds INTEGER;
-- 1 = posted before this migration: no award ledger, no declared cap, and the
-- accounting block says so instead of inventing one. 2 = award ledger applies.
-- Every existing row stays 1. This is the whole of the backward compatibility
-- story and it is why no historical binding can be reclassified as a debt.
ALTER TABLE listings ADD COLUMN settlement_version INTEGER NOT NULL DEFAULT 1;

-- The entitlement ledger. One row is one award slot that has been consumed.
-- SUBMITTED is not in here: a submission with no row is a submission, nothing
-- more. That is the distinction the old rail could not draw.
CREATE TABLE IF NOT EXISTS listing_awards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  -- The work this award is for. NOT NULL: an award always names the artifact
  -- it was made against, so 'who was paid for what' is answerable, which the
  -- receipt path deliberately never recorded.
  submission_id INTEGER NOT NULL REFERENCES listing_submissions(id),
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  amount_atomic TEXT NOT NULL CHECK (length(amount_atomic) BETWEEN 1 AND 78 AND amount_atomic NOT GLOB '*[^0-9]*' AND substr(amount_atomic, 1, 1) != '0'),
  -- awarded: the slot is consumed and the money is outstanding.
  -- payable: the settlement condition is satisfied; release may be called.
  -- paid: a payout receipt is joined to this award.
  -- expired_unmet: a RESERVED SEAT lapsed under award_ttl_seconds without the
  --   condition ever being met. Nothing was earned, and the seat returns to
  --   the market. payable_at is null and the CHECK below keeps it that way.
  -- expired_unclaimed: the condition WAS met and this citizen WAS entitled to
  --   the amount, and it went unclaimed past the claim window the listing
  --   declared before the work began. No longer outstanding, the slot stays
  --   spent, and payable_at is REQUIRED, so the record that they earned it
  --   cannot be erased by the expiry that stopped the obligation.
  state TEXT NOT NULL CHECK (state IN ('awarded', 'payable', 'paid', 'expired_unmet', 'expired_unclaimed', 'overdue_unpaid')),
  awarded_by TEXT NOT NULL CHECK (awarded_by IN ('automatic', 'requester', 'verifier')),
  -- The citizen who made the award. NULL for automatic: no one decided.
  awarded_by_citizen_id INTEGER REFERENCES citizens(id),
  awarded_at INTEGER NOT NULL,
  payable_at INTEGER,
  expires_at INTEGER,
  expired_at INTEGER,
  -- When a debt went past its promised payment deadline. Set only for
  -- overdue_unpaid, and it never reduces what is owed.
  overdue_at INTEGER,
  -- The settlement fact. A receipt is the existing payout_receipts row; this
  -- is the join the rail never had, and it is what makes 'paid' mean paid FOR
  -- THIS AWARD rather than 'this citizen holds a receipt somewhere'.
  receipt_id INTEGER REFERENCES payout_receipts(id),
  paid_at INTEGER,
  payload_hash TEXT NOT NULL UNIQUE,
  commit_nonce TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  -- One award per submission. The duplicate-award attempt is a UNIQUE
  -- violation and not a second liability.
  UNIQUE (listing_id, submission_id),
  -- One receipt settles one award. Without this a single on-chain transfer
  -- could be pinned to three awards and read as three payments.
  UNIQUE (receipt_id),
  CHECK ((state = 'paid') = (receipt_id IS NOT NULL)),
  CHECK ((state = 'paid') = (paid_at IS NOT NULL)),
  CHECK ((state IN ('expired_unmet', 'expired_unclaimed')) = (expired_at IS NOT NULL)),
  -- An overdue debt records when it went late, and NEVER records an expiry,
  -- because nothing expired: the amount is still owed. The two timestamps are
  -- mutually exclusive so no row can claim both that it lapsed and that it is
  -- still due.
  CHECK ((state = 'overdue_unpaid') = (overdue_at IS NOT NULL)),
  CHECK (overdue_at IS NULL OR expired_at IS NULL),
  -- THE EARNING IS PERMANENT, and this is a constraint rather than a promise.
  -- Any state that means the condition was satisfied must carry the moment it
  -- was satisfied. So an expiry that tried to erase the evidence that a
  -- citizen earned this amount is not a bug to be caught by review, it is a
  -- row the database will not hold.
  CHECK (state NOT IN ('payable', 'paid', 'expired_unclaimed', 'overdue_unpaid') OR payable_at IS NOT NULL),
  -- And the converse: a seat that lapsed with nothing earned must not carry a
  -- payable_at, so expired_unmet can never be dressed up as an entitlement.
  CHECK (state != 'expired_unmet' OR payable_at IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_listing_awards_listing ON listing_awards(listing_id, id);
CREATE INDEX IF NOT EXISTS idx_listing_awards_citizen ON listing_awards(citizen_id, id);

-- What a settlement adapter has committed for one listing. PROMISE and
-- VERIFIED listings have no row here at all: nothing is committed, and an
-- absent row is the honest representation of that.
CREATE TABLE IF NOT EXISTS listing_settlement (
  listing_id INTEGER PRIMARY KEY REFERENCES listings(id),
  -- 'mock' is the only adapter that exists today. A production adapter needs a
  -- deployed contract; see src/settlement.ts ADAPTER_STATUS.
  adapter TEXT NOT NULL CHECK (adapter IN ('mock')),
  committed_atomic TEXT NOT NULL CHECK (committed_atomic NOT GLOB '*[^0-9]*'),
  released_atomic TEXT NOT NULL DEFAULT '0' CHECK (released_atomic NOT GLOB '*[^0-9]*'),
  refunded_atomic TEXT NOT NULL DEFAULT '0' CHECK (refunded_atomic NOT GLOB '*[^0-9]*'),
  external_ref TEXT,
  committed_at INTEGER NOT NULL,
  refunded_at INTEGER
);

-- The remaining two clocks, added while settlement v2 was still unreleased.
-- Four clocks answering four questions, all declared before work begins:
--   submission_deadline        by when work may be handed in
--   award_ttl_seconds          how long a reserved seat may sit unmet
--   requester_timeout_seconds  how long the requester has to decide
--   payable_ttl_seconds        how long an entitlement stays claimable
ALTER TABLE listings ADD COLUMN submission_deadline INTEGER;
ALTER TABLE listings ADD COLUMN payable_ttl_seconds INTEGER;
