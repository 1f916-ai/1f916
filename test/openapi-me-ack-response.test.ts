import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";

const schemaSql = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

type ResponseSchema = {
  oneOf?: Array<{
    properties?: Record<string, { const?: unknown; enum?: unknown[]; description?: string; type?: string }>;
    required?: string[];
    type?: string;
  }>;
};

test("POST /api/me/ack declares both success receipts and their discriminating fields", async () => {
  const { env } = sqliteTestEnv(schemaSql);
  const response = await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env);
  const doc = (await response.json()) as {
    paths: Record<string, { post?: { responses?: Record<string, { content?: Record<string, { schema?: ResponseSchema }> }> } }>;
  };
  const ack = doc.paths["/api/me/ack"]?.post?.responses?.["200"]?.content?.["application/json"]?.schema;

  assert.ok(ack, "the 200 response needs a schema, not only a legacy example");
  assert.equal(ack.oneOf?.length, 2, "legacy timestamp and lossless cursor receipts are distinct shapes");

  const byMode = Object.fromEntries((ack.oneOf ?? []).map((branch) => [branch.properties?.mode?.enum?.[0] ?? branch.properties?.mode?.const, branch]));
  assert.deepEqual(Object.keys(byMode).sort(), ["legacy", "lossless"]);

  const commonRequired = ["advanced", "cursor", "mode", "now", "now_utc", "note"];
  for (const mode of ["legacy", "lossless"]) {
    const branch = byMode[mode];
    assert.equal(branch.type, "object");
    for (const field of commonRequired) assert.ok(branch.required?.includes(field), `${mode} receipt requires ${field}`);
    assert.equal(branch.properties?.advanced?.type, "boolean");
    assert.equal(branch.properties?.cursor?.type, "integer");
  }

  const legacy = byMode.legacy;
  assert.match(legacy.properties?.advanced?.description ?? "", /Concurrent acknowledgments can over- or under-report/i);

  const lossless = byMode.lossless;
  assert.deepEqual([...(lossless.required ?? [])].sort(), [...commonRequired, "comments", "mentions"].sort());
  assert.equal(lossless.properties?.comments?.type, "integer");
  assert.equal(lossless.properties?.mentions?.type, "integer");
  assert.match(lossless.properties?.comments?.description ?? "", /comment.*ID/i);
  assert.match(lossless.properties?.mentions?.description ?? "", /mention.*ID/i);
  assert.match(lossless.properties?.advanced?.description ?? "", /not a reliable per-request receipt for ID-stream movement/i);
});
