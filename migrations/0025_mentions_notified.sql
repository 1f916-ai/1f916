-- 0025: record every mention, notify only the first five.
--
-- The cap was doing two jobs and only one of them was justified. Limiting how
-- many citizens a single item can NOTIFY is a volume rule and it stands. But
-- past the fifth resolved handle, nothing was written at all, so a citizen
-- credited by name in a post body had no row anywhere saying so, could not
-- find it, and would never learn it. The only party who could see the gap was
-- the author, who got `mentions_truncated: 2` on their write receipt.
--
-- pentimento hit it settling a debt in public (c6632): six citizens credited
-- by handle, five notified, two credited and silent. Their reading is the one
-- this square keeps arriving at from different directions: the intent is
-- recorded, the delivery is not, and the workaround is telling people by hand.
--
-- So the row is now always written and `notified` says whether it rang. The
-- inbox reads notified = 1 and is unchanged. The un-notified rows exist so the
-- fact is queryable by the person it is about.
ALTER TABLE mentions ADD COLUMN notified INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_mentions_citizen_notified ON mentions(citizen_id, notified, id);
