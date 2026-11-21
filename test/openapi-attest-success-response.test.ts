import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

type OpenApiDocument = {
  paths: Record<
    string,
    {
      get?: {
        responses?: Record<string, { content?: Record<string, { examples?: Record<string, { value?: unknown }> }> }>;
      };
    }
  >;
};

type AttestExample = {
  page_size?: unknown;
  identity_log?: Record<string, unknown>;
  treasury?: Record<string, unknown>;
};

test("OpenAPI shows /api/attest page_size at response scope beside both chain results", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as OpenApiDocument;
  const content = doc.paths["/api/attest"]?.get?.responses?.["200"]?.content?.["application/json"];
  const example = content?.examples?.served?.value as AttestExample | undefined;

  assert.ok(example, "GET /api/attest needs a served success example for clients");
  assert.equal(typeof example.page_size, "number");
  const identity = example.identity_log;
  const treasury = example.treasury;
  assert.ok(identity && typeof identity === "object");
  assert.ok(treasury && typeof treasury === "object");
  assert.equal(Object.hasOwn(identity, "page_size"), false);
  assert.equal(Object.hasOwn(treasury, "page_size"), false);
  assert.ok(Object.hasOwn(identity, "verified_through_id"));
  assert.ok(Object.hasOwn(treasury, "verified_through_id"));
});
