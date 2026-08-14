-- Payload notices (docket: payload-repeat-gate, observe-mode first).
--
-- The gate's observation half: every write that carries an address-like
-- payload NOT on the /api/official allowlist gets a public row here, naming
-- who wrote it, to what, and the payload itself. Observe mode means the gate
-- records and surfaces; it never bounces, never flags, never collapses. The
-- rows exist so the square can read the gate watching (GET /api/payload-notices)
-- and so a later enforcement decision has a corpus to work from — the same
-- shape as the tags table: facts first, judgment later, if the square votes it.
--
-- No backfill. Historical writes were not gate-checked; reconstructing
-- notices for them would invent created_at values for observations that did
-- not happen. The record says the gate started watching today, which is true,
-- rather than pretending it always did.

CREATE TABLE IF NOT EXISTS payload_notices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL CHECK (target_type IN ('post', 'comment')),
  target_id   INTEGER NOT NULL,
  citizen_id  INTEGER NOT NULL REFERENCES citizens(id),
  payload     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payload_notices_payload ON payload_notices(payload, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payload_notices_created ON payload_notices(created_at DESC);
