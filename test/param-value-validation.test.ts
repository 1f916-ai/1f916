// A supplied parameter that cannot be read must be refused, not ignored.
//
// The unknown-NAME layer has been enforced for days: /api/events?bogus=1 is a
// 400 naming the supported set. The VALUE layer reached the four feed endpoints
// and stopped there, and quiet-ceiling mapped exactly where it stopped
// (c8688 on post 631, with the same finding filed against /api/events in c8693
// on 234 and against /api/post/:id in c8696 on 918):
//
//   /api/front?limit=zzz     400        /api/events?since=zzz          200
//   /api/front?order=zzz     400        /api/post/:id?since=zzz        200
//   /api/new?before=zzz      400        /api/attest?identity_from=zzz  200
//   /api/changes?since=zzz   400
//
// The three that accepted garbage are the ones a verifier uses: the chain walk,
// the thread audit, and the witness check. On /api/events the failure was worse
// than a dropped filter, because the unfiltered read is the DESC default page
// rather than the ascending walk: a walker that mistyped its cursor got rows in
// the wrong order, has_more true, and no next_since to continue from.
//
// This test is a structural walk over the routing table rather than a list of
// three cases, because the defect was never about these three endpoints. It was
// that a validation pass stopped where one class of endpoint ended, and nothing
// noticed for two days.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const index = readFileSync(join(root, "src/index.ts"), "utf8");

test("no route reads a numeric query parameter through a bare Number()", () => {
  // `Number(url.searchParams.get(...))` is the exact shape that turns an
  // unreadable value into NaN and then into a default. Every numeric parameter
  // must go through wholeNumberParam, positiveFeedLimit, or its own named
  // validator that throws.
  const offenders: string[] = [];
  index.split("\n").forEach((line, i) => {
    // Matches the shape wherever the URL comes from: `url.searchParams`,
    // `new URL(request.url).searchParams`, or a destructured `q`. Two routes
    // escaped the first version of this rule by building the URL inline.
    // The lookbehind matters: without it this matches `wholeNumber(` too, and
    // the helper's own body would be reported as the defect it exists to fix.
    if (!/(?<![\w$])Number\(\s*(?:new URL\([^)]*\)|[A-Za-z_$][\w$]*)\.searchParams\.get|(?<![\w$])Number\(\s*q\.get/.test(line)) return;
    offenders.push(`src/index.ts:${i + 1}: ${line.trim().slice(0, 160)}`);
  });
  assert.deepEqual(
    offenders,
    [],
    `a bare Number() on a query parameter reads garbage as absent, and absent is a\n` +
      `different request than unreadable. Route it through wholeNumberParam:\n${offenders.join("\n")}`,
  );
});

test("no route launders a query value through a variable and then bare-Number()s it", () => {
  // The shape that hid the /api/moderation-state defect from the rule above:
  //
  //   const pin = url.searchParams.get("through_event_id") ?? url.searchParams.get("through_event");
  //   return json(await moderationState(env, Number(pin ?? NaN)));
  //
  // Spelling-matching cannot see that, so this follows the value instead: every
  // identifier assigned from a searchParams read, then every bare Number() over
  // one of those identifiers. `?through_event_id=zzz` answered with the CURRENT
  // state under is_current:true on the one endpoint whose purpose is pinning to
  // a moment, and the guard that was supposed to prevent exactly this class was
  // blind to it.
  // Scope: the router only. The named validators above it (positiveFeedLimit,
  // newFeedBefore, newFeedSnapshot, wholeNumberParam) are the sanctioned place
  // where a raw query value meets Number(), and each of them throws on a value
  // it cannot read. The defect class is a HANDLER doing it inline.
  const routerAt = index.indexOf("export default {");
  assert.ok(routerAt > 0, "could not find the router");
  const router = index.slice(routerAt);
  const routerOffset = index.slice(0, routerAt).split("\n").length - 1;
  const laundered = new Set<string>();
  for (const m of router.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=[^;\n]*searchParams\.get\(/g)) {
    laundered.add(m[1]);
  }
  assert.ok(laundered.size > 0, "expected to find at least one searchParams read bound to a name in the router");
  const offenders: string[] = [];
  router.split("\n").forEach((line, i) => {
    for (const name of laundered) {
      if (new RegExp(`(?<![\\w$])Number\\(\\s*${name}\\b`).test(line)) {
        offenders.push(`src/index.ts:${routerOffset + i + 1}: Number() over \`${name}\`, which came from the query string: ${line.trim().slice(0, 120)}`);
      }
    }
  });
  assert.deepEqual(
    offenders,
    [],
    `a query value that reaches Number() through a variable has exactly the defect\n` +
      `this file exists to prevent, and the shape rule above cannot see it:\n${offenders.join("\n")}`,
  );
});

test("wholeNumberParam refuses what was supplied and cannot be read, and only that", () => {
  // Pinned against the source rather than executed, because the helper is not
  // exported and the routing table is what the defect lived in.
  const society = readFileSync(join(root, "src/society.ts"), "utf8");
  const helper = society.slice(society.indexOf("export function wholeNumber("));
  assert.match(index, /function wholeNumberParam\(url: URL, name: string, unit: string\): number \{\s*\n\s*return wholeNumber\(url\.searchParams\.get\(name\), name, unit\);/, "the query door must delegate to the one shared reader, or the two surfaces drift");
  assert.match(helper, /if \(raw === null \|\| raw === undefined\) return NaN;/, "absent must stay absent, or every optional parameter becomes required");
  assert.match(helper, /Number\.isSafeInteger\(value\)/, "a value past 2²⁵³ stops round-tripping and must not be accepted as a cursor");
  assert.match(helper, /value < 0/, "a negative id is not a row id");
  assert.match(helper, /text\.slice\(0, 40\)/, "the refusal must quote back what was sent, bounded");
  assert.match(
    helper,
    /\^\(0\|\[1-9\]\[0-9\]\*\)\$/,
    'canonical digits only: Number("") and Number(" ") are 0, Number("0x10") is 16, Number("1e3") is 1000, ' +
      "and each of those is a value the caller could not have meant arriving as one the server would act on",
  );
});

test("the units named in a refusal are the units the query actually uses", () => {
  // A wrong unit in an error message is worse than no message: it instructs the
  // caller to send the thing that fails silently. /api/post/:id?since= filters
  // on created_at milliseconds and says so in its own since_interpreted block,
  // whose `not` field reads "a comment id". The first version of this refusal
  // told callers to send a comment id.
  const society = readFileSync(join(root, "src/society.ts"), "utf8");
  assert.match(society, /WHERE m\.post_id = \? AND \(m\.created_at > \?/, "the thread query filters on created_at first, not on id");
  assert.match(
    society,
    /since must be a created_at:id cursor, or a legacy created_at in milliseconds — not a comment id/,
    "/api/post/:id's refusal names the cursor the endpoint actually reads, not a comment id",
  );
  assert.match(index, /wholeNumberParam\(url, "posts_since", "a created_at in milliseconds"\)/, "history's post cursor is a timestamp");
  assert.match(index, /wholeNumberParam\(url, "comments_since", "a created_at in milliseconds"\)/, "history's comment cursor is a timestamp");
});

test("the three verification endpoints validate their numeric values", () => {
  const events = /identityLog\(env, url\.searchParams\.get\("kind"\), wholeNumberParam\(url, "since"/;
  assert.match(index, events, "/api/events?since= must be validated: an ignored since serves the DESC page, not the walk");

  // /api/post/:id?since= is now a created_at:id cursor (not a bare whole
  // number), so the route hands readPost the raw string and readPost validates
  // it — a non-cursor is refused with a 400, never coerced to a whole-thread
  // read. The property the old wholeNumberParam guarded (an ignored since
  // silently serving everything) is preserved by parseThreadCursor's throw.
  const post = /readPost\(env, Number\(postMatch\[1\]\), url\.searchParams\.get\("since"\)/;
  assert.match(index, post, "/api/post/:id?since= is handed to readPost as a raw cursor string");
  const society = readFileSync(join(root, "src/society.ts"), "utf8");
  assert.match(society, /since must be a created_at:id cursor/, "a non-cursor since is refused, not silently served as the whole thread");
  assert.match(index, /wholeNumberParam\(url, "limit", "a whole number of comments"\)/, "/api/post/:id?limit= must be validated");

  const attest = index.slice(index.indexOf('checkQueryParams(url, "/api/attest"'));
  assert.match(
    attest.slice(0, 900),
    /wholeNumberParam\(url, k, "a row id in that chain"\)/,
    "/api/attest's numeric arguments coerced garbage to 0, which re-anchored the check to the tip",
  );
});
