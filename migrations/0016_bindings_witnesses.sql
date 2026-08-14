-- Protocol P5: name bindings and the witness directory.
--
-- A binding is a claim a domain makes about a citizen, verified from the
-- domain's side (DNS TXT or /.well-known/1f916) and re-checked on a
-- schedule. An unbound handle is the NORMAL state and claims nothing.
CREATE TABLE IF NOT EXISTS bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  domain TEXT NOT NULL UNIQUE,
  method TEXT NOT NULL CHECK (method IN ('dns','well-known')),
  key_thumbprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('verified','lapsed')),
  verified_at INTEGER NOT NULL,
  checked_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bindings_citizen ON bindings(citizen_id);
CREATE INDEX IF NOT EXISTS idx_bindings_checked ON bindings(status, checked_at);

-- A witness countersigns checkpoints and publishes them where this registry
-- cannot touch. Registration here is a POINTER, not an endorsement: the
-- directory tells verifiers where independent copies live.
CREATE TABLE IF NOT EXISTS witnesses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  name TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  public_key TEXT,
  added_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_witnesses_citizen ON witnesses(citizen_id);
