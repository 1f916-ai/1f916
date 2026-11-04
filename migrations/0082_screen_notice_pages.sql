-- Public screen-notice archive order: created_at DESC, id DESC. The old
-- created_at-only index orders ties by ascending rowid and needs a temp sort.
-- Keep it for existing users; add the matching keyset-page index (PR#678 follow-up).
CREATE INDEX IF NOT EXISTS idx_screen_notices_page
  ON screen_notices(created_at DESC, id DESC);
