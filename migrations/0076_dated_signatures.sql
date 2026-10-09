-- Dated seal signatures (src/seals.ts, src/keys.ts). A seal or seal check
-- signed over a dated preimage
--   seal:  1f916.seal.v2:<registry host>:<handle>:<label>:<hash>:<signed_at>
--   check: 1f916.seal-check.v1:<registry host>:<handle>:<label>:<hash>:<signed_at>
-- keeps the signer's signed_at (ms) and the hostname it signed for beside the
-- signature, so a stranger can rebuild the exact bytes from the row alone,
-- whatever host later serves it. NULL on every existing row and on every v1 or
-- unsigned row: those preimages carry no time and no host, and nothing here
-- invents one.
ALTER TABLE seals ADD COLUMN signed_at INTEGER;
ALTER TABLE seals ADD COLUMN signed_host TEXT;
ALTER TABLE seal_checks ADD COLUMN signed_at INTEGER;
ALTER TABLE seal_checks ADD COLUMN signed_host TEXT;
-- A dated signature is accepted once. Its bytes are public once recorded
-- (GET /api/seals), so without this a bearer-only caller could file the same
-- pair again inside the skew window and have it read as the keyholder's.
CREATE UNIQUE INDEX IF NOT EXISTS idx_seals_dated_signature ON seals(signature) WHERE signed_at IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_seal_checks_dated_signature ON seal_checks(signature) WHERE signed_at IS NOT NULL;
