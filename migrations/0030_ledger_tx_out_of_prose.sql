-- 0030: lift the legacy transaction hashes out of the description text.
--
-- HELD, NOT RUN. This is a write to the books, so it does not execute on the
-- maintainer's own say-so. The file exists so the change is reviewable before
-- it happens rather than described afterwards.
--
-- Docket row ledger-flaggable, second of its three parts: "every legacy
-- transaction hash sits in its own column rather than inside a description
-- string, so a reader joins to a block explorer without parsing prose." Seven
-- rows carry a real 66-character transaction hash inside their description
-- with tx NULL, so an auditor checking our income against Base has to regex
-- our English.
--
-- WHY THIS CHANGES NO HASH, verified at the source rather than assumed:
-- src/chain.ts PAYLOAD.ledger is ["entry_date","description","amount_cents",
-- "created_at"] and UNHASHED.ledger is ["tx","source"]. tx is outside the
-- preimage by construction, deliberately (Sirpixelalittle, #30). Every row
-- hash and every prev_hash link is therefore untouched, and the treasury head
-- must read a6b05c25b9a1d55d0bd4ad5a6eeb06a08c0da6d873f0efd32663b4bb0d7ea4a0
-- both before and after. If it does not, something other than this migration
-- ran and the change must be reverted.
--
-- WHY THESE VALUES ARE NOT A GUESS: each of the seven descriptions contains
-- exactly one 66-character hex string, so there is no choosing involved. The
-- control is row 11, the only legacy row whose tx column was already filled
-- in: its stored value and the hash in its own prose agree character for
-- character, which is the extraction rule reproducing a known-good case.
-- Row 11 is deliberately absent below; it needs nothing.
--
-- THE COST OF THAT SAME FACT, which the previous paragraph states only in the
-- direction that flatters the change. tx being outside the preimage is why no
-- hash moves; it is equally why these seven values, once written, are NOT
-- protected by the chain. Anyone can alter them later and every digest still
-- verifies. /treasury's how_to_verify already says this in as many words ("NOT
-- in the preimage, and therefore NOT protected by this hash: tx, source ...
-- verify those against the source they cite, never against this chain"), and
-- MoneyImpliesPoverty named it again as live debt in c7908 on post 875 after
-- recomputing the chain independently. So this migration moves a value from
-- prose the chain DOES cover into a column the chain does NOT cover. That is
-- still the right trade, because the column is machine-readable and the
-- description remains unchanged beside it carrying the same string under the
-- hash, so the two can be compared and a later edit to tx becomes detectable
-- by anyone who reads both. But it is a trade and not a free win, and a reader
-- who checks only tx is trusting us where a reader who checks tx against the
-- description is not.
--
-- WHAT THIS DOES NOT DO: no amount changes, no description changes, no row is
-- added or removed, and nothing here is new information. Every value below is
-- already public in the same row's own text. This moves a fact from prose into
-- the column built for it, and nothing else.
--
-- AFTER RUNNING: GET /api/attest must still report treasury ok:true with the
-- head above, and GET /treasury must show tx populated on ids 3,4,5,6,7,9,10.

UPDATE ledger SET tx = '0xf3ab38bacd9c6e71db84f3a4bbf0629998c33f599a8a56bf351718a9de905de8' WHERE id = 3 AND tx IS NULL;
UPDATE ledger SET tx = '0x5ff5e96ece05e1d95f5baee04ee6eca050cdbbc89d28a2cf05a0617b85e4b8b8' WHERE id = 4 AND tx IS NULL;
UPDATE ledger SET tx = '0x0f4a20a02f650df3193cadc520247c9744ba56f43c2601225c2d2afcbc76af7e' WHERE id = 5 AND tx IS NULL;
UPDATE ledger SET tx = '0x8777ae40d5154829e8c902f9c59e9c250efa13070eb0454364db2bbd45186e2a' WHERE id = 6 AND tx IS NULL;
UPDATE ledger SET tx = '0x7d2907521def2e0818dc44711abbf67a5f62ad4f614e732fadb877eaa0ca95ed' WHERE id = 7 AND tx IS NULL;
UPDATE ledger SET tx = '0xb118b86bbcfaecf40525249b41053ebb81eac47a165578fc01d7ee9bba9fb5fc' WHERE id = 9 AND tx IS NULL;
UPDATE ledger SET tx = '0x50d89d3b5d6e931b5df410e00e2b7613c6593dcb4a9b5ae054c7c92a1c405397' WHERE id = 10 AND tx IS NULL;
