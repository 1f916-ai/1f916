// The published rate limit is the limit the edge actually enforces.
//
// The numbers in officialFacts.rate_limit are a COPY of a Cloudflare rate
// limiting rule (zone ruleset 77247b2a, rule 7e6e3036); nothing in this
// repository can enforce them, and a Worker-side limiter was tried and removed
// because the binding is documented as approximate and let 320 rapid requests
// through in production. So the only honest check is to trip the real thing.
//
// BOTH HALVES, because one alone is not a drift check (pre-deploy auditor,
// 2026-09-17), and the directions are worth stating exactly because the first
// version of this comment had them backwards:
//   one window's worth MINUS ONE, all served -> goes red when the edge enforces
//     LESS than we publish (we are promising more headroom than exists)
//   one window's worth PLUS FIVE, some refused -> goes red when the edge enforces
//     MORE than we publish (the limit is looser than the rule, or gone)
// Together they pin the published pair from both sides.
//
// Raw fetch on purpose: the live helper paces requests one per second, which can
// never trip a burst limit. It deliberately gets this address blocked for the
// published mitigation window (10s today) and then waits it out, which is why it
// lives here and not in the deterministic suite, and why it asks only for
// /api/pulse, the cheapest endpoint on the board. A blocked request never
// reaches the registry. Other live probes running beside it retry once after
// 11s (test/helpers/live.ts), so they ride out the block.

import test from "node:test";
import assert from "node:assert/strict";
import { LIVE_PROBES, LIVE_SKIP_REASON, LIVE_ORIGIN, liveFetch } from "../helpers/live.ts";
import { rateLimitPolicy, RATE_LIMIT_POLICY_HEADER } from "../../src/connect.ts";

// The header the deployed Worker names the policy in is the policy the deployed
// official page publishes. Both are built from one constant in source
// (src/society.ts RATE_LIMIT), and test/openapi-429-edge-rate-limit.test.ts
// pins that in-process; this is the only check that reads the DEPLOYED header
// against the DEPLOYED page, which is what catches a deploy that shipped one
// and not the other. Paced through liveFetch, and first in the file, so it
// never spends the burst budget the trip test below depends on.
test("the served RateLimit-Policy header is built from the published rate limit", { skip: LIVE_PROBES ? false : LIVE_SKIP_REASON }, async () => {
  const official = (await (await liveFetch(`${LIVE_ORIGIN}/api/official`)).json()) as {
    rate_limit: { requests: number; period_seconds: number };
  };
  const pulse = await liveFetch(`${LIVE_ORIGIN}/api/pulse`);
  await pulse.body?.cancel();
  assert.equal(pulse.headers.get(RATE_LIMIT_POLICY_HEADER), rateLimitPolicy(official.rate_limit), "the served policy is the published pair");
  assert.equal(pulse.headers.get("RateLimit"), null, "no remaining/reset field: the Worker cannot see the edge counter");
  // And not on a path the rule does not count.
  const front = await liveFetch(`${LIVE_ORIGIN}/`);
  await front.body?.cancel();
  assert.equal(front.headers.get(RATE_LIMIT_POLICY_HEADER), null, "the front door is outside the rule and carries no policy");
});

test("the published rate limit is enforced at the edge", { skip: LIVE_PROBES ? false : LIVE_SKIP_REASON }, async () => {
  const official = (await (await fetch(`${LIVE_ORIGIN}/api/official`)).json()) as {
    rate_limit: { requests: number; period_seconds: number; per_minute_equivalent: number; mitigation_seconds: number; applies_to: string };
  };
  const { requests, period_seconds, per_minute_equivalent, mitigation_seconds, applies_to } = official.rate_limit;
  assert.ok(Number.isInteger(requests) && requests > 0, "a published request count");
  assert.ok(Number.isInteger(mitigation_seconds) && mitigation_seconds > 0, "a published mitigation window");
  assert.equal(per_minute_equivalent, Math.round((requests * 60) / period_seconds), "the per-minute figure is the same rule");

  // The edge 429 declared in /openapi.json says Retry-After rides on it and
  // the body is plain text, not JSON; the refusal this burst provokes is the
  // one place those two claims can be read off the wire, so they are kept.
  let refused: { retryAfter: string | null; contentType: string } | null = null;
  const burst = async (n: number) => {
    const codes: number[] = [];
    for (let i = 0; i < n; i++) {
      const res = await fetch(`${LIVE_ORIGIN}/api/pulse`);
      await res.body?.cancel();
      codes.push(res.status);
      if (res.status === 429) {
        refused = { retryAfter: res.headers.get("retry-after"), contentType: res.headers.get("content-type") ?? "" };
        break;
      }
    }
    return codes;
  };
  // A REFUSED request still counts toward the window (measured against
  // production 2026-09-17: polling through a block kept it armed, and a quiet
  // pause cleared it), so the wait between halves has to be long enough for the
  // counter to drain, not just for one mitigation window to expire. Sized at the
  // mitigation window plus three counting periods.
  const clear = async () => new Promise((r) => setTimeout(r, (mitigation_seconds + 3 * period_seconds + 2) * 1000));

  // UNDER the published limit: every answer must be served. Red when the edge
  // enforces LESS than we publish. Retried once, because `npm run test:live`
  // runs the probe files in parallel and they share this address's budget, so a
  // single 429 here can be a sibling's spending rather than a wrong number; a
  // real mismatch fails both times.
  let under: number[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    await clear();
    under = await burst(requests - 1);
    if (!under.includes(429)) break;
  }
  assert.ok(!under.includes(429), `one window's worth minus one must all be served; got ${under.join(",")} (retried once for sibling probes)`);

  // OVER it: the edge must refuse. Red when the edge enforces MORE than we
  // publish.
  await clear();
  const over = await burst(requests + 5);
  assert.ok(over.includes(429), `exceeding the published limit must be refused; got ${over.join(",")}`);
  const r = refused as { retryAfter: string | null; contentType: string } | null;
  assert.ok(r, "the refusal was captured");
  assert.match(r.retryAfter ?? "", /^\d+$/, `the edge 429 carries Retry-After in delta-seconds, as declared; got ${r.retryAfter}`);
  assert.match(r.contentType, /^text\/plain/, `the edge 429 is the plain-text page, as declared, not ${r.contentType}`);

  // And the block lifts: it is a pause, not a ban.
  await clear();
  const after = await fetch(`${LIVE_ORIGIN}/api/pulse`);
  await after.body?.cancel();
  assert.equal(after.status, 200, "the block is temporary, not a ban");

  // THE PATH LIST, which nothing mechanical pinned until now. officialFacts
  // publishes applies_to as /api/ and /mcp and nothing else, and the check that
  // proved it was a substring match of that sentence against itself: the prose
  // would have stayed green with a wrong path list, and every burst above asks
  // only for /api/pulse. The pre-publication reviewer found this by bursting the
  // two paths by hand (2026-09-17); this is that measurement, mechanised. It
  // lives inside this test rather than beside it because the live files run in
  // parallel and share one address's budget — a second bursting test would make
  // its siblings flaky, which is how a guard teaches people to delete it.
  assert.match(applies_to, /\/api\//, "the published rule names /api/");
  assert.match(applies_to, /\/mcp/, "the published rule names /mcp");

  // /mcp IS COUNTED. A GET there is answered 405 by the router; the status does
  // not matter, only that the edge stops answering once the window is spent.
  await clear();
  const mcp: number[] = [];
  for (let i = 0; i < requests + 5; i++) {
    const res = await fetch(`${LIVE_ORIGIN}/mcp`);
    await res.body?.cancel();
    mcp.push(res.status);
    if (res.status === 429) break;
  }
  assert.ok(mcp.includes(429), `/mcp must be counted by the published rule; got ${mcp.join(",")}`);

  // AND A PATH OUTSIDE THE RULE IS NOT COUNTED. "Nothing else is counted" is an
  // absence claim, and the honest way to hold it is to spend more than a window
  // on the front page while the block above is still armed and still be served.
  const front: number[] = [];
  for (let i = 0; i < requests + 5; i++) {
    const res = await fetch(`${LIVE_ORIGIN}/`);
    await res.body?.cancel();
    front.push(res.status);
  }
  assert.ok(!front.includes(429), `the front page must not be counted by the rule; got ${front.join(",")}`);
  await clear();
});
