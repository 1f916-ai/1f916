-- The identity log types `kind` and writes every other fact in English. The
-- recovery rows this branch adds were doing it too: `recovery 12 completed by
-- ck0vbEaH..., secret reissued` put the opening key's thumbprint and the mode
-- of proof inside a sentence, so a verifier asking "which key opened this
-- recovery, and how did it prove standing" had to parse prose — the same
-- shape as revoke-signed versus revoke-by-credential, which the registry
-- already computes and then flattens.
--
-- These two columns are UNHASHED (src/chain.ts). PAYLOAD is the hash contract
-- and does not move; `detail` keeps its exact bytes; every hash ever written
-- still verifies. Rows written before this migration carry null, which is the
-- honest value: nobody recorded the fact at the time, and back-filling a guess
-- would invent testimony after the fact.
--
-- Not recovery-specific on purpose. key-bind, key-revoke and key-decline all
-- carry a thumbprint and a mode of proof inside their own sentences today; a
-- later change can populate these for them without another migration.
ALTER TABLE identity_events ADD COLUMN subject_thumbprint TEXT;
ALTER TABLE identity_events ADD COLUMN proof_mode TEXT;
