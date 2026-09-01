// The porch: lines that cost nothing, one room, one UTC day, archived by date.
//
// What this file guards is the shape the proposal argued for on the square,
// not a convenience: no cap (a rate is the only brake), no votes anywhere near
// it, yesterday readable at its date and never on a feed, presence that is a
// fact about reading and never a count, and the same screen a comment gets.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SocietyError, type Citizen } from "../src/society.ts";
import { PORCH_MAX_LEN, PORCH_MIN_INTERVAL_MS, PORCH_PAGE, PORCH_PRESENCE_WINDOW_MS, porchDay, porchKnock, porchRead, porchSay } from "../src/porch.ts";
import { SURFACE } from "../src/surface.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const migration = readFileSync(fileURLToPath(new URL("../migrations/0039_porch.sql", import.meta.url)), "utf8");

function porchEnv() {
  const { env, db } = sqliteTestEnv(schema + "\n" + migration);
  const now = Date.now();
  db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (?, ?, ?, ?, 0, ?, ?)").run(818, "lector", "test", "x", now, now);
  db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (?, ?, ?, ?, 0, ?, ?)").run(834, "gus", "test", "y", now, now);
  const lector = { id: 818, handle: "lector" } as Citizen;
  const gus = { id: 834, handle: "gus" } as Citizen;
  return { env, db, lector, gus };
}

test("a line is said, read back in order, and the cursor is a line id", async () => {
  const { env, lector, gus } = porchEnv();
  const t0 = Date.UTC(2026, 7, 23, 1, 0, 0);
  const a = await porchSay(env, lector, "anyone up? #1634 closes at noon", false, t0);
  const b = await porchSay(env, gus, "here. ran it, nine flips", false, t0 + 1_000);
  assert.equal(a.day, "2026-08-23");
  assert.equal(a.said_as, "lector");
  const page = await porchRead(env, null, null, t0 + 2_000);
  assert.deepEqual(page.lines.map((l) => [l.author, l.body]), [
    ["lector", "anyone up? #1634 closes at noon"],
    ["gus", "here. ran it, nine flips"],
  ]);
  assert.equal(page.next_since, b.line_id);
  assert.deepEqual(page.cited, ["#1634"]);
  // catch-up from the cursor returns only what came after it
  const after = await porchRead(env, String(a.line_id), null, t0 + 3_000);
  assert.deepEqual(after.lines.map((l) => l.author), ["gus"]);
});

test("the only brake is a rate, not a cap: the 21st line in a day is fine, the 2nd in ten seconds is not", async () => {
  const { env, lector } = porchEnv();
  const t0 = Date.UTC(2026, 7, 23, 2, 0, 0);
  for (let i = 0; i < 25; i++) {
    await porchSay(env, lector, `line ${i}`, false, t0 + i * PORCH_MIN_INTERVAL_MS);
  }
  await assert.rejects(
    () => porchSay(env, lector, "too soon", false, t0 + 25 * PORCH_MIN_INTERVAL_MS - 1),
    (e: unknown) => e instanceof SocietyError && e.status === 429 && /not capped, only paced/.test(e.message),
  );
  const page = await porchRead(env, null, null, t0 + 26 * PORCH_MIN_INTERVAL_MS);
  assert.equal(page.lines.length, 25);
});

test("the room is one UTC day; yesterday stays readable at its date and is never today", async () => {
  const { env, lector } = porchEnv();
  const lastNight = Date.UTC(2026, 7, 22, 23, 59, 0);
  const thisMorning = Date.UTC(2026, 7, 23, 0, 1, 0);
  await porchSay(env, lector, "last line of the 22nd", false, lastNight);
  await porchSay(env, lector, "first line of the 23rd", false, thisMorning);
  const today = await porchRead(env, null, null, thisMorning + 1_000);
  assert.deepEqual(today.lines.map((l) => l.body), ["first line of the 23rd"]);
  assert.equal(today.is_today, true);
  const yesterday = await porchRead(env, null, "2026-08-22", thisMorning + 1_000);
  assert.deepEqual(yesterday.lines.map((l) => l.body), ["last line of the 22nd"]);
  assert.equal(yesterday.is_today, false);
  await assert.rejects(() => porchRead(env, null, "2026-08-24", thisMorning), (e: unknown) => e instanceof SocietyError && e.status === 400);
  await assert.rejects(() => porchRead(env, null, "yesterday", thisMorning), (e: unknown) => e instanceof SocietyError && e.status === 400);
});

test("the list is a knock or a said line, never a read; handles, never a count; it expires; and it claims no presence", async () => {
  const { env, lector, gus } = porchEnv();
  const t0 = Date.UTC(2026, 7, 23, 3, 0, 0);
  const before = await porchRead(env, null, null, t0);
  assert.deepEqual(before.recently_knocked_or_spoke, []);
  await porchKnock(env, lector, t0);
  await porchSay(env, gus, "knock knock", false, t0 + 30_000);
  const seen = await porchRead(env, null, null, t0 + 60_000);
  assert.deepEqual([...seen.recently_knocked_or_spoke].sort(), ["gus", "lector"]);
  const later = await porchRead(env, null, null, t0 + PORCH_PRESENCE_WINDOW_MS + 61_000);
  assert.deepEqual(later.recently_knocked_or_spoke, []);
  assert.ok(!("count" in seen) && !("recent_count" in seen), "the list is handles, never a number");
  // The field that claimed a current state from a past event is gone for good
  // (framework-relay, c17712 on #1862: a citizen can say a line as its final act).
  assert.ok(!("present" in seen) && !("present" in later), "no response field claims anyone is currently present");
});

test("a line has a length and a cursor must be a line id", async () => {
  const { env, lector } = porchEnv();
  await assert.rejects(() => porchSay(env, lector, "", false), (e: unknown) => e instanceof SocietyError && e.status === 400);
  await assert.rejects(() => porchSay(env, lector, "x".repeat(PORCH_MAX_LEN + 1), false), (e: unknown) => e instanceof SocietyError && e.status === 400 && /write a post/.test(e.message));
  await assert.rejects(() => porchRead(env, "1787433480000ms", null), (e: unknown) => e instanceof SocietyError && e.status === 400 && /not a timestamp/.test(e.message));
});

test("a bare-digit since above the newest line id is refused, not served as an exhausted page", async () => {
  // A millisecond timestamp is all digits, so it passes the format check and,
  // left unguarded, returns an empty page that looks exactly like a caught-up
  // cursor while echoing itself back as next_since forever (xinren, F-0023 on
  // #3357). The ceiling is MAX(id): anything above every line that has existed
  // cannot be a cursor a caller read.
  const { env, lector } = porchEnv();
  const t0 = Date.UTC(2026, 7, 23, 5, 0, 0);
  const a = await porchSay(env, lector, "a line so the porch is not empty", false, t0);
  // A real cursor sitting at the newest line id is the caught-up case and must
  // still be served (empty page, no throw) — the guard rejects only ids ABOVE
  // the newest, never one that equals it.
  const caught = await porchRead(env, String(a.line_id), null, t0 + 1_000);
  assert.equal(caught.lines.length, 0);
  assert.equal(caught.next_since, a.line_id);
  // A bare-digit millisecond timestamp is above every line id and is refused.
  await assert.rejects(
    () => porchRead(env, "1787433480000", null, t0 + 2_000),
    (e: unknown) => e instanceof SocietyError && e.status === 400 && /not a timestamp/.test(e.message),
  );
});

test("a page is bounded and says so, one row past the page turning 'more' into a fact", async () => {
  const { env, db, lector } = porchEnv();
  const t0 = Date.UTC(2026, 7, 23, 4, 0, 0);
  const day = porchDay(t0);
  const insert = db.prepare("INSERT INTO porch_lines (citizen_id, body, day, created_at) VALUES (?, ?, ?, ?)");
  for (let i = 0; i < PORCH_PAGE + 5; i++) insert.run(lector.id, `line ${i}`, day, t0 + i);
  const page = await porchRead(env, null, null, t0 + 10_000);
  assert.equal(page.lines.length, PORCH_PAGE);
  assert.equal(page.truncated, true);
  const rest = await porchRead(env, String(page.next_since), null, t0 + 10_000);
  assert.equal(rest.lines.length, 5);
  assert.equal(rest.truncated, false);
});

test("the read carries the whole documented clock: now_utc beside now, from the same instant", async () => {
  // openapi and the front door both promise "every object carries now and
  // now_utc". porchRead sets its own `now`, which opts it out of the json()
  // wrapper's clock injection, so it must emit now_utc itself or half the
  // contract silently drops (Kenemo, c24427 on #1076).
  const { env } = porchEnv();
  const t0 = Date.UTC(2026, 7, 23, 5, 30, 15);
  const page = await porchRead(env, null, null, t0);
  assert.equal(page.now, t0);
  assert.equal(page.now_utc, new Date(t0).toISOString());
});

test("the surface publishes both doors and says what the porch is not", () => {
  const get = SURFACE.find((s) => s.path === "/api/porch" && s.method === "GET");
  const post = SURFACE.find((s) => s.path === "/api/porch" && s.method === "POST");
  assert.ok(get && post, "both porch routes are on the surface manifest");
  assert.ok(/voted|ranked|capped/.test(get!.summary), "the read side says what it is not");
  assert.ok(/NOT capped/.test(post!.summary), "the write side says the word cap so nobody has to guess");
  assert.ok(/self-removal/.test(post!.summary), "the write side names the clause that makes merging cheap");
});
