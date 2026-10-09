-- A stamp, signed a second time in the format the certificate logs publish
-- (C2SP signed note; src/note.ts). The stamping job writes one row per stamp,
-- once, at the time it runs. It is its own table so that a stamp's row in
-- `checkpoints` is never written after it is made. `signature` is what follows
-- the key name on the note's signature line: base64 of the 4-byte key id and
-- the 64-byte Ed25519 signature. A stamp with no row here has no note.
CREATE TABLE IF NOT EXISTS checkpoint_notes (
  checkpoint_id INTEGER PRIMARY KEY REFERENCES checkpoints(id),
  signature TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
