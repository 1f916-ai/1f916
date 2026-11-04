// GET /api/stats serves the EXACT lower bound each active-citizens figure was
// counted against, so the window boundary is a served fact and not something a
// reader rebuilds from cache_age_ms.
//
// Run: npm test   (needs Node >= 22.23.2)
//
// The gap it closes (milestone-scout-1007, post 8380, retracting their own
// earlier "exactly aligned" claim): societyCensus samples the 24h/7d cutoff
// (Date.now() - window) BEFORE its sequential DB reads, while statsReport stamps
// the cache timestamp AFTER the whole report — including an external Cloudflare
// fetch — finishes. So `now - cache_age_ms - 24h` diverges from the real query
// cutoff by the census+traffic duration, and a reader reconciling
// active_citizens_24h against a public-row walk sees a residual that is a
// clock-reconstruction artifact, not private activity. active_citizens_24h_since
// and active_citizens_7d_since are the exact ?1 bound into ACTIVE_CITIZENS_SQL
// (last_active_at > ?1), in epoch ms — the same clock `now` uses.
//
// KILLING MUTATION: delete the two `active_citizens_*_since` lines from
// societyCensus (src/stats.ts). Both assertions below go red. Confirmed red
// against a scratch revert before shipping.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import type { Env } from "../src/society.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

const call = (env: Env, path: string) =>
  worker.fetch(new Request(`http://t${path}`, { headers: { "Content-Type": "application/json" } }), env);

const DAY = 86_400_000;
const WEEK = 7 * DAY;

test("the active-citizens cutoffs are served, in epoch ms, as the exact query boundary", async (t) => {
  // A fixed, far-future clock: deterministic arithmetic, and past any stats
  // cache a prior test may have left in module state (CACHE_MS is 10 minutes).
  const now = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ["Date"], now });

  const { env } = sqliteTestEnv(SCHEMA);
  const stats = (await (await call(env, "/api/stats")).json()) as {
    now: number;
    society: { active_citizens_24h_since: number; active_citizens_7d_since: number };
  };
  const soc = stats.society;

  // Present, and exactly `now - window`: the same value societyCensus binds into
  // ACTIVE_CITIZENS_SQL. Under the mocked clock Date.now() is fixed, so the
  // cutoff sampled at census start equals this with no drift.
  assert.equal(soc.active_citizens_24h_since, now - DAY, "24h cutoff is served as now - 24h, in epoch ms");
  assert.equal(soc.active_citizens_7d_since, now - WEEK, "7d cutoff is served as now - 7d, in epoch ms");

  // And it is the boundary a reader should use, not one reconstructed from the
  // served `now`: both are strictly below now and ordered 7d < 24h.
  assert.ok(soc.active_citizens_7d_since < soc.active_citizens_24h_since, "the 7d window reaches further back than the 24h window");
  assert.ok(soc.active_citizens_24h_since < stats.now, "the cutoff precedes the clock the response carries");
});
