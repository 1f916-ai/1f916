// /openapi.json declares the not-configured 503 the three Square identity
// assertion routes serve, not only their 200.
//
// src/identity-assertion.ts answers 503 when the deployment has no usable
// IDENTITY_ASSERTION_PUBLIC_KEY (both .well-known documents and issuance) or
// no matching signing seed (issuance). docs/identity-assertion-operations.md
// makes that the designed answer of an unconfigured origin, and it is what
// production served on every read from 2026-10-29 to 2026-10-31 while the
// document declared only 200 on the two GETs and 200/400/401/429 on the POST:
// 0 of 182 operations declared 503. A client generated from the document
// typed the one body an unconfigured origin actually returns `never`.
//
// This file pins the declaration (exactly these three operations declare
// 503, with the clocked Error body) against the live router: with no
// IDENTITY_ASSERTION_* env every one of them answers a status its operation
// declares. Dropping any one 503 turns the served-status test red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { validate } from "./helpers/json-schema.ts";
import worker from "../src/index.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";
const IDENTITY_OPS = [
  ["get", "/.well-known/1f916-identity-assertion"],
  ["get", "/.well-known/1f916-identity-jwks.json"],
  ["post", "/api/identity-assertion"],
] as const;
const OAUTH_OPS = [
  ["post", "/oauth/register"],
  ["get", "/oauth/authorize"],
  ["post", "/oauth/authorize"],
  ["post", "/oauth/token"],
] as const;

type Doc = {
  paths: Record<string, Record<string, { responses: Record<string, { description?: string; content?: Record<string, { schema?: { $ref?: string } }> }> }>>;
  components: { schemas: Record<string, Record<string, unknown>> };
};

async function served(env: unknown): Promise<Doc> {
  return (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env as never)).json()) as Doc;
}

test("the exact identity-assertion and dynamic OAuth 503 operation set is declared", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = await served(env);
  const want = new Set([...IDENTITY_OPS, ...OAUTH_OPS].map(([v, p]) => `${v} ${p}`));
  const got = new Set<string>();
  let checked = 0;
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const [verb, op] of Object.entries(ops)) {
      checked++;
      if (Object.keys(op.responses).includes("503")) got.add(`${verb} ${path}`);
    }
  }
  assert.deepEqual([...got].sort(), [...want].sort());
  assert.ok(checked >= 100, `only ${checked} operations in the document; the path scan has drifted`);
});

test("each declared 503 carries the clocked Error body and names the not-configured class", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = await served(env);
  for (const [verb, path] of IDENTITY_OPS) {
    const body = doc.paths[path][verb].responses["503"];
    assert.deepEqual(Object.keys(body.content ?? {}), ["application/json"], `${verb} ${path} 503 content`);
    assert.match(body.description ?? "", /not configured/i, `${verb} ${path} 503 description`);
  }
});

test("unconfigured_identity_route_must_not_be_spec_hollow: every live status is a declared one", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = await served(env);
  const reg = await worker.fetch(
    new Request(`${ORIGIN}/api/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle: "identity-503-berry", model: "gpt-5" }) }),
    env,
  );
  assert.equal(reg.status, 201, "register");
  const { secret } = (await reg.json()) as { secret: string };
  const requests: Record<string, Request> = {
    "/.well-known/1f916-identity-assertion": new Request(`${ORIGIN}/.well-known/1f916-identity-assertion`),
    "/.well-known/1f916-identity-jwks.json": new Request(`${ORIGIN}/.well-known/1f916-identity-jwks.json`),
    "/api/identity-assertion": new Request(`${ORIGIN}/api/identity-assertion`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ audience: "https://world.example/mcp", nonce: "0123456789abcdef0123456789abcdef" }),
    }),
  };
  for (const [verb, path] of IDENTITY_OPS) {
    const r = await worker.fetch(requests[path], env);
    assert.equal(r.status, 503, `${verb} ${path} on an unconfigured deployment`);
    const declared = doc.paths[path][verb].responses;
    assert.ok(String(r.status) in declared, `${verb} ${path} served ${r.status} but declares only ${Object.keys(declared).join("/")}`);
    const b = (await r.json()) as Record<string, unknown>;
    assert.deepEqual(validate(doc.components.schemas.Error, b), [], `${verb} ${path} 503 body is the clocked Error envelope`);
    assert.match(String(b.error), /not configured/i, `${verb} ${path} 503 error names the cause`);
  }
});
