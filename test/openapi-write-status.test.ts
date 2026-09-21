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
import { CREATED_ROUTES } from "../src/connect.ts";
import { SURFACE } from "../src/surface.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const index = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

// The router's own 201 set, read from source. Two guard shapes:
//   if (path === "/api/x" && method === "POST") { ... return json(..., 201); }
//   const fooMatch = path.match(/^\/api\/x\/(\d+)\/y$/); ... return json(..., 201);
// A guard block ends at the next `if (` at handler indentation.
function routerCreatedRoutes(): Set<string> {
  const out = new Set<string>();
  const literal = [...index.matchAll(/if \(path === "([^"]+)" && method === "POST"\)/g)];
  for (let i = 0; i < literal.length; i++) {
    const start = literal[i].index! + literal[i][0].length;
    const rest = index.slice(start);
    const next = rest.search(/\n      if \(/);
    const block = next === -1 ? rest : rest.slice(0, next);
    if (/,\s*201\s*\)/.test(block)) out.add(literal[i][1]);
  }
  for (const m of index.matchAll(/const (\w+) = (?:method === "POST" && )?path\.match\((\/[^\n]+?\/)\);/g)) {
    const [, name, rx] = m;
    const window = index.slice(m.index! + m[0].length, m.index! + m[0].length + 1200);
    if (!new RegExp(`${name}[^;]{0,600}?,\\s*201\\s*\\)`, "s").test(window)) continue;
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
  assert.ok(fromRouter.size >= 20, `source scan found only ${fromRouter.size} 201 returns; the scan regexes have drifted from the router's shape`);
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
  const declared201: string[] = [];
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const [verb, op] of Object.entries(ops)) {
      const codes = Object.keys(op.responses);
      assert.equal(codes.length, 1, `${verb.toUpperCase()} ${path} declares ${codes.length} success codes`);
      const want = verb === "post" && CREATED_ROUTES.has(toTemplate(path)) ? "201" : "200";
      assert.deepEqual(codes, [want], `${verb.toUpperCase()} ${path}`);
      if (codes[0] === "201") declared201.push(toTemplate(path));
    }
  }
  assert.deepEqual(declared201.sort(), [...CREATED_ROUTES].sort());
});

test("the two writes a client meets first are 200, not 201, and the document says so", async () => {
  // /api/comment and /api/vote return json(...) with no status: 200. They are
  // the most-called writes on the board and a client must not wait for a 201.
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
  };
  assert.deepEqual(Object.keys(doc.paths["/api/comment"].post.responses), ["200"]);
  assert.deepEqual(Object.keys(doc.paths["/api/vote"].post.responses), ["200"]);
  assert.deepEqual(Object.keys(doc.paths["/api/post"].post.responses), ["201"]);
});
