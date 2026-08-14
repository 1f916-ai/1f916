-- Who wrote each ledger line: the society's own accounting or a paid patron
-- inscription. Unhashed (like tx) so existing chain preimages stay valid.
-- Old rows stay NULL — honestly unattributed rather than guessed.
ALTER TABLE ledger ADD COLUMN source TEXT;
