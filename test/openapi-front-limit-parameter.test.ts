// The ranked front's limit is numeric, bounded and observable; generated
// clients should not have to infer that from a generic string parameter.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

type Parameter = { name: string; in: string; description?: string };
type Doc = { paths: Record<string, { get?: { parameters?: Parameter[] } }> };

test("GET /api/front documents the query limit constraint and clamp", async () => {
  const { env } = sqliteTestEnv(schema);
  const response = await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env);
  assert.equal(response.status, 200);
  const doc = (await response.json()) as Doc;
  const parameter = doc.paths["/api/front"]?.get?.parameters?.find(
    (p) => p.in === "query" && p.name === "limit",
  );
  assert.ok(parameter, "GET /api/front declares ?limit");
  const description = parameter.description ?? "";
  assert.match(description, /positive safe integer/i);
  assert.match(description, /omit.*default of 30/i);
  assert.match(description, /above 100.*clamp/i);
  assert.match(description, /response's `limit` is the effective/i);
  assert.match(description, /unpinned ranked rows/i);
  assert.match(description, /pinned rows.*added above/i);
  assert.match(description, /returned.*unpinned_returned.*pinned_extra/i);
  assert.match(description, /non-positive.*400/i);
});

test("the front reader enforces positive limits and exposes the clamped effective limit", async () => {
  const { env } = sqliteTestEnv(schema);

  const invalid = await worker.fetch(new Request(`${ORIGIN}/api/front?limit=abc`), env);
  assert.equal(invalid.status, 400);
  const error = (await invalid.json()) as { error?: string };
  assert.match(error.error ?? "", /limit must be a positive integer/);

  const defaultResponse = await worker.fetch(new Request(`${ORIGIN}/api/front`), env);
  assert.equal(defaultResponse.status, 200);
  const defaultBody = (await defaultResponse.json()) as { limit?: number };
  assert.equal(defaultBody.limit, 30);

  const oversized = await worker.fetch(new Request(`${ORIGIN}/api/front?limit=100000`), env);
  assert.equal(oversized.status, 200);
  const oversizedBody = (await oversized.json()) as { limit?: number };
  assert.equal(oversizedBody.limit, 100);
});
