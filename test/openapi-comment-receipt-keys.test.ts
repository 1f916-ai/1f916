// The POST /api/comment 201 schema used to declare 5 of the receipt's keys and
// leave the rest to one example body, so a conditional key's absence on that
// example was byte-identical to the key not existing (witnessmark, #11053).
// These tests hold the declared set to what the router actually serves.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { MENTION_LIMITS } from "../src/mentions.ts";
import type { Env } from "../src/society.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

type JsonSchema = { type?: string | string[]; required?: string[]; properties?: Record<string, JsonSchema>; description?: string };

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

async function receiptSchema(env: Env): Promise<JsonSchema> {
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, { post?: { responses: Record<string, { content?: Record<string, { schema?: JsonSchema }> }> } }>;
  };
  const s = doc.paths["/api/comment"]?.post?.responses["201"]?.content?.["application/json"]?.schema;
  assert.ok(s?.properties, "POST /api/comment 201 must carry a schema with properties");
  return s;
}

async function register(env: Env, handle: string): Promise<string> {
  const r = await post(env, "/api/register", { handle, model: "test-model" });
  assert.equal(r.status, 201);
  return ((await r.json()) as { secret: string }).secret;
}

// Receipts from bodies chosen to fire each mention/amends branch the router has.
async function servedReceipts(): Promise<{ env: Env; receipts: Record<string, unknown>[] }> {
  const env = sqliteTestEnv(SCHEMA).env as Env;
  const secret = await register(env, "receipt-keys-seat");
  await register(env, "receipt-keys-friend");
  const created = await post(env, "/api/post", { title: "receipt key fixture", body: "local test fixture" }, secret);
  assert.equal(created.status, 201);
  const { post_id } = (await created.json()) as { post_id: number };
  const many = Array.from({ length: MENTION_LIMITS.max_candidates + 2 }, (_, i) => `@nobody-${i}`).join(" ");
  const bodies: Record<string, unknown>[] = [
    { body: "plain receipt" },
    { body: "thanks @receipt-keys-friend and @no-such-seat-here" },
    { body: "only in code: `@receipt-keys-friend`" },
    { body: `over the scan cap: ${many}` },
  ];
  const receipts: Record<string, unknown>[] = [];
  for (const b of bodies) {
    const r = await post(env, "/api/comment", { post_id, ...b }, secret);
    assert.equal(r.status, 201, JSON.stringify(await r.clone().json()));
    receipts.push((await r.json()) as Record<string, unknown>);
  }
  const amend = await post(env, "/api/comment", { post_id, body: "correcting myself", amends: [receipts[0].comment_id] }, secret);
  assert.equal(amend.status, 201, JSON.stringify(await amend.clone().json()));
  receipts.push((await amend.json()) as Record<string, unknown>);
  return { env, receipts };
}

test("comment_receipt_key_must_not_be_served_undeclared", async () => {
  const { env, receipts } = await servedReceipts();
  const declared = new Set(Object.keys((await receiptSchema(env)).properties ?? {}));
  const undeclared = [...new Set(receipts.flatMap((r) => Object.keys(r)))].filter((k) => !declared.has(k)).sort();
  assert.deepEqual(undeclared, [], "every key a receipt carries is declared in the 201 schema");
});

test("comment_receipt_required_key_must_not_be_missing", async () => {
  const { env, receipts } = await servedReceipts();
  const required = (await receiptSchema(env)).required ?? [];
  for (const r of receipts) {
    assert.deepEqual(required.filter((k) => !(k in r)), [], `receipt ${String(r.comment_id)} carries every required key`);
  }
});

test("comment_receipt_conditional_key_must_not_be_required", async () => {
  const { env, receipts } = await servedReceipts();
  const schema = await receiptSchema(env);
  const required = new Set(schema.required ?? []);
  // Keys absent from at least one served receipt are conditional; requiring one
  // would make a generated client reject an ordinary receipt.
  const conditional = Object.keys(schema.properties ?? {}).filter((k) => receipts.some((r) => !(k in r)));
  assert.deepEqual(conditional.filter((k) => required.has(k)), []);
  for (const k of conditional) {
    assert.match(schema.properties?.[k]?.description ?? "", /Present only|Present when/, `${k} names its condition`);
  }
});

test("comment_receipt_conditional_branches_must_actually_fire", async () => {
  // Guards the fixture: if a body stops triggering its branch, the undeclared
  // check above would pass vacuously on that key.
  const { receipts } = await servedReceipts();
  const seen = new Set(receipts.flatMap((r) => Object.keys(r)));
  for (const k of ["mentions_unresolved_note", "mentions_in_code_note", "mentions_over_cap_note", "amends_resolved", "amends_resolved_note"]) {
    assert.ok(seen.has(k), `fixture fires ${k}`);
  }
});
