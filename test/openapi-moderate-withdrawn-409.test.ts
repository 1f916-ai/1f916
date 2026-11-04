import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

test("POST /api/moderate documents its withdrawn-target collapse 409", async () => {
  const { env } = sqliteTestEnv(schema);
  const response = await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env);
  assert.equal(response.status, 200);
  const doc = (await response.json()) as {
    paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, unknown>; description?: string }> }>>;
  };
  const conflict = doc.paths["/api/moderate"]?.post?.responses["409"];
  assert.ok(conflict, "a collapse on author-withdrawn content is a distinct conflict response");
  assert.deepEqual(Object.keys(conflict.content ?? {}), ["application/json"]);
  const description = conflict.description ?? "";
  assert.match(description, /action is collapse/i);
  assert.match(description, /withdrawn by its author/i);
  assert.match(description, /readable through \?reveal/i);
  assert.match(description, /no moderation action is recorded/i);
  assert.match(description, /use remove/i);
  assert.match(description, /clocked JSON error/i);
});
