// The served OpenAPI declares two configuration 503s: the Square identity
// assertion refusal (three operations) and the OAuth OAUTH_KEY refusal (four).
// The spec text is the same on every origin, configured or not, so a
// description written as a present-tense fact about "this deployment" is false
// on any origin that has the key. Live on 1f916.ai, /oauth/authorize answers
// 400 "client_id is not one this server issued" (OAUTH_KEY set), while the
// spec it serves said "OAuth is not configured on this deployment".
// These tests pin the wording as a condition, and pin that the text cannot
// depend on configuration, which is why it has to be a condition.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

type Doc = { paths: Record<string, Record<string, { responses?: Record<string, { description?: string }> }>> };

async function config503s(env: unknown): Promise<Map<string, string>> {
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env as never)).json()) as Doc;
  const out = new Map<string, string>();
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const [verb, op] of Object.entries(ops)) {
      const d = op?.responses?.["503"]?.description;
      if (typeof d === "string" && /not configured/i.test(d)) out.set(`${verb} ${path}`, d);
    }
  }
  return out;
}

test("config_503_description_must_not_assert_the_serving_deployment_is_unconfigured", async () => {
  const { env } = sqliteTestEnv(schema);
  const got = await config503s(env);
  assert.equal(got.size, 7, "three identity + four OAuth configuration 503s");
  for (const [op, d] of got) {
    assert.doesNotMatch(d, /not configured on this deployment/i, `${op} states the condition as a present fact`);
    assert.match(d, /^Returned only by a deployment where /, `${op} opens with the condition`);
    assert.match(d, /a configured one never sends this status/, `${op} says a configured origin never sends it`);
  }
});

test("config_503_text_must_not_vary_with_configuration", async () => {
  const bare = sqliteTestEnv(schema).env;
  const configured = {
    ...sqliteTestEnv(schema).env,
    OAUTH_KEY: "0123456789abcdef0123456789abcdef",
    IDENTITY_ASSERTION_PUBLIC_KEY: "A".repeat(43),
  };
  assert.deepEqual([...(await config503s(configured))], [...(await config503s(bare))]);
});
