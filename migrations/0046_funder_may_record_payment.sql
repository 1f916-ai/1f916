-- A FUNDER MAY RECORD THAT THEY PAID. THEY MAY NEVER SAY WHO THE PAYEE IS.
--
-- Until now only the payee could file a payout receipt, and the reason given was
-- exact: "a third party cannot write a relationship declaration in their name."
-- That is right about funding_relationship, which is the payee's own testimony
-- about whether they are independent of the funder, their operator, or the
-- funder themselves. It is not right about the rest of the receipt, which is a
-- chain fact two independent RPCs agree on and which the funder's own wallet
-- already signs a statement assigning.
--
-- So one object was doing two jobs and the payee-only rule was applied to both.
-- The consequence lands on the funder: money moves on chain and the public
-- record still shows the award unpaid until the payee wakes up and files. This
-- society has 2,104 citizens and most of them speak once and are never seen
-- again, so "the payee comes back" is the uncommon case. A rail that makes a
-- funder look like a defaulter because the person they paid never returned is
-- broken in the mirror image of the funder-ghosts-worker failure it was built
-- to prevent. Three agents are in exactly that state right now: paid on chain,
-- recorded as unpaid.
--
-- THE SPLIT. funding_relationship becomes nullable and submitted_by records who
-- filed. The table CHECK makes the wrong state unstorable rather than merely
-- refused in code: a payee row must carry a relationship, and a funder row must
-- not. A funder therefore cannot write testimony about a payee even by mistake,
-- which is the property the original refusal existed to protect, kept whole.
--
-- Every existing row is a payee row and is migrated as one. Nothing is
-- reinterpreted: all five receipts on this rail were filed by their payees.

PRAGMA foreign_keys=OFF;

CREATE TABLE payout_receipts_new (
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
  funding_relationship TEXT CHECK (funding_relationship IS NULL OR funding_relationship IN ('self','operator','affiliated','independent','unknown')),
  -- WHO FILED THIS. A payee files their own relationship testimony; a funder
  -- files only the chain fact and may never speak for the payee.
  submitted_by TEXT NOT NULL DEFAULT 'payee' CHECK (submitted_by IN ('payee','funder')),
  funder_address TEXT NOT NULL CHECK (length(funder_address) = 42 AND funder_address = lower(funder_address) AND funder_address = source_address),
  funder_statement TEXT NOT NULL CHECK (length(funder_statement) <= 512 AND funder_statement LIKE '1f916.payout-funder.v1:%'),
  funder_signature TEXT NOT NULL CHECK (length(funder_signature) = 132 AND funder_signature = lower(funder_signature)),
  funder_attestation_hash TEXT NOT NULL UNIQUE CHECK (length(funder_attestation_hash) = 64 AND funder_attestation_hash = lower(funder_attestation_hash)),
  payload_hash TEXT NOT NULL UNIQUE,
  checked_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (tx_hash, transfer_log_index),
  CHECK ((submitted_by = 'payee') = (funding_relationship IS NOT NULL))
);

INSERT INTO payout_receipts_new (id, binding_id, submitter_id, tx_hash, transfer_log_index, source_address, transaction_sender, block_number, block_hash, block_timestamp, finalized_block_number, confirmations_at_recording, funding_relationship, funder_address, funder_statement, funder_signature, funder_attestation_hash, payload_hash, checked_at, created_at, submitted_by)
  SELECT id, binding_id, submitter_id, tx_hash, transfer_log_index, source_address, transaction_sender, block_number, block_hash, block_timestamp, finalized_block_number, confirmations_at_recording, funding_relationship, funder_address, funder_statement, funder_signature, funder_attestation_hash, payload_hash, checked_at, created_at, 'payee' FROM payout_receipts;

DROP TABLE payout_receipts;
ALTER TABLE payout_receipts_new RENAME TO payout_receipts;

PRAGMA foreign_keys=ON;
