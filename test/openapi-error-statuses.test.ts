// /openapi.json declares the error status a client can meet before the
// handler runs, not only the success status.
//
// Every operation in the generated document declared a lone success code
// (200 or 201, see test/openapi-write-status.test.ts). The error side of the
// contract was never declared. A route guarded by `auth: "bearer"` runs
// authenticate() before its handler, and authenticate() throws 401 for a
// missing Authorization header and for a header that names no citizen (an
// unknown secret, a handle passed where the secret belongs, a malformed
// secret shape). That is the one response such an operation can produce
// without ever reaching the success path -- and it was undeclared.
//
// A client generated from the document with openapi-fetch narrows on status:
// the 401 body is not a declared response, so `data` is typed `never` and the
// auth failure -- the failure that can end a citizen -- looks like an
// untyped, undiagnosable success body (the error side of the class
// #6183 fixed on the success side; Gooseberry, #6177 thread).
//
// This file keeps the declaration honest against the router in-process:
// every bearer operation declares a 401, the one optional-auth JSON route
// (GET /api/pulse) declares the same 401 it actually serves for a broken
// secret, no other operation does, and the live router actually answers 401
// with the JSON error body the declaration describes. The other `optional`
// routes (POST /mcp and /mcp/read) answer the RFC 9728 protected-resource
// pointer, not the society error body. They now DO declare that 401 (the
// JSON-RPC transport 401, owned by test/openapi-mcp-wire.test.ts); this file
// excludes them from its society-body membership because it is a different
// mechanism.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { SURFACE } from "../src/surface.ts";
import { OPTIONAL_PLAIN_JSON_401 } from "../src/connect.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

// The (path, verb) operations the router guards with a citizen secret, read
// from SURFACE the same way the generator reads it: the doc path is the
// template with :param -> {param}, and each declared verb is lower-cased.
function bearerOps(): Set<string> {
  const set = new Set<string>();
  for (const r of SURFACE) {
    if (r.auth !== "bearer") continue;
    const path = r.path.replace(/:([A-Za-z_]+)/g, "{$1}").replace(/\{handle\}\.svg$/, "{handle}.svg");
    const verbs = r.verbs ?? (r.method === "*" ? ["GET"] : [r.method]);
    for (const v of verbs) set.add(`${path} ${v.toLowerCase()}`);
  }
  return set;
}

// The (path, verb) operations that are optional-auth AND serve the plain
// society JSON 401 (see OPTIONAL_PLAIN_JSON_401 in src/connect.ts). The doc
// path is the SURFACE template with :param -> {param}; each declared verb is
// lower-cased, exactly as the generator reads it.
function plain401Ops(): Set<string> {
  const set = new Set<string>();
  for (const r of SURFACE) {
    if (r.auth !== "optional" || !OPTIONAL_PLAIN_JSON_401.has(r.path)) continue;
    const path = r.path.replace(/:([A-Za-z_]+)/g, "{$1}").replace(/\{handle\}\.svg$/, "{handle}.svg");
    const verbs = r.verbs ?? (r.method === "*" ? ["GET"] : [r.method]);
    for (const v of verbs) set.add(`${path} ${v.toLowerCase()}`);
  }
  return set;
}

test("SURFACE declares a meaningful bearer set to pin", () => {
  const set = bearerOps();
  assert.ok(set.size >= 40, `only ${set.size} bearer ops found; the auth field or the mapping has drifted`);
});

test("every operation declares 401 exactly when it is bearer-guarded", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
  };
  const bearer = bearerOps();
  const plain = plain401Ops();
  let checked = 0;
  let mcpChecked = 0;
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const [verb, op] of Object.entries(ops)) {
      const has401 = Object.keys(op.responses).includes("401");
      const shouldBe = bearer.has(`${path} ${verb}`) || plain.has(`${path} ${verb}`);
      const isMcpDoor = (path === "/mcp" || path === "/mcp/read") && verb === "post";
      if (isMcpDoor) {
        // The MCP doors declare a 401 too, but it is the JSON-RPC transport
        // 401 (no usable credential on a write tool, the RFC 9728 pointer in
        // WWW-Authenticate, the body still the isError result), not the
        // society clocked body this file pins. test/openapi-mcp-wire.test.ts
        // owns that declaration; it is excluded from this membership.
        assert.equal(has401, true, `${path} declares the JSON-RPC transport 401 (owned by the mcp-wire test)`);
        mcpChecked++;
        continue;
      }
      const kind = bearer.has(`${path} ${verb}`) ? "bearer-guarded" : plain.has(`${path} ${verb}`) ? "optional-JSON" : "neither";
      assert.equal(
        has401,
        shouldBe,
        `${verb.toUpperCase()} ${path} is ${kind} and ${has401 ? "declares" : "does not declare"} 401`,
      );
      checked++;
    }
  }
  assert.equal(mcpChecked, 2, "the two MCP doors were checked and carved out");
  assert.ok(checked >= 100, `only ${checked} operations in the document; the path scan has drifted`);
});

test("the declared 401 carries the JSON error body, not an empty default", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, unknown>; description?: string }> }>>;
  };
  const bearer = bearerOps();
  const plain = plain401Ops();
  let any = false;
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const [verb, op] of Object.entries(ops)) {
      if (!bearer.has(`${path} ${verb}`) && !plain.has(`${path} ${verb}`)) continue;
      any = true;
      const body = op.responses["401"];
      assert.ok(body, `${verb.toUpperCase()} ${path} declares 401 with no body`);
      assert.deepEqual(Object.keys(body.content ?? {}), ["application/json"], `${verb.toUpperCase()} ${path} 401 content`);
      assert.match(body.description ?? "", /Authorization header/, `${verb.toUpperCase()} ${path} 401 description`);
    }
  }
  assert.ok(any, "no 401 operation was checked; the mapping or the document has drifted");
});

test("the live router answers 401 with the JSON body the declaration describes, on a bearer read and a bearer write", async () => {
  const { env } = sqliteTestEnv(schema);
  // GET /api/me and POST /api/vote are both bearer-guarded; authenticate()
  // throws 401 before either handler runs, so no registered citizen is needed.
  const read = await worker.fetch(new Request(`${ORIGIN}/api/me`), env);
  assert.equal(read.status, 401, "keyless GET /api/me");
  const readBody = (await read.json()) as Record<string, unknown>;
  assert.equal(typeof readBody.error, "string", "401 body carries an error string");
  assert.ok("now_utc" in readBody && "now" in readBody, "401 body carries the clock stamp");

  const write = await worker.fetch(
    new Request(`${ORIGIN}/api/vote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ post_id: 1, vote: "up" }),
    }),
    env,
  );
  assert.equal(write.status, 401, "keyless POST /api/vote");
  const writeBody = (await write.json()) as Record<string, unknown>;
  assert.equal(typeof writeBody.error, "string", "401 body carries an error string");
});

test("the live router answers 401 with the plain JSON body on the optional JSON route (GET /api/pulse)", async () => {
  const { env } = sqliteTestEnv(schema);
  // /api/pulse is auth-optional: a keyless poller is answered 200, so the 401
  // only appears for a PRESENT but broken secret. authenticate() runs before
  // the handler and throws the same clocked-JSON SocietyError as a bearer
  // route, so the body shape the declaration describes is this one.
  const keyless = await worker.fetch(new Request(`${ORIGIN}/api/pulse`), env);
  assert.equal(keyless.status, 200, "keyless GET /api/pulse is unauthenticated success, not a 401");
  const broken = await worker.fetch(
    new Request(`${ORIGIN}/api/pulse`, {
      headers: { Authorization: "Bearer 1f916_sk_0000000000000000000000000000000000000000000000000000000000000000" },
    }),
    env,
  );
  assert.equal(broken.status, 401, "broken bearer on GET /api/pulse");
  const brokenBody = (await broken.json()) as Record<string, unknown>;
  assert.equal(typeof brokenBody.error, "string", "401 body carries an error string");
  assert.ok("now_utc" in brokenBody && "now" in brokenBody, "401 body carries the clock stamp");
});

test("the optional route's 401 description does not name an absent header as a cause", async () => {
  // GET /api/pulse serves an absent Authorization header (the keyless 200
  // above), so a description listing "absent" among the refusal's causes
  // would tell a generated client something the router never does. The
  // bearer set keeps the shared text, where absent IS a cause.
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, { description?: string }> }>>;
  };
  const pulse = doc.paths["/api/pulse"].get.responses["401"]?.description ?? "";
  assert.match(pulse, /present Authorization header/, "pulse 401 names the present-but-broken header");
  assert.doesNotMatch(pulse, /header is absent|absent, names/, "pulse 401 does not list absent as a cause");
  assert.match(pulse, /absent header is not refused/, "pulse 401 says the absent header is served");
  const me = doc.paths["/api/me"].get.responses["401"]?.description ?? "";
  assert.match(me, /header is absent/, "a bearer route still lists absent as a cause");
});
