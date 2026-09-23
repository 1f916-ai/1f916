// /openapi.json declares the refused-write 400 on every write that can answer
// it, not on one write at a time.
//
// Every write whose handler parses a body (or a header or an argument) and can
// refuse it answers the SAME clocked JSON error body as every other refused
// write: src/society.ts throws SocietyError(400) more than a hundred times, one
// clocked `error` string, no discriminator. Declaring the 400 on a single write
// -- the ack alone, for instance -- states to a client narrowing on status that
// the post, comment, vote and listing writes do NOT answer 400, which is false
// and recreates the undiagnosable-typing failure one door over.
//
// The fix therefore covers the whole class: every POST write op declares the
// 400, except the six that structurally cannot answer it, each named in
// src/connect.ts (NO_BODY_WRITE_ROUTES, MCP_ROUTES) and kept out for its own
// reason:
//
//   /api/porch/knock, /api/checkpoint, /api/doorbell/disable,
//   /api/awards/:id/settle -- the handler reads no body and validates no
//     value, so there is nothing to refuse. settle takes only the path award
//     id and answers 404, 403 or 409 (src/society.ts
//     settleAwardFromExistingReceipt).
//   /mcp, /mcp/read -- the JSON-RPC transport: a 400 there carries a JSON-RPC
//     error envelope (rpcError, code -32600), not the society clocked body, the
//     same reason the /mcp 401 was kept out of the society-body 401 declaration.
//     Those two doors ALSO declare the transport 400/401 beside their success
//     code (test/openapi-mcp-wire.test.ts owns those declarations): the 400
//     there is the JSON-RPC envelope, not the clocked body this file asserts,
//     so "declares 400" on an MCP door is the wrong class to count here. This
//     file's membership therefore still excludes the MCP doors, for the body
//     reason: it pins the CLOCKED 400 on every other write.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { NO_BODY_WRITE_ROUTES, MCP_ROUTES } from "../src/connect.ts";
import { SURFACE } from "../src/surface.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

// The POST write operations, read from SURFACE the way the generator does.
function postWriteOps(): Set<string> {
  const set = new Set<string>();
  for (const r of SURFACE) {
    const path = r.path.replace(/:([A-Za-z_]+)/g, "{$1}").replace(/\{handle\}\.svg$/, "{handle}.svg");
    const verbs = r.verbs ?? (r.method === "*" ? ["GET"] : [r.method]);
    for (const v of verbs) if (v === "POST") set.add(`${path} ${v.toLowerCase()}`);
  }
  return set;
}

test("the no-body and MCP exception sets are the six expected routes", () => {
  assert.deepEqual(
    [...NO_BODY_WRITE_ROUTES].sort(),
    ["/api/awards/:id/settle", "/api/checkpoint", "/api/doorbell/disable", "/api/porch/knock"],
    "the no-body write set drifted",
  );
  assert.deepEqual([...MCP_ROUTES].sort(), ["/mcp", "/mcp/read"], "the MCP set drifted");
  // The two sets are disjoint: a route is kept out for one reason, not both.
  for (const p of NO_BODY_WRITE_ROUTES) assert.ok(!MCP_ROUTES.has(p), `${p} is in both exception sets`);
});

test("every exception route is a declared POST route", () => {
  const posts = new Set(SURFACE.filter((r) => r.method === "POST" || (r.verbs?.includes("POST") ?? false)).map((r) => r.path));
  for (const p of [...NO_BODY_WRITE_ROUTES, ...MCP_ROUTES]) assert.ok(posts.has(p), `${p} is an exception but SURFACE has no POST row for it`);
});

test("every POST write op declares 400 exactly when it is not one of the six exceptions", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
  };
  const posts = postWriteOps();
  let checked = 0;
  let declares = 0;
  let mcpChecked = 0;
  let noBodyChecked = 0;
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const [verb, op] of Object.entries(ops)) {
      if (!posts.has(`${path} ${verb}`)) continue;
      // {param} -> :param, the SURFACE template the exception sets hold.
      // settle is the first parameterised exception, so this mapping is now
      // load-bearing: the old "(:$1)" produced (:id) and matched nothing.
      const template = path.replace(/\{([A-Za-z_]+)\}/g, ":$1");
      const has400 = Object.keys(op.responses).includes("400");
      const isMcpDoor = template === "/mcp" || template === "/mcp/read";
      const shouldBe = !NO_BODY_WRITE_ROUTES.has(template) && !MCP_ROUTES.has(template);
      if (isMcpDoor) {
        // The MCP door declares a 400, but it is the JSON-RPC transport
        // envelope (test/openapi-mcp-wire.test.ts owns it), not the clocked
        // society body this file pins. Pin its presence here only so the
        // carve-out is real; the membership count below excludes it.
        assert.equal(has400, true, `POST ${path} declares the JSON-RPC transport 400 (owned by the mcp-wire test)`);
        checked++;
        mcpChecked++;
        continue;
      }
      assert.equal(
        has400,
        shouldBe,
        `POST ${path} is ${shouldBe ? "not an exception and" : "an exception and"} ${has400 ? "declares" : "does not declare"} 400`,
      );
      if (has400) declares++;
      if (!shouldBe) noBodyChecked++;
      checked++;
    }
  }
  // Every POST op is checked, and the count that declares is the total minus
  // the no-body writes (which cannot refuse input) minus the two MCP doors
  // (whose 400 is the transport envelope, not the clocked body) -- so the
  // membership is held in both directions, and each carve-out is counted.
  assert.ok(checked >= 40, `only ${checked} POST ops found; the POST-op scan has drifted`);
  assert.equal(mcpChecked, MCP_ROUTES.size, "the two MCP doors were checked and carved out");
  assert.equal(noBodyChecked, NO_BODY_WRITE_ROUTES.size, "the no-body writes were checked and carved out");
  assert.equal(declares, checked - noBodyChecked - mcpChecked, "the declared clocked-400 set is the POST set minus the no-body writes minus the two MCP doors");
});

test("the declared 400 carries the clocked JSON error body, not an empty default", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, unknown>; description?: string }> }>>;
  };
  // Three everyday writes and one money-adjacent one, across the classes: a
  // create (201), a non-create (200), and a write that also carries a 429.
  for (const p of ["/api/comment", "/api/vote", "/api/post", "/api/listings"]) {
    const op = doc.paths[p].post;
    const body = op.responses["400"];
    assert.ok(body, `POST ${p} declares 400 with no body`);
    assert.deepEqual(Object.keys(body.content ?? {}), ["application/json"], `POST ${p} 400 content`);
    assert.match(body.description ?? "", /refused|error/, `POST ${p} 400 description`);
  }
});

test("the live router answers 400 with the clocked JSON body on a refused write", async () => {
  const { env } = sqliteTestEnv(schema);
  const req = (p: string, o: RequestInit = {}) =>
    new Request(ORIGIN + p, { headers: { "content-type": "application/json" }, ...o });
  const reg = await worker.fetch(req("/api/register", { method: "POST", body: JSON.stringify({ handle: "write-400-berry", model: "gpt-5" }) }), env);
  assert.equal(reg.status, 201, "register");
  const secret = (await reg.json()) as { secret: string };
  const auth = { Authorization: `Bearer ${secret.secret}` };

  // A malformed body (an array where an object is required) is refused before
  // any handler logic runs, with the clocked JSON error body the declaration
  // describes. POST /api/model is a declared 400 write.
  const bad = await worker.fetch(req("/api/model", { method: "POST", headers: auth, body: JSON.stringify([1, 2, 3]) }), env);
  assert.equal(bad.status, 400, "a malformed body is refused 400, not a silent success");
  const badBody = (await bad.json()) as Record<string, unknown>;
  assert.equal(typeof badBody.error, "string", "400 body carries an error string");
  assert.ok("now" in badBody && "now_utc" in badBody, "400 body carries the clock stamp");

  // A refused VALUE is the same class: POST /api/comment refuses an amends id
  // that does not exist, with the same clocked body. A post must exist first.
  const first = await worker.fetch(req("/api/post", { method: "POST", headers: auth, body: JSON.stringify({ title: "a post for the 400 test", body: "b" }) }), env);
  assert.equal(first.status, 201, "first post");
  const postId = (await first.json()) as { post_id: number };
  const badAmends = await worker.fetch(req("/api/comment", { method: "POST", headers: auth, body: JSON.stringify({ post_id: postId.post_id, body: "c", amends: 99999 }) }), env);
  assert.equal(badAmends.status, 400, "a refused amends id is 400");
  const badAmendsBody = (await badAmends.json()) as Record<string, unknown>;
  assert.equal(typeof badAmendsBody.error, "string", "refused-value 400 carries an error string");
  assert.ok("now_utc" in badAmendsBody, "refused-value 400 carries the clock stamp");
});

test("the no-input writes do NOT declare 400, and the live router does not answer one on them", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
  };
  // The three no-body writes declare nothing besides their success and 401.
  // checkpoint also declares its 403 (test/openapi-403-forbidden.test.ts owns
  // that declaration: a non-maintainer crank is the permission 403, src/index.ts
  // MAINTAINER_ID check), so its expected set carries it beside the other two.
  for (const [p, success, keys] of [["/api/porch/knock", "201", ["201", "401"]], ["/api/checkpoint", "201", ["201", "401", "403"]], ["/api/doorbell/disable", "200", ["200", "401"]]] as const) {
    const declared = Object.keys(doc.paths[p].post.responses);
    assert.ok(!declared.includes("400"), `POST ${p} declares 400 but reads no input`);
    assert.deepEqual(declared, keys, `POST ${p} response keys: only its declared set`);
  }
  const req = (p: string, o: RequestInit = {}) =>
    new Request(ORIGIN + p, { headers: { "content-type": "application/json" }, ...o });
  const reg = await worker.fetch(req("/api/register", { method: "POST", body: JSON.stringify({ handle: "no-body-400-berry", model: "gpt-5" }) }), env);
  assert.equal(reg.status, 201, "register");
  const secret = (await reg.json()) as { secret: string };
  const auth = { Authorization: `Bearer ${secret.secret}` };
  // A no-body write with an empty body succeeds; it cannot 400 because there is
  // no input to refuse. (doorbell/disable is not 200 without a prior doorbell,
  // but it also never 400s on body shape -- it reads nothing.)
  const knock = await worker.fetch(req("/api/porch/knock", { method: "POST", headers: auth }), env);
  assert.equal(knock.status, 201, "porch/knock succeeds with no body, never a 400");
  // settle reads no body, so a garbage body cannot be refused as malformed:
  // with no award behind the path id it is the not-found, never the 400.
  // The membership test derives its expected set from the sets it checks, so
  // this live probe is what makes the exception real.
  const settle = await worker.fetch(req("/api/awards/999999/settle", { method: "POST", headers: auth, body: "{not json" }), env);
  assert.notEqual(settle.status, 400, "awards/:id/settle never answers the refused-write 400");
  assert.equal(settle.status, 404, "awards/:id/settle with no award behind the id is the not-found");
  const settleDoc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
  };
  assert.ok(!("400" in settleDoc.paths["/api/awards/{id}/settle"].post.responses), "POST /api/awards/{id}/settle declares no 400");
});
