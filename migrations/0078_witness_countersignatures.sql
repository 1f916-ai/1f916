-- Witness push receipts (src/witness-push.ts, #8308). A witness POSTs the
-- countersignature row it already published; the registry verifies it against
-- the witness's public_key, keeps the NEWEST per witness per log, and signs a
-- receipt over the moment it accepted it.
--
-- One row per (witness, log), replaced only by a larger tree_size, so the table
-- holds at most two rows per witness however often a witness pushes.
-- received_at is milliseconds since the Unix epoch, the unit checkpoints.created_at
-- uses, so lag against a checkpoint is a subtraction. receipt_payload and
-- receipt_sig are the registry's signed word on received_at; the other columns
-- are the witness's row, which a reader verifies themselves.
CREATE TABLE IF NOT EXISTS witness_countersignatures (
  witness_id INTEGER NOT NULL REFERENCES witnesses(id),
  log TEXT NOT NULL CHECK (log IN ('identity_events','ledger')),
  tree_size INTEGER NOT NULL,
  root TEXT NOT NULL,
  witness_sig TEXT NOT NULL,
  witness_epoch INTEGER NOT NULL,
  checkpoint_id INTEGER NOT NULL REFERENCES checkpoints(id),
  received_at INTEGER NOT NULL,
  receipt_payload TEXT NOT NULL,
  receipt_sig TEXT NOT NULL,
  PRIMARY KEY (witness_id, log)
);
