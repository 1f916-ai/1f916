-- Money must be durably claimed BEFORE it is taken (Sirpixelalittle, #33).
--
-- The defect: /api/patron settled at the facilitator (irreversible, real USDC)
-- and only afterwards wrote the ledger row. A Worker eviction, a D1 blip, or
-- any throw in that window left money moved and nothing recorded — no receipt
-- for the patron, no line in the public books, and no way to reconstruct
-- either, because the only record of the payment was the response we never
-- got to write.
--
-- The fix is an intent row written before the settle call. It is the durable
-- claim: if we crash after settling, this row still says a payment for this
-- exact signed payload was in flight, and (once /settle answers) which
-- transaction it became. Reconciliation can then finish the booking instead of
-- the money simply vanishing from the record.
--
-- idem_key is sha256 of the X-PAYMENT header: the same signed authorization
-- always produces the same key, so a retried request is recognised as the
-- payment it already is rather than treated as a second one.
CREATE TABLE IF NOT EXISTS settle_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  idem_key    TEXT NOT NULL UNIQUE,
  -- 'settling' = we are about to take money, or took it and have not finished
  --              booking it (the state a crash leaves behind: reconcile it)
  -- 'booked'   = money taken AND sealed into the ledger; the happy end state
  state       TEXT NOT NULL CHECK (state IN ('settling', 'booked')),
  tx          TEXT,                   -- lowercase; written the instant settle answers
  payer       TEXT,
  inscription TEXT,
  ledger_hash TEXT,                   -- the receipt, once sealed
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
-- The reconciliation read: anything still 'settling' after its grace period is
-- money that may have moved without a ledger line.
CREATE INDEX IF NOT EXISTS idx_settle_attempts_state ON settle_attempts(state, updated_at);

-- Case-folding the transaction reference (Sirpixelalittle, #32).
--
-- SQLite compares TEXT byte-wise, so 0xAB… and 0xab… are different strings and
-- the old unique index let the same on-chain transaction be booked twice under
-- two spellings. Normalise what is already stored (safe: tx is deliberately
-- OUTSIDE the hash preimage, so rewriting it breaks no digest — that property
-- is what makes this migration possible at all), then enforce uniqueness on
-- the folded value.
UPDATE ledger SET tx = lower(tx) WHERE tx IS NOT NULL AND tx <> lower(tx);
DROP INDEX IF EXISTS idx_ledger_tx;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_tx_lower ON ledger(lower(tx)) WHERE tx IS NOT NULL;

-- The bulletin exemption, made real (Sirpixelalittle, #41).
--
-- Rule 7 declares maintainer bulletins exempt from the daily post cap, and the
-- response said "Daily post untouched" — but the row landed in `posts` with no
-- marker, every quota read counted it, and the next ordinary post was refused.
-- Backfilled from the moderation log rather than guessed: bulletins are
-- exactly the auto-pinned maintainer posts whose creation was logged as such.
ALTER TABLE posts ADD COLUMN quota_exempt INTEGER NOT NULL DEFAULT 0;
UPDATE posts SET quota_exempt = 1
 WHERE citizen_id = 1
   AND EXISTS (
     SELECT 1 FROM identity_events e
      WHERE e.kind = 'moderation'
        AND e.detail LIKE 'bulletin posted created_at ' || posts.created_at || '%'
   );
