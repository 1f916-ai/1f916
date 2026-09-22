// /openapi.json declares the query-parameter 400 on every GET the router
// guards, and on no other.
//
// checkQueryParams (src/index.ts) runs before the handler on each GET whose
// route has a QUERY_PARAMS entry. An unknown or repeated parameter is refused
// with a 400 whose `error` names the supported set. That was the most common
// error a client could hit on a read, and the document never declared it:
// every read listed its `parameters` but no response for sending the wrong
// ones. A generated client typed that 400 body `never`, so a typo in a
// parameter name read as an undiagnosable success body instead of the one
// error whose text says what to send (the error side of the class the
// 401, 429, 404 and 304 declarations already closed).
//
// The declaration is projected from QUERY_PARAMS, the same object the guard
// reads, so it cannot drift from the router. This file holds that in-process:
// the set of GETs declaring 400 equals the set with a QUERY_PARAMS entry, and
// the live router actually answers 400 with the named supported set on every
// one of them.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { SURFACE } from "../src/surface.ts";
import { QUERY_PARAMS } from "../src/query-params.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

type Doc = { paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, unknown>; description?: string }> }>> };

const docPath = (p: string) => p.replace(/:([A-Za-z_]+)/g, "{$1}").replace(/\{handle\}\.svg$/, "{handle}.svg");

function guardedGets(): Set<string> {
  const set = new Set<string>();
  for (const r of SURFACE) {
    const verbs = r.verbs ?? (r.method === "*" ? ["GET"] : [r.method]);
    if (verbs.includes("GET") && QUERY_PARAMS[r.path]) set.add(docPath(r.path));
  }
  return set;
}

async function doc(): Promise<Doc> {
  const { env } = sqliteTestEnv(schema);
  return (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as Doc;
}

test("QUERY_PARAMS guards a meaningful set of GETs to pin", () => {
  assert.ok(guardedGets().size >= 30, `only ${guardedGets().size} guarded GETs; the table or the mapping has drifted`);
});

test("every GET declares 400 exactly when the router guards its query string", async () => {
  const d = await doc();
  const guarded = guardedGets();
  let checked = 0;
  for (const [path, ops] of Object.entries(d.paths)) {
    const op = ops.get;
    if (!op) continue;
    const has400 = "400" in op.responses;
    const shouldBe = guarded.has(path);
    assert.equal(has400, shouldBe, `GET ${path} is ${shouldBe ? "guarded and" : "unguarded and"} ${has400 ? "declares" : "does not declare"} 400`);
    checked++;
  }
  assert.ok(checked >= 60, `only ${checked} GET operations in the document; the path scan has drifted`);
  for (const [path, ops] of Object.entries(d.paths)) {
    for (const [verb, op] of Object.entries(ops)) {
      if (verb === "get") continue;
      assert.ok(!("400" in op.responses && op.responses["400"].description?.includes("query parameter")), `${verb.toUpperCase()} ${path} declares the query 400 but the router never reads a POST query string`);
    }
  }
});

test("the declared 400 is JSON and says what it refuses", async () => {
  const d = await doc();
  for (const path of guardedGets()) {
    const body = d.paths[path]?.get?.responses["400"];
    assert.ok(body, `GET ${path} declares no 400`);
    assert.deepEqual(Object.keys(body.content ?? {}), ["application/json"], `GET ${path} 400 content`);
    assert.match(body.description ?? "", /query parameter/, `GET ${path} 400 description`);
  }
});

test("the live router answers 400 naming the supported set on every guarded GET", async () => {
  const { env } = sqliteTestEnv(schema);
  // Bearer GETs authenticate before the guard: a keyless request with a bad
  // parameter meets the 401, not this 400. So probe with a real secret, and
  // pin that ordering on its own below.
  const reg = await worker.fetch(
    new Request(`${ORIGIN}/api/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle: "query-400-berry", model: "gpt-5" }) }),
    env,
  );
  assert.equal(reg.status, 201, "register");
  const { secret } = (await reg.json()) as { secret: string };
  const bearer = new Set(SURFACE.filter((r) => r.auth === "bearer").map((r) => r.path));
  // A path parameter the router matches by shape needs that shape, or the
  // request 404s before the guard runs: /porch/:day takes a date, and a
  // :handle or :slug is two characters or more.
  const SHAPE: Record<string, string> = { day: "2026-08-21", handle: "nobody-here", slug: "no-such-grant" };
  let probed = 0;
  for (const r of SURFACE) {
    const verbs = r.verbs ?? (r.method === "*" ? ["GET"] : [r.method]);
    const allowed = QUERY_PARAMS[r.path];
    if (!verbs.includes("GET") || !allowed) continue;
    const url = `${ORIGIN}${r.path.replace(/:([A-Za-z_]+)/g, (_, n: string) => SHAPE[n] ?? "1")}?zz_not_a_param=1`;
    const headers: Record<string, string> = bearer.has(r.path) ? { Authorization: `Bearer ${secret}` } : {};
    const res = await worker.fetch(new Request(url, { headers }), env);
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    assert.equal(res.status, 400, `GET ${r.path}?zz_not_a_param=1 answered ${res.status}: ${String(body.error ?? "").slice(0, 120)}`);
    const error = String(body.error ?? "");
    assert.match(error, /zz_not_a_param/, `GET ${r.path} 400 does not name the refused parameter`);
    for (const p of allowed) assert.ok(error.includes(p), `GET ${r.path} 400 does not name supported parameter ${p}`);
    probed++;
  }
  assert.equal(probed, guardedGets().size, "every guarded GET was probed");
});

test("on a bearer GET the 401 comes first: a keyless bad parameter is refused as unauthenticated", async () => {
  const { env } = sqliteTestEnv(schema);
  const res = await worker.fetch(new Request(`${ORIGIN}/api/me?zz_not_a_param=1`), env);
  assert.equal(res.status, 401, "authenticate() runs before checkQueryParams");
});
