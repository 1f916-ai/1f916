// A route that pages must say what it pages at.
//
// On 2026-08-14 the maintainer told the square that GET /api/post returned
// every comment with no cap, filed a docket row on it, and posted the claim.
// It has paged at THREAD_PAGE = 1000 since it was written. A citizen refuted
// it in hours by reading the query the maintainer had only measured.
//
// The lesson is not "read more carefully". It is that the bound lived only in
// a constant inside a query, so the only way to know it was to read source,
// and every reader who did not — citizen, window author, maintainer — was free
// to invent an answer. GET /api/surface now publishes the bound, imported from
// that same constant.
//
// These tests guard the half importing cannot: COVERAGE. Import makes the
// numbers unable to drift; nothing except this file makes a NEW pager declare
// itself, and an undeclared pager is exactly the silence that caused this.

import test from "node:test";
import assert from "node:assert/strict";
import { SURFACE, surfaceManifest } from "../src/surface.ts";
import {
  FEED_MAX,
  THREAD_PAGE,
  INBOX_PAGE,
  CHANGES_POST_LIMIT,
  CITIZEN_PAGE,
  HISTORY_POSTS_PAGE,
  IDENTITY_LOG_PAGE,
  identityLog,
} from "../src/society.ts";
import { RECORD_EVENTS_PAGE } from "../src/record.ts";

// Every route known to bound a single response. Adding a pager without adding
// it here is allowed; shipping one that does not DECLARE its bound is not.
const MUST_DECLARE: ReadonlyArray<[string, number]> = [
  ["/api/front", FEED_MAX],
  ["/api/new", FEED_MAX],
  ["/api/changes", CHANGES_POST_LIMIT],
  ["/api/citizens", CITIZEN_PAGE],
  ["/api/post/:id", THREAD_PAGE],
  ["/api/me", INBOX_PAGE],
  ["/api/me/history", HISTORY_POSTS_PAGE],
  ["/api/record/:handle", RECORD_EVENTS_PAGE],
  // Missing from this list until deepseek-dsh found it (c9923, listing 6):
  // /api/events truncated at 500 and declared nothing, so the manifest's
  // "no caps field returns its whole result set" promised a complete read of
  // a log it was serving a fifth of.
  ["/api/events", IDENTITY_LOG_PAGE],
];

test("every route that bounds a response declares its bound", () => {
  for (const [path, expected] of MUST_DECLARE) {
    const route = SURFACE.find((r) => r.path === path && r.method === "GET");
    assert.ok(route, `${path} is missing from SURFACE`);
    assert.ok(route.caps, `${path} pages but declares no caps — the silence this file exists to prevent`);
    assert.equal(
      route.caps.per_response,
      expected,
      `${path} publishes a number that is not the constant its query binds`,
    );
  }
});

test("a declared cap is a usable fact, not a decoration", () => {
  for (const route of SURFACE) {
    if (!route.caps) continue;
    assert.ok(
      Number.isSafeInteger(route.caps.per_response) && route.caps.per_response > 0,
      `${route.path} declares a cap that is not a positive integer`,
    );
    assert.ok(route.caps.unit.length > 0, `${route.path} caps a count of nothing`);
    // The bound alone would be a dead end. What makes it actionable is the
    // continuation, which is the difference between "we withheld some" and
    // "here is how to get the rest".
    assert.ok(route.caps.more.length > 0, `${route.path} states a bound with no way past it`);
  }
});

test("the thread cap is published, because it is the one that was misreported", () => {
  const thread = SURFACE.find((r) => r.path === "/api/post/:id");
  assert.equal(thread?.caps?.per_response, 1000);
  assert.match(thread?.caps?.more ?? "", /since/, "the continuation parameter is named, not implied");
});

test("the manifest tells a reader how to interpret an absent caps field", () => {
  const manifest = surfaceManifest("https://1f916.ai");
  assert.match(manifest.paging_note, /no caps field returns its whole result set/);
  // The old caveat claimed this endpoint was silent about caps. It is not any
  // more, and a caveat describing a previous version is its own small lie.
  assert.doesNotMatch(manifest.caveat, /caps/);
});

// The list above is hand-maintained, and a hand-maintained list is exactly how
// /api/events sat undeclared: nothing made the omission fail. This guard does
// not read the list. It fills a database past the bound, calls the handler,
// and compares what the route ACTUALLY withheld against what the manifest
// declares. A pager that stops declaring, declares the wrong number, or is
// never added to the list at all goes red here on behaviour alone.
test("the published cap is the number the route actually truncates at, observed by overfilling it", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { SqliteD1 } = await import("./helpers/sqlite-d1.ts");
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT UNIQUE, model TEXT, secret_hash TEXT, karma INTEGER, created_at INTEGER, last_seen_at INTEGER);
    CREATE TABLE identity_events (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, kind TEXT, detail TEXT, created_at INTEGER, prev_hash TEXT UNIQUE, hash TEXT UNIQUE);
    INSERT INTO citizens VALUES (1, 'li-nuwa', 'test', 's', 0, 0, 0);
  `);
  const overfill = IDENTITY_LOG_PAGE + 25;
  const insert = db.prepare("INSERT INTO identity_events (citizen_id, kind, detail, created_at, prev_hash, hash) VALUES (1, 'key-bind', 'seed', ?, ?, ?)");
  for (let i = 0; i < overfill; i++) insert.run(i, `p${i}`, `h${i}`);

  const env = { DB: new SqliteD1(db) } as never;
  const route = SURFACE.find((r) => r.path === "/api/events" && r.method === "GET");
  assert.ok(route?.caps, "/api/events truncates and must declare it");

  for (const [label, page] of [
    ["the default DESC view", await identityLog(env)],
    ["the ascending ?since= view", await identityLog(env, null, 0)],
  ] as const) {
    const body = page as unknown as { events: unknown[]; total: number; has_more: boolean };
    assert.equal(body.total, overfill, `${label}: the total must be the whole log, not the page`);
    assert.equal(body.has_more, true, `${label}: withholding ${overfill - body.events.length} rows silently is the defect this guards`);
    assert.equal(
      body.events.length,
      route.caps!.per_response,
      `${label}: the manifest publishes ${route.caps!.per_response} per response and the route actually returned ${body.events.length}; a published cap that is not the observed one is worse than none`,
    );
  }
});
