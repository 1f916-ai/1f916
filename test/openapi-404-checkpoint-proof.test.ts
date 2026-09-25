// /openapi.json declares the PLAIN clocked-error 404 the keyless client meets
// on the two Merkle-log proof reads, not only the success status and the
// malformed-query 400.
//
// GET /api/checkpoint/consistency answers, when the tree size named by from or
// to has no checkpoint row, the same clocked JSON error body as every other
// refused read: now, now_utc and a single prose `error` string ("no checkpoint
// at <operand> for log <log>"), with no id_class discriminator. GET /api/proof
// answers the same body when the row id names no chain row ("<log> has no row
// <event>") or when the newest checkpoint does not yet cover the event.
// (src/checkpoint.ts throws SocietyError(404) for each.) The document declared
// only the 200 and the query 400 on these two, so an openapi-fetch client
// narrowing on status typed the miss `never`: it could not read off the wire
// that nothing is recorded at the named coordinate, as opposed to the
// endpoint itself being absent -- the undiagnosable-typing class the
// keyless-lookup 404 (test/openapi-404-plain-miss.test.ts) fixed on its own
// side, on the proof-read side.
//
// This file keeps the declaration honest against the router in-process: the
// two proof reads declare the plain 404 and no other route does via this set,
// the declared body is the clocked JSON error with no id_class, and the live
// router actually serves that body on both.
//
// Deliberately apart from PLAIN_404_ROUTES: that set is the path-id keyless
// lookup reads, and its test pins the eleven. These two take their arguments
// in the query string. The malformed-query 400 (bad log, sizes, or event id)
// is the query400 rule, a different outcome; the legacy_unsealed 409 on
// /api/proof is a state refusal, not an absence, and stays undeclared.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { ANCHOR_FILE_404_ROUTES, CHECKPOINT_PROOF_404_ROUTES, MANDATE_404_ROUTES, PLAIN_404_ROUTES, SEALS_404_ROUTES, WRITE_TARGET_404_ROUTES } from "../src/connect.ts";

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

test("CHECKPOINT_PROOF_404_ROUTES is exactly the two Merkle-log proof reads", () => {
  assert.deepEqual(
    [...CHECKPOINT_PROOF_404_ROUTES].sort(),
    ["/api/checkpoint/consistency", "/api/proof"],
    "the checkpoint-proof-404 set drifted from the two Merkle-log proof reads",
  );
});

test("the two proof reads declare the plain 404, and the set adds exactly two to the fourteen declared", async () => {
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
      const isProof = verb === "get" && CHECKPOINT_PROOF_404_ROUTES.has(path.replace(/\{([A-Za-z_]+)\}/g, ":$1"));
      // The sibling 404 sets each declare the same clocked 404 through their
      // own membership (anchor files, proof reads, seals, content-target
      // writes); test/openapi-404-plain-miss.test.ts owns the full closed set.
      const tpl = path.replace(/\{([A-Za-z_]+)\}/g, ":$1");
      const isSibling =
        (verb === "get" && (ANCHOR_FILE_404_ROUTES.has(tpl) || CHECKPOINT_PROOF_404_ROUTES.has(tpl) || SEALS_404_ROUTES.has(tpl) || MANDATE_404_ROUTES.has(tpl))) ||
        (verb === "post" && WRITE_TARGET_404_ROUTES.has(tpl));
      const expected404 = isSibling || isPlainLookup || isProse404 || ((path === "/api/post/{id}" || path === "/api/comment/{id}") && isTyped);
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
  // the two Merkle-log proof reads = sixteen declared 404s, no more.
  // With every sibling set merged the document declares twenty-three.
  assert.equal(declared404, 25, `expected twenty-five declared 404s across the plain, typed, prose, mandate and sibling sets, got ${declared404}`);
});

test("the declared checkpoint-proof-404 body is the clocked JSON error with no id_class", async () => {
  const doc = await docPaths();
  let checked = 0;
  for (const [path, ops] of Object.entries(doc)) {
    for (const [verb, op] of Object.entries(ops)) {
      const shouldBe = verb === "get" && CHECKPOINT_PROOF_404_ROUTES.has(path.replace(/\{([A-Za-z_]+)\}/g, ":$1"));
      if (!shouldBe) continue;
      const body = op.responses["404"];
      assert.ok(body, `${path} proof read declares a 404`);
      assert.deepEqual(Object.keys(body.content ?? {}), ["application/json"], `${path} 404 content is JSON`);
      const s = body.content?.["application/json"]?.schema;
      assert.ok(s && s.type === "object", `${path} 404 schema is an object`);
      const props = s?.properties as Record<string, unknown> | undefined;
      assert.ok(props && "error" in props, `${path} 404 schema names the error string`);
      assert.ok(!props?.id_class, `${path} checkpoint-proof-404 body carries no id_class discriminator`);
      assert.deepEqual((s?.required as string[]) ?? [], ["error"], `${path} 404 required: only the error is always present`);
      assert.match(body.description ?? "", /no id_class/i, `${path} 404 description says the body carries no id_class`);
      checked++;
    }
  }
  assert.equal(checked, 2, `expected exactly the two Merkle-log proof reads, got ${checked}`);
});

test("the live router serves the clocked plain 404 on both proof reads, with no id_class", async () => {
  const { env } = sqliteTestEnv(schema);
  const miss: [string, string, RegExp][] = [
    ["/api/checkpoint/consistency?log=identity_events&from=7000000&to=7000001", "a tree size with no checkpoint", /no checkpoint at from=7000000 and to=7000001/],
    ["/api/proof?log=identity_events&event=999999999", "a row id that names no chain row", /identity_events has no row 999999999/],
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
  const bad = await worker.fetch(new Request(`${ORIGIN}/api/proof?log=bogus_log&event=1`), env);
  assert.equal(bad.status, 400, "an invented log is the malformed-query 400, not the absence 404");
});
