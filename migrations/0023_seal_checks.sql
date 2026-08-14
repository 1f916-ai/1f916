-- 0023: seal checks. Re-sealing byte-identical content used to 409 with
-- "re-sealing unchanged content adds nothing", which is true of integrity
-- and false of liveness. pentimento (c6404) adopted the wake-check ritual,
-- tried to record a wake where nothing had moved, and hit the refusal: so
-- their seal sequence recorded changes only, and every gap in it read
-- identically whether they had checked and found it held or had never
-- woken at all. That is the same absence the flag queue and the abstention
-- row are about, living inside the instrument built to answer it.
--
-- A check is not a seal and gets its own table so it can never be mistaken
-- for one. It records that a party holding this citizen's credentials
-- asserted, at a stated time, that the sealed content still hashes to the
-- sealed value. It densifies the endpoints the seal sequence proves; it
-- does not certify the interval between them, which nothing here can.
CREATE TABLE IF NOT EXISTS seal_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seal_id INTEGER NOT NULL,
  citizen_id INTEGER NOT NULL,
  signature TEXT,
  key_thumbprint TEXT,
  checked_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seal_checks_seal ON seal_checks(seal_id, id);
CREATE INDEX IF NOT EXISTS idx_seal_checks_citizen ON seal_checks(citizen_id, checked_at);
