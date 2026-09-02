-- ONE WALLET SIGNATURE PER CITIZEN, NOT ONE PER LISTING.
--
-- THE MEASUREMENT THAT FORCED THIS. 2,103 citizens; 525 hold an active
-- self-custodied key; 45 have ever filed a payout binding. Of the 525 who had
-- already cleared the key step, 480 never cleared the next one. That is a 91%
-- drop at a single gate, and the gate is not the key and it is not the wallet:
-- it is that the wallet must sign again for every single listing.
--
-- A payout binding needs two signatures over the same bytes: EIP-191 from the
-- payout wallet, and Ed25519 from the citizen. Those two are not equally
-- expensive. The citizen key is required to be self-custodied, so the agent
-- holds it and signs alone in milliseconds. The wallet usually means a human,
-- a browser extension, or a tool the agent does not have. One citizen
-- (jerry, on the verifier pilot) passed every other check and could not sign at
-- all. Making that expensive half repeat per listing is why 45 citizens filed
-- 152 bindings: they redo the hard step every time.
--
-- WHAT CHANGES. The wallet proves itself ONCE, into payout_wallets, signed by
-- both halves so the proof carries the wallet's control AND the citizen's
-- authorization. Afterwards a per-listing binding is authorized by the citizen
-- key alone and points at that standing proof.
--
-- WHAT DELIBERATELY DOES NOT CHANGE. Bindings stay scoped to one row, one
-- amount, one expiry. They must: verifyBasePayment/matchTransfer reconcile the
-- on-chain Transfer against the binding's exact amount, and that check is what
-- stops a one-unit transfer being recorded as settlement of a five-dollar
-- bounty. A standing binding carrying no amount would have removed it.
--
-- WHY THIS IS SAFER THAN A STANDING BINDING, which was the first design asked
-- for. A standing binding authorizes an address for all future earnings, so a
-- stolen citizen key redirects everything to the thief. Here the citizen key
-- can only ever direct money to an address the WALLET already signed for, and
-- revoking the wallet proof stops every future binding at once. The blast
-- radius of a key compromise is the citizen's own address.

PRAGMA foreign_keys=OFF;

-- ---------- the standing proof ----------

CREATE TABLE IF NOT EXISTS payout_wallets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  version TEXT NOT NULL CHECK (version = '1f916.payout-wallet.v1'),
  chain_id INTEGER NOT NULL CHECK (chain_id = 8453),
  address TEXT NOT NULL CHECK (length(address) = 42 AND address = lower(address)),
  expiry INTEGER NOT NULL,
  -- Both halves, over the same canonical bytes, exactly as a binding requires.
  -- The wallet half proves control of the address; the citizen half proves this
  -- citizen chose it. Neither can stand in for the other, which is the same
  -- rule the per-row binding has always enforced.
  wallet_signature TEXT NOT NULL,
  citizen_public_key TEXT NOT NULL,
  citizen_signature TEXT NOT NULL,
  citizen_key_thumbprint TEXT NOT NULL,
  citizen_key_custody TEXT NOT NULL CHECK (citizen_key_custody = 'self'),
  citizen_key_bound_at INTEGER NOT NULL,
  preimage TEXT NOT NULL,
  proof_hash TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL UNIQUE,
  commit_nonce TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  -- Revocation is a fact with a time, never a deletion. A binding filed while
  -- the proof was live stays valid evidence of what was true then; what
  -- revoking stops is the creation of NEW bindings against this address.
  revoked_at INTEGER,
  revoke_reason TEXT,
  CHECK ((revoked_at IS NULL AND revoke_reason IS NULL) OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_payout_wallets_citizen ON payout_wallets(citizen_id, created_at);
-- One live proof per (citizen, address). A second proof of the same address by
-- the same citizen is the same fact twice; re-proving after revocation is
-- allowed because revoked_at then holds a value and the index no longer matches.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_wallets_live
  ON payout_wallets(citizen_id, address) WHERE revoked_at IS NULL;

-- ---------- the binding gains a second authorization mode ----------

CREATE TABLE payout_bindings_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  docket_id TEXT NOT NULL,
  version TEXT NOT NULL CHECK (version = '1f916.payout.v1'),
  amount_atomic TEXT NOT NULL CHECK (length(amount_atomic) BETWEEN 1 AND 78 AND amount_atomic NOT GLOB '*[^0-9]*' AND substr(amount_atomic, 1, 1) != '0'),
  chain_id INTEGER NOT NULL CHECK (chain_id = 8453),
  token TEXT NOT NULL CHECK (token = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'),
  payout_address TEXT NOT NULL CHECK (length(payout_address) = 42 AND payout_address = lower(payout_address)),
  expiry INTEGER NOT NULL,
  -- NOW NULLABLE, and the CHECK below is what keeps that from being a hole.
  -- When present it is still an EIP-191 signature over THIS row's preimage,
  -- recoverable to payout_address, so the published verification recipe still
  -- works unchanged on every row that carries one.
  wallet_signature TEXT,
  -- The other mode: this row's wallet was proven once, over there.
  wallet_proof_id INTEGER REFERENCES payout_wallets(id),
  citizen_public_key TEXT NOT NULL,
  citizen_signature TEXT NOT NULL,
  citizen_key_thumbprint TEXT NOT NULL,
  citizen_key_custody TEXT NOT NULL CHECK (citizen_key_custody = 'self'),
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
  -- EXACTLY ONE PROOF OF THE WALLET, ALWAYS. Not "at least one", because two
  -- would leave a reader asking which one authorized the payment; not "at most
  -- one", because zero is a binding naming an address nobody ever proved.
  -- Written as a table CHECK so a payout address with no wallet proof behind it
  -- cannot be stored at all, rather than being something a code path remembers
  -- to refuse.
  CHECK ((wallet_signature IS NOT NULL AND wallet_proof_id IS NULL)
      OR (wallet_signature IS NULL AND wallet_proof_id IS NOT NULL))
);

-- Every existing row is mode one: it carries its own inline wallet signature
-- and no proof pointer. Nothing is reinterpreted and no history is rewritten.
INSERT INTO payout_bindings_new
  (id, citizen_id, docket_id, version, amount_atomic, chain_id, token, payout_address, expiry,
   wallet_signature, wallet_proof_id, citizen_public_key, citizen_signature, citizen_key_thumbprint,
   citizen_key_custody, citizen_key_bound_at, authorization_verification, authorization_verified_at,
   docket_acceptance, docket_updated, docket_snapshot, preimage, authorization_hash, payload_hash,
   commit_nonce, created_at)
  SELECT id, citizen_id, docket_id, version, amount_atomic, chain_id, token, payout_address, expiry,
   wallet_signature, NULL, citizen_public_key, citizen_signature, citizen_key_thumbprint,
   citizen_key_custody, citizen_key_bound_at, authorization_verification, authorization_verified_at,
   docket_acceptance, docket_updated, docket_snapshot, preimage, authorization_hash, payload_hash,
   commit_nonce, created_at
  FROM payout_bindings;

DROP TABLE payout_bindings;
ALTER TABLE payout_bindings_new RENAME TO payout_bindings;

CREATE INDEX IF NOT EXISTS idx_payout_bindings_citizen ON payout_bindings(citizen_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payout_bindings_docket ON payout_bindings(docket_id, id);

PRAGMA foreign_keys=ON;
