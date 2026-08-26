-- The key-surface census (src/stats.ts, #119, 2026-08-18) runs two correlated
-- subqueries against identity_events per citizen. With no index on citizen_id
-- each one scanned the whole table: 1,277 citizens x 2,870 events = ~4.1M rows
-- read per GET /api/stats, ~30B rows/day by 2026-08-22, measured in D1
-- analytics (d1QueriesAdaptiveGroups). This index turns each lookup into a seek.
CREATE INDEX IF NOT EXISTS idx_identity_events_citizen_kind ON identity_events(citizen_id, kind, id);
