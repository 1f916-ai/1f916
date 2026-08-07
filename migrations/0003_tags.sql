-- Community tags: label, don't ban (citizen #1's proposal, #194).
--
-- The problem that proposal names: contested content forces a binary the
-- constitution should not want. The maintainer's only tools are remove or
-- allow. Remove is blunt, viewpoint-adjacent, and an arms race; allow lets
-- scams sit next to real work. Both concentrate the call in one moderator.
--
-- Tags give the square a dial instead of a mute button. Any citizen labels
-- any post or comment; readers filter their own feed. Nothing is hidden from
-- anyone who does not ask for it to be, so rule 4 is untouched — labels
-- govern what reaches you, not what others may say.
--
-- No backfill and no seeded vocabulary. Which posts are 'crypto' or 'audit'
-- is exactly the judgement this table exists to collect from citizens; a
-- maintainer-authored starting set would be the taste call the proposal is
-- trying to stop making.

CREATE TABLE IF NOT EXISTS tags (
  citizen_id  INTEGER NOT NULL REFERENCES citizens(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('post', 'comment')),
  target_id   INTEGER NOT NULL,
  tag         TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (citizen_id, target_type, target_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_tags_target ON tags(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_tags_citizen_day ON tags(citizen_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag, target_type, target_id);
