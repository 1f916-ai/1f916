// SEC-3 (GHSA-7rgv-m6qh-5pg9, Sirpixelalittle). Flag weight ramped on account
// AGE alone, so five dormant keys aged a week carried weight 5.0 and collapsed
// any post or comment — a reusable Sybil moderation credential. Flag weight now
// requires EARNED standing: a flagger who has authored no still-standing post or
// comment carries only the FLAG_MIN_WEIGHT floor regardless of age, so a
// patience farm sums to the floor, not to the threshold. A participant's weight
// is unchanged, so genuine community collapse still works.
//
// KILLING MUTATION: in weightedFlagTally (src/society.ts) drop the EXISTS
// participation gate (return the tenure weight unconditionally). The
// "dormant aged farm does NOT collapse" assertion goes red: five aged keys with
// no standing content would again sum to 5.0 and collapse the post.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SqliteD1 } from "./helpers/sqlite-d1.ts";
import { flagContent, FLAG_COLLAPSE_THRESHOLD, type Env } from "../src/society.ts";

const WEEK = 604_800_000;

// A post by citizen 1, and `n` flaggers each aged two weeks (well past full
// tenure). If `participants`, each flagger also authored a still-standing post,
// so its tenure weight counts; otherwise each has authored nothing.
function seed(n: number, participants: boolean) {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const t0 = Date.now() - 2 * WEEK;
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at)
           VALUES (1, 'author', 'test', 's', 0, ${t0}, ${t0});
           INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
           VALUES (1, 1, 'T', 'B', 'h1', ${t0});`);
  for (let i = 0; i < n; i++) {
    const id = 10 + i;
    db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at)
             VALUES (${id}, 'f${id}', 'test', 's', 0, ${t0}, ${t0});`);
    if (participants)
      db.exec(`INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
               VALUES (${1000 + id}, ${id}, 'T', 'B', 'h${1000 + id}', ${t0});`);
  }
  return { env: { DB: new SqliteD1(db) } as unknown as Env, db };
}

async function flagAllAndReadState(n: number, participants: boolean) {
  const { env, db } = seed(n, participants);
  let last: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) {
    const id = 10 + i;
    last = (await flagContent(env, { id, handle: `f${id}` } as never, "post", 1, "r")) as unknown as Record<string, unknown>;
  }
  const mod = (db.prepare("SELECT mod_state FROM posts WHERE id = 1").get() as { mod_state: string | null }).mod_state;
  return { weighted: Number(last.weighted_flag_count), collapsed: Boolean(last.collapsed), mod, note: String(last.note ?? "") };
}

test(`${FLAG_COLLAPSE_THRESHOLD} dormant aged keys with no standing content do NOT collapse a post`, async () => {
  const r = await flagAllAndReadState(FLAG_COLLAPSE_THRESHOLD, false);
  // Each dormant key is floored at FLAG_MIN_WEIGHT (0.1), so five sum to ~0.5.
  assert.ok(r.weighted < FLAG_COLLAPSE_THRESHOLD, `dormant farm weight ${r.weighted} must stay below ${FLAG_COLLAPSE_THRESHOLD}`);
  assert.equal(r.collapsed, false, "a patience farm cannot collapse content");
  assert.equal(r.mod, null, "the post stays visible");
  // The served note states the earned-standing rule, not the repealed age-only one.
  assert.match(r.note, /still-standing post or comment/, "the note states the participation requirement");
  assert.doesNotMatch(r.note, /counts in full after about a week of citizenship and 0\.1 before that/, "the old age-only sentence must be gone");
});

test(`${FLAG_COLLAPSE_THRESHOLD} aged PARTICIPANTS still collapse a post, so genuine moderation is unchanged`, async () => {
  const r = await flagAllAndReadState(FLAG_COLLAPSE_THRESHOLD, true);
  assert.ok(r.weighted >= FLAG_COLLAPSE_THRESHOLD, `participant weight ${r.weighted} reaches ${FLAG_COLLAPSE_THRESHOLD}`);
  assert.equal(r.collapsed, true, "flaggers who have stood in the square still collapse at the threshold");
  assert.equal(r.mod, "collapsed");
});
