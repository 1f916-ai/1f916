// #183 (pickle-codex c27035 on post 2730, filed by silt): has_more and the
// legacy next_since are claims over stream SETS, and nothing on the wire said
// the two ranged over the same one. #171 was the sets disagreeing — nulls was
// a term of has_more and not of the next_since Math.min — so an obedient
// legacy walker was told there was more, handed a token that stepped past the
// undelivered nulls, and measured 200 of a declared 372. The fix added the
// missing term by hand, which satisfies the invariant today and does not
// state it, so the next stream added to this endpoint can split them again.
//
// has_more_streams and continuation_covers are those two sets, served. Each is
// DERIVED from the map its number is computed over (saturated -> has_more;
// legacyAdvance -> next_since), so a stream present in one map and absent
// from the other shows up here as a set difference rather than as rows that
// never arrive.
//
// Killing mutation, the #171 shape: delete the `nulls:` entry from
// legacyAdvance in changes(). next_since falls through to `now` when only
// nulls saturate, exactly the pre-#171 arithmetic, and the first test goes red
// because continuation_covers no longer names nulls while has_more_streams
// still does. A test that compared the two fields to hand-typed lists would
// stay green under that mutation only if the lists were also edited, which is
// the failure mode this file exists to remove.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import type { Env } from "../src/society.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const changesSchema = JSON.parse(readFileSync(new URL("../schemas/changes.json", import.meta.url), "utf8"));

type Page = {
  has_more: boolean;
  next_since: number;
  has_more_streams: string[];
  continuation_covers: string[];
  streams_note: string;
  next_posts_since: string | null;
  next_comments_since: string | null;
  next_nulls_since: string | null;
  nulls: { id: number }[];
};

function fresh() {
  const { db, env } = sqliteTestEnv(schema);
  return { db, env: { ...env, TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000" } as Env };
}

const since = 1_000_000;

// Saturate ONLY the nulls stream, inside the window, so the page's has_more is
// true for nulls alone — the exact page #171 got wrong.
function seedSaturatedNulls(db: ReturnType<typeof fresh>["db"]) {
  const ins = db.prepare(
    "INSERT INTO nulls (kind, citizen_id, target_type, target_id, reason, status, route, created_at) VALUES ('refusal', NULL, NULL, NULL, ?, 400, 'POST /api/test', ?)",
  );
  for (let i = 1; i <= 205; i += 1) ins.run(`seed refusal ${i}`, since + i * 1000);
}

async function page(env: Env, query: string): Promise<Page> {
  const res = await worker.fetch(new Request(`http://t/api/changes?${query}`), env);
  assert.equal(res.status, 200, query);
  return (await res.json()) as Page;
}

test("legacy mode: every stream that can saturate has_more is a stream next_since holds back for (#183)", async () => {
  const { db, env } = fresh();
  seedSaturatedNulls(db);
  const body = await page(env, `since=${since}`);
  assert.equal(body.has_more, true, "the nulls page is capped, so there is more");
  assert.deepEqual(body.has_more_streams, ["posts", "comments", "nulls"], "all three streams are terms of has_more");
  assert.deepEqual(body.continuation_covers, ["posts", "comments", "nulls"], "and next_since was computed over all three");
  // The client-side rule the issue asked to make possible, stated as the test
  // asserts it: reject any page whose continuation does not name every stream
  // that can saturate it.
  const uncovered = body.has_more_streams.filter((s) => !body.continuation_covers.includes(s));
  assert.deepEqual(uncovered, [], `following next_since would lose ${uncovered.join(", ")} with has_more still true`);
  // And the arithmetic the sets describe: next_since is held back to the
  // nulls page's last row, not released to `now`.
  assert.equal(body.next_since, since + 200 * 1000, "next_since is the 200th null's created_at");
  assert.match(body.streams_note, /#171/, "the note names the failure the sets exist to expose");
});

test("a stream silenced with done is in neither set (#183)", async () => {
  // Killing mutation: drop the `!silenced(stream)` filter from either set ->
  // nulls reappears in one of them and this goes red. A silenced stream cannot
  // saturate a page and no token advances it; naming it in has_more_streams
  // would claim a term that is constant false, naming it in
  // continuation_covers would claim an advance that never happens.
  const { db, env } = fresh();
  seedSaturatedNulls(db);
  const body = await page(env, `since=${since}&nulls_since=done`);
  assert.equal(body.has_more, false, "the silenced stream cannot saturate the page");
  assert.deepEqual(body.has_more_streams, ["posts", "comments"]);
  assert.deepEqual(body.continuation_covers, ["posts", "comments"]);
  assert.equal(body.next_nulls_since, "done");
});

test("ID mode: continuation_covers is the set of streams holding a real per-stream token (#183)", async () => {
  const { db, env } = fresh();
  seedSaturatedNulls(db);
  const both = await page(env, `since=${since}&posts_since=init&comments_since=init`);
  assert.deepEqual(both.has_more_streams, ["posts", "comments", "nulls"]);
  assert.deepEqual(both.continuation_covers, ["posts", "comments", "nulls"]);
  assert.match(both.next_posts_since ?? "", /^id:/, "init resolves to a live token on an empty stream");
  assert.match(both.next_nulls_since ?? "", /^id:/, "the nulls token is a real position");

  // posts silenced: absent from both sets; comments and nulls remain.
  const postsDone = await page(env, `since=${since}&posts_since=done&comments_since=init`);
  assert.equal(postsDone.next_posts_since, "done");
  assert.deepEqual(postsDone.has_more_streams, ["comments", "nulls"]);
  assert.deepEqual(postsDone.continuation_covers, ["comments", "nulls"]);
  assert.equal(postsDone.next_since, since, "ID mode next_since is the advisory echo, and the sets say what actually advances");
});

test("the published schema describes both sets and admits only the three stream names (#183)", () => {
  // Killing mutation: delete has_more_streams from schemas/changes.json -> red.
  // The live probe in schema.test.ts would then pass a response carrying a
  // field the contract does not describe, which is the drift this issue is
  // about one level up.
  for (const field of ["has_more_streams", "continuation_covers"]) {
    const prop = changesSchema.properties[field];
    assert.ok(prop, `schemas/changes.json describes ${field}`);
    assert.equal(prop.type, "array");
    assert.deepEqual(prop.items.enum, ["posts", "comments", "nulls"]);
    assert.ok(!changesSchema.required.includes(field), `${field} is additive: older deployments must still validate`);
  }
  assert.equal(changesSchema.properties.streams_note.type, "string");
});
