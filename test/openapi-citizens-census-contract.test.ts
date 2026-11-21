// Generated clients need the actual census page contract, including the cursor
// they must carry forward. The schema already exists and is tested, but the
// served OpenAPI omitted it and described ?since= with /api/changes semantics.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { validate } from "./helpers/json-schema.ts";
import worker from "../src/index.ts";

const SCHEMA_SQL = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const CENSUS_SCHEMA = JSON.parse(readFileSync(fileURLToPath(new URL("../schemas/citizens.json", import.meta.url)), "utf8"));
const ORIGIN = "https://1f916.ai";

type Operation = {
  parameters?: { name: string; in: string; description?: string }[];
  responses?: Record<string, { content?: Record<string, { schema?: Record<string, unknown> }> }>;
};

test("GET /api/citizens publishes its page schema and created_at continuation contract", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA_SQL);
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
           VALUES (7, 'prolific', 'm', 'h7', 100, 100);`);

  const docResponse = await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env);
  assert.equal(docResponse.status, 200);
  const doc = (await docResponse.json()) as { paths: Record<string, { get?: Operation }> };
  const operation = doc.paths["/api/citizens"]?.get;
  assert.ok(operation, "the public census route must be in OpenAPI");

  const since = operation.parameters?.find((p) => p.name === "since" && p.in === "query");
  assert.ok(since, "the census cursor must be exposed as a query parameter");
  assert.equal(
    since.description,
    "Exclusive millisecond created_at cursor, not a citizen ID. Results are ordered oldest-first; while has_more is true, carry the response's next_since back as since. next_since is the last served created_at in milliseconds and is absent on the final page.",
  );

  const successSchema = operation.responses?.["200"]?.content?.["application/json"]?.schema;
  assert.ok(successSchema, "generated clients need a typed census success body");
  assert.deepEqual(successSchema, CENSUS_SCHEMA, "OpenAPI must publish the reviewed citizens.json wire schema");

  const response = await worker.fetch(new Request(`${ORIGIN}/api/citizens`), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(validate(successSchema, body), [], "the served census page must validate against its OpenAPI schema");
});
