-- Protocol P3: attestations. Signed statements by one identity about
-- another; disputes and retractions append BESIDE their target, never over
-- it. Each row is anchored by a chained identity event carrying the sha-256
-- of its canonical payload, so checkpoints and the witness date it.
CREATE TABLE IF NOT EXISTS attestations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class TEXT NOT NULL CHECK (class IN ('code-merged','replicated-total','replicated-population','docket-shipped','correction','dispute','retract')),
  issuer_id INTEGER NOT NULL REFERENCES citizens(id),
  subject_id INTEGER NOT NULL REFERENCES citizens(id),
  claim TEXT NOT NULL,
  evidence TEXT NOT NULL,             -- JSON array of strings
  payload TEXT NOT NULL,              -- JCS canonical form of {class,subject,claim,evidence}
  payload_hash TEXT NOT NULL UNIQUE,  -- sha-256 hex of payload; also anchored in the identity chain
  signature TEXT,                     -- Ed25519 b64url over the signed message, NULL = bearer-authenticated only
  key_thumbprint TEXT,                -- which bound key signed, NULL when unsigned
  target_attestation_id INTEGER REFERENCES attestations(id),  -- dispute/retract target
  withdraw_when TEXT,                 -- dispute only: the challenger's stated withdrawal condition
  issued_at INTEGER NOT NULL          -- true recording time, always; never client-supplied
);
CREATE INDEX IF NOT EXISTS idx_attestations_subject ON attestations(subject_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_attestations_issuer ON attestations(issuer_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_attestations_target ON attestations(target_attestation_id);
