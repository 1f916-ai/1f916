// The OAuth bridge has a deliberate configuration refusal: when OAUTH_KEY is
// absent, each dynamic OAuth operation serves a clocked 503, not a transient
// outage. A generated client needs that branch so it does not retry forever.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { validate } from "./helpers/json-schema.ts";
import worker from "../src/index.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";
const OAUTH_OPS = [
  ["post", "/oauth/register"],
  ["get", "/oauth/authorize"],
  ["post", "/oauth/authorize"],
  ["post", "/oauth/token"],
] as const;

type Operation = { responses: Record<string, { description?: string; content?: Record<string, { schema?: { $ref?: string } }> }> };
type Doc = {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Record<string, unknown>> };
};

async function served(env: unknown): Promise<Doc> {
  return (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env as never)).json()) as Doc;
}

test("exactly the four dynamic OAuth operations declare the OAUTH_KEY 503", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = await served(env);
  const want = new Set(OAUTH_OPS.map(([verb, path]) => `${verb} ${path}`));
  const got = new Set<string>();
  for (const [path, operations] of Object.entries(doc.paths)) {
    for (const [verb, operation] of Object.entries(operations)) {
      if (path.startsWith("/oauth/") && "503" in operation.responses) got.add(`${verb} ${path}`);
    }
  }
  assert.deepEqual([...got].sort(), [...want].sort());
});

test("each OAuth 503 is a typed, non-transient JSON configuration refusal", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = await served(env);
  for (const [verb, path] of OAUTH_OPS) {
    const response = doc.paths[path][verb].responses["503"];
    assert.deepEqual(Object.keys(response.content ?? {}), ["application/json"], `${verb} ${path} media type`);
    assert.deepEqual(response.content?.["application/json"]?.schema, { $ref: "#/components/schemas/Error" }, `${verb} ${path} Error schema`);
    assert.match(response.description ?? "", /OAUTH_KEY/i, `${verb} ${path} names its configuration`);
    assert.match(response.description ?? "", /not configured/i, `${verb} ${path} describes the served class`);
    assert.match(response.description ?? "", /retry|until/i, `${verb} ${path} explains retry behavior`);
  }
});

test("an unconfigured OAuth route never serves a status omitted from its operation", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = await served(env);
  const clientId = "a.b";
  const authorizeFields = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "https://host.example/cb",
    state: "st8",
    code_challenge: "A".repeat(43),
    code_challenge_method: "S256",
  });
  const requests: Record<string, Request> = {
    "post /oauth/register": new Request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://host.example/cb"] }),
    }),
    "get /oauth/authorize": new Request(`${ORIGIN}/oauth/authorize?${authorizeFields}`),
    "post /oauth/authorize": new Request(`${ORIGIN}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", Origin: ORIGIN },
      body: new URLSearchParams([...authorizeFields, ["mode", "existing"], ["secret", "unused"]]).toString(),
    }),
    "post /oauth/token": new Request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: clientId, client_id: clientId, code_verifier: "A".repeat(43) }).toString(),
    }),
  };
  for (const [verb, path] of OAUTH_OPS) {
    const r = await worker.fetch(requests[`${verb} ${path}`], env);
    assert.equal(r.status, 503, `${verb} ${path}`);
    assert.ok(String(r.status) in doc.paths[path][verb].responses, `${verb} ${path} declares served status`);
    const body = (await r.json()) as Record<string, unknown>;
    assert.deepEqual(validate(doc.components.schemas.Error, body), [], `${verb} ${path} 503 body is the shared Error envelope`);
    assert.match(String(body.error), /OAUTH_KEY|not configured/i, `${verb} ${path} names the missing configuration`);
  }
});
