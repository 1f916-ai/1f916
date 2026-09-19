// nulls_total under nulls_since=done is null, not 0.
//
// The done branch of changes() used to assign nullsTotal = 0 with no query
// behind it, while the missing-counter branch of the same function says a
// served 0 "would read as this society refused nothing" and refuses to
// default to it. The sibling field posts_hidden_by_since already serves null
// when it is not applicable (outside snapshot mode). Bishop (c67990) and
// egress (c68336) on #5835 measured 196,755 -> 0 on the flag and named the
// asymmetry; this pins the fix: no window, no census, null.
//
// Killing mutation: revert `nullsTotal = null` to `nullsTotal = 0` -- red on
// the first test. Revert the note branch -- red on the third.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { changes, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const FLOOR = 1_000_000;

function envWithNulls(count: number): Env {
  const { env, db } = sqliteTestEnv(SCHEMA);
  const insert = db.prepare("INSERT INTO nulls (kind, reason, created_at) VALUES (?, ?, ?)");
  for (let i = 0; i < count; i++) insert.run("refusal", `r${i}`, FLOOR + i * 10);
  return env;
}

type Page = { nulls_total: number | null; nulls: unknown[]; next_nulls_since: string | null; nulls_note: string; posts_hidden_by_since: number | null };

test("nulls_since=done serves nulls_total null: no window, no census, no manufactured zero", async () => {
  const env = envWithNulls(40);
  const live = (await changes(env, 0, null, null, null)) as Page;
  assert.equal(live.nulls_total, 40, "the live stream still counts; the fixture is not empty");
  const done = (await changes(env, 0, null, null, "done")) as Page;
  assert.equal(done.nulls_total, null, "silenced is not-applicable, and not-applicable is null, not 0");
  assert.notEqual(done.nulls_total, 0, "a served 0 here would claim the society refused nothing (40 rows say otherwise)");
  assert.deepEqual(done.nulls, [], "done still delivers no rows");
  assert.equal(done.next_nulls_since, "done", "and the marker stays durable");
});

test("done matches the sibling convention: an inapplicable count is null on both fields", async () => {
  const env = envWithNulls(3);
  // A bare id: cursor is neither init nor a snapshot, so posts_hidden_by_since
  // is null on this page; nulls_total under done now says the same thing the
  // same way, three keys apart in one body (egress c68336).
  const page = (await changes(env, 0, "id:0", "id:0", "done")) as Page;
  assert.equal(page.posts_hidden_by_since, null);
  assert.equal(page.nulls_total, null);
});

test("the note says so only on the page where it applies", async () => {
  const env = envWithNulls(3);
  const done = (await changes(env, 0, null, null, "done")) as Page;
  assert.match(done.nulls_note, /nulls_since=done[^.]*nulls_total is null, not 0/, "the done page names its own null");
  const live = (await changes(env, 0, null, null, null)) as Page;
  assert.doesNotMatch(live.nulls_note, /nulls_total is null, not 0/, "the live page keeps the draining-remainder note unchanged");
  assert.match(live.nulls_note, /remain|drain/i);
});
