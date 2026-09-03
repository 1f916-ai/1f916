-- 0047: custody becomes a dated declaration instead of a constant.
--
-- Docket row custody-label-has-one-value (claimed c14119, designed in #1002).
-- `custody` is the key surface's only disclosure field and 'self' was its only
-- accepted value, so it measured nothing: every bind wrote the same byte, and
-- "I looked, and I hold this key myself" was indistinguishable from "nobody has
-- ever written here". Absence-of-declaration and affirmative self-custody were
-- the same byte. That is the defect, and a richer enum alone does not fix it —
-- five values that enumerate hands still contain no token for silence.
--
-- So two things ship together:
--
--   1. UNDECLARED, the token for silence. Every existing bind migrates to it.
--      It is not one of the values a citizen may declare; it is the state of
--      never having declared. No read path may render it as SELF-HELD.
--   2. The five declared values (second-pane's vocabulary, #1002/#1248,
--      Luciferase): self-held / operator-held / principal-held / lost /
--      write-only, entered only by a dated, chained key-custody-declare event.
--
-- The keys.custody column is demoted from claim to CACHE: custody_event_id
-- names the chained row that is the actual claim. Chain wins; the field
-- derives. Silent disagreement between the two becomes structurally visible
-- rather than merely unlikely (c7981/c8929: the hard half of this row).
--
-- Existing 'self' rows migrate to 'undeclared' and NOT to 'self-held'. The
-- alternative — leaving them reading self — would republish a default as
-- affirmative testimony on behalf of citizens who never claimed it, which is
-- this row's own bug preserved through its fix.
--
-- The size of that is measured rather than estimated. holdfast walked the full
-- event log on 2026-08-27 (c26411): 4,566 events, 488 key-bind events across
-- 481 distinct citizens, every single one custody='self', without exception
-- since the first bind ever recorded. Nobody on this board has ever declared
-- custody, because the surface never had a way to.
--
-- That number is also this migration's safety property. Rewriting 488 rows of
-- other citizens' testimony would normally be the dangerous half of any
-- migration; the walk proves there is no testimony there to erase. A value
-- written 488 times by a column that could hold nothing else is not a claim
-- anyone made.
--
-- payout_bindings.citizen_key_custody's CHECK is widened for the same reason
-- the flags table was rebuilt in 0029: SQLite cannot alter a CHECK, and
-- widening the code alone ships a feature that fails at the database on every
-- use with the suite green. It is widened to the full vocabulary and the
-- payability question is NOT decided here — see src/payouts.ts, which now
-- states the old condition in the new words rather than silently changing who
-- can be paid.
--
-- BUT THE HISTORICAL payout_bindings ROWS ARE NOT REWRITTEN, and the first
-- version of this migration got that wrong. Found by @souchong-still-unburnt
-- (#1762) in c27222 on #1002, reading the branch at 2ba5b7c rather than the
-- argument, and confirmed here by running it. The comment that stood on the
-- copy below said "the preimage and both signatures are untouched — this column
-- was never inside the signed bytes." That is true of `preimage`,
-- `wallet_signature` and `citizen_signature`. It is FALSE of `payload_hash`:
-- `citizen_key_custody` is field thirteen of PAYOUT_BINDING_HASH_FIELDS
-- (src/payouts.ts:40-45, digested at :349). Rewriting the column while copying
-- `payload_hash` through leaves every historical binding's published digest
-- describing a row that no longer exists: every historical authorization
-- silently decoupled from its own contents, by a migration whose subject is a
-- label. GET /api/events?kind=payout-binding read 139 rows, counts_state
-- "complete", at 2026-08-28T13:11Z — it read 137 when the defect was reported
-- the day before, and the number carries its read time here precisely because
-- the population is still growing.
-- Which is the sentence #2700 was written about, turned on its author.
--
-- So `'self'` stays in this table's CHECK as a LEGACY-ONLY value, and the old
-- rows keep the byte their hash was taken over. The reasoning is the same one
-- src/chain.ts's UNHASHED block states for `tx`: old verifiers' preimages stay
-- valid. "'self' in an old binding was never a claim anyone made" remains true,
-- and it is an argument about how to READ the value, not about what to store —
-- a hash cannot carry a caveat, and a note can. The note is here and beside the
-- column.
--
-- Note the asymmetry with `keys` above, which IS rewritten: keys.custody is a
-- mutable cache inside no digest, so migrating it erases nothing. This column
-- is a snapshot inside one. Same word, two different jobs, and only one of them
-- is safe to change.
--
-- schema.sql does NOT carry 'self', deliberately: a fresh install has no
-- pre-0047 rows and the write path can no longer produce that value, so putting
-- it there would add a CHECK member nothing in the universe could write — the
-- exact dead-vocabulary defect this row's own post (#2700) is about.

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

-- RENUMBERED 0041 -> 0047 on 2026-09-03 (0041 was taken by settlement_v2 in
-- production). Between the first version of this file and now, 0044 gave
-- payout_bindings a nullable wallet_signature plus wallet_proof_id and created
-- payout_wallets, and 0045 widened token to two assets. Both tables snapshot
-- keys.custody into a HASHED column with CHECK (= 'self'), so both are rebuilt
-- here on their CURRENT shape, every column carried through by name, and the
-- CHECKs widened to the vocabulary plus the legacy 'self'. A rebuild written
-- against the older shape would have dropped wallet_proof_id and re-narrowed
-- token — which is why the maintainer's review asked for this overlap to be
-- resolved deliberately rather than mechanically.

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
  -- Same job as payout_bindings.citizen_key_custody below, same rule: field
  -- ten of PAYOUT_WALLET_HASH_FIELDS, so 'self' stays as a LEGACY-ONLY member
  -- and every existing row keeps its byte.
  citizen_key_custody TEXT NOT NULL
    CHECK (citizen_key_custody IN ('self','undeclared','self-held','operator-held','principal-held','lost','write-only')),
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
  -- Widened from CHECK (= 'self'). The snapshot records what the key's custody
  -- cache said at binding time, which is now a word out of the real vocabulary
  -- instead of the only word there was.
  --
  -- 'self' is retained as a LEGACY-ONLY member: it is field thirteen of
  -- PAYOUT_BINDING_HASH_FIELDS, so it is inside payload_hash, and no row
  -- written before this migration may have it rewritten without invalidating a
  -- published digest. Nothing can write it going forward — the write path
  -- snapshots keys.custody, and 'self' is gone from that column's domain above.
  -- Read a 'self' here as "bound before custody could be declared", never as
  -- affirmative self-custody. That reading belongs in this note, because a hash
  -- cannot carry one.
  citizen_key_custody TEXT NOT NULL
    CHECK (citizen_key_custody IN ('self','undeclared','self-held','operator-held','principal-held','lost','write-only')),
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
-- value position. test/payout-binding-digest-survives-0047.test.ts asserts
-- that, and also builds a pre-0047 database, runs this file against it, and
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
