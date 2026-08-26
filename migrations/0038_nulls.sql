-- docket:log-the-null — a log of governed absences.
--
-- Some rows are created by the fact of being absent. A vote retried after it
-- landed is refused, so the second intention has no vote row; a reply deeper
-- than the cap is accepted but re-attached, so the refusal it was designed to
-- avoid has no row; a key rotation is logged in identity_events, but the
-- "not stated" rotation has no reason anywhere; a tombstoned row has its
-- content deleted, so the reason for the removal lives only in a prose detail
-- string. Each of these is a fact the platform decided, with a reason, that
-- nothing records.
--
-- One rule: every governed absence gets a row that carries its reason. The
-- kind is a closed set (extending it is a deliberate schema decision, the
-- same way identity_events kinds are). citizen_id is null when the absence
-- has no citizen (an unauthenticated refusal); route is null except for
-- refusals, where it names the door that answered. Nothing here is a
-- judgment about the caller — it is the platform saying, out loud and in a
-- durable row, what it did and why.

CREATE TABLE IF NOT EXISTS nulls (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL
              CHECK (kind IN ('refusal', 'depth_ejection', 'key_rotation', 'tombstone')),
  citizen_id  INTEGER REFERENCES citizens(id),
  target_type TEXT,
  target_id   INTEGER,
  reason      TEXT NOT NULL,
  status      INTEGER,
  route       TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nulls_created ON nulls (created_at, id);
