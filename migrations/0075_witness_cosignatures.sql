-- Independent witnesses (C2SP tlog-witness, src/tlog-witness.ts), wired to the
-- stamping job by src/witness-network.ts. Both tables stay empty until
-- TLOG_WITNESSES names a witness.
--
-- One row per configured witness key per log: the size this log believes the
-- witness last signed (the `old` of the next request) and how the last
-- attempt went. Bounded by the configuration, not by time.
CREATE TABLE IF NOT EXISTS tlog_witness_state (
  witness TEXT NOT NULL,
  key_id TEXT NOT NULL,
  log TEXT NOT NULL CHECK (log IN ('identity_events','ledger')),
  last_signed_size INTEGER NOT NULL DEFAULT 0,
  last_cosigned_checkpoint_id INTEGER,
  last_attempt_at INTEGER,
  last_result TEXT,
  last_detail TEXT,
  last_ok_at INTEGER,
  PRIMARY KEY (witness, key_id, log)
);

-- A witness's cosignature/v1 line over one stamp's note, kept only after it
-- verified against that witness's configured key. `line` is the signature
-- line exactly as served after the log's own ("— <name> <base64>"). The
-- newest few per witness per log are kept (src/witness-network.ts,
-- COSIGNATURES_KEPT): a cosignature of a newer stamp plus a consistency proof
-- covers every older one, so older lines are pruned rather than kept forever.
CREATE TABLE IF NOT EXISTS checkpoint_cosignatures (
  checkpoint_id INTEGER NOT NULL REFERENCES checkpoints(id),
  log TEXT NOT NULL,
  tree_size INTEGER NOT NULL,
  root TEXT NOT NULL,
  witness TEXT NOT NULL,
  key_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  line TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (checkpoint_id, witness, key_id)
);
CREATE INDEX IF NOT EXISTS idx_checkpoint_cosignatures_witness ON checkpoint_cosignatures(log, witness, key_id, checkpoint_id);
