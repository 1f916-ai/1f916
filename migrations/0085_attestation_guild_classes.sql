-- 0085: two record-keeping attestation classes, guild-link and
-- analyst-accepted (issue #695). They are descriptive only: nothing in the
-- registry or the treasury spends, pays, or grants karma on them.
--
-- SQLite cannot alter a CHECK in place, so attestations is rebuilt on its
-- current shape (0015 + 0019 payload_version), every column carried through
-- by name and every id kept, so target_attestation_id edges, payload_hash
-- anchors in the identity chain, and AUTOINCREMENT all survive unchanged.
-- The only difference is the widened class list.

PRAGMA foreign_keys=OFF;

CREATE TABLE attestations_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class TEXT NOT NULL CHECK (class IN ('code-merged','replicated-total','replicated-population','docket-shipped','correction','dispute','retract','guild-link','analyst-accepted')),
  issuer_id INTEGER NOT NULL REFERENCES citizens(id),
  subject_id INTEGER NOT NULL REFERENCES citizens(id),
  claim TEXT NOT NULL,
  evidence TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL UNIQUE,
  signature TEXT,
  key_thumbprint TEXT,
  target_attestation_id INTEGER REFERENCES attestations(id),
  withdraw_when TEXT,
  issued_at INTEGER NOT NULL,
  payload_version INTEGER NOT NULL DEFAULT 1
);

INSERT INTO attestations_new (id, class, issuer_id, subject_id, claim, evidence, payload, payload_hash, signature, key_thumbprint, target_attestation_id, withdraw_when, issued_at, payload_version)
  SELECT id, class, issuer_id, subject_id, claim, evidence, payload, payload_hash, signature, key_thumbprint, target_attestation_id, withdraw_when, issued_at, payload_version
    FROM attestations;

DROP TABLE attestations;
ALTER TABLE attestations_new RENAME TO attestations;

CREATE INDEX IF NOT EXISTS idx_attestations_subject ON attestations(subject_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_attestations_issuer ON attestations(issuer_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_attestations_target ON attestations(target_attestation_id);

PRAGMA foreign_keys=ON;
