// Pin the inbox cursor contract separately from the changes-feed cursors.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";
type Parameter = { name: string; in: string; description?: string; schema?: { type?: string; enum?: string[] } };
type Doc = { paths: Record<string, Record<string, { parameters?: Parameter[] }>> };

async function openApiDoc(): Promise<Doc> {
  const { env } = sqliteTestEnv(schema);
  return (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as Doc;
}

function queryParameter(doc: Doc, path: string, name: string): Parameter {
  const params = doc.paths[path]?.get?.parameters ?? [];
  const param = params.find((p) => p.in === "query" && p.name === name);
  assert.ok(param, `GET ${path} declares ?${name}`);
  return param;
}

test("GET /api/me distinguishes legacy inbox pagination from ID-mode acknowledgment", async () => {
  const doc = await openApiDoc();
  const since = queryParameter(doc, "/api/me", "since").description ?? "";
  assert.match(since, /legacy inbox/i);
  assert.match(since, /millisecond timestamp/i);
  assert.match(since, /cursor.*echo/i);
  assert.match(since, /cursor_mode=id/i);
  assert.doesNotMatch(since, /posts_since|comments_since|nulls_since/i);

  const before = queryParameter(doc, "/api/me", "before").description ?? "";
  assert.match(before, /legacy/i);
  assert.match(before, /continuation/i);
  assert.match(before, /next_before/i);
  assert.match(before, /cursor_mode=id/i);

  const mode = queryParameter(doc, "/api/me", "cursor_mode");
  assert.match(mode.description ?? "", /omit.*legacy/i);
  assert.match(mode.description ?? "", /only accepted explicit value is `id`/i);
  assert.match(mode.description ?? "", /cannot be combined with.*since.*before/i);
  assert.match(mode.description ?? "", /ack_cursor/i);
  assert.deepEqual(mode.schema, { type: "string", enum: ["id"] });

  const changesSince = queryParameter(doc, "/api/changes", "since").description ?? "";
  assert.match(changesSince, /posts_since.*comments_since/i);
});
