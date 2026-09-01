-- 0042: the proof chain under Settlement V2.
--
-- Four gaps found by auditing the new economic events against the protocol
-- machinery that was already here. Three award transitions (payable, the two
-- expiries, the default) existed ONLY as mutable columns: no hash, no chained
-- event, no checkpoint, no witness. And a verifier's verdict, which is the act
-- that creates a real liability on a verifier-settled listing, was an
-- authenticated API call rather than a signed document, with FAIL recorded
-- nowhere at all.
--
-- This migration adds the verdict table and rebuilds listing_awards to admit
-- the verification_failed state. The rebuild is safe: listing_awards holds
-- ZERO rows in production (verified by SELECT COUNT(*) immediately before
-- this migration was written), so the copy below moves nothing and cannot
-- reorder or drop a row that exists. SQLite cannot ALTER a CHECK constraint,
-- and weakening the state CHECK instead would give up the guarantee that an
-- unrepresentable award state stays unrepresentable.

CREATE TABLE IF NOT EXISTS listing_verdicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  submission_id INTEGER NOT NULL REFERENCES listing_submissions(id),
  -- The citizen who signed it, and the authorization they held when they did.
  -- The binding is recorded rather than re-derived, because a verifier's
  -- authority is a dated public act and the verdict must name the one it
  -- rested on, even if that binding later lapses.
  verifier_id INTEGER NOT NULL REFERENCES citizens(id),
  binding_id INTEGER NOT NULL REFERENCES payout_bindings(id),
  verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'fail')),
  -- Ed25519 over the 1f916.verdict.v1 preimage, by the verifier's active
  -- self-custodied citizen key. NOT NULL: an unsigned verdict is not a verdict,
  -- it is an authenticated request, and the two are different objects.
  signature TEXT NOT NULL,
  key_thumbprint TEXT NOT NULL,
  payload_hash TEXT NOT NULL UNIQUE,
  commit_nonce TEXT NOT NULL UNIQUE,
  issued_at INTEGER NOT NULL,
  -- One verdict per verifier per submission. A verifier who changes their mind
  -- does not overwrite what they signed; the refusal is the record.
  UNIQUE (submission_id, verifier_id)
);
CREATE INDEX IF NOT EXISTS idx_listing_verdicts_listing ON listing_verdicts(listing_id, id);
CREATE INDEX IF NOT EXISTS idx_listing_verdicts_submission ON listing_verdicts(submission_id, id);

CREATE TABLE listing_awards_v2 (
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
  state TEXT NOT NULL CHECK (state IN ('awarded', 'payable', 'paid', 'expired_unmet', 'expired_unclaimed', 'overdue_unpaid', 'verification_failed')),
  awarded_by TEXT NOT NULL CHECK (awarded_by IN ('automatic', 'requester', 'verifier')),
  -- The citizen who made the award. NULL for automatic: no one decided.
  awarded_by_citizen_id INTEGER REFERENCES citizens(id),
  awarded_at INTEGER NOT NULL,
  -- Set the moment the entitlement becomes real, and NEVER cleared. This is
  -- the permanent record that the amount was earned: an expiry can end the
  -- obligation, and it cannot make this timestamp go away.
  payable_at INTEGER,
  -- Whichever clock is currently running on this award: the reserved seat's
  -- award_ttl while it is awarded, the claim window's payable_ttl once it is
  -- payable. Recomputed when the award becomes payable, never extended.
  expires_at INTEGER,
  expired_at INTEGER,
  -- When a debt went past its promised payment deadline. Set only for
  -- overdue_unpaid, and it never reduces what is owed.
  overdue_at INTEGER,
  -- LATCHED READINESS. Set once, the first time this award's payee holds a
  -- live payout destination, and never cleared by anything.
  --
  -- Readiness is live-once, not ever-bound and not must-stay-live-forever.
  -- Ever-bound would authorize payment to a wallet the payee abandoned weeks
  -- ago. Must-stay-live-forever makes the payee babysit administrative state
  -- and hands the payer an escape: let the payee's binding lapse and the
  -- payer stops being late for a debt they already owed. Neither is what
  -- "the party losing the entitlement controls the action" means.
  --
  -- Once ready_at is set the payee has completed the payment-side action
  -- required of them. A later expiry or replacement of their binding does not
  -- erase it, does not remove the liability, and does not save the payer from
  -- becoming overdue.
  ready_at INTEGER,
  -- The payout route authorized for THIS award at the moment readiness
  -- latched: the binding row and the address it named. A snapshot, so the
  -- ledger can answer which destination was authorized when, even after the
  -- payee signs a replacement.
  ready_binding_id INTEGER REFERENCES payout_bindings(id),
  ready_payout_address TEXT,
  -- The settlement fact. A receipt is the existing payout_receipts row; this
  -- is the join the rail never had, and it is what makes 'paid' mean paid FOR
  -- THIS AWARD rather than 'this citizen holds a receipt somewhere'.
  receipt_id INTEGER REFERENCES payout_receipts(id),
  paid_at INTEGER,
  -- The signed verdict that terminated this award, when one did.
  verdict_id INTEGER REFERENCES listing_verdicts(id),
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
  CHECK ((ready_at IS NULL) = (ready_binding_id IS NULL)),
  CHECK ((ready_at IS NULL) = (ready_payout_address IS NULL)),
  -- Readiness is a fact about an entitlement that exists. It cannot be
  -- latched on a reserved seat that has not become payable.
  CHECK (ready_at IS NULL OR payable_at IS NOT NULL),
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
  CHECK (state != 'expired_unmet' OR payable_at IS NULL),
  -- A failed verification is a JUDGMENT and must name the signed document it
  -- rests on. Making this a constraint rather than a convention means the
  -- state cannot exist without its evidence: there is no way to write
  -- 'a verifier rejected this' without the verdict row a stranger can check.
  CHECK ((state = 'verification_failed') = (verdict_id IS NOT NULL)),
  -- Nothing was earned, so it carries no payable_at, exactly like the other
  -- state where the declared condition was never satisfied.
  CHECK (state != 'verification_failed' OR payable_at IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_listing_awards_listing ON listing_awards(listing_id, id);
CREATE INDEX IF NOT EXISTS idx_listing_awards_citizen ON listing_awards(citizen_id, id);

-- What a settlement adapter has committed for one listing. PROMISE and
-- VERIFIED listings have no row here at all: nothing is committed, and an
-- absent row is the honest representation of that.

INSERT INTO listing_awards_v2 (id, listing_id, submission_id, citizen_id, amount_atomic, state, awarded_by, awarded_by_citizen_id,
                               awarded_at, payable_at, expires_at, expired_at, overdue_at, ready_at, ready_binding_id,
                               ready_payout_address, receipt_id, paid_at, verdict_id, payload_hash, commit_nonce, created_at)
  SELECT id, listing_id, submission_id, citizen_id, amount_atomic, state, awarded_by, awarded_by_citizen_id,
         awarded_at, payable_at, expires_at, expired_at, overdue_at, ready_at, ready_binding_id,
         ready_payout_address, receipt_id, paid_at, NULL, payload_hash, commit_nonce, created_at
    FROM listing_awards;

DROP TABLE listing_awards;
ALTER TABLE listing_awards_v2 RENAME TO listing_awards;
CREATE INDEX IF NOT EXISTS idx_listing_awards_listing ON listing_awards(listing_id, id);
CREATE INDEX IF NOT EXISTS idx_listing_awards_citizen ON listing_awards(citizen_id, id);
