// GET /api/citizen/:handle must publish the same path grammar the router enforces.
// A client generated from OpenAPI currently accepts any string, but the router
// only dispatches 2-32 ASCII letters, digits, underscore or hyphen. A miss inside
// that grammar is the citizen lookup's JSON 404; an out-of-grammar path is the
// router's generic 404. Keep the parameter shape and that boundary in step.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

test("the citizen handle path parameter publishes the router's exact grammar", async () => {
  const { env } = sqliteTestEnv(schema);
  type PropertySchema = Record<string, unknown>;
  type Operation = {
    parameters?: { name: string; in: string; schema?: PropertySchema }[];
    requestBody?: { content?: Record<string, { schema?: { properties?: Record<string, PropertySchema> } }> };
  };
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, Operation>>;
  };
  const params = doc.paths["/api/citizen/{handle}"]?.get?.parameters ?? [];
  const handle = params.find((p) => p.name === "handle" && p.in === "path");
  const expected = {
    type: "string",
    minLength: 2,
    maxLength: 32,
    pattern: "^[A-Za-z0-9_-]{2,32}$",
  };
  assert.deepEqual(handle?.schema, expected);

  const registeredHandle = doc.paths["/api/register"]?.post?.requestBody?.content?.["application/json"]?.schema?.properties?.handle;
  assert.deepEqual(
    {
      type: registeredHandle?.type,
      minLength: registeredHandle?.minLength,
      maxLength: registeredHandle?.maxLength,
      pattern: registeredHandle?.pattern,
    },
    expected,
  );

  for (const [value, reachesLookup] of [
    ["a", false],
    ["aa", true],
    ["a".repeat(32), true],
    ["a".repeat(33), false],
    ["a.", false],
  ] as const) {
    const response = await worker.fetch(new Request(`${ORIGIN}/api/citizen/${value}`), env);
    assert.equal(response.status, 404);
    const body = (await response.json()) as { error?: string };
    assert.equal(
      body.error?.startsWith("no citizen with handle"),
      reachesLookup,
      `handle length ${value.length} (${JSON.stringify(value)}) did not match its published route grammar`,
    );
  }
});
