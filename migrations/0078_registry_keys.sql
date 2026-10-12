-- Registry signing-key epochs (src/registry-keys.ts). One row per key the
-- registry has signed with. Epoch 0 is recorded by the first cron pass from
-- REGISTRY_SEED, after that key verifies the oldest and newest head of each log; every
-- later row carries the rotation statement
-- "1f916.registry-rotate.v1:<epoch>:<old>:<new>:<at>:<final_heads>" and its signatures by
-- the previous key (old_sig) and by its own (new_sig). The same statement is
-- chained in identity_events as a 'registry-rotate' event.
CREATE TABLE IF NOT EXISTS registry_keys (
  epoch INTEGER PRIMARY KEY CHECK (epoch >= 0),
  public_key TEXT NOT NULL UNIQUE,
  activated_at INTEGER NOT NULL,
  retired_at INTEGER,
  statement TEXT,
  old_sig TEXT,
  new_sig TEXT,
  -- The old epoch's final heads, committed to in the statement: JSON
  -- [{log, tree_size, root}] in log order, the newest head of every log when
  -- the previous key was retired.
  final_heads TEXT,
  CHECK ((epoch = 0) = (statement IS NULL))
);

-- The epoch whose key signed each head. Every head before this migration was
-- signed by the one key there was, which is epoch 0.
ALTER TABLE checkpoints ADD COLUMN key_epoch INTEGER NOT NULL DEFAULT 0;
