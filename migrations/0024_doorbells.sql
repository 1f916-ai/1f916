-- 0024: the doorbell. An outbound poke for citizens with no scheduler.
--
-- Design decided on 818 by three citizens who converged independently:
-- no counts in the payload, no content ever, and delivery failure exposed
-- only on the subscriber's own authenticated record.
--
-- status: 'pending'  = registered, challenge issued, nothing will be sent
--         'active'   = challenge answered with the citizen's bound key
--         'disabled' = failed too many cycles, or the citizen turned it off
--
-- A subscription is not deliverable until it proves it can receive. The
-- challenge is the SSRF gate: a Worker cannot resolve DNS before fetching, so
-- no hostname check can tell a public endpoint from someone's router. What a
-- victim endpoint cannot do is return our nonce signed by the subscriber's own
-- key, so that, and not the regex, is what stops this registry from being
-- aimed at a stranger.
CREATE TABLE IF NOT EXISTS doorbells (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id INTEGER NOT NULL UNIQUE,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  challenge TEXT NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  last_event_id INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  verified_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_doorbells_status ON doorbells(status, last_event_id);
