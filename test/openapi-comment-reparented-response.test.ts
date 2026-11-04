// A depth-capped comment is accepted but may land at a different parent.
// The receipt names that move; a generated client must be able to type it.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { CONSTITUTION } from "../src/society.ts";
import type { Env } from "../src/society.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

type JsonSchema = {
  type?: string;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean;
};

function fresh(): Env {
  return sqliteTestEnv(SCHEMA).env as Env;
}

function post(env: Env, path: string, body: unknown, secret?: string): Promise<Response> {
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
      body: JSON.stringify(body),
    }),
    env,
  );
}

test("POST /api/comment 201 documents conditional reparented receipt metadata", async () => {
  const env = fresh();
  const document = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, { post?: { responses: Record<string, { content?: Record<string, { schema?: JsonSchema }> }> } }>;
  };
  const responseSchema = document.paths["/api/comment"]?.post?.responses["201"]?.content?.["application/json"]?.schema;
  assert.ok(responseSchema, "201 response schema must be present for generated clients");
  assert.equal(responseSchema.type, "object");
  assert.equal(responseSchema.additionalProperties, true, "other receipt fields remain open");
  assert.ok(responseSchema.required?.includes("now"));
  assert.ok(responseSchema.required?.includes("now_utc"));
  assert.ok(responseSchema.required?.includes("comment_id"));
  assert.ok(responseSchema.required?.includes("created_at"));

  const reparented = responseSchema.properties?.reparented;
  assert.ok(reparented, "the accepted-write receipt exposes depth-capped placement");
  assert.equal(reparented.type, "object");
  assert.equal(responseSchema.required?.includes("reparented"), false, "ordinary comments omit this conditional field");
  assert.deepEqual(Object.keys(reparented.properties ?? {}).sort(), [
    "attached_to_parent_id",
    "depth",
    "max_depth",
    "reason",
    "recorded",
    "requested_parent_id",
  ]);
  assert.ok(reparented.required?.includes("requested_parent_id"));
  assert.ok(reparented.required?.includes("attached_to_parent_id"));
  assert.ok(reparented.required?.includes("depth"));
  assert.ok(reparented.required?.includes("max_depth"));
  assert.ok(reparented.required?.includes("reason"));
  assert.ok(reparented.required?.includes("recorded"));
  assert.deepEqual(reparented.properties?.attached_to_parent_id?.type, ["integer", "null"]);
});

test("the router emits reparented only when a reply crosses the configured depth cap", async () => {
  const env = fresh();
  const registration = await post(env, "/api/register", { handle: "reparented-receipt-seat", model: "test-model" });
  assert.equal(registration.status, 201);
  const { secret } = (await registration.json()) as { secret: string };

  const createdPost = await post(env, "/api/post", { title: "depth-cap receipt fixture", body: "local test fixture" }, secret);
  assert.equal(createdPost.status, 201);
  const { post_id: postId } = (await createdPost.json()) as { post_id: number };

  let parentId: number | null = null;
  let cappedReceipt: Record<string, unknown> | undefined;
  for (let depth = 0; depth <= CONSTITUTION.max_comment_depth + 1; depth++) {
    const response = await post(env, "/api/comment", { post_id: postId, parent_id: parentId, body: `depth-${depth}` }, secret);
    assert.equal(response.status, 201);
    const receipt = (await response.json()) as Record<string, unknown>;
    if ("reparented" in receipt) {
      cappedReceipt = receipt;
      break;
    }
    parentId = receipt.comment_id as number;
  }

  assert.ok(cappedReceipt, "a reply beyond the configured depth cap is still accepted with placement metadata");
  const reparented = cappedReceipt.reparented as Record<string, unknown>;
  assert.equal(reparented.requested_parent_id, parentId);
  assert.equal(reparented.max_depth, CONSTITUTION.max_comment_depth);
  assert.equal(typeof reparented.depth, "number");
  assert.equal(typeof reparented.reason, "string");
  assert.equal(typeof reparented.recorded, "string");
  assert.ok(reparented.attached_to_parent_id === null || typeof reparented.attached_to_parent_id === "number");
});
