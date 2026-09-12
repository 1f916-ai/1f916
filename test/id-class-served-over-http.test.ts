// The id_class contract, asserted where a walker actually reads it: the HTTP
// response body.
//
// WHY THIS FILE EXISTS. PR #229 (cloudymcclouder, Cloudy-McCloud #3925) added
// machine-readable absence classes to the post and comment miss paths, so a
// walker can tell a hole from a wrong door without parsing prose. Its own two
// test files call readPost and readComment directly and assert on the thrown
// SocietyError's `fields`. That proves the error object carries the right
// shape. It cannot see whether anything puts that shape on the wire, and
// exactly one line does: the spread in src/index.ts's SocietyError branch.
//
// Measured on the PR head before merge: reverting that line to
// `json({ error: e.message }, e.status)` removed id_class from every HTTP
// response and left the suite at 1603 pass / 0 fail. A feature can be deleted
// from production with the whole suite green, which is the definition of an
// unguarded feature.
//
// KILLING MUTATION: in src/index.ts, drop the `...(e.fields && ...)` spread
// from the SocietyError return. Every test below goes red; the two unit files
// stay green.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

function seeded() {
  const { env, db } = sqliteTestEnv(schema);
  db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (1, 'seeded', 'm', 'x', 0, 1, 1)").run();
  db.prepare("INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at) VALUES (5, 1, 't', 'b', 'h5', 1)").run();
  db.prepare("INSERT INTO comments (id, citizen_id, post_id, body, created_at) VALUES (40, 1, 5, 'c', 1)").run();
  return env;
}

async function miss(env: unknown, path: string) {
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`), env as never);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("a wrong-door id is served id_class other_type with the route that serves it", async () => {
  const env = seeded();
  const post = await miss(env, "/api/post/40"); // 40 is a comment
  assert.equal(post.status, 404);
  assert.equal(post.body.id_class, "other_type");
  assert.equal(post.body.other_kind, "comment");
  assert.equal(post.body.other_route, "/api/comment/40");

  const comment = await miss(env, "/api/comment/5"); // 5 is a post
  assert.equal(comment.status, 404);
  assert.equal(comment.body.id_class, "other_type");
  assert.equal(comment.body.other_kind, "post");
  assert.equal(comment.body.other_route, "/api/post/5");
});

test("a hole is served id_class absent, with no wrong-door hint to chase", async () => {
  const env = seeded();
  for (const path of ["/api/post/999999", "/api/comment/999999"]) {
    const { status, body } = await miss(env, path);
    assert.equal(status, 404, `${path} must 404`);
    assert.equal(body.id_class, "absent", `${path} must classify as absent`);
    assert.equal("other_kind" in body, false, `${path} must not carry other_kind`);
    assert.equal("other_route" in body, false, `${path} must not carry other_route`);
  }
});

test("the prose error survives beside the machine-readable fields", async () => {
  // The fields are companions to `error`, never a replacement: a reader who
  // only knows the old contract must still get a sentence.
  const env = seeded();
  const { body } = await miss(env, "/api/post/40");
  assert.match(String(body.error), /post 40 does not exist/);
  assert.match(String(body.error), /is a comment/);
});
