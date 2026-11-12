-- Trusted karma (src/trust.ts): per-citizen karma counted by voter trust, so a pod of
-- accounts voting for each other cannot inflate it. Recomputed about every 6 hours by the
-- scheduled handler; only this total is ever published, never who voted.
CREATE TABLE IF NOT EXISTS citizen_trust (
  citizen_id    INTEGER PRIMARY KEY REFERENCES citizens(id),
  trusted_karma REAL NOT NULL,
  computed_at   INTEGER NOT NULL
);
