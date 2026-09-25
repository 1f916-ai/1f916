// /openapi.json validates at the root.
//
// Every JSON object the router serves is stamped with `now` and `now_utc` by
// the json() wrapper. The OpenAPI 3.1 root object is closed: the meta-schema
// lists its members and sets unevaluatedProperties: false, so any key that is
// not one of them and does not start with `x-` makes the whole document
// invalid. Two validators refused the live document at the root, before
// reading a single path (Gooseberry, #6177 thread, 2026-09-21):
//
//   redocly lint:              error struct  Property `now` is not expected here.
//   openapi-spec-validator:    Unevaluated properties are not allowed ('now', 'now_utc' were unexpected)
//
// A client that lints before it generates never got to the 130 operations.
// The clock now rides as `x-now` / `x-now_utc`, which the specification
// reserves for exactly this, and the wrapper leaves this one document alone.
//
// The root allowlist below is OAS 3.1.0 §4.8.1 (the OpenAPI Object), copied
// rather than imported: the repo has no OpenAPI dependency and should not
// take one for a nine-entry list.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

// OpenAPI Object fixed fields, OAS 3.1.0. Anything else must match ^x-.
const OAS31_ROOT_FIELDS = new Set([
  "openapi",
  "info",
  "jsonSchemaDialect",
  "servers",
  "paths",
  "webhooks",
  "components",
  "security",
  "tags",
  "externalDocs",
]);

test("the OpenAPI root carries only fixed fields and x- extensions", async () => {
  const { env } = sqliteTestEnv(schema);
  const res = await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env);
  assert.equal(res.status, 200);
  const doc = (await res.json()) as Record<string, unknown>;
  const foreign = Object.keys(doc).filter((k) => !OAS31_ROOT_FIELDS.has(k) && !k.startsWith("x-"));
  assert.deepEqual(foreign, [], `root keys a validator refuses: ${JSON.stringify(foreign)}`);
});

test("the clock is still served, as extensions, on one instant", async () => {
  const { env } = sqliteTestEnv(schema);
  const res = await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env);
  const doc = (await res.json()) as { "x-now"?: unknown; "x-now_utc"?: unknown; now?: unknown; now_utc?: unknown };
  assert.equal(typeof doc["x-now"], "number", "x-now is the unix-millisecond clock");
  assert.equal(typeof doc["x-now_utc"], "string");
  assert.equal(new Date(doc["x-now"] as number).toISOString(), doc["x-now_utc"], "the two fields are one instant");
  assert.equal(doc.now, undefined, "the bare clock field must not come back through the wrapper");
  assert.equal(doc.now_utc, undefined);
});

test("no other JSON document lost its clock", async () => {
  // The wrapper opt-out is for the closed-root documents named in
  // connect.ts UNCLOCKED_DOCUMENTS (test/discovery-catalogs.test.ts pins that
  // set). If it leaks, the sibling discovery documents would be the first to
  // show it.
  const { env } = sqliteTestEnv(schema);
  for (const path of ["/.well-known/mcp.json", "/api/pulse", "/api/surface"]) {
    const doc = (await (await worker.fetch(new Request(`${ORIGIN}${path}`), env)).json()) as { now?: unknown; now_utc?: unknown };
    assert.equal(typeof doc.now, "number", `${path} still carries now`);
    assert.equal(typeof doc.now_utc, "string", `${path} still carries now_utc`);
  }
});
