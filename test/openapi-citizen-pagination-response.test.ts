// Generated clients need the per-list cursors and totals to walk a citizen record.
// The route currently serves them, but its OpenAPI 200 response has no schema.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

type JsonSchema = {
  type?: string | string[];
  description?: string;
  const?: unknown;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean;
  items?: JsonSchema;
};

type Document = {
  paths: Record<string, { get?: { responses: Record<string, { content?: Record<string, { schema?: JsonSchema }> }> } }>;
};

function seeded() {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
           VALUES (7, 'prolific', 'm', 'h7', 100, 100);`);
  db.exec(`INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, created_at)
           VALUES (1, 7, 'host', 'b', NULL, 'h-1', 100);`);
  db.exec(`INSERT INTO comments (id, post_id, citizen_id, parent_id, body, created_at)
           VALUES (2000, 1, 7, NULL, 'c', 2000);`);
  return env;
}

function assertNullableInteger(schema: JsonSchema | undefined, label: string) {
  assert.ok(schema, `${label} must be declared`);
  assert.deepEqual(schema.type, ["integer", "null"], `${label} is either an exclusive row ID or null`);
}

test("GET /api/citizen/{handle} publishes the per-list pagination response contract", async () => {
  const env = seeded();
  const docResponse = await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env);
  assert.equal(docResponse.status, 200);
  const document = (await docResponse.json()) as Document;
  const bodySchema = document.paths["/api/citizen/{handle}"]?.get?.responses["200"]?.content?.["application/json"]?.schema;
  assert.ok(bodySchema, "the citizen success body must be typed for generated clients");
  assert.equal(bodySchema.type, "object");
  assert.equal(bodySchema.additionalProperties, true, "other public-record fields remain open");

  const props = bodySchema.properties ?? {};
  for (const field of ["now", "now_utc", "post_total", "comment_total", "page_caps", "truncated", "truncated_note", "paging"]) {
    assert.ok(bodySchema.required?.includes(field), `${field} is always served`);
    assert.ok(props[field], `${field} must be described`);
  }
  assert.equal(props.post_total?.type, "integer");
  assert.equal(props.comment_total?.type, "integer");
  assert.equal(props.page_caps?.type, "object");
  assert.equal(props.page_caps?.properties?.posts?.const, 200);
  assert.equal(props.page_caps?.properties?.comments?.const, 500);
  assert.equal(props.truncated?.type, "boolean");
  assert.match(props.truncated?.description ?? "", /corpus-scoped/i);
  assert.match(props.truncated?.description ?? "", /not.*page/i);

  const paging = props.paging;
  assert.ok(paging, "the independent post and comment cursors must be typed");
  assert.equal(paging.type, "object");
  for (const field of ["order", "dropped_end", "posts", "comments", "how", "applied_note"]) {
    assert.ok(paging.required?.includes(field), `paging.${field} is always served`);
    assert.ok(paging.properties?.[field], `paging.${field} must be described`);
  }
  for (const [kind, cursor, next] of [
    ["posts", "posts_before", "next_posts_before"],
    ["comments", "comments_before", "next_comments_before"],
  ] as const) {
    const list = paging.properties?.[kind];
    assert.ok(list, `paging.${kind} must be described`);
    for (const field of ["cap", "returned", cursor, "truncated", next]) {
      assert.ok(list.required?.includes(field), `paging.${kind}.${field} is always served`);
      assert.ok(list.properties?.[field], `paging.${kind}.${field} must be described`);
    }
    assert.equal(list.properties?.cap?.type, "integer");
    assert.equal(list.properties?.returned?.type, "integer");
    assert.equal(list.properties?.truncated?.type, "boolean");
    assertNullableInteger(list.properties?.[cursor], `paging.${kind}.${cursor}`);
    assertNullableInteger(list.properties?.[next], `paging.${kind}.${next}`);
  }

  const response = await worker.fetch(new Request(`${ORIGIN}/api/citizen/prolific`), env);
  assert.equal(response.status, 200);
  const record = (await response.json()) as Record<string, any>;
  assert.equal(record.post_total, 1);
  assert.equal(record.comment_total, 1);
  assert.equal(record.paging.posts.returned, 1);
  assert.equal(record.paging.comments.returned, 1);
  assert.equal(record.paging.posts.posts_before, null);
  assert.equal(record.paging.comments.comments_before, null);
  assert.equal(record.paging.posts.next_posts_before, null);
  assert.equal(record.paging.comments.next_comments_before, null);
});
