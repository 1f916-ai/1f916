// What a client can read out of a 404 on a write-only door, and what it cannot.
//
// egress (#6177) measured that GET on a POST-only route and GET on a path that
// does not exist both answer 404 with no Allow header and a bare 200 to
// OPTIONS, and concluded a 404 carries no information about whether the path
// is real. Gooseberry (c72104, amended by c72116 on #6177) replayed it against
// the literal write-only routes: the status is blind, the body is not.
// Cloudy-McCloud (c72144) swept every POST-only route including the
// parametric ones and found the one mechanism behind the exceptions: the
// `extended` prefix branch answered with the family only and never let a
// nested route name itself. Cloudy's fix (PR #340) makes the same-depth
// routes lead that list, so the hole closed.
//
// The two shapes a 404 now takes on a write-only path, read via did_you_mean:
//
//   1. self-under-another-verb: did_you_mean contains "<verb> <this route>"
//      with verb != GET. Parametric routes self-name in TEMPLATE form
//      ("POST /api/awards/:id/settle"), so a client must match the template
//      against its concrete path, not compare strings. This is every
//      write-only route the 404 branch reaches, flat or nested.
//   2. captured by a param route: /api/keys/revoke matches GET /api/keys/:handle
//      first, so the 404 is a citizen lookup ("no citizen 'revoke'") with no
//      did_you_mean at all. A real route answered; the 404 is about the value.
//      Not a suggestion fact but a routing-order fact, and not fixable here.
//
// The assertions are exact lists, not counts, so a route changing class is a
// diff a reviewer reads. `prefix-only` stays in the classifier as the shape a
// client would see on a server that predates #340; the sweep asserts it is
// empty here, so a regression of #340 shows up as a named route, not a
// count.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { SURFACE } from "../src/surface.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

const segs = (p: string) => p.replace(/\/+$/, "").split("/").filter(Boolean);

// Write-only routes: declared in SURFACE with no GET and no "*" on the same
// path. Parametric routes are probed with a concrete value per slot.
function writeOnlyRoutes(): { template: string; concrete: string }[] {
  const methods = new Map<string, Set<string>>();
  for (const r of SURFACE) {
    if (!methods.has(r.path)) methods.set(r.path, new Set());
    methods.get(r.path)!.add(r.method);
  }
  return [...methods]
    .filter(([, m]) => !m.has("GET") && !m.has("*"))
    .map(([template]) => ({
      template,
      concrete: template.replace(/:id\b/g, "7").replace(/:slug\b/g, "fly-life").replace(/:[A-Za-z_]+/g, "xyzzy"),
    }));
}

// A declared template matches a concrete path when they have the same number
// of segments and every declared segment is either equal or a :param.
function templateMatches(template: string, concrete: string): boolean {
  const t = segs(template);
  const c = segs(concrete);
  return t.length === c.length && t.every((s, i) => s === c[i] || s.startsWith(":"));
}

// A declared route is a proper positional prefix of the guess: shorter, and
// every one of its segments equal or a :param in that slot. This is the
// predicate the `extended` branch in src/index.ts uses.
function hasProperPrefixRoute(concrete: string): boolean {
  const c = segs(concrete);
  return SURFACE.some((r) => {
    const d = segs(r.path);
    return d.length > 0 && d.length < c.length && d.every((s, i) => s === c[i] || s.startsWith(":"));
  });
}

type NotFound = { error?: string; did_you_mean?: string[] };

// The classifier a client is told to use. Kept here, in the test, so the
// contract it encodes is the one the assertions check.
function classify(concrete: string, status: number, body: NotFound): "wrong-method" | "prefix-only" | "captured" | "unknown" {
  if (status !== 404) return "unknown";
  const dym = body.did_you_mean ?? [];
  const entries = dym.map((e) => ({ verb: e.slice(0, e.indexOf(" ")), path: e.slice(e.indexOf(" ") + 1) }));
  if (entries.some((e) => e.verb !== "GET" && templateMatches(e.path, concrete))) return "wrong-method";
  if (dym.length === 0 && body.error !== undefined && !body.error.startsWith("Not found: ")) return "captured";
  if (entries.length > 0 && entries.every((e) => segs(e.path).length < segs(concrete).length && segs(e.path).every((s, i) => s === segs(concrete)[i] || s.startsWith(":")))) return "prefix-only";
  return "unknown";
}

async function sweep() {
  const { env } = sqliteTestEnv(schema);
  const rows: { template: string; concrete: string; klass: ReturnType<typeof classify>; body: NotFound }[] = [];
  for (const { template, concrete } of writeOnlyRoutes()) {
    const res = await worker.fetch(new Request(`${ORIGIN}${concrete}`), env);
    const body = (await res.json()) as NotFound;
    rows.push({ template, concrete, klass: classify(concrete, res.status, body), body });
  }
  return rows;
}

test("every write-only route answers GET with a 404 that falls in one of three named classes", async () => {
  const rows = await sweep();
  const by = (k: string) => rows.filter((r) => r.klass === k).map((r) => r.template).sort();
  assert.deepEqual(by("unknown"), [], "a write-only route whose GET 404 fits none of the three shapes is a new class; name it above");

  // Class 1: every write-only route the 404 branch reaches names itself under
  // its own verb, flat or nested. Nested ones lead their list (PR #340).
  assert.deepEqual(by("wrong-method"), [
    "/api/a2a",
    "/api/awards/:id/payable",
    "/api/awards/:id/settle",
    "/api/bindings",
    "/api/comment",
    "/api/doorbell",
    "/api/doorbell/disable",
    "/api/doorbell/verify",
    "/api/flag",
    "/api/flag/disposition",
    "/api/grants/:slug/proposals",
    "/api/grants/:slug/transition",
    "/api/journal/review",
    "/api/keys",
    "/api/ledger",
    "/api/listings/:id/awards",
    "/api/listings/:id/paid",
    "/api/listings/:id/submissions",
    "/api/listings/:id/withdraw",
    "/api/me/ack",
    "/api/me/cadence",
    "/api/model",
    "/api/moderate",
    "/api/offers/:id/orders",
    "/api/offers/:id/withdraw",
    "/api/patron",
    "/api/payout-bindings",
    "/api/payout-bindings/:id/receipt",
    "/api/payout-wallets/:id/revoke",
    "/api/pin",
    "/api/porch/knock",
    "/api/post",
    "/api/register",
    "/api/rotate",
    "/api/seal",
    "/api/tag",
    "/api/vote",
    "/api/withdraw",
    "/api/witness",
    "/oauth/register",
    "/oauth/token",
  ]);

  // The pre-#340 hole. Empty by construction now; a route landing here means
  // the extended branch stopped letting same-depth routes lead.
  assert.deepEqual(by("prefix-only"), []);

  // Class 2: swallowed by GET /api/keys/:handle before the 404 branch.
  assert.deepEqual(by("captured"), ["/api/keys/decline", "/api/keys/revoke"]);
});

test("a nested write-only route leads its own did_you_mean, and the prefix family follows", async () => {
  // Cloudy-McCloud's rule before #340 (c72144) was: self-names iff no declared
  // route is a proper prefix. After #340 the prefix routes self-name too, in
  // slot 0, with the family after. Assert both halves so the fix's shape is
  // what is pinned, not just its effect.
  const rows = await sweep();
  for (const r of rows) {
    if (r.klass === "captured") continue;
    if (!hasProperPrefixRoute(r.concrete)) continue;
    const dym = r.body.did_you_mean ?? [];
    assert.ok(dym.length >= 2, `${r.template}: expected itself plus its family, got ${JSON.stringify(dym)}`);
    const [verb, path] = [dym[0].slice(0, dym[0].indexOf(" ")), dym[0].slice(dym[0].indexOf(" ") + 1)];
    assert.equal(verb, "POST", `${r.template}: slot 0 must be the write verb`);
    assert.equal(path, r.template, `${r.template}: slot 0 must be this route's own template`);
    assert.ok(
      dym.slice(1).some((e) => segs(e.slice(e.indexOf(" ") + 1)).length < segs(r.concrete).length),
      `${r.template}: the prefix family must still follow, got ${JSON.stringify(dym)}`,
    );
  }
});

test("a fabricated sibling under a prefix no longer gets the real route's list", async () => {
  // Before #340 these pairs were byte-identical, which was the undecidable
  // hole. Now the real route names itself and the fake one cannot.
  const { env } = sqliteTestEnv(schema);
  for (const [real, fake] of [
    ["/api/me/ack", "/api/me/xyzzy"],
    ["/api/doorbell/verify", "/api/doorbell/xyzzy"],
    ["/api/offers/7/orders", "/api/offers/7/xyzzy"],
  ]) {
    const a = (await (await worker.fetch(new Request(`${ORIGIN}${real}`), env)).json()) as NotFound;
    const b = (await (await worker.fetch(new Request(`${ORIGIN}${fake}`), env)).json()) as NotFound;
    assert.notDeepEqual(a.did_you_mean, b.did_you_mean, `${real} vs ${fake} must differ`);
    assert.equal(classify(real, 404, a), "wrong-method");
    assert.notEqual(classify(fake, 404, b), "wrong-method", `${fake}: a fake path must not read as wrong-method; got ${JSON.stringify(b.did_you_mean)}`);
  }
});

test("a path that exists under no method is class-none: a 404 whose did_you_mean never names it", async () => {
  const { env } = sqliteTestEnv(schema);
  const path = "/api/definitely-not-a-route-xyz9";
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`), env);
  assert.equal(res.status, 404);
  const body = (await res.json()) as NotFound;
  assert.match(body.error ?? "", /^Not found: GET /);
  assert.ok(Array.isArray(body.did_you_mean) && body.did_you_mean.length > 0, "a bare miss still gets suggestions");
  assert.ok(!body.did_you_mean!.some((e) => templateMatches(e.slice(e.indexOf(" ") + 1), path)), "and none of them is the guessed path itself");
  assert.equal(classify(path, res.status, body), "unknown");
});
