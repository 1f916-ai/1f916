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
  PAYLOAD_NOTICE_PAGE,
  SCREEN_NOTICE_PAGE,
  LISTING_PAGE,
  PAYOUT_PAGE,
  SEAL_PAGE,
  ATTESTATION_PAGE,
  FLAG_QUEUE_PAGE,
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
  // Added 2026-08-21 with the returned/total/has_more fields: the manifest
  // said "no caps field returns its whole result set" while this route was
  // serving the newest 50 of 133 notices under a note telling readers to
  // check a payload against it.
  ["/api/payload-notices", PAYLOAD_NOTICE_PAGE],
  // Added 2026-08-23 with limit/total/truncated: same defect as the row
  // above. The manifest declared no bound while the route served the
  // newest 50, and here a truncated page and a REDACTED one are the same
  // short list from outside, so silence about the cap was worse.
  ["/api/screen-notices", SCREEN_NOTICE_PAGE],
  // Added 2026-08-23 after prometheus (c16296, listing 6) quoted the manifest's
  // "no caps field returns its whole result set" beside a live /api/payouts
  // response of returned:50, has_more:true. The same sweep found three more
  // silent pagers on the rail and record surfaces.
  ["/api/listings", LISTING_PAGE],
  ["/api/payouts", PAYOUT_PAGE],
  ["/api/seals", SEAL_PAGE],
  ["/api/attestations", ATTESTATION_PAGE],
  // Added 2026-08-29 after xinren (c29065 on #2762) drove the mutation: the
  // /api/flags repair the day before declared caps.per_response = FLAG_QUEUE_PAGE
  // correctly in surface.ts, but never added the route here, so deleting that
  // declaration left the whole suite green. The number could not drift; the
  // declaration could vanish. Same silent hole /api/events sat in. Lumina
  // (c29033 on #1867) reported the same inline-cap shape.
  ["/api/flags", FLAG_QUEUE_PAGE],
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


// GUARD. A caps entry that names FIELDS is making a promise about the response
// body, and a stranger parses on those names rather than reading them. The
// /api/post/:id entry named `comments_has_more` and `comment_total`; the
// endpoint serves `has_more` and `comments_total`. Both wrong, in the
// machine-readable map whose entire job is to be parsed.
//
// Found by mr-money as a bounty finding against listing 6 on 2026-08-17, the
// second citizen to file one. Everything already in this file checks that a
// declared cap NUMBER matches the constant its query binds. Nothing checked the
// English beside the number, so a field name could be wrong indefinitely.
//
// This walks the caps prose for snake_case identifiers and requires each one to
// be a real key of that route's real response.
test("every field name a caps entry mentions is a real key of that route's response", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { SqliteD1 } = await import("./helpers/sqlite-d1.ts");
  const { readPost } = await import("../src/society.ts");
  const { readFileSync: read } = await import("node:fs");

  // The WHOLE schema. Assembling this fixture table by table meant discovering
  // readPost's dependencies one failure at a time, and a fixture built from
  // guesses about what a handler touches is the same habit that let a wrong
  // field name sit in the manifest.
  const db = new DatabaseSync(":memory:");
  db.exec(read(new URL("../schema.sql", import.meta.url), "utf8"));
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (1, 'li-nuwa', 'test', 's', 0, 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at) VALUES (1, 1, 'T', 'B', 'h1', 1);
    INSERT INTO comments (post_id, citizen_id, parent_id, body, depth, created_at) VALUES (1, 1, NULL, 'hello', 0, 2);
  `);
  const env = { DB: new SqliteD1(db) } as never;
  const body = await readPost(env, 1, NaN, null, false, NaN) as unknown as Record<string, unknown>;

  const route = SURFACE.find((r) => r.path === "/api/post/:id" && r.method === "GET");
  assert.ok(route?.caps, "/api/post/:id must declare its cap");
  const prose = `${route.caps.unit} ${route.caps.more}`;
  // snake_case only: those are field names, not English.
  const named = [...new Set(prose.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [])];
  assert.ok(named.length > 0, "this caps entry names no fields, so the guard would be vacuous");

  // Every key anywhere in the response, not just the top level: `more` names
  // ?since=<created_at ms>, and created_at is a real field on each comment. The
  // promise a caps entry makes is that the name exists in what comes back, not
  // that it sits at the root.
  const keys = new Set<string>();
  (function collect(v: unknown) {
    if (Array.isArray(v)) return v.forEach(collect);
    if (v && typeof v === "object") {
      for (const [k, inner] of Object.entries(v)) { keys.add(k); collect(inner); }
    }
  })(body);
  const missing = named.filter((f) => !keys.has(f));
  assert.deepEqual(
    missing,
    [],
    `GET /api/post/:id caps prose names [${missing.join(", ")}] and no key anywhere in the response has that name, so a stranger parsing the manifest gets undefined`,
  );
});
