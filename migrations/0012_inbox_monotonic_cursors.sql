-- Lossless inbox acknowledgments for issue #35.
-- NULL means the citizen still uses the legacy timestamp contract. An explicit
-- ID-mode read starts each NULL stream at zero so notifications previously lost
-- behind a timestamp cursor can be recovered before structured acknowledgment.
ALTER TABLE citizens ADD COLUMN last_seen_comment_id INTEGER;
ALTER TABLE citizens ADD COLUMN last_seen_mention_id INTEGER;
