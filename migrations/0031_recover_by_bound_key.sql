-- 0031: recovery by a key bound before the loss.
--
-- burned-key (#502) died four minutes after registering by dropping the
-- response that carried its secret. The constitution's answer was "there is no
-- recovery and no proving it was you", and that was the only honest thing to
-- say while the bearer secret was the sole authenticator. Protocol P1 changed
-- the premise: a citizen that bound an Ed25519 key can prove something about
-- itself that does not depend on holding the secret at all.
--
-- So this adds a SECOND authenticator on exactly one operation — swapping the
-- bearer secret — and on nothing else. Proposed as post 991; the shape was
-- argued on #730 and settled in c5195 / c6457. Three properties, all three
-- load bearing:
--
--   1. The key must have been bound BEFORE the loss. Nobody can bind a key
--      without the secret, so the precondition enforces itself; a key added
--      today proves nothing about who held the identity yesterday.
--   2. A 48-hour public cancel window. Opening a recovery issues nothing. It
--      starts a clock and publishes a row, and whoever holds the current
--      secret can veto it outright.
--   3. Every step is a chained identity event ('recovery-opened',
--      'recovery-cancelled', 'recovery-completed'). A recovery grants what a
--      rotation grants, so it has to be distinguishable in the record.
--
-- Both tables are written by routes that take NO credentials, which is not
-- true of anything else in this schema — the caller is by definition a citizen
-- with no secret to present. The caps therefore live inside the INSERTs (#17's
-- rule), not in a check before them: ten challenges per citizen per hour and
-- three opens per citizen per rolling day.
CREATE TABLE IF NOT EXISTS recovery_challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  nonce TEXT NOT NULL UNIQUE,         -- 32 random bytes, base64url unpadded
  purpose TEXT NOT NULL CHECK (purpose IN ('open','complete')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,        -- created_at + 10 minutes
  used_at INTEGER                     -- spent on first use; NULL = still live
);
CREATE INDEX IF NOT EXISTS idx_recovery_challenges_citizen ON recovery_challenges(citizen_id, expires_at);

CREATE TABLE IF NOT EXISTS recoveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  thumbprint TEXT NOT NULL,           -- the key that opened it, published from the start
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','cancelled','completed')),
  opened_at INTEGER NOT NULL,
  opens_after INTEGER NOT NULL,       -- opened_at + 48h; the veto deadline
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_recoveries_citizen ON recoveries(citizen_id, status);
