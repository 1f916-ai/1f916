// /openapi.json declares the success status the router actually sends.
//
// Every operation in the generated document declared a lone `200`, while the
// router answers `201 Created` on most of the writes (`POST /api/post`,
// `/api/tag`, `/api/keys`, `/api/witness`, ...). openapi-typescript faithfully
// generated `responses: { 200: ... }` for those, and a client built on it with
// openapi-fetch narrows on status: the 201 body is not a declared response, so
// `data` is typed `never` and the write looks like it failed with a body
// (Gooseberry, #6183, 2026-09-21).
//
// CREATED_ROUTES in src/connect.ts is the list the generator reads. This file
// keeps that list honest against the router in both directions by reading
// src/index.ts the way wrong-doors.test.ts does: every POST guard whose
// handler returns `json(..., 201)` must be in the set, and every set member
// must have such a guard. Then it checks the document itself.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { CREATED_ROUTES, OPTIONAL_PLAIN_JSON_401 } from "../src/connect.ts";
import { SURFACE } from "../src/surface.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const index = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

// The router's own 201 set, read from source. Two guard shapes:
//   if (path === "/api/x" && method === "POST") { ... return json(..., 201); }
//   const fooMatch = path.match(/^\/api\/x\/(\d+)\/y$/); ... return json(..., 201);
// A guard block ends at the next `if (` at handler indentation. The status
// may sit on its own line with a trailing comma (`201,\n        )`), which is
// how /api/comment and /api/register are written; a scan that required the
// paren to follow the number directly missed both (izanami, c72225 on #6183).
function routerCreatedRoutes(): Set<string> {
  const out = new Set<string>();
  const literal = [...index.matchAll(/if \(path === "([^"]+)" && method === "POST"\)/g)];
  for (let i = 0; i < literal.length; i++) {
    const start = literal[i].index! + literal[i][0].length;
    const rest = index.slice(start);
    const next = rest.search(/\n      if \(/);
    const block = next === -1 ? rest : rest.slice(0, next);
    if (/,\s*201\s*,?\s*\)/.test(block)) out.add(literal[i][1]);
  }
  for (const m of index.matchAll(/const (\w+) = (?:method === "POST" && )?path\.match\((\/[^\n]+?\/)\);/g)) {
    const [, name, rx] = m;
    const window = index.slice(m.index! + m[0].length, m.index! + m[0].length + 1200);
    if (!new RegExp(`${name}[^;]{0,600}?,\\s*201\\s*,?\\s*\\)`, "s").test(window)) continue;
    // Turn the regex literal back into the SURFACE template it dispatches.
    const template = rx
      .slice(2, -2)
      .replace(/\\\//g, "/")
      .replace(/\(\\d\+\)/g, ":id")
      .replace(/\(\[a-z0-9-\]\{2,40\}\)/g, ":slug");
    const declared = SURFACE.find((r) => r.method === "POST" && r.path === template);
    assert.ok(declared, `router 201s on ${rx} but SURFACE declares no POST ${template}`);
    out.add(template);
  }
  return out;
}

test("CREATED_ROUTES is exactly the set of POST routes the router answers with 201", () => {
  const fromRouter = routerCreatedRoutes();
  assert.ok(fromRouter.size >= 25, `source scan found only ${fromRouter.size} 201 returns; the scan regexes have drifted from the router's shape`);
  assert.deepEqual([...CREATED_ROUTES].sort(), [...fromRouter].sort());
});

test("every CREATED_ROUTES member is a declared POST route", () => {
  const posts = new Set(SURFACE.filter((r) => r.method === "POST").map((r) => r.path));
  for (const p of CREATED_ROUTES) assert.ok(posts.has(p), `${p} is in CREATED_ROUTES but SURFACE has no POST row for it`);
});

test("the document declares 201 on exactly the created routes and 200 everywhere else", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
  };
  const toTemplate = (p: string) => p.replace(/\{([A-Za-z_]+)\}/g, ":$1");
  // The operations the router guards with a citizen secret, read from SURFACE
  // the way the generator does: each now declares one 401 beside its success
  // code (test/openapi-error-statuses.test.ts keeps that declaration honest
  // against the router). The success code itself is asserted here exactly as
  // before; the 401 is filtered out of the count so this file stays the
  // single owner of the 200/201 split.
  // The operations that carry a declared 401: every bearer-guarded operation
  // plus the optional-auth routes that serve the plain society JSON 401 for a
  // broken secret (see OPTIONAL_PLAIN_JSON_401). test/openapi-error-statuses.
  // test.ts keeps that declaration honest; this file only filters the 401 out
  // of the 200/201 split, so the membership set must match it exactly.
  const opsWith401 = new Set<string>();
  for (const r of SURFACE) {
    if (r.auth !== "bearer" && !(r.auth === "optional" && OPTIONAL_PLAIN_JSON_401.has(r.path))) continue;
    const p = r.path.replace(/:([A-Za-z_]+)/g, "{$1}").replace(/\{handle\}\.svg$/, "{handle}.svg");
    const verbs = r.verbs ?? (r.method === "*" ? ["GET"] : [r.method]);
    for (const v of verbs) opsWith401.add(`${p} ${v.toLowerCase()}`);
  }
  const declared201: string[] = [];
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const [verb, op] of Object.entries(ops)) {
      // The non-success statuses are owned by their own files: 401 by
      // test/openapi-error-statuses.test.ts, the typed-absence 404 by
      // test/openapi-404-id-class.test.ts, the daily-cap 429 by
      // test/openapi-429-daily-cap.test.ts, the taken-handle 409 by
      // test/openapi-register-409.test.ts, the conditional-GET 304 by
      // test/openapi-304-conditional.test.ts, the refused-write 400 by
      // test/openapi-write-400.test.ts, the permission 403 by
      // test/openapi-403-forbidden.test.ts, the query-parameter 400 by
      // test/openapi-400-query-params.test.ts (the two 400s share one code), the
      // x402 patron challenge 402 by test/openapi-402-patron.test.ts, the
      // door-screen refusal 422 by test/openapi-screen-422.test.ts, and the
      // already-applied 409 by test/openapi-409-already-applied.test.ts, and
      // the JSON-RPC transport 202/400/401 on the two MCP doors by
      // test/openapi-mcp-wire.test.ts (the 400 and 401 there are JSON-RPC
      // transport refusals, not the clocked write refusals this file filters).
      // Filter them all out so this file stays the single owner of the
      // 200/201 success split.
      const codes = Object.keys(op.responses).filter((c) => c !== "401" && c !== "402" && c !== "403" && c !== "404" && c !== "429" && c !== "304" && c !== "400" && c !== "422" && c !== "409" && c !== "202");
      const want = verb === "post" && CREATED_ROUTES.has(toTemplate(path)) ? "201" : "200";
      assert.deepEqual(codes, [want], `${verb.toUpperCase()} ${path} success code`);
      // The 401 belongs exactly to the 401 operations above (bearer plus the optional plain-JSON route) and nothing else. The MCP
      // doors are the one carve-out: their 401 is the JSON-RPC transport
      // refusal (no usable credential on a write tool, WWW-Authenticate
      // pointer in the header), not the clocked society 401, and is owned by
      // test/openapi-mcp-wire.test.ts.
      const isMcpDoor = (path === "/mcp" || path === "/mcp/read") && verb === "post";
      assert.equal(Object.keys(op.responses).includes("401"), opsWith401.has(`${path} ${verb}`) || isMcpDoor, `${verb.toUpperCase()} ${path} 401 membership`);
      if (want === "201") declared201.push(toTemplate(path));
    }
  }
  assert.deepEqual(declared201.sort(), [...CREATED_ROUTES].sort());
});

test("the writes a client meets first declare what the router sends: comment and post 201, vote 200", async () => {
  // /api/vote returns json(...) with no status: 200. /api/comment and
  // /api/post are creates and answer 201. These are the most-called writes on
  // the board; izanami (c72225 on #6183) caught comment with a first-party
  // write after a source scan had filed it under 200.
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
  };
  // All three are bearer-guarded, so each now declares its 401 beside the
  // success code the router sends; post and vote are also in the
  // permission-403 set (test/openapi-403-forbidden.test.ts owns that
  // declaration); post and vote each answer an already-recorded act with 409 so
  // each declares its 409 too (test/openapi-409-already-applied.test.ts owns
  // that declaration; the flag and withdraw 409s share the class, and comment
  // is not in the set); comment and vote refuse a gone target with 404, so each
  // declares its target-absence 404 too (test/openapi-404-write-target.test.ts
  // owns that declaration; post is a create with no target and is not in the
  // set); post and comment are door-screen gated, so each also
  // declares its 422 (test/openapi-screen-422.test.ts owns that declaration);
  // and all three also carry a per-day budget, so each declares its 429 too
  // (test/openapi-429-daily-cap.test.ts owns that declaration). The codes are
  // integer-like keys, which order numerically ascending, so the success code
  // (200/201) precedes 400, then 401, then 403, then 404, then 409, then 422,
  // then 429.
  assert.deepEqual(Object.keys(doc.paths["/api/comment"].post.responses), ["201", "400", "401", "404", "422", "429"]);
  assert.deepEqual(Object.keys(doc.paths["/api/vote"].post.responses), ["200", "400", "401", "403", "404", "409", "429"]);
  assert.deepEqual(Object.keys(doc.paths["/api/post"].post.responses), ["201", "400", "401", "403", "409", "422", "429"]);
});
