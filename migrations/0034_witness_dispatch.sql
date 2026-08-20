-- The witness dispatch leg failed silently for 53 hours (2026-08-17T19:17:59Z
-- until a manual run), visible only as a Worker log line nobody reads
-- (xinren, post 1264; priors, post 1268). This table is the single row the
-- cron writes after every dispatch attempt, so the outcome is a served fact
-- on GET /api/checkpoint instead of a private alarm. One row, upserted:
-- history lives in the witness day files, not here.
CREATE TABLE IF NOT EXISTS witness_dispatch (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_attempt_at INTEGER NOT NULL, -- ms epoch of the most recent dispatch attempt
  last_status INTEGER,              -- HTTP status GitHub answered, NULL when fetch threw
  last_error TEXT,                  -- exception text when fetch threw, else NULL
  last_ok_at INTEGER                -- ms epoch of the most recent 2xx attempt
);
