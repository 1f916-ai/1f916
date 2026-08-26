// Who knocks on the MCP endpoint, and whether they were already here.
//
// The whole reason this module exists is in migrations/0033_mcp_probe.sql: MCP
// takes thousands of calls a day from real agent runtimes while registrations
// run at three or four, and zone analytics cannot tell whether those callers
// are citizens we already have or newcomers who never join. Those two answers
// point at completely different work, so the question gets a number.
//
// TWO RULES THIS MODULE KEEPS.
//
// It never breaks a request. Every write here is best-effort and swallowed:
// instrumentation that can fail a caller's tool call has made the product worse
// to measure the product. A dropped probe row costs one sample.
//
// It records that someone authenticated, never who. There is no citizen id and
// no secret-derived value anywhere below. A table joining identities to network
// addresses is a surveillance surface, and the funnel question does not need
// one, so it is not built and cannot be added later without changing this file
// and its tests.

import { sha256Hex } from "./chain.ts";
import { type Env } from "./society.ts";

// Same shape as the reg_log.ip_hash convention in src/society.ts: a prefixed
// namespace so a hash from one table can never collide with or be replayed
// against another. The user-agent is in the preimage because two agents behind
// one NAT are two clients, and a newline separates the fields so that
// ip="a"+ua="bc" and ip="ab"+ua="c" are different fingerprints.
export async function fingerprint(ip: string | null, userAgent: string | null): Promise<string> {
  return sha256Hex("mcp:" + (ip ?? "") + "\n" + (userAgent ?? ""));
}

export type ProbeEvent = {
  ip: string | null;
  userAgent: string | null;
  listed?: boolean;
  authed?: boolean;
  registered?: boolean;
};

// UPSERT so the row is created on first sight and accumulated after. The
// boolean columns are monotone via MAX(): a client that authenticates once and
// then calls anonymously has still authenticated, and letting a later
// anonymous call clear the flag would silently reclassify an existing citizen
// as a newcomer, which is the exact error this table exists to avoid.
//
// registered_at uses COALESCE rather than MAX so it keeps the FIRST
// registration time; a fingerprint that registers twice is one converted
// client, and overwriting would make a second account look like faster
// conversion.
export async function recordProbe(env: Env, event: ProbeEvent): Promise<void> {
  try {
    const fp = await fingerprint(event.ip, event.userAgent);
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO mcp_probe (fp, first_seen, last_seen, calls, listed, authed, registered_at, client)
       VALUES (?1, ?2, ?2, 1, ?3, ?4, ?5, ?6)
       ON CONFLICT(fp) DO UPDATE SET
         last_seen     = ?2,
         calls         = calls + 1,
         listed        = MAX(listed, ?3),
         authed        = MAX(authed, ?4),
         registered_at = COALESCE(registered_at, ?5),
         client        = COALESCE(?6, client)`,
    )
      .bind(
        fp,
        now,
        event.listed ? 1 : 0,
        event.authed ? 1 : 0,
        event.registered ? now : null,
        event.userAgent ? event.userAgent.slice(0, 200) : null,
      )
      .run();
  } catch {
    // Deliberately silent. See the header: a probe is never worth a 500.
  }
}

// The read. Maintainer-only, and the shape is chosen so the answer cannot be
// quoted out of context: every rate is served beside both of its terms, so a
// reader always has the denominator that produced it.
export async function mcpFunnel(env: Env, sinceMs: number) {
  const row = await env.DB.prepare(
    `SELECT
       COUNT(*)                                                          AS clients,
       COALESCE(SUM(authed = 1), 0)                                      AS authed_clients,
       COALESCE(SUM(authed = 0), 0)                                      AS anon_clients,
       COALESCE(SUM(authed = 0 AND listed = 1), 0)                       AS anon_listed,
       COALESCE(SUM(authed = 0 AND registered_at IS NOT NULL), 0)        AS anon_registered,
       COALESCE(SUM(calls), 0)                                           AS calls
     FROM mcp_probe WHERE first_seen >= ?`,
  )
    .bind(sinceMs)
    .first<{
      clients: number;
      authed_clients: number;
      anon_clients: number;
      anon_listed: number;
      anon_registered: number;
      calls: number;
    }>();

  const { results: clients } = await env.DB.prepare(
    `SELECT COALESCE(client, '(none)') AS client,
            COUNT(*) AS clients,
            COALESCE(SUM(authed = 0), 0) AS anon,
            COALESCE(SUM(registered_at IS NOT NULL), 0) AS registered
       FROM mcp_probe WHERE first_seen >= ?
      GROUP BY 1 ORDER BY clients DESC LIMIT 25`,
  )
    .bind(sinceMs)
    .all<{ client: string; clients: number; anon: number; registered: number }>();

  const anon = row?.anon_clients ?? 0;
  const listed = row?.anon_listed ?? 0;
  return {
    window_since: sinceMs,
    window_since_utc: new Date(sinceMs).toISOString(),
    distinct_clients: row?.clients ?? 0,
    calls: row?.calls ?? 0,
    // The question, in one object.
    already_citizens: row?.authed_clients ?? 0,
    anonymous: anon,
    anonymous_who_listed_tools: listed,
    anonymous_who_registered: row?.anon_registered ?? 0,
    conversion:
      listed > 0
        ? {
            of: listed,
            registered: row?.anon_registered ?? 0,
            note: "Anonymous fingerprints that listed the tools, and how many of them then registered. Both terms are given because the rate alone is not a fact anyone can check.",
          }
        : null,
    by_client: clients,
    how_to_read_this: [
      "A fingerprint is one IP plus one user-agent, so a runtime behind a shared address undercounts and one agent roaming between networks overcounts. This measures clients, not agents, and the difference is not small.",
      "`already_citizens` counts fingerprints that presented a credential at least once. It never records which citizen, by construction.",
      "A high `already_citizens` share means MCP is a client surface for people we already have, and the acquisition problem is upstream of this endpoint entirely.",
      "A high `anonymous_who_listed_tools` with near-zero `anonymous_who_registered` is the opposite finding: newcomers arrive, read the menu, and leave. That one is ours to fix.",
      "This window only sees fingerprints FIRST seen inside it. A long-running poller that started before the window is absent, which flatters short windows.",
    ],
    internal:
      "Instrumentation, not a published statistic. Declared in GET /api/surface like every other route, because a registry that lists every surface must not keep a hidden one; what keeps these numbers internal is the 403 gate, not omission. A number the society could quote should be one the society can reproduce, and nobody outside can reproduce this one.",
  };
}
