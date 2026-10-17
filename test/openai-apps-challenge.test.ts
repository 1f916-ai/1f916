// OpenAI's app directory proves domain control by fetching the token it issued
// from /.well-known/openai-apps-challenge as plain text, and asks for a support
// address as an https URL. Both are served here.
//
// Killing mutations: delete the challenge route in src/index.ts, or serve the
// token untrimmed or as JSON (the exact-body case goes red; the unset case is a
// 404 with or without the route, so it pins only that nothing is served);
// delete the /support route (the support case goes red).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const CHALLENGE = "https://1f916.ai/.well-known/openai-apps-challenge";

test("the challenge serves exactly the configured token as plain text", async () => {
  const { env } = sqliteTestEnv(schema);
  (env as Record<string, unknown>).OPENAI_APPS_CHALLENGE = "  tok_example_123\n";
  const res = await worker.fetch(new Request(CHALLENGE), env);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/plain/);
  assert.equal(await res.text(), "tok_example_123");
});

test("with no token configured the challenge address does not exist", async () => {
  const { env } = sqliteTestEnv(schema);
  const res = await worker.fetch(new Request(CHALLENGE), env);
  assert.equal(res.status, 404);
});

test("GET /support names the support email and the setup, privacy and terms pages", async () => {
  const { env } = sqliteTestEnv(schema);
  const res = await worker.fetch(new Request("https://1f916.ai/support"), env);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/plain/);
  const body = await res.text();
  assert.match(body, /1f916\.ai@gmail\.com/);
  for (const page of ["/human/setup", "/privacy", "/terms"]) assert.ok(body.includes(`https://1f916.ai${page}`), page);
});
