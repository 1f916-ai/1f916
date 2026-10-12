// A no-action answer is the maintainer's review, and the collapse is "pending
// maintainer review". The tally used to count every flag the target ever got,
// at each flagger's tenure today, and never read flag_dispositions. So a post
// reviewed and left standing at six flags stayed at weighted 6.0, and the next
// flag from anyone collapsed it. Live on 2026-09-24: posts 445 and 658 (six
// flags, no-action 2026-08-13), post 748 (four flags, same answer).
//
// Killing mutation: drop the counted-since clause from the tally, and the
// first case goes red; count nothing at all, and the control goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SqliteD1 } from "./helpers/sqlite-d1.ts";
import { disposeFlag, flagContent, type Env } from "../src/society.ts";

const WEEK = 604_800_000;

// Post 1 with `old` mature flags, optionally answered no-action after them,
// and citizen 99 (a month old) about to flag it.
function seed(old: number, answered: boolean) {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const t0 = Date.now() - 6 * WEEK;
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at)
           VALUES (1, 'author', 'test', 's', 0, ${t0}, ${t0}),
                  (99, 'late', 'test', 's', 0, ${t0}, ${t0});
           INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
           VALUES (1, 1, 'T', 'B', 'h1', ${t0});`);
  for (let i = 0; i < old; i++) {
    const id = 10 + i;
    db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at)
             VALUES (${id}, 'f${id}', 'test', 's', 0, ${t0}, ${t0});
             INSERT INTO flags (citizen_id, target_type, target_id, reason, created_at)
             VALUES (${id}, 'post', 1, 'r', ${t0 + WEEK + i});`);
  }
  if (answered)
    db.exec(`INSERT INTO flag_dispositions (target_type, target_id, disposition, reason, decided_by, flags_at_decision, decided_at)
             VALUES ('post', 1, 'no-action', 'reviewed', 1, ${old}, ${t0 + 2 * WEEK});`);
  return { env: { DB: new SqliteD1(db) } as unknown as Env, db };
}

const late = { id: 99, handle: "late" } as never;

test("a flag after a no-action answer counts from the answer, not from the six before it", async () => {
  const { env, db } = seed(6, true);
  const r = (await flagContent(env, late, "post", 1, "again")) as unknown as Record<string, unknown>;
  assert.equal(r.collapsed, false, "one flag after a review cannot collapse what the review left standing");
  assert.equal(r.flag_count, 7, "the raw count still counts every flag");
  assert.equal(r.weighted_flag_count, 1, "only the flag after the answer weighs");
  assert.ok(typeof r.counted_since === "number", "the response says from when it counted");
  assert.equal((db.prepare("SELECT mod_state FROM posts WHERE id = 1").get() as { mod_state: string | null }).mod_state, null);
});

test("a disposition carries the weighted sum beside the raw count, and still names no flagger", async () => {
  // Post 445's question (#6538): was it near the threshold when it was
  // answered? The chained detail said "6 flag(s)", and the weights live in
  // flags JOIN citizens, which no stranger can read.
  const { env, db } = seed(5, false);
  const young = Date.now() - WEEK / 2;
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at)
           VALUES (50, 'young', 'test', 's', 0, ${young}, ${young});
           INSERT INTO flags (citizen_id, target_type, target_id, reason, created_at)
           VALUES (50, 'post', 1, 'r', ${young});`);
  const maintainer = { id: 1, handle: "author" } as never;
  const r = (await disposeFlag(env, maintainer, { target_type: "post", target_id: 1, disposition: "no-action", reason: "reviewed" })) as unknown as Record<string, unknown>;
  // Mutation: keep only the raw count in the detail. Five mature flags and a
  // half-week-old one read "6 flag(s)", the same as six mature ones.
  assert.equal(r.flags_at_decision, 6);
  assert.equal(r.weighted_at_decision, 5.5);
  const ev = db.prepare("SELECT detail FROM identity_events WHERE kind = 'flag-disposition'").get() as { detail: string };
  assert.match(ev.detail, /no-action at 6 flag\(s\), weighted 5\.5 — reviewed/);
  // The aggregate is the whole of it: no flagger handle reaches the log.
  assert.ok(!/young|f1\d/.test(ev.detail), "a disposition judges the target, never the citizens who flagged it");
});

test("control: five mature flags with no answer still collapse on the next flag", async () => {
  const { env, db } = seed(5, false);
  const r = (await flagContent(env, late, "post", 1, "fifth-plus-one")) as unknown as Record<string, unknown>;
  assert.equal(r.collapsed, true, "an unreviewed target at the threshold still folds");
  assert.equal(r.counted_since, null);
  assert.equal((db.prepare("SELECT mod_state FROM posts WHERE id = 1").get() as { mod_state: string | null }).mod_state, "collapsed");
});
