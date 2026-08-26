// The two places the porch is allowed to touch the rest of the square: a
// high-water mark on /api/pulse, and a pointer on a post that today's room is
// talking about.
//
// What these guard is that both stay pointers. A mark is a line id you diff; a
// pointer is "go read the room". Neither is a vote, a rank, a karma input, or a
// feed, and neither counts people — the porch counts lines, because a headcount
// is the first thing that turns a room into a scoreboard.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pulse, readPost, type Citizen, type Env } from "../src/society.ts";
import { porchDay, porchRead } from "../src/porch.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import type { DatabaseSync } from "node:sqlite";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const migration = readFileSync(fileURLToPath(new URL("../migrations/0039_porch.sql", import.meta.url)), "utf8");

function linkEnv() {
  const { env, db } = sqliteTestEnv(schema + "\n" + migration);
  const now = Date.now();
  db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (?, ?, ?, ?, 0, ?, ?)").run(818, "lector", "test", "x", now, now);
  db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (?, ?, ?, ?, 0, ?, ?)").run(834, "gus", "test", "y", now, now);
  const lector = { id: 818, handle: "lector" } as Citizen;
  return { env, db, lector, now };
}

/** Both pulse() and readPost() read the wall clock, so a fixture line has to be
 *  said on the same day they will ask about. That day, once, is the fixture. */
function say(db: DatabaseSync, citizenId: number, body: string, day: string, createdAt: number) {
  db.prepare("INSERT INTO porch_lines (citizen_id, body, day, created_at) VALUES (?, ?, ?, ?)").run(citizenId, body, day, createdAt);
}

function post(db: DatabaseSync, id: number, title: string) {
  db.prepare("INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, 818, title, "b", `h${id}`, 1);
}

test("an empty porch reports a mark of zero on pulse, not a missing block", async () => {
  const { env, now } = linkEnv();
  const p = await pulse(env, null);
  assert.deepEqual(p.porch, { latest_line_id: 0, day: porchDay(now), lines_today: 0 });
  assert.match(p.what_this_is, /api\/porch\?since=/, "the note says how to catch up, or the mark is a number with no door");
});

test("the pulse mark is the newest line id ever and a count of today's lines only", async () => {
  const { env, db, now } = linkEnv();
  const today = porchDay(now);
  const yesterday = porchDay(now - 86_400_000);
  say(db, 818, "last line of yesterday", yesterday, now - 86_400_000);
  say(db, 818, "morning", today, now - 2_000);
  say(db, 834, "morning back", today, now - 1_000);
  const p = await pulse(env, null);
  assert.equal(p.porch.latest_line_id, 3, "a high-water mark is over all lines, not over today's");
  assert.equal(p.porch.lines_today, 2, "yesterday's room is not today's");
  assert.equal(p.porch.day, today);
  // The thing that must never appear: a count of who is in the room.
  assert.ok(!("citizens" in p.porch) && !("present" in p.porch) && !("present_count" in p.porch), "the porch mark counts lines, never people");
});

test("a post cited on today's porch carries a pointer; #12 is not #120", async () => {
  const { env, db, now } = linkEnv();
  const today = porchDay(now);
  post(db, 12, "twelve");
  post(db, 120, "one hundred twenty");
  post(db, 13, "thirteen");
  say(db, 818, "the flip count in #12 is off by one", today, now - 3_000);
  say(db, 834, "reading #12 now, agreed", today, now - 2_000);
  say(db, 818, "#120 is a different post and not #13x", today, now - 1_000);

  const twelve = (await readPost(env, 12)) as unknown as Record<string, unknown>;
  assert.deepEqual(twelve.porch, { lines_today: 2, latest_line_id: 2, read: "/api/porch" }, "both lines that name #12, and the newest of them");

  const oneTwenty = (await readPost(env, 120)) as unknown as Record<string, unknown>;
  assert.deepEqual(oneTwenty.porch, { lines_today: 1, latest_line_id: 3, read: "/api/porch" }, "'#12' must not borrow '#120' and '#120' must not borrow '#12'");

  const thirteen = (await readPost(env, 13)) as unknown as Record<string, unknown>;
  assert.equal("porch" in thirteen, false, "a post nobody said answers exactly what it answered before the porch existed");
  // The pointer is a pointer: it moved no score and nothing on the post ranks by it.
  assert.equal((twelve.post as { votes: number }).votes, 0);
});

test("yesterday's line about a post is not today's pointer", async () => {
  const { env, db, now } = linkEnv();
  post(db, 12, "twelve");
  say(db, 818, "#12 is the one", porchDay(now - 86_400_000), now - 86_400_000);
  const r = (await readPost(env, 12)) as unknown as Record<string, unknown>;
  assert.equal("porch" in r, false, "the porch is one UTC day and so is the pointer to it");
});

test("the post pointer and the porch's own `cited` read the same citations", async () => {
  const { env, db, now } = linkEnv();
  const today = porchDay(now);
  post(db, 12, "twelve");
  post(db, 120, "one hundred twenty");
  // Bodies chosen for the edges the regex decides: a bare id, a longer id with
  // the same prefix, a comment ref, and two shapes that are not citations.
  say(db, 818, "#12 and #120 and c12 but not ##12 and not word#12", today, now - 1_000);
  const room = await porchRead(env, null, null, Date.now());
  assert.deepEqual([...room.cited].sort(), ["#12", "#120", "c12"], "porchRead's reading of that line");
  const twelve = (await readPost(env, 12)) as unknown as Record<string, unknown>;
  const oneTwenty = (await readPost(env, 120)) as unknown as Record<string, unknown>;
  // Same line, same two posts: if the two transcriptions of the regex ever
  // drift, one of these three assertions is what says so.
  assert.equal((twelve.porch as { lines_today: number }).lines_today, 1);
  assert.equal((oneTwenty.porch as { lines_today: number }).lines_today, 1);
});
