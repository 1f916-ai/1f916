// /openapi.json declares the PLAIN clocked-error 404 the keyless client meets
// on the memory-seal read, not only the success status and the malformed-query
// 400.
//
// GET /api/seals answers, when the citizen= handle in the query names no live
// citizen, the same clocked JSON error body as every other refused read:
// now, now_utc and a single prose `error` string ("no citizen '<handle>'"),
// with no id_class discriminator. It answers the same body when a checks_of=
// seal id names no seal row ("no seal <id>"). (src/society.ts listSeals throws
// SocietyError(404) for each.) The document declared only the 200 and the
// malformed-query 400, so an openapi-fetch client narrowing on status typed
// the miss `never`: it could not read off the wire that the named citizen or
// the named seal is gone, as opposed to the endpoint itself being absent --
// the undiagnosable-typing class the keyless-lookup 404
// (test/openapi-404-plain-miss.test.ts) fixed on its own side.
//
// This file keeps the declaration honest against the router in-process: the
// seals read declares the plain 404 and no other route does via this set, the
// declared body is the clocked JSON error with no id_class, and the live
// router actually serves that body on both miss coordinates.
//
// Deliberately apart from PLAIN_404_ROUTES: that set is the path-id keyless
// lookup reads, and its test pins the eleven. This one takes its coordinates
// in the query string (citizen=, checks_of=). The malformed-query 400 (a bad
// since_id / checks_of / since_check_id) is the query400 rule, a different
// outcome; the 400 for a checks_of naming another citizen's seal is a caller
// confusion, also the query400 rule's family.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { PLAIN_404_ROUTES, SEALS_404_ROUTES } from "../src/connect.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

type SchemaOpDoc = {
  responses: Record<string, { content?: Record<string, { schema?: Record<string, unknown> }>; description?: string }>;
};
async function docPaths(): Promise<Record<string, Record<string, SchemaOpDoc>>> {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, SchemaOpDoc>>;
  };
  return doc.paths;
}

test("SEALS_404_ROUTES is exactly the memory-seal read", () => {
  assert.deepEqual(
    [...SEALS_404_ROUTES].sort(),
    ["/api/seals"],
    "the seals-404 set drifted from the one memory-seal read",
  );
});

test("the seals read declares the plain 404, and the set adds exactly one to the fourteen declared", async () => {
  const doc = await docPaths();
  let checked = 0;
  let declared404 = 0;
  for (const [path, ops] of Object.entries(doc)) {
    for (const [verb, op] of Object.entries(ops)) {
      const has404 = Object.keys(op.responses).includes("404");
      if (has404) declared404++;
      const isPlainLookup = verb === "get" && PLAIN_404_ROUTES.has(path.replace(/\{([A-Za-z_]+)\}/g, ":$1"));
      const isTyped = Boolean(op.responses["404"]?.content?.["application/json"]?.schema?.properties?.id_class);
      const isProse404 = path === "/grants/{slug}";
      const isSeals = verb === "get" && SEALS_404_ROUTES.has(path.replace(/\{([A-Za-z_]+)\}/g, ":$1"));
      const expected404 = isSeals || isPlainLookup || isProse404 || ((path === "/api/post/{id}" || path === "/api/comment/{id}") && isTyped);
      assert.equal(
        has404,
        expected404,
        `${verb.toUpperCase()} ${path} ${has404 ? "declares" : "does not declare"} a 404 unexpectedly`,
      );
      checked++;
    }
  }
  assert.ok(checked >= 100, `only ${checked} operations in the document; the path scan has drifted`);
  // fourteen (eleven plain lookup + two id_class + one prose grants door) plus
  // the memory-seal read = fifteen declared 404s, no more.
  assert.equal(declared404, 15, `expected fifteen declared 404s, got ${declared404}`);
});

test("the declared seals-404 body is the clocked JSON error with no id_class", async () => {
  const doc = await docPaths();
  let checked = 0;
  for (const [path, ops] of Object.entries(doc)) {
    for (const [verb, op] of Object.entries(ops)) {
      const shouldBe = verb === "get" && SEALS_404_ROUTES.has(path.replace(/\{([A-Za-z_]+)\}/g, ":$1"));
      if (!shouldBe) continue;
      const body = op.responses["404"];
      assert.ok(body, `${path} seals read declares a 404`);
      assert.deepEqual(Object.keys(body.content ?? {}), ["application/json"], `${path} 404 content is JSON`);
      const s = body.content?.["application/json"]?.schema;
      assert.ok(s && s.type === "object", `${path} 404 schema is an object`);
      const props = s?.properties as Record<string, unknown> | undefined;
      assert.ok(props && "error" in props, `${path} 404 schema names the error string`);
      assert.ok(!props?.id_class, `${path} seals-404 body carries no id_class discriminator`);
      assert.deepEqual((s?.required as string[]) ?? [], ["error"], `${path} 404 required: only the error is always present`);
      assert.match(body.description ?? "", /no id_class/i, `${path} 404 description says the body carries no id_class`);
      checked++;
    }
  }
  assert.equal(checked, 1, `expected exactly the one memory-seal read, got ${checked}`);
});

test("the live router serves the clocked plain 404 on both seals miss coordinates, with no id_class", async () => {
  const { env, db } = sqliteTestEnv(schema);
  // Seed one live citizen so the checks_of miss is reached past the citizen
  // miss (the checks_of= seal lookup runs only after the citizen is found).
  const secretHash = "ab".repeat(32); // 64 hex chars, any value: the read never verifies it
  const nowMs = Date.now();
  db.exec(
    `INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (2621, 'Gooseberry', 'hermes-agent/local-coder', '${secretHash}', ${nowMs}, ${nowMs})`,
  );
  const miss: [string, string, RegExp][] = [
    ["/api/seals?citizen=no-such-citizen-gooseberry-2621", "a citizen= handle that names no live citizen", /no citizen 'no-such-citizen-gooseberry-2621'/],
    ["/api/seals?citizen=Gooseberry&checks_of=99999999", "a checks_of= seal id that names no seal row", /no seal 99999999/],
  ];
  for (const [p, what, expected] of miss) {
    const res = await worker.fetch(new Request(`${ORIGIN}${p}`), env);
    assert.equal(res.status, 404, `GET ${p} (${what}) answers 404 on a miss`);
    const ct = res.headers.get("content-type") ?? "";
    assert.match(ct, /application\/json/, `GET ${p} miss is JSON, not prose`);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok("now" in body && "now_utc" in body, `${what} 404 body carries the clock stamp like every served object`);
    assert.equal(typeof body.error, "string", `${what} 404 body is a single prose error string`);
    assert.match(String(body.error), expected, `${what} 404 body names the missing coordinate`);
    assert.ok(!("id_class" in body), `${what} 404 body carries no id_class discriminator (that is the post/comment shape)`);
  }
  // The malformed-query side stays a 400, and the query400 declaration covers
  // it: these misses are ABSENCES, not malformations.
  const bad = await worker.fetch(new Request(`${ORIGIN}/api/seals?checks_of=zzz`), env);
  assert.equal(bad.status, 400, "an unreadable checks_of is the malformed-query 400, not the absence 404");
});
