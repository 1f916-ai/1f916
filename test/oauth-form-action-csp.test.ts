// THE CONSENT PAGE MUST PERMIT THE REDIRECT IT EXISTS TO PERFORM.
//
// GET /oauth/authorize renders a form that POSTs back here; that POST answers
// 303 to the client's redirect_uri. `form-action 'self'` allows the POST and
// forbids the redirect in every engine that enforces form-action ACROSS a
// redirect. Engines split on it: Chrome and WebKit BLOCK, Firefox allows. (The
// first version of this header said the opposite; #179 is filed from Chrome and
// Safari, the two that block.) CSP fails silently: no
// request, no error the person sees, a 303 that never navigates. That is #179.
// #175 is the damage — the citizen is registered before the code is sealed, so
// an interrupted flow leaves a real handle whose secret nobody ever received.
//
// Naming the destination grants nothing: connect.ts refuses any redirect_uri
// the client did not register before this page is rendered.
//
// KILLING MUTATIONS:
//   1. return "" from formActionSource -> test 1 goes red (policy is bare 'self').
//   2. drop the regex guard and emit src unconditionally -> test 4 goes red.
//   3. use u.origin for every scheme -> test 3 goes red ("null" leaks in).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { DatabaseSync } from "node:sqlite";
import { SqliteD1 } from "./helpers/sqlite-d1.ts";

const ORIGIN = "https://1f916.ai";
const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function makeEnv() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(schema);
  return { DB: new SqliteD1(sqlite), OAUTH_KEY: "0123456789abcdef0123456789abcdef" } as unknown as never;
}

// Register a real client through the route: client_id is a SEALED token, not a
// table row, so a hand-built fixture cannot stand in for one.
async function registerClient(env: never, redirect: string): Promise<string> {
  const r = await worker.fetch(
    new Request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Test Connector", redirect_uris: [redirect] }),
    }),
    env,
  );
  assert.equal(r.status, 201, `register failed: ${r.status}`);
  return ((await r.json()) as { client_id: string }).client_id;
}

async function csp(redirect: string): Promise<string> {
  const env = makeEnv();
  const clientId = await registerClient(env, redirect);
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    state: "st8",
    code_challenge: "c".repeat(43),
    code_challenge_method: "S256",
  });
  const res = await worker.fetch(new Request(`${ORIGIN}/oauth/authorize?${q}`), env);
  assert.equal(res.status, 200, `expected the consent page, got ${res.status}`);
  return res.headers.get("content-security-policy") ?? "";
}

test("form-action names the client origin the route is about to 303 to", async () => {
  const policy = await csp("https://chat.openai.com/aip/callback");
  assert.match(policy, /form-action 'self' https:\/\/chat\.openai\.com/);
  assert.doesNotMatch(policy, /form-action 'self';/, "bare 'self' forbids the redirect this page exists to make");
});

test("the rest of the policy is unchanged — this widens one directive, not the header", async () => {
  const policy = await csp("https://chat.openai.com/aip/callback");
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /style-src 'unsafe-inline'/);
  assert.doesNotMatch(policy, /script-src/, "no script source is introduced");
});

test("a custom-scheme redirect contributes its scheme, never the string 'null'", async () => {
  // URL.origin is "null" for a non-special scheme. Emitting that would put a
  // literal `null` source into the policy, which is worse than omitting it.
  const policy = await csp("myapp://cb");
  assert.match(policy, /form-action 'self' myapp:/);
  assert.doesNotMatch(policy, /null/, "the string 'null' must never reach the header");
});

test("a registrable redirect whose origin carries a semicolon is NOT emitted", async () => {
  // THIS IS THE GUARD'S ONLY REAL TEST, and the first version of this file did
  // not have it. That version used "https://exa mple.com/cb", which
  // registration refuses outright, so the request never reached the header and
  // the regex in formActionSource had ZERO coverage while this file's own
  // comment claimed a mutation would kill it. The pre-deploy auditor dropped
  // the guard, printed the mutated line, and watched all 1692 tests stay green.
  //
  // "https://a;b.com/cb" IS registrable today. Without the guard the header
  // becomes `form-action 'self' https://a;b.com`, and a CSP parser splits that
  // on the semicolon into a second directive. That is the injection.
  //
  // Killing mutation: delete the regex test in formActionSource and return the
  // source unconditionally. This goes red; nothing else does.
  const policy = await csp("https://a;b.com/cb");
  assert.doesNotMatch(policy, /a;b\.com/, "a source with a semicolon must never reach the header");
  assert.equal(
    (policy.match(/;/g) ?? []).length,
    2,
    "exactly the two separators the policy's own three directives need — no third",
  );
  assert.match(policy, /form-action 'self'$/, "and the directive falls back to bare 'self'");
});

test("an unregistered redirect_uri is still refused before any page is rendered", async () => {
  // The CSP change reads redirect_uri from validated params. If that check ever
  // weakened, the header would name an origin the client does not own.
  const env = makeEnv();
  const clientId = await registerClient(env, "https://chat.openai.com/aip/callback");
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "https://evil.example/cb",
    state: "st8",
    code_challenge: "c".repeat(43),
    code_challenge_method: "S256",
  });
  const res = await worker.fetch(new Request(`${ORIGIN}/oauth/authorize?${q}`), env);
  assert.equal(res.status, 400, "the CSP change must not weaken the registration check it relies on");
  assert.doesNotMatch(res.headers.get("content-security-policy") ?? "", /evil\.example/);
});
