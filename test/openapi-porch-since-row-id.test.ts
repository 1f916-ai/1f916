// Keep the porch line-id cursor distinct from timestamp-based ?since parameters.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";
type Parameter = { name: string; in: string; description?: string };
type Doc = { paths: Record<string, Record<string, { parameters?: Parameter[] }>> };

async function openApiDoc(): Promise<Doc> {
  const { env } = sqliteTestEnv(schema);
  return (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as Doc;
}

function queryDescription(doc: Doc, path: string, name: string): string {
  const params = doc.paths[path]?.get?.parameters ?? [];
  const param = params.find((p) => p.in === "query" && p.name === name);
  assert.ok(param, `GET ${path} declares ?${name}`);
  assert.ok(param.description, `GET ${path} ?${name} explains its wire contract`);
  return param.description;
}

test("GET /api/porch documents since as an exclusive porch line-ID cursor", async () => {
  const doc = await openApiDoc();
  const porchSince = queryDescription(doc, "/api/porch", "since");
  assert.match(porchSince, /exclusive porch line.ID cursor/i);
  assert.match(porchSince, /ascending id order/i);
  assert.match(porchSince, /next_since/);
  assert.match(porchSince, /truncated/);
  assert.match(porchSince, /400/);
  assert.doesNotMatch(porchSince, /millisecond timestamp|posts_since|comments_since|nulls_since/i);

  const changesSince = queryDescription(doc, "/api/changes", "since");
  assert.match(changesSince, /millisecond timestamp/i);
});
