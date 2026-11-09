// Soft-power: schemas/mandates.json $id is https://1f916.ai/schemas/mandates.json,
// but that URL 404'd while /source/1f916/schemas/mandates.json 200'd and
// GET /api/mandates's OpenAPI 200 carried examples with no schema (hollow 200).
//
// This PR serves the file at its $id, publishes the same object as the OpenAPI
// 200 schema for GET /api/mandates, and pins both against drop / type-flip
// mutants on every mandateListRow required field.
//
// Killing mutations:
//   1. Drop the /schemas/mandates.json route -> served status != 200.
//   2. Serve a different object than schemas/mandates.json -> deepEqual fails.
//   3. Leave GET /api/mandates 200 without a schema -> declared is undefined.
//   4. Wire a different schema than the file -> deepEqual against file fails.
//   5. Drop any mandateListRow required property from the schema -> drop mutant
//      of a real row validates (must not).
//   6. Widen a required field's type so a flipped value validates -> type-flip
//      mutant must stay rejected.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { validate } from "./helpers/json-schema.ts";
import worker from "../src/index.ts";
import { SURFACE } from "../src/surface.ts";

const schemaSql = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const fileSchema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/mandates.json", import.meta.url)), "utf8"),
) as Record<string, unknown>;
const ORIGIN = "https://1f916.ai";
const SCHEMA_PATH = "/schemas/mandates.json";
const EXPECTED_ID = "https://1f916.ai/schemas/mandates.json";

const rowDef = (fileSchema.$defs as Record<string, Record<string, unknown>>).mandateListRow;
const rowProps = rowDef.properties as Record<string, Record<string, unknown>>;
const rowRequired = rowDef.required as string[];

/** Minimal list body that validates today; used as the drop/type-flip host. */
function validListBody(): Record<string, unknown> {
  return {
    now: 1,
    now_utc: "1970-01-01T00:00:00.001Z",
    contract: "1f916.mandates.v1",
    what_this_is: "Mandates list.",
    mandates: [
      {
        id: 1,
        citizen: "example-citizen",
        label: "digest",
        subject: null,
        signed: false,
        signature: null,
        key_thumbprint: null,
        signed_message: null,
        created_at: 1,
        public: false,
        instruction_hash: "a".repeat(64),
        action_hash: "b".repeat(64),
        outcome_hash: null,
        commit: "c".repeat(64),
        commit_payload: "1f916.mandate.v1:example-citizen:1:" + "a".repeat(64) + ":" + "b".repeat(64) + ":",
        seal: { id: 1, label: "mandate", chained: "d".repeat(64) },
        stored: { instruction: false, action: false, outcome: false, envelope: false },
        envelope_bytes: null,
        envelope_format: null,
        page: "/mandates/1",
        record: "/api/record/example-citizen",
        has_outcome: false,
        outcome_added: null,
      },
    ],
    has_more: false,
    next_since_id: 1,
    caps: { per_response: 100, unit: "mandates", more: "has_more" },
  };
}

test("$id is the public URL this PR serves", () => {
  assert.equal(fileSchema.$id, EXPECTED_ID);
});

test("GET /schemas/mandates.json serves the file at its $id, unclocked", async () => {
  const { env } = sqliteTestEnv(schemaSql);
  const res = await worker.fetch(new Request(`${ORIGIN}${SCHEMA_PATH}`), env);
  assert.equal(res.status, 200, "the $id URL must not 404");
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.now, undefined, "JSON Schema document must not carry the society clock");
  assert.equal(body.$id, EXPECTED_ID);
  assert.deepEqual(body, fileSchema, "served bytes must be the reviewed schemas/mandates.json");
});

test("OpenAPI GET /api/mandates 200 publishes schemas/mandates.json (not a hollow 200)", async () => {
  const { env } = sqliteTestEnv(schemaSql);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema?: unknown }> }> }>>;
  };
  const declared = doc.paths["/api/mandates"]?.get?.responses["200"]?.content?.["application/json"]?.schema;
  assert.ok(declared, "GET /api/mandates 200 must publish a JSON response schema");
  assert.deepEqual(declared, fileSchema, "OpenAPI schema must be identical to schemas/mandates.json");
  assert.equal((declared as { $id?: string }).$id, EXPECTED_ID);

  const schemaDoc = doc.paths[SCHEMA_PATH]?.get?.responses["200"];
  assert.ok(schemaDoc, "OpenAPI must list GET /schemas/mandates.json");
  assert.doesNotMatch(schemaDoc.description, /^JSON; every object carries/, "schema document must not promise the clock");
});

test("the served document is compact, not the pretty-printed file, so the SURFACE prose must not claim byte-identity", async () => {
  // json() serializes the imported object with JSON.stringify (compact), so the
  // served body is NOT byte-identical to the pretty-printed source file even
  // though it parses equal. A served summary that says "same bytes" is a claim
  // an agent can falsify by hashing both. The prose must make the structural
  // claim instead. (Deploy-gate finding on PR#736, 2026-11-07.)
  const { env } = sqliteTestEnv(schemaSql);
  const servedText = await (await worker.fetch(new Request(`${ORIGIN}${SCHEMA_PATH}`), env)).text();
  const fileText = readFileSync(fileURLToPath(new URL("../schemas/mandates.json", import.meta.url)), "utf8");
  assert.notEqual(servedText.length, fileText.length, "served (compact) and file (pretty) differ in bytes — 'same bytes' would be false");
  assert.equal(JSON.stringify(JSON.parse(servedText)), JSON.stringify(JSON.parse(fileText)), "but they are structurally equal");

  const entry = SURFACE.find((r) => r.path === SCHEMA_PATH);
  assert.ok(entry, "SURFACE must list /schemas/mandates.json");
  assert.doesNotMatch(entry.summary, /same bytes/i, "SURFACE summary must not claim byte-identity with the source file");
});

test("dropping any mandateListRow required field makes a real row fail validation", () => {
  const body = validListBody();
  assert.deepEqual(validate(fileSchema, body), [], "control body must validate before mutants");

  for (const field of rowRequired) {
    const mutantSchema = structuredClone(fileSchema) as Record<string, unknown>;
    const mutantRow = (mutantSchema.$defs as Record<string, Record<string, unknown>>).mandateListRow;
    const req = [...(mutantRow.required as string[])].filter((k) => k !== field);
    mutantRow.required = req;
    // A body missing `field` must still validate against the weakened schema
    // (proving the drop mattered) and must NOT validate against the real one.
    const weakenedBody = structuredClone(body) as Record<string, unknown>;
    const row = (weakenedBody.mandates as Record<string, unknown>[])[0];
    delete row[field];
    assert.deepEqual(
      validate(mutantSchema, weakenedBody),
      [],
      `drop-${field}: weakened schema must accept a body missing ${field}`,
    );
    assert.ok(
      validate(fileSchema, weakenedBody).length > 0,
      `drop-${field}: published schema must reject a body missing ${field}`,
    );
  }
  assert.equal(rowRequired.length, 23, "mandateListRow required count (re-count if schema grows)");
});

test("type-flipping any mandateListRow field is rejected by the published schema", () => {
  const body = validListBody();
  assert.deepEqual(validate(fileSchema, body), [], "control body must validate before type-flips");

  // Pick a flipped value incompatible with each field's declared type.
  function flip(field: string, prop: Record<string, unknown>): unknown {
    const t = prop.type;
    const types = Array.isArray(t) ? t : t != null ? [t] : [];
    if (types.includes("integer") || types.includes("number")) return "not-a-number";
    if (types.includes("boolean")) return "not-a-boolean";
    if (types.includes("object")) return 0;
    if (types.includes("array")) return 0;
    if (types.includes("string")) return 0;
    if (prop.anyOf || prop.oneOf) return { unexpected: true };
    // null-only or unknown — use an empty object which most scalar fields reject
    return { unexpected: true };
  }

  let flipped = 0;
  for (const field of rowRequired) {
    const prop = rowProps[field];
    assert.ok(prop, `mandateListRow.properties.${field} exists`);
    const mutant = structuredClone(body) as Record<string, unknown>;
    const row = (mutant.mandates as Record<string, unknown>[])[0];
    row[field] = flip(field, prop);
    const errors = validate(fileSchema, mutant);
    assert.ok(errors.length > 0, `type-flip ${field}: published schema must reject ${JSON.stringify(row[field])}; got ${errors}`);
    flipped += 1;
  }
  assert.equal(flipped, 23, "every required row field got a type-flip probe");
});
