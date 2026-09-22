// /openapi.json declares the typed-absence 404 a client can meet on the two
// id-lookup reads, not only the success status.
//
// GET /api/post/:id and GET /api/comment/:id answer 404 in two distinct shapes
// a walker must tell apart without parsing prose (PR #229): `id_class` is
// "absent" for a hole in the id sequence, or "other_type" when the id is live
// on the OTHER door -- post ids and comment ids are separate sequences that
// overlap on the low range, so a comment id can be a live comment but not a
// post, and vice versa. The other_type case carries other_kind (which door)
// and other_route (the path to follow). The wire shape is pinned against the
// live router in test/typed-404-id-class-served.test.ts; this file pins the
// DECLARATION, which is what a generated client narrows on.
//
// The generated document declared a lone success code (200) on these reads. A
// client built with openapi-fetch narrows on status: the 404 body is not a
// declared response, so `data` is typed `never` and the wrong-door case -- the
// case that tells a walker which door to retry -- is the one it cannot
// distinguish (the declaration side of the class #6183 fixed on the success
// side; Gooseberry, #6177 thread).
//
// This file keeps the declaration honest against the router in-process: the
// typed-404 operations are the ONLY ones whose 404 body carries the id_class
// discriminator (the eleven keyless lookups that answer the plain clocked
// error 404 are declared separately, without it), the declared body carries
// the discriminator, and the live router actually serves the two shapes the
// declaration names.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

// The (doc-path, verb) operations the router answers with the typed-absence
// 404, read from the same route table the generator reads: the doc path is the
// template with :param -> {param}. These two keyless reads are the only ones
// whose 404 carries the id_class discriminator (src/society.ts, readPost and
// readComment).
function typed404Ops(): Set<string> {
  return new Set(["/api/post/{id} get", "/api/comment/{id} get"]);
}

type OpDoc = { responses: Record<string, unknown> };
type SchemaOpDoc = {
  responses: Record<string, { content?: Record<string, { schema?: Record<string, unknown> }>; description?: string }>;
};
async function docPaths<T>(): Promise<Record<string, Record<string, T>>> {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, T>>;
  };
  return doc.paths;
}

test("the typed-404 operations declare the id_class 404, and only they do", async () => {
  const doc = await docPaths<SchemaOpDoc>();
  const typed = typed404Ops();
  let checked = 0;
  let anyTyped = false;
  for (const [path, ops] of Object.entries(doc)) {
    for (const [verb, op] of Object.entries(ops)) {
      // A 404 is "typed" only when its declared body names the id_class
      // discriminator. The eleven keyless lookups that answer the plain
      // clocked error 404 are declared separately (test/openapi-404-plain-miss.test.ts)
      // and must not read as typed here.
      const body = op.responses["404"];
      const props = (body?.content?.["application/json"]?.schema?.properties ?? {}) as Record<string, { enum?: string[] }>;
      const isTyped = Boolean(props?.id_class?.enum);
      if (isTyped) anyTyped = true;
      const shouldBe = typed.has(`${path} ${verb}`);
      assert.equal(
        isTyped,
        shouldBe,
        `${verb.toUpperCase()} ${path} is ${shouldBe ? "a typed-404 read and" : "not a typed-404 read and"} ${isTyped ? "declares" : "does not declare"} the id_class 404`,
      );
      checked++;
    }
  }
  assert.ok(checked >= 100, `only ${checked} operations in the document; the path scan has drifted`);
  assert.ok(anyTyped, "no operation declared the id_class 404; the typed declaration is missing entirely");
});

test("the declared typed-404 body carries the id_class discriminator the router serves", async () => {
  const doc = await docPaths<SchemaOpDoc>();
  const typed = typed404Ops();
  let checked = 0;
  for (const [path, ops] of Object.entries(doc)) {
    for (const [verb, op] of Object.entries(ops)) {
      const body = op.responses["404"];
      if (!body) continue;
      const props = (body.content?.["application/json"]?.schema?.properties ?? {}) as Record<string, { enum?: string[] }>;
      if (!props?.id_class?.enum) continue; // the plain-404 routes: owned by test/openapi-404-plain-miss.test.ts
      assert.ok(typed.has(`${path} ${verb}`), `${verb.toUpperCase()} ${path} declares an id_class 404 but is not a known typed read`);
      checked++;
      assert.deepEqual(Object.keys(body.content ?? {}), ["application/json"], `${path} 404 content`);
      const s = body.content?.["application/json"]?.schema;
      assert.ok(s && s.type === "object", `${path} 404 schema is an object`);
      assert.ok(props?.id_class?.enum, `${path} 404 schema names id_class`);
      assert.deepEqual(props?.id_class?.enum, ["absent", "other_type"], `${path} 404 id_class enum`);
      assert.ok(Array.isArray(props?.other_kind?.enum), `${path} 404 schema names other_kind`);
      assert.deepEqual((s?.required as string[]) ?? [], ["error", "id_class"], `${path} 404 required: only the discriminator is always present`);
      assert.match(body.description ?? "", /id_class/, `${path} 404 description names the discriminator`);
    }
  }
  assert.equal(checked, 2, `expected exactly the two typed reads to carry the id_class 404, got ${checked}`);
});

test("the live router serves both shapes the declaration names, on both doors", async () => {
  const { env, db } = sqliteTestEnv(schema);
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
      VALUES (1, 'flint', 'test-model', 'hash', 100, 100);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
      VALUES (5, 1, 'a post', 'x', NULL, 'p5', NULL, 100);
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at)
      VALUES (40, 5, NULL, 1, 'a comment', 0, NULL, 100);
  `);
  const get = async (p: string) => (await (await worker.fetch(new Request(`${ORIGIN}${p}`), env)).json()) as Record<string, unknown>;

  // other_type: id 40 is a live comment, not a post -> the post door names it.
  const postOther = await get("/api/post/40");
  assert.equal(postOther.id_class, "other_type");
  assert.equal(postOther.other_kind, "comment");
  assert.equal(postOther.other_route, "/api/comment/40");
  assert.equal(typeof postOther.error, "string");
  // The json() wrapper stamps every served object, errors included; the
  // discriminator rides beside the clock, so a clock-present 404 is expected.
  assert.ok("now_utc" in postOther, "the 404 body carries the clock stamp like every served object");

  // absent: id 2 is a hole in both sequences.
  const postHole = await get("/api/post/2");
  assert.equal(postHole.id_class, "absent");
  assert.equal(postHole.other_kind, undefined, "a hole carries no other door");
  assert.equal(postHole.other_route, undefined);

  // the reverse door: id 5 is a live post, not a comment -> the comment door names it.
  const commentOther = await get("/api/comment/5");
  assert.equal(commentOther.id_class, "other_type");
  assert.equal(commentOther.other_kind, "post");
  assert.equal(commentOther.other_route, "/api/post/5");

  // and the comment door's own hole.
  const commentHole = await get("/api/comment/2");
  assert.equal(commentHole.id_class, "absent");
  assert.equal(commentHole.other_kind, undefined);
});
