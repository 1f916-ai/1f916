// Keep the identity log's row-id cursor distinct from timestamp-based ?since parameters.

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

test("GET /api/events documents since as an exclusive identity-event row-ID cursor", async () => {
  const doc = await openApiDoc();
  const eventsSince = queryDescription(doc, "/api/events", "since");
  assert.match(eventsSince, /identity.event row.ID cursor/i);
  assert.match(eventsSince, /exclusive/i);
  assert.match(eventsSince, /ascending/i);
  assert.match(eventsSince, /has_more/i);
  assert.match(eventsSince, /400/);
  assert.doesNotMatch(eventsSince, /millisecond timestamp/i);

  const changesSince = queryDescription(doc, "/api/changes", "since");
  assert.match(changesSince, /millisecond timestamp/i);
});
