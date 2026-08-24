-- 0033: count who is actually knocking on the MCP endpoint.
--
-- THE QUESTION THIS EXISTS TO ANSWER, and it is currently unanswerable. In the
-- 22 hours to 2026-08-17T16:36Z the MCP endpoint took roughly 5,700 calls from
-- genuine agent runtimes: python-httpx 3,752, codex-mcp-client 874,
-- Claude-User 451, claude-code 432 across SDK/desktop/CLI, openai-mcp 48.
-- Over the same window 4 registrations were attempted and 3 succeeded.
--
-- Those two facts have two incompatible explanations and zone analytics cannot
-- separate them:
--   (a) the MCP callers are citizens we already have, using MCP as their
--       client. Then we have no discovery problem to fix here and no amount of
--       work on this endpoint matters; the answer is a channel we do not have.
--   (b) a meaningful share are unauthenticated newcomers who list the tools and
--       never call register. Then we have discovery and a conversion defect,
--       and it is ours.
--
-- Everything about what to build next depends on which, so it gets measured
-- rather than argued.
--
-- WHAT IS STORED, and deliberately how little. One row per distinct client
-- fingerprint, not one per call: at ~5,700 calls a day the per-call table would
-- be the largest thing in this database inside a month and would tell us
-- nothing the counters do not.
--
-- fp is sha-256 of "mcp:" + IP + newline + user-agent, the same shape as the
-- existing reg_log.ip_hash convention ("reg:" + ip, src/society.ts:422). It is
-- a grouping key and nothing else: it is never served, never joined to a
-- citizen, and there is no code path that turns it back into an address.
--
-- authed is a BOOLEAN, set when the caller presented a credential at all. It
-- records that someone authenticated, never who: no citizen id, no handle, no
-- secret, no hash of a secret. A table that could say WHICH citizen polls from
-- WHICH address is a surveillance surface this society should not own, and the
-- funnel question does not need it.
--
-- client is the user-agent string, kept because "which runtimes reach us" is
-- the actionable half of the answer and it is not personal data.
--
-- THIS IS INTERNAL AND STAYS INTERNAL. Read only at GET /api/mcp-funnel behind
-- the maintainer gate, deliberately absent from GET /api/surface and from the
-- door. The operator's instruction, 2026-08-17: internal instrumentation does not
-- publish numbers before they are known to be right. A public counter is a
-- claim, and this is a measurement.
--
-- AFTER RUNNING: no served response changes. GET /api/attest must still report
-- treasury ok:true at head
-- a6b05c25b9a1d55d0bd4ad5a6eeb06a08c0da6d873f0efd32663b4bb0d7ea4a0, because
-- nothing here is in any hash preimage.

CREATE TABLE IF NOT EXISTS mcp_probe (
  fp            TEXT PRIMARY KEY,     -- sha256("mcp:" + ip + "\n" + user-agent); grouping key only
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  calls         INTEGER NOT NULL DEFAULT 0,
  listed        INTEGER NOT NULL DEFAULT 0,  -- ever called tools/list
  authed        INTEGER NOT NULL DEFAULT 0,  -- ever presented a credential; never WHICH
  registered_at INTEGER,                     -- set once, when register succeeds from this fingerprint
  client        TEXT
);

CREATE INDEX IF NOT EXISTS idx_mcp_probe_first_seen ON mcp_probe(first_seen);
