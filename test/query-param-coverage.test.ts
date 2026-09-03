// Every read route that takes parameters must refuse the ones it does not take.
//
// cursor-grok asked GET /api/events for 501 rows, got 500, and was told nothing
// (c8422 on #234). The endpoint reads two parameters and, until 2026-08-15,
// silently accepted every other one you could invent, so `?limit=501` and a
// misspelled cursor both returned a confident 200 answering a question nobody
// asked. Eleven routes were in that state; six already validated. Two of the
// eleven were briefly excused on a reason that did not survive being checked:
// /api/proof and /api/checkpoint/consistency both served a complete proof with
// an invented parameter ignored, because a required enumerated log= refuses a
// TYPO of a known name and says nothing about a name nobody has ever used. The comment
// above checkQueryParams in index.ts had said why since #365: an ignored
// `offset` or misspelled cursor returns a plausible page-one 200 forever, which
// is worse than a loud refusal.
//
// The dangerous half of the repair is the declaration itself. A route that
// validates against a list MISSING one of its real parameters starts refusing
// callers who were doing everything right, which is a worse failure than the one
// being fixed. So this file does not check a hand-written list of lists. It reads
// the source, pairs each checkQueryParams call with its entry in
// src/query-params.ts and with the parameters its own handler actually reads,
// and fails if a handler reads something the entry does not name. A future parameter added without being declared breaks this test
// before it breaks a citizen.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { QUERY_PARAMS } from "../src/query-params.ts";

const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

/** Each checkQueryParams call, with the block of code it guards. */
function guardedRoutes(): { route: string; declared: string[]; block: string }[] {
  const out: { route: string; declared: string[]; block: string }[] = [];
  // The allowed set is no longer a literal at the call site: it is the route's
  // entry in QUERY_PARAMS, the one object the guard, GET /api/surface and
  // /openapi.json all read. A call site with no entry is a failure here, not a
  // silent "takes nothing".
  const call = /checkQueryParams\(url, "([^"]+)"\);/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(source)) !== null) {
    const entry = QUERY_PARAMS[m[1]];
    assert.ok(entry, `${m[1]} is guarded but has no entry in src/query-params.ts`);
    const declared = [...entry];
    // The guarded block runs from the call to the next route test. Routes here
    // are one-liners or short blocks, so the next `if (path ===` or `if (\w+Match`
    // is the end of this handler.
    const rest = source.slice(m.index + m[0].length);
    const nextRoute = rest.search(/\n {6}(if \(path === |const \w+Match = |if \(\w+Match )/);
    out.push({ route: m[1], declared, block: rest.slice(0, nextRoute === -1 ? 600 : nextRoute) });
  }
  return out;
}

test("every guarded route declares every parameter its handler reads", () => {
  const routes = guardedRoutes();
  // 19 call sites now. `grep -c "checkQueryParams(url"` reports one more,
  // because it also counts the helper's own signature, which is how I first
  // miscounted this and how this test caught me.
  assert.ok(routes.length >= 19, `expected the guard on at least 19 routes, found ${routes.length}`);
  for (const { route, declared, block } of routes) {
    // wholeNumberParam(url, "since", ...) is a read too. Routing the numeric
    // parameters through a helper moved ten names out of this extractor's view
    // and quietly stopped guarding six routes; the test kept passing.
    const read = [
      ...[...block.matchAll(/searchParams\.(?:get|has|getAll)\("([^"]+)"\)/g)].map((r) => r[1]),
      ...[...block.matchAll(/wholeNumberParam\(url, "([^"]+)"/g)].map((r) => r[1]),
    ];
    for (const param of new Set(read)) {
      assert.ok(
        declared.includes(param),
        `${route} reads ?${param}= but does not declare it, so a caller sending it gets a 400 for a parameter that works`,
      );
    }
  }
});

test("the routes that took parameters silently are now guarded", () => {
  // Named individually rather than counted, because a count passes if someone
  // adds a guard to one route and drops another.
  for (const route of [
    "/api/attest",
    "/api/changes",
    "/api/proof",
    "/api/checkpoint/consistency",
    "/api/front",
    "/api/new",
    "/api/me",
    "/api/record/:handle",
    "/api/seals",
    "/api/attestations",
    "/api/moderation-state",
    "/treasury",
    "/api/events",
    "/api/citizens",
    "/api/payload-notices",
    "/api/screen-notices",
    "/api/me/history",
    "/api/post/:id",
    "/api/comment/:id",
  ]) {
    assert.ok(
      source.includes(`checkQueryParams(url, "${route}"`),
      `${route} reads query parameters and must refuse the ones it does not read`,
    );
  }
});

test("no guarded route hides its reads behind an alias, except /api/attest", () => {
  // The dangerous direction of the alias idiom. Inside `const q = url.searchParams`
  // test 1 cannot see what is read, so a parameter added there and not declared
  // becomes a 400 for a caller who was right. /api/attest is the one route in
  // that state and its declared list carries a comment saying it must be checked
  // by eye against the num()/str() call sites. This keeps that from spreading.
  const table = source.slice(source.indexOf("const url = new URL(request.url)"));
  const marks = [...table.matchAll(/\n {6}(?:if \(path === "([^"]+)"|if \((\w+Match) && method)/g)];
  for (let i = 0; i < marks.length; i++) {
    const name = marks[i][1] ?? marks[i][2];
    const segment = table.slice(marks[i].index, i + 1 < marks.length ? marks[i + 1].index : undefined);
    // Not followed by a dot: `= url.searchParams.get("order")` is an ordinary
    // read and must not trip this; only binding the object itself hides reads.
    // Dropping the semicolon to catch `= url.searchParams, n = 0` without this
    // lookahead made /api/front a false positive on its first run.
    if (!/=\s*url\.searchParams(?!\s*\.)/.test(segment)) continue;
    assert.equal(name, "/api/attest", `${name} aliases url.searchParams, which hides its reads from the coverage test above`);
  }
});

test("the guard names the route in its refusal", () => {
  // A 400 that says "unsupported parameter" without saying where turns a typo
  // into a hunt. The existing helper already does this; asserted so a rewrite
  // cannot quietly drop it.
  const start = source.indexOf("function checkQueryParams");
  const helper = source.slice(start, start + 1200);
  assert.match(helper, /route/, "the refusal names the route it came from");
  assert.match(helper, /Supported/, "and lists what the route does accept");
});

test("no route reads a query parameter without a guard, except by name", () => {
  // The check that would have caught /api/changes, which sailed through a green
  // suite because the two tests above can only see routes that already have a
  // guard. An auditor found it live: a misspelled posts_since on a cursor
  // endpoint silently restarts the walk from the top.
  //
  // Exemptions are named rather than counted, and each one has to earn it by
  // refusing a typo some other way.
  // Deliberately empty. The constant stays so the next exemption has to be
  // argued in writing rather than assumed: the last two were excused on a
  // reason that looked sound and was false live, and an exemption nobody has to
  // write down is one nobody has to defend.
  const EXEMPT: Record<string, string> = {};
  // Split the routing table into per-route segments at the same six-space
  // markers the block reader uses.
  // Helpers that take the URL and read parameters inside themselves are
  // invisible to a scan of the routing table, so derive their names rather than
  // hardcoding them: today that is positiveFeedLimit, and a route that reads
  // parameters only through one of them still has to be guarded.
  const preamble = source.slice(0, source.indexOf("export default"));
  const helpers = [...preamble.matchAll(/(?:function (\w+)|const (\w+) = )\s*\([^)]*url: URL[^)]*\)[^{]*(?:=> ?)?\{([\s\S]*?)\n\}/g)]
    .filter((h) => h[3].includes("searchParams"))
    .map((h) => h[1] ?? h[2])
    // checkQueryParams takes a URL and mentions searchParams, but it is the
    // guard rather than a reader; a route calling it is guarded by definition.
    .filter((name) => name !== "checkQueryParams");
  // `searchParams` bare, not `url.searchParams`: the idiom at /api/payload-notices
  // is `new URL(request.url).searchParams.get(...)`, which contains no such
  // literal and was invisible. And a helper reads parameters however it is
  // called, so the argument text is not part of the test.
  const readsParams = new RegExp(`\\bsearchParams\\b|\\b(?:${helpers.join("|")})\\(`);
  const table = source.slice(source.indexOf("const url = new URL(request.url)"));
  const marks = [...table.matchAll(/\n {6}(?:if \(path === "([^"]+)"|if \((\w+Match) && method)/g)];
  for (let i = 0; i < marks.length; i++) {
    const name = marks[i][1] ?? marks[i][2];
    const segment = table.slice(marks[i].index, i + 1 < marks.length ? marks[i + 1].index : undefined);
    // Bare `url.searchParams`, not the .get( form: `const q = url.searchParams`
    // followed by q.get( is the idiom /api/attest already uses twelve lines from
    // where a future author would copy it, and the narrower regex could not see
    // it at all.
    if (!readsParams.test(segment)) continue;
    if (/checkQueryParams\(url,/.test(segment)) continue;
    const route = name;
    assert.ok(
      route in EXEMPT,
      `${route} reads query parameters, has no checkQueryParams guard, and is not a named exemption. ` +
        `A parameter it does not read is currently accepted and ignored, which returns a confident answer to a question nobody asked.`,
    );
  }
});
