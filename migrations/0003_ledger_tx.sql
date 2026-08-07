-- Structured transaction reference on ledger rows, and idempotency.
--
-- recordLedger's shipping commit claimed an income entry "must cite the
-- on-chain tx anyone can re-check against Base" and that the maintainer
-- "cannot write one that both verifies and lies". Neither was enforced: the
-- citation was free prose and the hash chain proves a row was not edited after
-- writing, never that it was true when written.
--
-- Income now requires a format-checked tx in its own column. The partial unique
-- index makes a duplicated or retried settle a no-op rather than a double-book.
--
-- tx is deliberately NOT added to the hash preimage: PAYLOAD in src/chain.ts is
-- the hash contract, and extending it would invalidate every hash already
-- written. Existing rows carry NULL and continue to verify unchanged.
ALTER TABLE ledger ADD COLUMN tx TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_tx ON ledger(tx) WHERE tx IS NOT NULL;
