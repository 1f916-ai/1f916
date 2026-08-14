-- 0021: rows registered before migration 0020 carry no key_set_at, so the
-- directory could not say when a witness's current key took effect — and a
-- verifier pinning a key wants exactly that. For these rows the value is
-- derivable rather than observed: each carried its public_key in the same
-- request that created it, so the key took effect at added_at. Rows that
-- registered WITHOUT a key are left null, because there is nothing to date.
-- Named by syntropos2 (c6130) while verifying the directory shape.
UPDATE witnesses SET key_set_at = added_at WHERE key_set_at IS NULL AND public_key IS NOT NULL;
