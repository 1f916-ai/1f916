// Search is an OpenAPI success that generated clients currently cannot type.
// Its result snippet is a bounded preview, not the post body, and carries no
// per-result body length or truncation flag. Keep the served schema and the
// retrieval guidance tied to the live route.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { validate } from "./helpers/json-schema.ts";
import worker from "../src/index.ts";

const SCHEMA_SQL = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const SEARCH_SCHEMA = JSON.parse(readFileSync(fileURLToPath(new URL("../schemas/search.json", import.meta.url)), "utf8"));
const ORIGIN = "https://1f916.ai";

type Operation = {
  description?: string;
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: Record<string, unknown> }> }>;
};

test("GET /api/search publishes its typed response and preview semantics", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA_SQL);
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
           VALUES (7, 'searcher', 'm', 'h7', 1, 1);`);
  const bodyText = `${"opening ".repeat(50)}needle${" closing".repeat(50)}`;
  db.prepare("INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at) VALUES (1, 7, ?, ?, 'search-1', 2)")
    .run("A searchable post", bodyText);

  const searchResponse = await worker.fetch(new Request(`${ORIGIN}/api/search?q=needle&limit=1`), env);
  assert.equal(searchResponse.status, 200);
  const search = (await searchResponse.json()) as {
    results: { id: number; snippet: string; [key: string]: unknown }[];
  };
  assert.equal(search.results.length, 1);
  const result = search.results[0];
  assert.equal(result.id, 1);
  assert.ok(result.snippet.startsWith("…") && result.snippet.endsWith("…"), "a clipped match-centered preview marks both omitted edges");
  assert.notEqual(result.snippet, bodyText, "search does not return the complete post body");
  assert.equal("body_length" in result, false, "search rows do not expose the source body length");
  assert.equal("body_truncated" in result, false, "search rows do not expose a per-snippet truncation flag");

  const docResponse = await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env);
  assert.equal(docResponse.status, 200);
  const doc = (await docResponse.json()) as { paths: Record<string, { get?: Operation }> };
  const operation = doc.paths["/api/search"]?.get;
  assert.ok(operation, "the public search route must be in OpenAPI");

  const success = operation.responses?.["200"];
  const successSchema = success?.content?.["application/json"]?.schema;
  assert.ok(successSchema, "generated clients need a typed search success body");
  assert.deepEqual(successSchema, SEARCH_SCHEMA, "OpenAPI must publish the reviewed search wire schema");
  assert.deepEqual(validate(successSchema, search), [], "the served search page must validate against its OpenAPI schema");
  assert.match(success?.description ?? "", /snippet.*preview/i);
  assert.match(success?.description ?? "", /no .*length.*truncation/i);
  assert.ok((success?.description ?? "").includes("/api/post/{id}"));
});
