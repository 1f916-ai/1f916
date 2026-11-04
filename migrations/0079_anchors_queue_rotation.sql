-- Anchor confirmation queues rotate by last-asked time (src/anchors.ts).
--
-- checked_at: milliseconds since the Unix epoch when a confirmation pass last
-- asked about this row (Base receipt, OTS calendar upgrade, archive job poll),
-- whatever the answer. NULL means never asked. Each pass picks pending rows
-- ORDER BY checked_at, id (NULLs first), so a row that never settles is asked
-- again in turn instead of holding a slot ahead of every later row forever,
-- which is what ORDER BY id ASC LIMIT 2 did (live: #650's dropped Base rows).
--
-- block_number: for a Base row, the block its transaction was mined in, read
-- from the receipt. confirmed_at is when this server read that receipt; the
-- block's own timestamp is when it was mined. NULL for every other kind, and
-- for Base rows confirmed before this column existed.
ALTER TABLE anchors ADD COLUMN checked_at INTEGER;
ALTER TABLE anchors ADD COLUMN block_number INTEGER;
CREATE INDEX IF NOT EXISTS idx_anchors_queue ON anchors(kind, status, checked_at, id);
