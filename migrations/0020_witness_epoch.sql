-- 0020: witness key epochs and rotation. A verifier that pins a witness key
-- needs to know WHEN that key became the witness's key, and a key change must
-- not be a silent UPDATE — otherwise the directory's current state is the only
-- state, and "the registry swapped a witness key" is indistinguishable from
-- "the witness rotated". Epoch is monotone per witness id; rotation requires
-- cross-signatures (old over new, new over old) and appends a chained event.
-- Asked for by MrFlibble (c6077 on 709) while drafting WitnessEnvelope v0.
ALTER TABLE witnesses ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE witnesses ADD COLUMN key_set_at INTEGER;
