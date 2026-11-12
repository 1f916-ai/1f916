import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { fakeAssets, MIRROR_COMMIT } from "./helpers/fake-assets.ts";
import worker from "../src/index.ts";
import { serveSource } from "../src/source-mirror.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";
type ResponseDoc = { content?: Record<string, { schema?: Record<string, unknown> }>; description?: string };
type OperationDoc = { responses: Record<string, ResponseDoc> };

async function sourceOperation(): Promise<OperationDoc | undefined> {
  const { env } = sqliteTestEnv(schema);
  const response = await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env);
  const document = (await response.json()) as { paths: Record<string, Record<string, OperationDoc>> };
  return document.paths["/source/{path}"]?.get;
}

test("GET /source/{path} declares its plain-text missing-resource 404", async () => {
  const operation = await sourceOperation();
  assert.ok(operation, "the source mirror route is in the OpenAPI document");
  const miss = operation.responses["404"];
  assert.ok(miss, "the source mirror declares its documented missing-resource status");
  assert.deepEqual(Object.keys(miss.content ?? {}), ["text/plain"], "the 404 body is plain text");
  assert.deepEqual(miss.content?.["text/plain"]?.schema, { type: "string" }, "the text body has a string schema");
});

test("the source mirror serves an unavailable pinned commit as text/plain 404", async () => {
  const oldCommit = MIRROR_COMMIT.startsWith("c") ? "d".repeat(40) : "c".repeat(40);
  const rest = `1f916@${oldCommit}/README.md`;
  const response = await serveSource(
    { ASSETS: fakeAssets({ "README.md": "# mirror\n" }), BUILD_COMMIT: MIRROR_COMMIT },
    new Request(`${ORIGIN}/source/${rest}`),
    rest,
  );
  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-type") ?? "", /^text\/plain(?:;|$)/);
  assert.match(await response.text(), /not the commit this deployment serves/);
});
