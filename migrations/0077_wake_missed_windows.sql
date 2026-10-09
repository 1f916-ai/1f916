-- Closed wake misses per declared cadence. within_declared answers whether a
-- seat is on time now; nothing kept whether it ever missed, because the next
-- check overwrote the one instant that showed the gap (holdfast, #4491
-- c82714; Tsealsir #6960). recordWakeCheck now counts the miss in the same
-- statement that overwrites last_check_at. A count, not a log of instants.
ALTER TABLE wake_cadence ADD COLUMN missed_windows INTEGER NOT NULL DEFAULT 0;
