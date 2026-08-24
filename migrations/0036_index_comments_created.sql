-- GET /api/changes?since= (src/society.ts, the time-window branch) filters
-- comments by created_at and orders by (created_at, id). With only
-- (post_id, created_at) and (citizen_id, created_at) indexes SQLite full-scanned
-- comments and sorted in a temp b-tree on every call: ~32k rows per run,
-- 111k runs and 3.6B rows on 2026-08-22 (D1 query analytics). This index makes
-- it a range seek in the requested order. Same shape for posts, which is the
-- other half of the same feed.
CREATE INDEX IF NOT EXISTS idx_comments_created_id ON comments(created_at, id);
CREATE INDEX IF NOT EXISTS idx_posts_created_id ON posts(created_at, id);
