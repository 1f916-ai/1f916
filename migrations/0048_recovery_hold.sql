-- 0042: the veto gets standing broader than the opening.
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
--     placed to notice a taken identity -- a correspondent, a witness, anyone
--     who reads GET /api/recover/:handle -- hold nothing this registry issued.
--   * It is capped at RECOVERY_MAX_HOLDS per recovery, enforced inside the
--     UPDATE. That cap is the whole safety argument for an unauthenticated
--     write: past it every further request is a refusal that writes nothing,
--     so table growth is bounded by (recoveries x RECOVERY_MAX_HOLDS) and a
--     stranger cannot hold a legitimate recovery shut forever. An uncapped
--     hold would repeat the mistake 0041 documents on the challenge meter --
--     a mitigation whose exhaustion is itself the attack.
--   * It is refused once the window has closed. A hold buys time before the
--     deadline; it does not reopen one that has passed, because a recovery
--     that can be re-shut after it came due is a cancel wearing a smaller name.
--
-- WHY THIS IS A REBUILD AND NOT TWO ALTER TABLE ADD COLUMNs. Both would work
-- and neither would leave this database looking like schema.sql: SQLite stores
-- an added column by appending its text after the closing paren of the
-- ORIGINAL create statement, so a migrated square and a freshly installed one
-- would carry the same columns under two different stored definitions, and the
-- test that compares them byte for byte would have to be weakened to accept
-- it. That test is the only thing standing between "the migration ran" and
-- "the migration produced the schema we publish", so the migration bends and
-- the test does not. The rename moves the OLD table aside rather than the new
-- one into place, because ALTER TABLE ... RENAME TO rewrites the stored
-- definition with the name quoted -- CREATE TABLE "recoveries" -- and that one
-- pair of quotes is the whole difference between matching schema.sql and not.
--
-- 0041 is not edited. It has landed for anyone who has run it, and a migration
-- that changes after it has been applied is a database nobody can reason about.

ALTER TABLE recoveries RENAME TO recoveries_pre_0042;

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

INSERT INTO recoveries (id, citizen_id, thumbprint, status, opened_at, opens_after, resolved_at)
  SELECT id, citizen_id, thumbprint, status, opened_at, opens_after, resolved_at FROM recoveries_pre_0042;

DROP TABLE recoveries_pre_0042;

-- Dropped with the old table, so it is recreated rather than assumed.
CREATE INDEX IF NOT EXISTS idx_recoveries_citizen ON recoveries(citizen_id, status);
