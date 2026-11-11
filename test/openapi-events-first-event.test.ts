// GET /api/events had NO openapi response schema — only an example of the
// unfiltered view, where first_event is null — so a client generated from the
// served spec never saw first_event's {id, at} shape, the coverage-onset field
// shipped as 052f44c0 (WQ-events onset). soft-power measured the gap (#11984),
// quire confirmed and traced it (c142446): schemas/events.json had the field and
// tests validated against it, but the served /openapi.json inline schema table
// did not point at that file. Now /api/events is keyed to schemas/events.json,
// so the served schema is the same test-validated artifact and cannot drift.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import type { Env } from "../src/society.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

type JsonSchema = {
  type?: string | string[];
  description?: string;
  required?: string[];
  properties?: Record<string, JsonSchema>;
};

test("GET /api/events documents first_event's {id, at} shape in the served openapi schema", async () => {
  const env = sqliteTestEnv(SCHEMA).env as Env;
  const response = await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env);
  assert.equal(response.status, 200);
  const document = (await response.json()) as {
    paths: Record<string, { get?: { responses: Record<string, { content?: Record<string, { schema?: JsonSchema }> }> } }>;
  };
  const schema = document.paths["/api/events"]?.get?.responses["200"]?.content?.["application/json"]?.schema;

  // The whole defect: there was no schema here at all, only an example.
  assert.ok(schema, "the events success body must be typed for generated clients, not left to an example");
  assert.equal(schema.type, "object");

  const props = schema.properties ?? {};
  // first_event is the coverage-onset, served {id, at} on a kind-filtered view
  // and null otherwise. A client must learn the object shape, not infer null
  // from the single unfiltered example.
  const fe = props.first_event;
  assert.ok(fe, "first_event must be a documented property");
  const feType = Array.isArray(fe.type) ? fe.type : [fe.type];
  assert.ok(feType.includes("object") && feType.includes("null"), "first_event is {id,at} OR null");
  assert.ok(fe.properties?.id, "first_event.id is documented");
  assert.ok(fe.properties?.at, "first_event.at is documented");
  assert.ok(props.first_event_note, "first_event_note is a documented property");

  // Sanity that the schema is the real events response, not a stub: the always-
  // served census fields are present too.
  for (const field of ["total", "counts_state", "totals_by_kind", "events"]) {
    assert.ok(props[field], `${field} must be documented on the events schema`);
  }
});
