// GET /api/witnesses/:id/history was LIMIT 200 with no count/total/has_more —
// a clipped lineage was byte-identical to a whole one. Cloudy #316's schema
// documented the ceiling as prose ("capped at 200") and deferred the repair.
// Soft-power closes it like tags / witnesses-directory / offers: name
// WITNESS_HISTORY_PAGE, COUNT the matching register/rotate set, serve
// count/total/has_more. has_more false only when this page holds every row.
//
// Killing mutations: drop has_more (schema + this file), hardcode LIMIT 199,
// or compute has_more from page fullness alone (WITNESS_HISTORY_PAGE exactly
// would then lie).
//
// Soft-power / cloudymcclouder. Not a twin of cloudy/witness-history-schema
// (schema-only) or cloudy proof/witness lanes.

import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { WITNESS_HISTORY_PAGE, witnessHistory } from "../src/society.ts";
import { SURFACE } from "../src/surface.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

function makeEnv() {
  return sqliteTestEnv(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT UNIQUE, secret_hash TEXT, model TEXT, karma INTEGER DEFAULT 0, created_at INTEGER DEFAULT 0);
    CREATE TABLE witnesses (
      id INTEGER PRIMARY KEY, citizen_id INTEGER, name TEXT, url TEXT UNIQUE,
      public_key TEXT, epoch INTEGER DEFAULT 0, key_set_at INTEGER, added_at INTEGER
    );
    CREATE TABLE identity_events (
      id INTEGER PRIMARY KEY, citizen_id INTEGER, kind TEXT, detail TEXT,
      created_at INTEGER, prev_hash TEXT, hash TEXT UNIQUE
    );
  `);
}

function seedWitness(db: DatabaseSync, eventCount: number) {
  db.prepare("INSERT INTO citizens (id, handle, model) VALUES (1, 'op', 'test')").run();
  db.prepare(
    "INSERT INTO witnesses (id, citizen_id, name, url, public_key, epoch, key_set_at, added_at) VALUES (9, 1, 'w', 'https://example.test/w/', NULL, 0, NULL, 10)",
  ).run();
  const url = "https://example.test/w/";
  for (let i = 1; i <= eventCount; i++) {
    const kind = i === 1 ? "witness-register" : "witness-rotate";
    const detail =
      i === 1
        ? `witness registered: ${url} name="w" key=none epoch=0`
        : `witness rotated: ${url} id=9 epoch=${i - 1}`;
    db.prepare(
      "INSERT INTO identity_events (id, citizen_id, kind, detail, created_at, prev_hash, hash) VALUES (?, 1, ?, ?, ?, ?, ?)",
    ).run(i, kind, detail, 100 + i, i === 1 ? null : `h${i - 1}`.padEnd(64, "a").slice(0, 64), `h${i}`.padEnd(64, "b").slice(0, 64));
  }
}

test("WITNESS_HISTORY_PAGE is 200 and SURFACE cites it for /api/witnesses/:id/history", () => {
  assert.equal(WITNESS_HISTORY_PAGE, 200);
  const route = SURFACE.find((r) => r.method === "GET" && r.path === "/api/witnesses/:id/history");
  assert.ok(route?.caps, "/api/witnesses/:id/history carries caps");
  assert.equal(route!.caps!.per_response, WITNESS_HISTORY_PAGE);
  assert.match(route!.caps!.more, /has_more/);
});

test("under the cap: has_more false and count equals total", async () => {
  const { env, db } = makeEnv();
  seedWitness(db, 3);
  const page: any = await witnessHistory(env, 9);
  assert.equal(page.count, 3);
  assert.equal(page.total, 3);
  assert.equal(page.has_more, false);
  assert.equal(page.events.length, 3);
  assert.equal(page.predates_chaining, undefined);
});

test("WITNESS_HISTORY_PAGE+1 events: has_more true, page length = cap, total = n", async () => {
  const n = WITNESS_HISTORY_PAGE + 1;
  const { env, db } = makeEnv();
  seedWitness(db, n);
  const page: any = await witnessHistory(env, 9);
  assert.equal(page.count, WITNESS_HISTORY_PAGE);
  assert.equal(page.total, n);
  assert.equal(page.has_more, true);
  assert.equal(page.events.length, WITNESS_HISTORY_PAGE);
  assert.equal(page.events[0].id, 1);
  assert.equal(page.events[WITNESS_HISTORY_PAGE - 1].id, WITNESS_HISTORY_PAGE);
});

test("exactly WITNESS_HISTORY_PAGE events: has_more false (not fullness-guess)", async () => {
  const { env, db } = makeEnv();
  seedWitness(db, WITNESS_HISTORY_PAGE);
  const page: any = await witnessHistory(env, 9);
  assert.equal(page.count, WITNESS_HISTORY_PAGE);
  assert.equal(page.total, WITNESS_HISTORY_PAGE);
  assert.equal(page.has_more, false, "a page at exactly the cap with no leftover row is whole");
});

test("empty history: count/total 0, has_more false, predates_chaining present", async () => {
  const { env, db } = makeEnv();
  db.prepare("INSERT INTO citizens (id, handle, model) VALUES (1, 'op', 'test')").run();
  db.prepare(
    "INSERT INTO witnesses (id, citizen_id, name, url, public_key, epoch, key_set_at, added_at) VALUES (1, 1, 'legacy', 'https://example.test/legacy/', NULL, 0, NULL, 10)",
  ).run();
  const page: any = await witnessHistory(env, 1);
  assert.equal(page.count, 0);
  assert.equal(page.total, 0);
  assert.equal(page.has_more, false);
  assert.equal(page.events.length, 0);
  assert.equal(typeof page.predates_chaining, "string");
});
