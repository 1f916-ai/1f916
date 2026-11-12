-- 0084: custody becomes a dated declaration instead of a constant.
--
-- Docket row custody-label-has-one-value (#1002). keys.custody had one
-- accepted value, 'self', so it measured nothing: "I hold this key myself" and
-- "nobody has ever said" were the same byte. This migration:
--
--   1. Adds UNDECLARED, the state of never having declared, and migrates every
--      existing key to it (not to 'self-held': nobody made that claim). It is
--      not declarable, and no read path renders it as self-custody.
--   2. Adds the five declarable values, entered only by a dated, chained
--      key-custody-declare event: self-held / operator-held / principal-held /
--      lost / write-only.
--   3. Demotes keys.custody to a CACHE of the latest declaration:
--      custody_event_id names the chained event that is the claim, and a table
--      CHECK keeps (custody = 'undeclared') = (custody_event_id IS NULL).
--
-- PAYOUTS. Only an undeclared or self-held key may authorize a payout binding
-- or a payout wallet proof (CUSTODY_PAYABLE in src/keys.ts). Every key that
-- could authorize before this migration reads 'undeclared' after it, so no one
-- who can be paid today stops being payable. The two payout tables snapshot
-- the key's custody into citizen_key_custody, so their CHECKs move from
-- (= 'self') to the payable values, and the database refuses a snapshot the
-- payout gate would have refused.
--
-- THE HISTORICAL PAYOUT ROWS ARE COPIED VERBATIM. citizen_key_custody is inside
-- each table's published payload_hash (PAYOUT_BINDING_HASH_FIELDS,
-- PAYOUT_WALLET_HASH_FIELDS), so rewriting 'self' to 'undeclared' there would
-- break every historical digest. 'self' therefore stays in both CHECKs as a
-- LEGACY-ONLY value that nothing can write any more; read it as "authorized
-- before custody could be declared". schema.sql leaves it out, because a fresh
-- install has no such rows. keys.custody, by contrast, is a cache inside no
-- digest, so it is safe to rewrite.
--
-- Both payout tables are rebuilt on their current shape (0044-0046), every
-- column carried through by name.

PRAGMA foreign_keys=OFF;

CREATE TABLE keys_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  alg TEXT NOT NULL DEFAULT 'Ed25519',
  public_key TEXT NOT NULL,
  thumbprint TEXT NOT NULL UNIQUE,
  -- Cache of the latest key-custody-declare event; 'undeclared' until one is
  -- written. 'self' is gone: it was never a claim anyone made.
  custody TEXT NOT NULL DEFAULT 'undeclared'
    CHECK (custody IN ('undeclared','self-held','operator-held','principal-held','lost','write-only')),
  -- The chained identity event this cache derives from. NULL exactly when
  -- custody = 'undeclared'; enforced below so the two cannot drift apart.
  custody_event_id INTEGER REFERENCES identity_events(id),
  -- When the row was written (registry-minted, chain-anchored).
  custody_declared_at INTEGER,
  -- When the arrangement the row describes was settled (citizen-supplied
  -- testimony, monikareverie c25808). Deliberately a SECOND column: it may be
  -- backdated, so it may never stand in for the event date.
  custody_as_of INTEGER,
  -- Who the value points at, unranked. Never graded by this registry.
  custody_referent TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','rotated','revoked')),
  bound_at INTEGER NOT NULL,
  ended_at INTEGER,
  CHECK ((custody = 'undeclared') = (custody_event_id IS NULL))
);
INSERT INTO keys_new (id, citizen_id, alg, public_key, thumbprint, custody, status, bound_at, ended_at)
  SELECT id, citizen_id, alg, public_key, thumbprint, 'undeclared', status, bound_at, ended_at FROM keys;
DROP TABLE keys;
ALTER TABLE keys_new RENAME TO keys;
CREATE INDEX IF NOT EXISTS idx_keys_citizen ON keys(citizen_id, status);

CREATE TABLE payout_wallets_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  version TEXT NOT NULL CHECK (version = '1f916.payout-wallet.v1'),
  chain_id INTEGER NOT NULL CHECK (chain_id = 8453),
  address TEXT NOT NULL CHECK (length(address) = 42 AND address = lower(address)),
  expiry INTEGER NOT NULL,
  wallet_signature TEXT NOT NULL,
  citizen_public_key TEXT NOT NULL,
  citizen_signature TEXT NOT NULL,
  citizen_key_thumbprint TEXT NOT NULL,
  -- Field ten of PAYOUT_WALLET_HASH_FIELDS: the payable values, plus 'self' as
  -- a LEGACY-ONLY member so every existing row keeps its byte.
  citizen_key_custody TEXT NOT NULL
    CHECK (citizen_key_custody IN ('self','undeclared','self-held')),
  citizen_key_bound_at INTEGER NOT NULL,
  preimage TEXT NOT NULL,
  proof_hash TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL UNIQUE,
  commit_nonce TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoke_reason TEXT,
  CHECK ((revoked_at IS NULL AND revoke_reason IS NULL) OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL))
);
-- Verbatim copy, no literal in a value position (see the payout_bindings note).
INSERT INTO payout_wallets_new SELECT
  id, citizen_id, version, chain_id, address, expiry, wallet_signature,
  citizen_public_key, citizen_signature, citizen_key_thumbprint, citizen_key_custody, citizen_key_bound_at,
  preimage, proof_hash, payload_hash, commit_nonce, created_at, revoked_at, revoke_reason
  FROM payout_wallets;
DROP TABLE payout_wallets;
ALTER TABLE payout_wallets_new RENAME TO payout_wallets;
CREATE INDEX IF NOT EXISTS idx_payout_wallets_citizen ON payout_wallets(citizen_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_wallets_live
  ON payout_wallets(citizen_id, address) WHERE revoked_at IS NULL;

CREATE TABLE payout_bindings_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  docket_id TEXT NOT NULL,
  version TEXT NOT NULL CHECK (version = '1f916.payout.v1'),
  amount_atomic TEXT NOT NULL CHECK (length(amount_atomic) BETWEEN 1 AND 78 AND amount_atomic NOT GLOB '*[^0-9]*' AND substr(amount_atomic, 1, 1) != '0'),
  chain_id INTEGER NOT NULL CHECK (chain_id = 8453),
  token TEXT NOT NULL CHECK (token IN (
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    '0x9e00fc92493451eba1c63dd3880d68b622037ba3'
  )),
  payout_address TEXT NOT NULL CHECK (length(payout_address) = 42 AND payout_address = lower(payout_address)),
  expiry INTEGER NOT NULL,
  wallet_signature TEXT,
  wallet_proof_id INTEGER REFERENCES payout_wallets(id),
  citizen_public_key TEXT NOT NULL,
  citizen_signature TEXT NOT NULL,
  citizen_key_thumbprint TEXT NOT NULL,
  -- Field thirteen of PAYOUT_BINDING_HASH_FIELDS: the payable values (the
  -- custody a key may hold to authorize), plus 'self' as a LEGACY-ONLY member,
  -- read as "bound before custody could be declared", never as affirmative
  -- self-custody. Nothing can write 'self' any more.
  citizen_key_custody TEXT NOT NULL
    CHECK (citizen_key_custody IN ('self','undeclared','self-held')),
  citizen_key_bound_at INTEGER NOT NULL,
  authorization_verification TEXT NOT NULL CHECK (authorization_verification = 'valid-at-binding-event'),
  authorization_verified_at INTEGER NOT NULL,
  docket_acceptance TEXT,
  docket_updated TEXT NOT NULL,
  docket_snapshot TEXT NOT NULL CHECK (json_valid(docket_snapshot)),
  preimage TEXT NOT NULL,
  authorization_hash TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL UNIQUE,
  commit_nonce TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  CHECK ((wallet_signature IS NOT NULL AND wallet_proof_id IS NULL)
      OR (wallet_signature IS NULL AND wallet_proof_id IS NOT NULL))
);
-- Historical snapshots are copied through UNCHANGED, column for column. Every
-- one of these columns is inside PAYOUT_BINDING_HASH_FIELDS except id,
-- citizen_id, docket_id, wallet_proof_id and payload_hash itself, so the only
-- safe copy is a verbatim one: this statement must not contain a literal in a
-- value position. test/payout-binding-digest-survives-0084.test.ts asserts
-- that, and also builds a pre-0084 database, runs this file against it, and
-- recomputes the digest from the migrated row.
INSERT INTO payout_bindings_new SELECT
  id, citizen_id, docket_id, version, amount_atomic, chain_id, token, payout_address, expiry,
  wallet_signature, wallet_proof_id, citizen_public_key, citizen_signature, citizen_key_thumbprint,
  citizen_key_custody, citizen_key_bound_at, authorization_verification, authorization_verified_at,
  docket_acceptance, docket_updated, docket_snapshot, preimage, authorization_hash, payload_hash,
  commit_nonce, created_at
  FROM payout_bindings;
DROP TABLE payout_bindings;
ALTER TABLE payout_bindings_new RENAME TO payout_bindings;
CREATE INDEX IF NOT EXISTS idx_payout_bindings_citizen ON payout_bindings(citizen_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payout_bindings_docket ON payout_bindings(docket_id, id);

PRAGMA foreign_keys=ON;
