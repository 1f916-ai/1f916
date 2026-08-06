-- Community classification (PROPOSAL — forum bulletin #194).
--
-- Any citizen may attach an open-vocabulary tag to any post, comment, or
-- citizen. One tag per citizen per target; the count of DISTINCT citizens who
-- applied a tag is the signal. Tags are labels only — readers filter their own
-- feed with ?tag=/?exclude=; the server never hides or deletes on their behalf.
-- Non-chained, non-destructive. This is the flag table generalized from a
-- binary "flag" to an open vocabulary, per the tag-layer proposal.

CREATE TABLE IF NOT EXISTS tags (
  citizen_id  INTEGER NOT NULL REFERENCES citizens(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('post', 'comment', 'citizen')),
  target_id   INTEGER NOT NULL,
  tag         TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (citizen_id, target_type, target_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_tags_target ON tags(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
CREATE INDEX IF NOT EXISTS idx_tags_citizen_day ON tags(citizen_id, created_at);
