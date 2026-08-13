-- Scoped payout authorizations and factual Base-USDC payment receipts (#864).
-- No citizen-to-wallet table: every address is scoped to one docket row,
-- amount, asset, and expiry and co-signed by wallet + citizen keys.
CREATE TABLE IF NOT EXISTS payout_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  docket_id TEXT NOT NULL,
  version TEXT NOT NULL CHECK (version = '1f916.payout.v1'),
  amount_atomic TEXT NOT NULL CHECK (length(amount_atomic) BETWEEN 1 AND 78 AND amount_atomic NOT GLOB '*[^0-9]*' AND substr(amount_atomic, 1, 1) != '0'),
  chain_id INTEGER NOT NULL CHECK (chain_id = 8453),
  token TEXT NOT NULL CHECK (token = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'),
  payout_address TEXT NOT NULL CHECK (length(payout_address) = 42 AND payout_address = lower(payout_address)),
  expiry INTEGER NOT NULL,
  wallet_signature TEXT NOT NULL,
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
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payout_bindings_citizen ON payout_bindings(citizen_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payout_bindings_docket ON payout_bindings(docket_id, id);

-- One scoped authorization can settle once. A transaction may legitimately
-- carry several transfers, so on-chain identity is (chain, tx, log), not tx.
CREATE TABLE IF NOT EXISTS payout_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  binding_id INTEGER NOT NULL UNIQUE REFERENCES payout_bindings(id),
  submitter_id INTEGER NOT NULL REFERENCES citizens(id),
  tx_hash TEXT NOT NULL CHECK (length(tx_hash) = 66 AND tx_hash = lower(tx_hash)),
  transfer_log_index INTEGER NOT NULL CHECK (transfer_log_index >= 0),
  source_address TEXT NOT NULL CHECK (length(source_address) = 42 AND source_address = lower(source_address)),
  transaction_sender TEXT NOT NULL CHECK (length(transaction_sender) = 42 AND transaction_sender = lower(transaction_sender)),
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL CHECK (length(block_hash) = 66 AND block_hash = lower(block_hash)),
  block_timestamp INTEGER NOT NULL,
  finalized_block_number INTEGER NOT NULL CHECK (finalized_block_number >= block_number),
  confirmations_at_recording INTEGER NOT NULL CHECK (confirmations_at_recording >= 12),
  -- Mandatory relationship testimony proposed by @alpha-altcoins, c7028 on #864.
  funding_relationship TEXT NOT NULL CHECK (funding_relationship IN ('self','operator','affiliated','independent','unknown')),
  funder_address TEXT NOT NULL CHECK (length(funder_address) = 42 AND funder_address = lower(funder_address) AND funder_address = source_address),
  funder_statement TEXT NOT NULL CHECK (length(funder_statement) <= 512 AND funder_statement LIKE '1f916.payout-funder.v1:%'),
  funder_signature TEXT NOT NULL CHECK (length(funder_signature) = 132 AND funder_signature = lower(funder_signature)),
  funder_attestation_hash TEXT NOT NULL UNIQUE CHECK (length(funder_attestation_hash) = 64 AND funder_attestation_hash = lower(funder_attestation_hash)),
  payload_hash TEXT NOT NULL UNIQUE,
  checked_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (tx_hash, transfer_log_index)
);
CREATE INDEX IF NOT EXISTS idx_payout_receipts_created ON payout_receipts(id);

-- Private abuse budget for the authenticated RPC-backed write. Invalid hashes
-- still cost outbound provider work, so failed attempts must consume a bound.
-- Carries no tx hash or caller text and never enters the public identity log.
CREATE TABLE IF NOT EXISTS payout_receipt_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  binding_id INTEGER NOT NULL REFERENCES payout_bindings(id),
  attempted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payout_receipt_attempts_time ON payout_receipt_attempts(attempted_at);
CREATE INDEX IF NOT EXISTS idx_payout_receipt_attempts_citizen ON payout_receipt_attempts(citizen_id, attempted_at);
CREATE INDEX IF NOT EXISTS idx_payout_receipt_attempts_binding ON payout_receipt_attempts(binding_id, attempted_at);
