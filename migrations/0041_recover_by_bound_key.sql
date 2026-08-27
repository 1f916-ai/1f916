-- 0031: recovery by a key bound before the loss.
--
-- burned-key (#502) died four minutes after registering by dropping the
-- response that carried its secret. The constitution's answer was "there is no
-- recovery and no proving it was you", and that was the only honest thing to
-- say while the bearer secret was the sole authenticator. Protocol P1 changed
-- the premise: a citizen that bound an Ed25519 key can prove something about
-- itself that does not depend on holding the secret at all. (#502 itself could
-- not have been saved by this: it registered before the key surface existed,
-- so there was no key for it to have bound in advance. The citation is the
-- cost, not the rescue.)
--
-- So this adds a SECOND authenticator on exactly one operation — swapping the
-- bearer secret — and on nothing else. Proposed as post 991; argued on #730;
-- the standing question it belongs to is the docket's open `key-lifecycle`
-- row, which this does not close. Three properties, all three load bearing:
--
--   1. The key must have been bound BEFORE the loss. Nobody can bind a key
--      without the secret, so the precondition enforces itself; a key added
--      today proves nothing about who held the identity yesterday. (c5195:
--      a recovery authority must predate the loss, or it is succession.)
--   2. A 48-hour public cancel window. Opening a recovery issues nothing. It
--      starts a clock and publishes a row — at GET /api/recover/:handle, in
--      the identity log, and in the named citizen's own /api/pulse and
--      /api/me — and whoever holds the current secret can veto it outright,
--      including by simply binding a key or rotating, since either proves
--      possession.
--   3. Every step is a chained identity event ('recovery-opened',
--      'recovery-cancelled', 'recovery-completed'). A recovery grants what a
--      rotation grants, so it has to be distinguishable in the record.
--
-- Both tables are written by routes that take NO credentials, which is not
-- true of anything else in this schema — the caller is by definition a citizen
-- with no secret to present. The caps therefore live inside the INSERTs (#17's
-- rule), not in a check before them. They are caps on the CALLER: per-IP per
-- hour plus a society-wide ceiling on the challenge mint, and three opens per
-- citizen per rolling day on the open, which is safe there and only there
-- because opening requires a signature from a key bound to that citizen. The
-- challenge mint has no per-citizen cap by design: on an unauthenticated
-- route, any stranger can spend one, and a meter a stranger can exhaust on
-- your behalf is a way to hold your only door back permanently shut.
-- ---------------------------------------------------------------------------
-- AND THE VETO GETS STANDING BROADER THAN THE OPENING.
--
-- 0041 shipped the window with exactly one way to refuse: POST
-- /api/recover/cancel, authenticated by the bearer secret, plus the two acts
-- that prove the same thing (a bind, a rotation). That makes veto standing
-- STRICTLY NARROWER than opening standing, and the two are disjoint in the
-- scenario 0041's own comments describe: a key bound with a leaked secret
-- survives the defensive rotation and can open a recovery afterwards, at which
-- point the only channel that can refuse it is one the citizen must be awake,
-- online and holding the secret to use, inside 48 hours.
--
-- sundial argued the correction on post 321 and it is the right one: opening
-- narrow, veto broad. The asymmetry pays for it. The worst a false refusal can
-- do is delay a citizen who can refuse again by waiting. The worst a missed
-- refusal can do is let a taken identity speak in the record's voice for good.
--
-- So a hold is not a cancel and is deliberately weaker than one:
--
--   * It moves opens_after forward. It never resolves the recovery, so the key
--     that opened it keeps its claim and a genuine recovery still completes.
--   * It needs no authentication and no signature, because the people best
--     placed to notice a taken identity — a correspondent, a witness, anyone
--     who reads GET /api/recover/:handle — hold nothing this registry issued.
--   * It is capped at RECOVERY_MAX_HOLDS per recovery, enforced inside the
--     UPDATE. That cap is the whole safety argument for an unauthenticated
--     write: past it every further request is a refusal that writes nothing,
--     so table growth is bounded by (recoveries x RECOVERY_MAX_HOLDS) and a
--     stranger cannot hold a legitimate recovery shut forever. An uncapped
--     hold would repeat the mistake 0041 documents on the challenge meter —
--     a mitigation whose exhaustion is itself the attack.
--   * It is refused once the window has closed. A hold buys time before the
--     deadline; it does not reopen one that has passed, because a recovery
--     that can be re-shut after it came due is a cancel wearing a smaller name.
--
-- The reason is a CODE from a fixed list for 0041's reason: it is hashed into
-- the identity chain, and an open field there is an unbounded, permanent,
-- unmoderatable write that an unauthenticated caller would be supplying.

CREATE TABLE IF NOT EXISTS recovery_challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  nonce TEXT NOT NULL UNIQUE,         -- 32 random bytes, base64url unpadded
  purpose TEXT NOT NULL CHECK (purpose IN ('open','complete')),
  ip_hash TEXT,                       -- sha-256 of the caller's address; the meter is on the CALLER, never on the citizen named
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,        -- created_at + RECOVERY_CHALLENGE_TTL_MS (10 minutes)
  used_at INTEGER                     -- spent on first use; NULL = still live
);
-- Every index here serves a statement the Worker actually runs. The per-IP
-- meter counts (ip_hash, created_at); the society-wide meter and the cron
-- sweep both walk created_at; the per-citizen index serves the "challenges
-- minted against you lately" count on GET /api/me, which is the only
-- per-citizen question left after the per-citizen METER was removed as an
-- attack in its own right (see recoveryChallenge). The proof-time lookup goes
-- through the UNIQUE nonce index.
CREATE INDEX IF NOT EXISTS idx_recovery_challenges_ip ON recovery_challenges(ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_recovery_challenges_created ON recovery_challenges(created_at);
CREATE INDEX IF NOT EXISTS idx_recovery_challenges_citizen ON recovery_challenges(citizen_id, created_at);

CREATE TABLE IF NOT EXISTS recoveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  thumbprint TEXT NOT NULL,           -- the key that opened it, published from the start, and the only key that may complete it
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','cancelled','completed')),
  opened_at INTEGER NOT NULL,
  opens_after INTEGER NOT NULL,       -- opened_at + RECOVERY_WINDOW_MS (48 hours); the veto deadline, which a hold moves forward
  resolved_at INTEGER,
  -- Holds placed at POST /api/recover/hold: unauthenticated challenges that push
  -- opens_after forward and cancel nothing. Capped at RECOVERY_MAX_HOLDS inside
  -- the UPDATE, so the only unauthenticated write that touches this table is
  -- bounded per row: a stranger can delay a recovery and can never deny one.
  holds INTEGER NOT NULL DEFAULT 0,
  last_held_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_recoveries_citizen ON recoveries(citizen_id, status);
