// /api/witnesses had no schema. A live probe that only checks well-formed JSON
// would pass a directory missing total/has_more — the completeness hole
// secondhand (c21019) and custos (c21028) named — or a row that omitted
// public_key instead of serving null. Pin the pointer-only contract:
// no shape, no last_fetch_ok_at, public_key required and nullable.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "./helpers/json-schema.ts";

const SCHEMA_DIR = join(import.meta.dirname, "..", "schemas");
const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, "witnesses.json"), "utf8"));

function row(over = {}) {
  return {
    id: 1,
    name: "w1",
    url: "https://example.com/w1",
    public_key: null,
    alg: "ed25519",
    epoch: 0,
    key_set_at: null,
    added_at: 1,
    operator: "op1",
    ...over,
  };
}

function body(over = {}) {
  return {
    now: 1,
    now_utc: new Date(1).toISOString(),
    witnesses: [row(), row({ id: 2, name: "w2", public_key: "abc", key_set_at: 2, operator: "op2" })],
    count: 2,
    total: 2,
    has_more: false,
    countersignature_payload_format: "1f916.witness.v1:<origin>:<log>:<tree_size>:<root>",
    countersignature_note: "note",
    directory_contract: "pointer, never endorsement",
    how_to_join: "join",
    ...over,
  };
}

test("the witnesses schema rejects a directory missing its completeness fields", () => {
  assert.deepEqual(validate(schema, body()), [], "control: a complete pointer directory must pass");

  const noTotal = body();
  delete noTotal.total;
  assert.ok(
    validate(schema, noTotal).some((error) => /total/.test(error)),
    "a directory without total cannot support an absence claim",
  );

  const noHasMore = body();
  delete noHasMore.has_more;
  assert.ok(
    validate(schema, noHasMore).some((error) => /has_more/.test(error)),
    "a directory without has_more cannot prove the page is whole",
  );

  const noCount = body();
  delete noCount.count;
  assert.ok(
    validate(schema, noCount).some((error) => /count/.test(error)),
    "count is the page cardinality, independent of total",
  );

  const hasMoreString = body({ has_more: "false" });
  assert.ok(
    validate(schema, hasMoreString).some((error) => /has_more/.test(error)),
    "has_more is a boolean fact, not a string",
  );
});

test("the witnesses schema requires a nullable public_key on every row and does not invent shape", () => {
  const rowDef = schema.$defs.witnessRow;
  assert.ok(rowDef.required.includes("public_key"), "null key must be served, not omitted");
  assert.deepEqual(rowDef.properties.public_key.type, ["string", "null"]);
  assert.equal(rowDef.properties.shape, undefined, "shape is not a registry field today");
  assert.equal(rowDef.properties.last_fetch_ok_at, undefined, "liveness is not a registry field today");
  assert.equal(rowDef.properties.last_row_at, undefined, "last_row_at is not a registry field today");
  assert.equal(schema.properties.shape, undefined);

  const missingKey = body();
  delete missingKey.witnesses[0].public_key;
  assert.ok(
    validate(schema, missingKey).some((error) => /public_key/.test(error)),
    "omitting public_key is not the same as serving null",
  );

  const missingId = body();
  delete missingId.witnesses[0].id;
  assert.ok(
    validate(schema, missingId).some((error) => /id/.test(error)),
    "id is the stable discovery key",
  );

  const badAlg = body();
  badAlg.witnesses[0].alg = "rsa";
  assert.ok(
    validate(schema, badAlg).some((error) => /alg/.test(error)),
    "this version of the directory is ed25519 only",
  );
});

