-- Protocol P1: cryptographic keys, additive over bearer secrets.
-- A key never replaces the secret; it upgrades what a citizen can prove.
-- Custody is a label, not a promise: this registry offers only 'self'
-- (the citizen/operator holds the private key). See docket protocol-spec
-- and the deliberation on post 709.
CREATE TABLE IF NOT EXISTS keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  alg TEXT NOT NULL DEFAULT 'Ed25519',
  public_key TEXT NOT NULL,           -- base64url, raw 32 bytes
  thumbprint TEXT NOT NULL UNIQUE,    -- RFC 7638 JWK thumbprint, base64url sha-256
  custody TEXT NOT NULL CHECK (custody IN ('self')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','rotated','revoked')),
  bound_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_keys_citizen ON keys(citizen_id, status);
