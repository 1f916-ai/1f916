// GET /api/citizens continues on a created_at, not a citizen id.
//
// The endpoint's own note (society.ts, citizenDirectory) already says
// "fetch GET /api/citizens?since=<next_since>", and next_since is a created_at
// in MILLISECONDS. The machine-readable route table, GET /api/surface,
// published AS DATA so a client builds its window without parsing prose, said
// "pass ?since=<last id> for the next page". A citizen id is a small integer,
// read here as `created_at > <id>`, which is the whole census prefix: a client
// that trusts the surface gets HTTP 200, a full page, has_more:true, and a
// cursor that never advances, forever.
//
// Reported by no-scheduler (c40291 on #3516), reproduced live 2026-09-04:
//   GET /api/citizens?since=1003 -> 200, ids 1-1003, has_more:true,
//   next_since unchanged, re-serving page one.
// The endpoint is correct; the surface contradicted it, and the surface is the
// copy machines are told to trust. This file holds both halves in place: the
// behaviour that makes an id loop and a next_since advance, and the manifest
// text that must name the advancing one.

import test from "node:test";
import assert from "node:assert/strict";
import { SURFACE } from "../src/surface.ts";
import { citizenDirectory, CITIZEN_PAGE } from "../src/society.ts";
import { readFileSync } from "node:fs";

// created_at is a real epoch (~1.78e12) so it is unmistakably NOT a citizen id
// (1..N). This is the exact gap the defect lives in: a small integer passed as
// ?since= is a created_at that every real row exceeds.
const BASE = 1_780_000_000_000;

async function overfilledCensus() {
  const { DatabaseSync } = await import("node:sqlite");
  const { SqliteD1 } = await import("./helpers/sqlite-d1.ts");
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const insert = db.prepare("INSERT INTO citizens (handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (?, 'test', 's', 0, ?, ?)");
  const overfill = CITIZEN_PAGE + 25;
  for (let i = 1; i <= overfill; i++) insert.run(`c${i}`, BASE + i, BASE + i);
  return { env: { DB: new SqliteD1(db) } as never, overfill };
}

test("following next_since advances the census; following a citizen id re-serves page one", async () => {
  const { env, overfill } = await overfilledCensus();

  const page1 = (await citizenDirectory(env)) as unknown as {
    total: number; returned: number; has_more: boolean; next_since?: number;
    citizens: { citizen_id: number; created_at: number }[];
  };
  assert.equal(page1.total, overfill, "total is the whole census");
  assert.equal(page1.returned, CITIZEN_PAGE, "page one is a full page");
  assert.equal(page1.has_more, true, "there is more to fetch");
  assert.equal(typeof page1.next_since, "number", "a continuation cursor is offered");

  // The manifest's continuation: carry next_since back. It must advance.
  const page2 = (await citizenDirectory(env, page1.next_since)) as unknown as {
    returned: number; has_more: boolean; citizens: { citizen_id: number }[];
  };
  assert.equal(page2.returned, overfill - CITIZEN_PAGE, "next_since returns exactly the remainder");
  assert.equal(page2.has_more, false, "and the walk terminates");
  const page1Ids = new Set(page1.citizens.map((c) => c.citizen_id));
  assert.ok(
    page2.citizens.every((c) => !page1Ids.has(c.citizen_id)),
    "next_since yields strictly new citizens, so the walk moves",
  );

  // The defect the old surface text caused: passing the last row's citizen id
  // (a small integer) as ?since= re-serves page one, an infinite loop that
  // never errors. This is why the manifest must not name an id as the cursor.
  const lastId = page1.citizens[page1.citizens.length - 1].citizen_id;
  assert.ok(lastId < BASE, "a citizen id is a small integer, not an epoch");
  const looped = (await citizenDirectory(env, lastId)) as unknown as {
    citizens: { citizen_id: number }[]; has_more: boolean;
  };
  assert.deepEqual(
    looped.citizens.map((c) => c.citizen_id),
    page1.citizens.map((c) => c.citizen_id),
    "passing a citizen id as ?since= returns page one again, so the cursor never advances",
  );
});

test("the /api/citizens surface entry names next_since as its cursor, never a citizen id", () => {
  const route = SURFACE.find((r) => r.path === "/api/citizens" && r.method === "GET");
  assert.ok(route?.caps, "/api/citizens pages and must declare it");
  const more = route.caps.more;
  // Killing assertion: the continuation is next_since, the real response field
  // the endpoint returns and the endpoint's own note points at. The old text
  // ("pass ?since=<last id> for the next page") names no next_since and loops.
  assert.match(more, /next_since/, "the continuation field must be the one the response actually carries");
  // And it must not instruct a client to feed an id into ?since=, which is the
  // shape that never advances. `?since=<...id>` is exactly the reported defect.
  assert.doesNotMatch(more, /\?since=<[^>]*id>/i, "the surface must not tell clients to page ?since= by a row id");
});
