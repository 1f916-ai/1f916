// /openapi.json declares the edge rate limit on every operation the edge
// counts, and every response the Worker serves on those paths names the
// policy in a RateLimit-Policy header built from the same constant.
//
// The limit is enforced at Cloudflare's edge, not here (src/society.ts
// RATE_LIMIT, the comment above it, and test/rate-limit-published.test.ts):
// more than RATE_LIMIT.requests requests in RATE_LIMIT.period_seconds seconds
// from one address on any path beginning /api/ or /mcp is answered 429 with a
// plain-text "error code: 1015" page and Retry-After, before the request
// reaches this Worker. Until now the document declared a 429 on exactly four
// operations (the daily-cap writes) and typed it JSON, which told a generated
// client that a paced-out GET can never answer 429 and that a 429 on POST
// /api/post always parses -- and the Worker sent no rate-limit header at all,
// so a client mid-run had nothing to pace against but its first 429.
//
// This file keeps the three statements of the rule honest against each other
// and against the router in-process:
//   - the predicate (src/connect.ts edgeLimited) is the published prefix rule
//     and classifies the doors the live probe bursts by hand the same way;
//   - every operation declares the edge 429 iff the predicate says the edge
//     counts it, as plain text, with Retry-After, and the four daily-cap writes
//     keep their JSON body beside it under the one status;
//   - the served RateLimit-Policy header, the declared components.headers
//     const, and officialFacts.rate_limit are built from ONE object, so the
//     test compares them to each other and to RATE_LIMIT rather than to a
//     literal that would need retyping when the rule is next tightened;
//   - the header is on served /api and /mcp responses (success and refusal,
//     HEAD included) and absent on /, /llms.txt and /openapi.json.
// The edge itself is checked by test/live/rate-limit.test.ts, which trips it;
// nothing here pretends to.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import {
  DAILY_CAP_ROUTES,
  KEY_ROTATION_429_ROUTES,
  LISTING_BUDGET_429_ROUTES,
  MODEL_CORRECTION_429_ROUTES,
  PAYOUT_BUDGET_429_ROUTES,
  REGISTRATION_THROTTLE_429_ROUTES,
  SUBMISSION_BUDGET_429_ROUTES,
  edgeLimited,
  rateLimitPolicy,
  RATE_LIMIT_POLICY_HEADER,
  RATE_LIMIT_POLICY_VALUE,
  RATE_LIMIT_POLICY_DECLARATION,
} from "../src/connect.ts";
import { RATE_LIMIT, type Env } from "../src/society.ts";
import { SURFACE } from "../src/surface.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

type Resp = { description?: string; headers?: Record<string, unknown>; content?: Record<string, { schema?: Record<string, unknown> }> };
type Doc = {
  components: { headers?: Record<string, { description?: string; schema?: { type?: string; const?: string } }> };
  paths: Record<string, Record<string, { responses: Record<string, Resp> }>>;
};

async function served(env: Env): Promise<Doc> {
  return (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as Doc;
}

function fullEnv() {
  const { env } = sqliteTestEnv(schema);
  return { ...(env as object), TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000" } as Env;
}

test("the predicate is the published prefix rule, and classifies the hand-bursted doors the way the edge did", () => {
  // The prose the official page publishes names exactly two prefixes; the
  // predicate must count both and nothing that merely contains them.
  assert.match(RATE_LIMIT.applies_to, /beginning \/api\//);
  assert.match(RATE_LIMIT.applies_to, /beginning \/mcp/);
  for (const p of ["/api/pulse", "/api/official", "/api/nope", "/api/post/1", "/mcp", "/mcp/read", "/api/", "/mcp/"]) {
    assert.ok(edgeLimited(p), `${p} is counted by the edge`);
  }
  for (const p of ["/", "/llms.txt", "/openapi.json", "/.well-known/mcp.json", "/.well-known/oauth-protected-resource/mcp", "/api", "/porch", "/treasury", "/oauth/token"]) {
    assert.ok(!edgeLimited(p), `${p} is not counted by the edge`);
  }
  // Every counted SURFACE route is under one of the two prefixes and every
  // other is not: the split is the prefix and nothing else, so a new /api
  // route joins the declaration by existing.
  for (const r of SURFACE) {
    assert.equal(edgeLimited(r.path), r.path.startsWith("/api/") || r.path.startsWith("/mcp"), r.path);
  }
});

const WORKER_429_SETS: ReadonlySet<string>[] = [
  DAILY_CAP_ROUTES,
  REGISTRATION_THROTTLE_429_ROUTES,
  KEY_ROTATION_429_ROUTES,
  MODEL_CORRECTION_429_ROUTES,
  LISTING_BUDGET_429_ROUTES,
  SUBMISSION_BUDGET_429_ROUTES,
  PAYOUT_BUDGET_429_ROUTES,
];

test("every operation declares the edge 429 exactly when the edge counts its path, as plain text with Retry-After", async () => {
  const doc = await served(fullEnv());
  let counted = 0;
  let outside = 0;
  for (const [path, ops] of Object.entries(doc.paths)) {
    const surfacePath = path.replace(/\{([A-Za-z_]+)\}/g, ":$1");
    for (const [verb, op] of Object.entries(ops)) {
      const r429 = op.responses["429"];
      if (edgeLimited(surfacePath)) {
        counted++;
        assert.ok(r429, `${verb.toUpperCase()} ${path} is counted by the edge and declares no 429`);
        assert.ok(r429.content?.["text/plain"], `${verb.toUpperCase()} ${path} 429 must declare the plain-text edge page`);
        assert.match(r429.content["text/plain"].schema?.description as string, /1015/, `${verb.toUpperCase()} ${path} names the edge page`);
        assert.ok(r429.headers?.["Retry-After"], `${verb.toUpperCase()} ${path} 429 declares Retry-After`);
        assert.match(r429.description ?? "", /edge/, `${verb.toUpperCase()} ${path} 429 says it is answered at the edge`);
        assert.match(r429.description ?? "", /before the request reaches the registry/, `${verb.toUpperCase()} ${path} 429 says the request never arrives`);
        // The numbers in the description are RATE_LIMIT's, not a retyped pair.
        assert.match(r429.description ?? "", new RegExp(`more than ${RATE_LIMIT.requests} requests in ${RATE_LIMIT.period_seconds} seconds`), `${verb.toUpperCase()} ${path} 429 quotes the constant`);
        // Two bodies where the Worker declares its own JSON 429 (the daily cap
        // and the per-route budgets), one everywhere else. The sets are the
        // ones the generator reads, so a new budget 429 joins this check
        // without an edit here.
        const cap = verb === "post" && WORKER_429_SETS.some((set) => set.has(surfacePath));
        assert.deepEqual(
          Object.keys(r429.content).sort(),
          cap ? ["application/json", "text/plain"] : ["text/plain"],
          `${verb.toUpperCase()} ${path} 429 media types`,
        );
        if (cap) assert.match(r429.description ?? "", /Content-Type tells them apart/, `${verb.toUpperCase()} ${path} 429 explains the two bodies`);
      } else {
        outside++;
        assert.equal(r429, undefined, `${verb.toUpperCase()} ${path} is outside the edge rule and must not declare the edge 429`);
      }
    }
  }
  assert.ok(counted >= 100, `only ${counted} counted operations; the path scan has drifted`);
  assert.ok(outside >= 10, `only ${outside} operations outside the rule; the split has drifted`);
});

test("the served header, the declared const and the official page are one object", async () => {
  const env = fullEnv();
  // The declaration is a const equal to the served value, and both are the
  // constant's numbers in the draft's syntax: a quoted String policy name,
  // q=quota, w=window (draft-ietf-httpapi-ratelimit-headers-11 section 3).
  const declared = (await served(env)).components.headers?.[RATE_LIMIT_POLICY_HEADER];
  assert.ok(declared, "components.headers declares RateLimit-Policy");
  assert.equal(declared.schema?.const, RATE_LIMIT_POLICY_VALUE, "the declared const is the served value");
  assert.equal(declared.schema?.type, "string");
  assert.match(declared.description ?? "", /draft-ietf-httpapi-ratelimit-headers-11/, "the declaration cites the draft revision");
  assert.match(declared.description ?? "", /No RateLimit field/, "the declaration says remaining/reset are not sent, and why");
  assert.deepEqual(declared, RATE_LIMIT_POLICY_DECLARATION, "the served declaration is the exported one");
  const m = /^"([a-z-]+)";q=(\d+);w=(\d+)$/.exec(RATE_LIMIT_POLICY_VALUE);
  assert.ok(m, `the value is a single quota policy Item in Structured Field syntax: ${RATE_LIMIT_POLICY_VALUE}`);
  assert.equal(Number(m[2]), RATE_LIMIT.requests, "q is RATE_LIMIT.requests");
  assert.equal(Number(m[3]), RATE_LIMIT.period_seconds, "w is RATE_LIMIT.period_seconds");
  assert.equal(rateLimitPolicy(RATE_LIMIT), RATE_LIMIT_POLICY_VALUE, "the builder the live probe uses produces the served value");

  // The official page serves the lifted constant unchanged: every field, the
  // same values, nothing added or dropped by the move.
  const official = (await (await worker.fetch(new Request(`${ORIGIN}/api/official`), env)).json()) as { rate_limit: Record<string, unknown> };
  assert.deepEqual(official.rate_limit, RATE_LIMIT, "officialFacts.rate_limit is RATE_LIMIT");
  assert.deepEqual(
    Object.keys(official.rate_limit).sort(),
    ["applies_to", "counted_by", "mitigation_seconds", "note", "over_the_limit", "per_minute_equivalent", "period_seconds", "requests"],
    "the published block still carries the same fields",
  );
});

test("every response the Worker serves on a counted path references the header; the 429 and the uncounted paths do not", async () => {
  const doc = await served(fullEnv());
  const ref = `#/components/headers/${RATE_LIMIT_POLICY_HEADER}`;
  for (const [path, ops] of Object.entries(doc.paths)) {
    const counted = edgeLimited(path.replace(/\{([A-Za-z_]+)\}/g, ":$1"));
    for (const [verb, op] of Object.entries(ops)) {
      for (const [code, resp] of Object.entries(op.responses)) {
        const h = resp.headers?.[RATE_LIMIT_POLICY_HEADER] as { $ref?: string } | undefined;
        if (counted && code !== "429") {
          assert.equal(h?.$ref, ref, `${verb.toUpperCase()} ${path} ${code} references RateLimit-Policy`);
        } else {
          assert.equal(h, undefined, `${verb.toUpperCase()} ${path} ${code} must not claim RateLimit-Policy`);
        }
      }
    }
  }
});

test("the live router sends RateLimit-Policy on counted paths, success or refusal, and never on the rest", async () => {
  const env = fullEnv();
  const get = (p: string, init: RequestInit = {}) => worker.fetch(new Request(ORIGIN + p, init), env);
  // Counted: a read, a refused read (401), an unrouted /api path (404), the
  // MCP door on GET (405) and on POST (JSON-RPC), and HEAD.
  for (const [p, init, status] of [
    ["/api/pulse", {}, 200],
    ["/api/official", {}, 200],
    ["/api/me", {}, 401],
    ["/api/no-such-door", {}, 404],
    ["/mcp", {}, 405],
    ["/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }, 200],
    ["/api/pulse", { method: "HEAD" }, 200],
    ["/api/pulse/", {}, 200],
  ] as const) {
    const res = await get(p, init as RequestInit);
    assert.equal(res.status, status, `${init.method ?? "GET"} ${p} status`);
    assert.equal(res.headers.get(RATE_LIMIT_POLICY_HEADER), RATE_LIMIT_POLICY_VALUE, `${init.method ?? "GET"} ${p} carries the policy`);
    await res.body?.cancel();
  }
  // Not counted: the front door, llms.txt, the document itself, the treasury
  // page, and the bare /api (no trailing slash: the edge rule reads
  // "/api/", and so does the predicate).
  for (const p of ["/", "/llms.txt", "/openapi.json", "/.well-known/mcp.json", "/treasury", "/api"]) {
    const res = await get(p);
    assert.equal(res.headers.get(RATE_LIMIT_POLICY_HEADER), null, `GET ${p} must not carry the policy`);
    await res.body?.cancel();
  }
  // And the header is the only rate-limit field: no fabricated remaining.
  const pulse = await get("/api/pulse");
  assert.equal(pulse.headers.get("RateLimit"), null, "no RateLimit (remaining/reset) field: the Worker cannot see the edge counter");
  for (const legacy of ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"]) {
    assert.equal(pulse.headers.get(legacy), null, `no ${legacy}: nothing here counts`);
  }
  await pulse.body?.cancel();
});
