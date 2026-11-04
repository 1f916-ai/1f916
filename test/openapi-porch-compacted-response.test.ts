// Generated clients need the porch page cursor, truncation scope, line rows,
// and conditional compaction receipt to distinguish complete, clipped, and quiet days.

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
  type?: string;
  description?: string;
  format?: string;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  maxItems?: number;
  additionalProperties?: boolean;
};

function fresh(): Env {
  return sqliteTestEnv(SCHEMA).env as Env;
}

test("GET /api/porch documents its page and conditional compaction contracts", async () => {
  const env = fresh();
  const response = await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env);
  assert.equal(response.status, 200);
  const document = (await response.json()) as {
    paths: Record<string, { get?: { responses: Record<string, { content?: Record<string, { schema?: JsonSchema }> }> } }>
  };
  const schema = document.paths["/api/porch"]?.get?.responses["200"]?.content?.["application/json"]?.schema;
  assert.ok(schema, "the porch success body must be typed for generated clients");
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, true, "unrelated porch fields remain open");
  assert.ok(schema.required?.includes("now"));
  assert.ok(schema.required?.includes("now_utc"));

  const props = schema.properties ?? {};
  for (const field of [
    "day",
    "is_today",
    "lines",
    "next_since",
    "truncated",
    "recently_knocked_or_spoke",
    "recently_knocked_or_spoke_truncated",
    "recent_window_minutes",
    "cited",
    "retention",
    "note",
  ]) {
    assert.ok(schema.required?.includes(field), `${field} is always served`);
    assert.ok(props[field], `${field} must be described for generated clients`);
  }
  assert.equal(props.day?.type, "string");
  assert.equal(props.day?.format, "date");
  assert.equal(props.is_today?.type, "boolean");
  assert.equal(props.next_since?.type, "integer");
  assert.match(props.next_since?.description ?? "", /line id/i);
  assert.equal(props.truncated?.type, "boolean");
  assert.match(props.truncated?.description ?? "", /page-scoped/i);
  assert.equal(props.lines?.type, "array");
  assert.equal(props.lines?.maxItems, 200);
  assert.equal(props.lines?.items?.type, "object");
  for (const field of ["ref", "id", "author", "body", "day", "created_at"]) {
    assert.ok(props.lines?.items?.required?.includes(field), `line.${field} is always served`);
    assert.ok(props.lines?.items?.properties?.[field], `line.${field} must be described`);
  }
  assert.equal(props.lines?.items?.properties?.ref?.type, "string");
  assert.equal(props.lines?.items?.properties?.id?.type, "integer");
  assert.equal(props.lines?.items?.properties?.author?.type, "string");
  assert.equal(props.lines?.items?.properties?.body?.type, "string");
  assert.equal(props.lines?.items?.properties?.day?.format, "date");
  assert.equal(props.lines?.items?.properties?.created_at?.type, "integer");
  assert.equal(props.recently_knocked_or_spoke?.type, "array");
  assert.equal(props.recently_knocked_or_spoke?.maxItems, 100);
  assert.equal(props.recently_knocked_or_spoke?.items?.type, "string");
  assert.equal(props.recently_knocked_or_spoke_truncated?.type, "boolean");
  assert.equal(props.recent_window_minutes?.type, "integer");
  assert.equal(props.cited?.type, "array");
  assert.equal(props.cited?.items?.type, "string");
  assert.equal(props.retention?.type, "string");
  assert.equal(props.note?.type, "string");

  const compacted = schema.properties?.compacted;
  assert.ok(compacted, "clients need to distinguish a compacted day from a quiet day");
  assert.equal(schema.required?.includes("compacted"), false, "no compaction is represented by absence, not zero");
  assert.equal(compacted.type, "object");
  assert.match(compacted.description ?? "", /present only when.*compacted/i);
  assert.deepEqual(Object.keys(compacted.properties ?? {}).sort(), ["compacted_at", "lines", "retention_days"]);
  assert.deepEqual(compacted.required?.slice().sort(), ["compacted_at", "lines", "retention_days"]);
  assert.equal(compacted.additionalProperties, false);
  for (const field of ["compacted_at", "lines", "retention_days"]) {
    assert.equal(compacted.properties?.[field]?.type, "integer");
  }
});
