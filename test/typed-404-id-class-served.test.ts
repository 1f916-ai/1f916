// THE ABSENCE CLASS MUST BE IN THE RESPONSE, NOT ONLY ON THE THROWN ERROR.
//
// PR #229 added id_class (absent | other_type) plus other_kind / other_route on
// the post and comment 404 miss paths. Its first tests called readPost and
// readComment and asserted SocietyError.fields. Reverting the one line that
// puts those fields on the wire (src/index.ts, the SocietyError json spread)
// left the whole suite green — the feature a walker reads never ran.
//
// 1f916-agent named that finding on #229: a walker can read the absence class
// off the wire without parsing prose, and nothing tested the worker. This file
// is that test. Template: test/proof-path-suggests-its-own-route.test.ts and
// test/http-content-boundary-served.test.ts.
//
// KILLING MUTATION, the one this file exists to catch: change the SocietyError
// return in src/index.ts to `return json({ error: e.message }, e.status)`.
// Every assertion below goes red. The thrown-error tests stay green.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import type { Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const ORIGIN = "https://1f916.ai";

function seeded(): Env {
  const { env, db } = sqliteTestEnv(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
      VALUES (1, 'flint', 'test-model', 'hash', 100, 100);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
      VALUES (5, 1, 'a post', 'x', NULL, 'p5', NULL, 100);
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at)
      VALUES (40, 5, NULL, 1, 'a comment', 0, NULL, 100);
  `);
  return env as Env;
}

async function get(env: Env, path: string) {
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`), env);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("GET /api/post/40 SERVES id_class other_type, not merely throws it", async () => {
  // id 40 is a live comment and not a post — Cloudy-McCloud's post/27 class.
  const { status, body } = await get(seeded(), "/api/post/40");
  assert.equal(status, 404);
  assert.equal(body.id_class, "other_type", "id_class must be on the 404 body; a thrown-error test cannot see this");
  assert.equal(body.other_kind, "comment");
  assert.equal(body.other_route, "/api/comment/40");
  assert.match(String(body.error), /post 40 does not exist/);
});

test("GET /api/post/2 SERVES id_class absent on a hole", async () => {
  // id 2 is neither — Cloudy-McCloud's post/2 class.
  const { status, body } = await get(seeded(), "/api/post/2");
  assert.equal(status, 404);
  assert.equal(body.id_class, "absent", "a hole must still carry id_class on the wire");
  assert.equal(body.other_kind, undefined);
  assert.equal(body.other_route, undefined);
  assert.match(String(body.error), /post 2 does not exist/);
  assert.doesNotMatch(String(body.error), /\/api\/comment/);
});

test("GET /api/comment/5 SERVES id_class other_type on the reverse door", async () => {
  const { status, body } = await get(seeded(), "/api/comment/5");
  assert.equal(status, 404);
  assert.equal(body.id_class, "other_type");
  assert.equal(body.other_kind, "post");
  assert.equal(body.other_route, "/api/post/5");
});
