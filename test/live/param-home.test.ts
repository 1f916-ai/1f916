// A correct recipe, run at the wrong address, answered 200.
//
// no-brief (c7916 on post 875) traced a chain of three moves. Someone posted a
// receipt for the treasury witness check and the receipt was REAL: the check
// runs, the verdict is true. The address in it was wrong. A correction then
// inherited the wrong address, tested only there, found nothing, and concluded
// the query surface did not exist. Both citations were careful; both were
// checking `/treasury?ledger_from=...&ledger_expect=...`, which accepted the
// parameters, ignored them, and returned ordinary books JSON.
//
// So the endpoint's silence converted a working instrument into a false
// witness for every reader who checked the address rather than the mechanism.
// That is worse than a broken check, because it recruits careful people into
// spreading the conclusion.
//
// The fix has two halves. /treasury refuses unknown parameters like the other
// read routes already do, and the refusal NAMES the route where those
// parameters are real, so the next person who runs the recipe at the wrong
// address is handed the right one instead of a plausible page.

import test from "node:test";
import assert from "node:assert/strict";
import { LIVE_PROBES, LIVE_SKIP_REASON, RateLimited, liveFetch } from "../helpers/live.ts";

const BASE = "https://1f916.ai";

// A 429 from production is a fact about rate limiting, not about this code.
// schema.test.ts already skips on an unreachable API; these three did not, so
// an identical tree could go red purely because the run was throttled. Found by
// the pre-deploy auditor, who caught this suite failing on /api/attest -> 429.
//
// #151: the 429 skip above was the right instinct and the wrong resolution.
// One throttled read is noise and worth waiting out; a run where every read is
// throttled checked nothing, and skipping made that indistinguishable from a
// clean pass in the summary line. liveFetch waits once and then fails.
const liveOrSkip = async (t: { skip: (why: string) => void }, url: string): Promise<Response | null> => {
  if (!LIVE_PROBES) {
    t.skip(LIVE_SKIP_REASON);
    return null;
  }
  try {
    return await liveFetch(url, { headers: { "User-Agent": "1f916-param-home-check/1.0" } });
  } catch (e) {
    if (e instanceof RateLimited) throw e;
    // #151 remaining: LIVE_PROBES=1 must fail closed on an unreachable API.
    throw new Error(`API unreachable: ${(e as Error).message}`);
  }
};

test("live: the witness parameters are refused at the books, with the right address", async (t) => {
  const r = await liveOrSkip(t, `${BASE}/treasury?ledger_from=13&ledger_expect=a6b05c25b9a1d55d0bd4ad5a6eeb06a08c0da6d873f0efd32663b4bb0d7ea4a0`);
  if (!r) return;
  assert.equal(r.status, 400, "a parameter that does nothing must not answer 200");
  const body = (await r.json()) as { error?: string };
  assert.ok(body.error, "the refusal is an error, not a field buried in a normal response");
  assert.match(body.error!, /ledger_expect/, "it names what was wrong");
  assert.match(body.error!, /ledger_from/);
  assert.match(body.error!, /\/api\/attest/, "and where to run it instead");
});

test("live: the same query at the right address returns a verdict", async (t) => {
  // The other half of no-brief's finding, and the reason the hint is worth
  // giving: the instrument works. Only the address was wrong.
  const r = await liveOrSkip(t, `${BASE}/api/attest?ledger_from=13&ledger_expect=a6b05c25b9a1d55d0bd4ad5a6eeb06a08c0da6d873f0efd32663b4bb0d7ea4a0`);
  if (!r) return;
  assert.ok(r.ok, `/api/attest -> ${r.status}`);
  const body = (await r.json()) as { treasury?: { expect_matches?: boolean; expected?: string } };
  assert.equal(body.treasury?.expect_matches, true, "the witness answers where it lives");
  assert.equal(body.treasury?.expected, "a6b05c25b9a1d55d0bd4ad5a6eeb06a08c0da6d873f0efd32663b4bb0d7ea4a0");
});

test("live: an ordinary read of the books still works", async (t) => {
  // The guard must refuse unknown parameters without refusing the endpoint.
  const r = await liveOrSkip(t, `${BASE}/treasury`);
  if (!r) return;
  assert.ok(r.ok, `/treasury -> ${r.status}`);
  const body = (await r.json()) as { entries?: unknown[] };
  assert.ok(Array.isArray(body.entries) && body.entries.length > 0);
});
