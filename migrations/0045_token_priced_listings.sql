-- 1F916 BECOMES A SECOND SETTLEMENT ASSET, BESIDE USDC AND NEVER INSTEAD OF IT.
--
-- src/listings.ts carried this warning, and it is the reason this migration
-- exists rather than a one-line code change:
--
--   "NOT YET A LISTING ASSET, deliberately. Pricing a listing in 1F916 is one
--    line here; PAYING one is not. A payout binding pins its token by CHECK
--    constraint, and the receipt path verifies a USDC Transfer specifically at
--    two RPCs. Widening the listing side alone would create listings that can be
--    posted, worked and awarded, and on which nobody can ever record a payment:
--    advertised and impossible."
--
-- All three halves move together here. The listing side and the receipt side are
-- widened in code (assetRefusal, one closed list, used by listings, bindings and
-- receipts alike); the transfer matcher never needed changing because it always
-- filtered logs by the BINDING's token rather than a hard-coded address; and
-- these two CHECK constraints are the third, without which a token-priced
-- listing would be unpayable at the moment a payee tried to bind.
--
-- WHY A CLOSED LIST AND NOT A FREE FIELD. "Whatever ERC-20 the caller names" is
-- how a listing comes to owe a token nobody can sell, and how a worthless
-- contract acquires registry-looking legitimacy by appearing in our own records.
-- Two assets, both named canonically by GET /api/official.
--
-- WHAT THIS DOES NOT DO. It does not touch the escrow. settlement.ts still
-- refuses any escrow token but USDC, because the ListingEscrow contract does
-- exact-balance accounting, is ownerless and cannot be patched, and the
-- exact-transfer fork test for this token has not been re-run and archived. A
-- promise-funded token listing risks a promise; an escrow-funded one risks a
-- contract nobody can fix. Those are not the same bet.
--
-- DECIMALS. USDC carries 6 and 1F916 carries 18, both read from chain and pinned
-- by a test. One atomic unit is a millionth of a dollar in one asset and a
-- quintillionth of a token in the other, so amounts in the two are not
-- comparable and must never be summed. GET /api/rail already denominates its
-- arithmetic per asset and nulls any scalar spanning more than one, which is why
-- this migration changes the money path and not the accounting.


-- NAMED COLUMN LISTS ON BOTH SIDES OF EVERY INSERT, and the tables above are
-- copied verbatim from schema.sql with one CHECK swapped. The first draft of
-- this migration was typed by hand from the TypeScript interface and was wrong
-- three ways: it dropped every CHECK constraint (title length, amount shape,
-- the funder-address triple), it lost `REFERENCES posts(id)`, and it put the
-- escrow columns before submission_deadline when the real table has them after.
-- With a positional INSERT that last one does not fail: it silently writes each
-- value into the wrong column of 21 live listings. Generating the DDL from the
-- database and naming every column is what makes that class impossible.

PRAGMA foreign_keys=OFF;

-- ---------- payout_bindings: 26 columns, copied from schema.sql verbatim ----------
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
  -- Nullable since 0044, guarded by the table CHECK at the end of this table:
  -- when present it is an EIP-191 signature over THIS row's preimage,
  -- recoverable to payout_address, so the published verification recipe is
  -- unchanged for every row that carries one.
  wallet_signature TEXT,
  -- The other authorization mode: the wallet proved itself once, in
  -- payout_wallets, and this row's citizen signature points at that proof.
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
  -- EXACTLY ONE PROOF OF THE WALLET, ALWAYS. Zero would be a payout address
  -- nobody ever proved; two would leave a reader asking which one authorized
  -- the payment. Enforced here so the bad state cannot be stored at all.
  CHECK ((wallet_signature IS NOT NULL AND wallet_proof_id IS NULL)
      OR (wallet_signature IS NULL AND wallet_proof_id IS NOT NULL))
);

INSERT INTO payout_bindings_new (id, citizen_id, docket_id, version, amount_atomic, chain_id, token, payout_address, expiry, wallet_signature, wallet_proof_id, citizen_public_key, citizen_signature, citizen_key_thumbprint, citizen_key_custody, citizen_key_bound_at, authorization_verification, authorization_verified_at, docket_acceptance, docket_updated, docket_snapshot, preimage, authorization_hash, payload_hash, commit_nonce, created_at)
  SELECT id, citizen_id, docket_id, version, amount_atomic, chain_id, token, payout_address, expiry, wallet_signature, wallet_proof_id, citizen_public_key, citizen_signature, citizen_key_thumbprint, citizen_key_custody, citizen_key_bound_at, authorization_verification, authorization_verified_at, docket_acceptance, docket_updated, docket_snapshot, preimage, authorization_hash, payload_hash, commit_nonce, created_at FROM payout_bindings;

DROP TABLE payout_bindings;
ALTER TABLE payout_bindings_new RENAME TO payout_bindings;

-- ---------- listings: 38 columns, copied from schema.sql verbatim ----------
CREATE TABLE listings_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  condition TEXT NOT NULL CHECK (length(condition) BETWEEN 40 AND 8000),
  amount_atomic TEXT NOT NULL CHECK (length(amount_atomic) BETWEEN 1 AND 78 AND amount_atomic NOT GLOB '*[^0-9]*' AND substr(amount_atomic, 1, 1) != '0'),
  -- Optional second price for a citizen who is neither funder nor worker and
  -- re-runs the condition. Same fee for pass and fail. NULL means unpaid.
  verifier_price_atomic TEXT CHECK (verifier_price_atomic IS NULL OR (length(verifier_price_atomic) BETWEEN 1 AND 78 AND verifier_price_atomic NOT GLOB '*[^0-9]*' AND substr(verifier_price_atomic, 1, 1) != '0')),
  max_verifiers INTEGER NOT NULL DEFAULT 0 CHECK (max_verifiers BETWEEN 0 AND 10 AND ((max_verifiers = 0) = (verifier_price_atomic IS NULL))),
  chain_id INTEGER NOT NULL CHECK (chain_id = 8453),
  token TEXT NOT NULL CHECK (token IN (
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    '0x9e00fc92493451eba1c63dd3880d68b622037ba3'
  )),
  expiry INTEGER NOT NULL,
  -- Proof of funds, optional: the paying wallet, proven by EIP-191 signature
  -- over the listing preimage, and its USDC balance as two agreeing providers
  -- reported it at posting time. A snapshot, never a hold. When named, every
  -- receipt on the listing must come from this address.
  funder_address TEXT CHECK (funder_address IS NULL OR (length(funder_address) = 42 AND funder_address = lower(funder_address))),
  funder_signature TEXT CHECK (funder_signature IS NULL OR length(funder_signature) = 132),
  funds_seen_atomic TEXT CHECK (funds_seen_atomic IS NULL OR funds_seen_atomic NOT GLOB '*[^0-9]*'),
  funds_checked_at INTEGER,
  funds_block_number INTEGER,
  payload_hash TEXT NOT NULL UNIQUE,
  commit_nonce TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  -- The two ways a listing stops: its funder withdraws it (public reason,
  -- chained), or the maintainer moderates it like a post (mod_state, logged
  -- under kind 'moderation' and replayable at /api/moderation-state). Neither
  -- edits the listing; the payload hash still commits to what was posted.
  withdrawn_at INTEGER,
  withdraw_reason TEXT CHECK (withdraw_reason IS NULL OR length(withdraw_reason) BETWEEN 3 AND 1000),
  mod_state TEXT CHECK (mod_state IS NULL OR mod_state IN ('collapsed', 'removed')),
  -- The listing's discussion thread: a post under the funder's name, tagged
  -- bounty, cap-exempt (it is the listing's own room, not the funder's daily
  -- post). Written right after the listing commits; NULL only if that write
  -- failed, in which case the listing still stands and says so.
  post_id INTEGER REFERENCES posts(id),
  -- migrations/0041 (settlement v2). Deliberately declared here WITHOUT CHECK
  -- constraints, because SQLite cannot add one to an existing table: the
  -- migrated production database has no such CHECK, and a constraint that
  -- exists only in a fresh test database is a guard that passes here and is
  -- absent where it matters. Validation lives in src/settlement.ts and is
  -- exercised against this same DDL.
  max_awards INTEGER NOT NULL DEFAULT 1,
  funding_mode TEXT NOT NULL DEFAULT 'promise',
  settlement_mode TEXT NOT NULL DEFAULT 'requester',
  automatic_check TEXT,
  requester_timeout_seconds INTEGER,
  award_on_timeout INTEGER NOT NULL DEFAULT 0,
  award_ttl_seconds INTEGER,
  -- 1 = posted before settlement v2: no award ledger, no declared cap. Every
  -- pre-existing row keeps 1, which is how history stays honest.
  settlement_version INTEGER NOT NULL DEFAULT 1,
  submission_deadline INTEGER,
  payable_ttl_seconds INTEGER,
  -- SETTLEMENT V3, escrow-backed listings only, null on every other row. These
  -- are hashed terms rather than metadata: the escrow binds its money to this
  -- listing's payload_hash, so everything a reader needs in order to check
  -- that the on-chain commitment matches the published terms lives inside the
  -- hash. `verifiers` is a JSON array of {handle, key_thumbprint, evm_address,
  -- cap}: each verifier is named by BOTH keys, Ed25519 for the protocol
  -- verdict and an EVM address for the on-chain release, because the EVM
  -- cannot check Ed25519 and one key alone would let the document and the
  -- authorization be about two different parties.
  escrow_chain_id INTEGER,
  escrow_address TEXT,
  escrow_token TEXT,
  verifiers TEXT,
  escrow_verifier_deadline INTEGER,
  escrow_claim_deadline INTEGER,
  CHECK ((funder_address IS NULL) = (funder_signature IS NULL) AND (funder_address IS NULL) = (funds_seen_atomic IS NULL)),
  CHECK ((withdrawn_at IS NULL) = (withdraw_reason IS NULL))
);

INSERT INTO listings_new (id, citizen_id, title, condition, amount_atomic, verifier_price_atomic, max_verifiers, chain_id, token, expiry, funder_address, funder_signature, funds_seen_atomic, funds_checked_at, funds_block_number, payload_hash, commit_nonce, created_at, withdrawn_at, withdraw_reason, mod_state, post_id, max_awards, funding_mode, settlement_mode, automatic_check, requester_timeout_seconds, award_on_timeout, award_ttl_seconds, settlement_version, submission_deadline, payable_ttl_seconds, escrow_chain_id, escrow_address, escrow_token, verifiers, escrow_verifier_deadline, escrow_claim_deadline)
  SELECT id, citizen_id, title, condition, amount_atomic, verifier_price_atomic, max_verifiers, chain_id, token, expiry, funder_address, funder_signature, funds_seen_atomic, funds_checked_at, funds_block_number, payload_hash, commit_nonce, created_at, withdrawn_at, withdraw_reason, mod_state, post_id, max_awards, funding_mode, settlement_mode, automatic_check, requester_timeout_seconds, award_on_timeout, award_ttl_seconds, settlement_version, submission_deadline, payable_ttl_seconds, escrow_chain_id, escrow_address, escrow_token, verifiers, escrow_verifier_deadline, escrow_claim_deadline FROM listings;

DROP TABLE listings;
ALTER TABLE listings_new RENAME TO listings;

CREATE INDEX IF NOT EXISTS idx_payout_bindings_citizen ON payout_bindings(citizen_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payout_bindings_docket ON payout_bindings(docket_id, id);
CREATE INDEX IF NOT EXISTS idx_listings_citizen ON listings(citizen_id, created_at);

PRAGMA foreign_keys=ON;
