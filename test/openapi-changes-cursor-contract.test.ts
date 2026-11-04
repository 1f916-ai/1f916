// /api/changes has two pagination contracts. Keep the choice and each stream cursor visible on the query parameters that generated clients consume.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { QUERY_PARAM_DESCRIPTIONS } from "../src/query-params.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

type Parameter = { name: string; in: string; description?: string };
type Doc = { paths: Record<string, Record<string, { parameters?: Parameter[] }>> };

async function openApiDoc(): Promise<Doc> {
  const { env } = sqliteTestEnv(schema);
  return (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as Doc;
}

test("GET /api/changes exposes its cursor contract on the four query parameters", async () => {
  const doc = await openApiDoc();
  const params = doc.paths["/api/changes"]?.get?.parameters ?? [];
  const description = (name: string): string => {
    const param = params.find((p) => p.in === "query" && p.name === name);
    assert.ok(param, `GET /api/changes declares ?${name}`);
    assert.ok(param.description, `?${name} explains its wire contract`);
    return param.description;
  };

  const since = description("since");
  assert.match(since, /millisecond/i);
  assert.match(since, /legacy/i);
  assert.match(since, /at-least-once/i);
  assert.match(since, /init/i);
  assert.match(since, /advisory/i);
  assert.match(since, /if nulls_since is omitted/i);
  assert.match(since, /nulls ID cursor is still bounded by this timestamp window/i);

  for (const name of ["posts_since", "comments_since"] as const) {
    const text = description(name);
    const other = name === "posts_since" ? "comments_since" : "posts_since";
    assert.match(text, new RegExp(`together with ${other}`));
    assert.match(text, /init/);
    assert.match(text, new RegExp(`next_${name}`));
    assert.match(text, /snapi:/);
    assert.match(text, /id:/);
    assert.match(text, /done/);
  }

  const nulls = description("nulls_since");
  assert.match(nulls, /independent/i);
  assert.match(nulls, /row id, not a timestamp/i);
  assert.match(nulls, /since window/i);
  assert.match(nulls, /still filters within that same since window/i);
  assert.match(nulls, /id:0/);
  assert.match(nulls, /bare row ID/i);
  assert.match(nulls, /next_nulls_since/);
  assert.match(nulls, /done/);
});

test("changes cursor descriptions stay in the shared parameter projection and within its length bound", () => {
  for (const name of ["since", "posts_since", "comments_since", "nulls_since"]) {
    const text = QUERY_PARAM_DESCRIPTIONS[name];
    assert.ok(text, `description table contains ${name}`);
    assert.ok(text.length <= 400, `${name} description is at most 400 characters`);
  }
});
