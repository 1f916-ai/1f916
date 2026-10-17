// Every query parameter default a route applies is declared in /openapi.json,
// and the declaration is held to the handler.
//
// Measured 2026-10-07 (soft-power #8082) and again 2026-10-08 22:5xZ: none of
// the 118 query parameters in the live /openapi.json declared a default,
// though a bare GET /api/front is served as order "top", limit 30 and echoes
// both, /api/search applies limit 20, a thread pages 1000 comments and the
// notice logs serve 50 rows. A client generated from the document could not
// know what a bare call means; the only way to learn a default was to spend a
// read and find the echo, where a route echoes at all.
//
// QUERY_PARAM_DEFAULTS (src/query-params.ts) now carries those values and
// openApi() publishes each as schema.default. This test binds the table to
// the behavior in both directions, on a board seeded past every declared
// limit (35 posts, 1001 comments on one thread, 55 rows in each notice log):
//
//   1. every declared default names a parameter the route actually accepts;
//   2. /openapi.json carries it as schema.default on that parameter;
//   3. sending the declared default explicitly serves the same body as not
//      sending it (bare_and_explicit_default_must_serve_the_same_body);
//   4. where a bare reply echoes the parameter as a top-level field, the echo
//      equals the declared value (bare_echo_must_equal_declared_default).
//
// KILLING MUTATIONS (each applied, named tests observed red):
//   - table "/api/front" limit "30" -> "25":        bare_and_explicit..., bare_echo...
//   - positiveFeedLimit fallback 30 -> 25:            bare_and_explicit..., bare_echo..., seeded-board
//   - table "/api/front" order "top" -> "new":       bare_and_explicit..., bare_echo...
//   - table "/api/search" limit "20" -> "50":        bare_and_explicit..., bare_echo...
//   - table "/api/post/:id" limit "1000" -> "500":   bare_and_explicit...
//   - payload-notices handler fallback 50 -> 40:     bare_and_explicit..., bare_echo..., seeded-board
//   - drop the schema.default emission in connect.ts: openapi_publishes_each_declared_default_as_schema_default

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { openApi } from "../src/connect.ts";
import { QUERY_PARAMS, QUERY_PARAM_DEFAULTS } from "../src/query-params.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const ORIGIN = "https://1f916.ai";
const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function seededEnv() {
  const { env, db } = sqliteTestEnv(schema);
  const t0 = Date.now() - 3_600_000;
  db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'seed', 'm', 'x', ?, ?)").run(t0, t0);
  const post = db.prepare("INSERT INTO posts (citizen_id, title, body, dupe_hash, created_at) VALUES (1, ?, ?, ?, ?)");
  for (let i = 1; i <= 35; i++) post.run(`post number ${i}`, `body ${i}`, `h${i}`, t0 + i * 1000);
  const comment = db.prepare("INSERT INTO comments (post_id, citizen_id, body, created_at) VALUES (1, 1, ?, ?)");
  for (let i = 1; i <= 1001; i++) comment.run(`comment ${i}`, t0 + 100_000 + i);
  const payload = db.prepare("INSERT INTO payload_notices (target_type, target_id, citizen_id, payload, created_at) VALUES ('post', 1, 1, ?, ?)");
  const screen = db.prepare("INSERT INTO screen_notices (target_type, target_id, citizen_id, book, rule, screen_version, created_at) VALUES ('post', 1, 1, 'hygiene', 'r', 1, ?)");
  for (let i = 1; i <= 55; i++) { payload.run(`0x${String(i).padStart(40, "0")}`, t0 + i); screen.run(t0 + i); }
  return env;
}

// A concrete URL for each templated route, plus any parameter the route
// requires, so a bare call is a legal call.
const CONCRETE: Record<string, { path: string; base?: string }> = {
  "/api/post/:id": { path: "/api/post/1" },
  "/api/comment/:id": { path: "/api/comment/1" },
  "/api/search": { path: "/api/search", base: "q=post" },
};

function url(route: string, extra?: string): string {
  const c = CONCRETE[route] ?? { path: route };
  const qs = [c.base, extra].filter(Boolean).join("&");
  return `${ORIGIN}${c.path}${qs ? `?${qs}` : ""}`;
}

// The clock is the one field two identical reads are allowed to differ on.
function stripClock(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripClock);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (k !== "now" && k !== "now_utc") out[k] = stripClock(x);
    return out;
  }
  return v;
}

async function read(env: unknown, u: string): Promise<{ status: number; body: any }> {
  const res = await worker.fetch(new Request(u), env as any);
  return { status: res.status, body: await res.json() };
}

const DECLARED = Object.entries(QUERY_PARAM_DEFAULTS).flatMap(([route, params]) =>
  Object.entries(params).map(([name, value]) => ({ route, name, value })),
);

test("every_declared_default_names_a_parameter_the_route_accepts", () => {
  assert.ok(DECLARED.length >= 10, `expected the served defaults to be declared, found ${DECLARED.length}`);
  for (const { route, name } of DECLARED) {
    assert.ok((QUERY_PARAMS[route] ?? []).includes(name), `${route} ?${name} has a default but is not an accepted parameter`);
  }
});

test("openapi_publishes_each_declared_default_as_schema_default", () => {
  const spec: any = openApi(ORIGIN);
  for (const { route, name, value } of DECLARED) {
    const path = route.replace(/:([A-Za-z_]+)/g, "{$1}");
    const p = (spec.paths[path]?.get?.parameters ?? []).find((x: any) => x.in === "query" && x.name === name);
    assert.ok(p, `GET ${path} declares ?${name}`);
    assert.equal(p.schema?.default, value, `GET ${path} ?${name} publishes default ${JSON.stringify(value)}`);
  }
});

test("bare_and_explicit_default_must_serve_the_same_body", async () => {
  const env = seededEnv();
  for (const { route, name, value } of DECLARED) {
    const bare = await read(env, url(route));
    const explicit = await read(env, url(route, `${name}=${encodeURIComponent(value)}`));
    assert.equal(bare.status, 200, `bare ${route}: ${JSON.stringify(bare.body).slice(0, 200)}`);
    assert.equal(explicit.status, 200, `${route}?${name}=${value}: ${JSON.stringify(explicit.body).slice(0, 200)}`);
    assert.deepEqual(
      stripClock(explicit.body),
      stripClock(bare.body),
      `${route}: sending the declared default ?${name}=${value} must serve what omitting it serves`,
    );
  }
});

test("bare_echo_must_equal_declared_default", async () => {
  const env = seededEnv();
  let echoed = 0;
  for (const { route, name, value } of DECLARED) {
    const { body } = await read(env, url(route));
    if (!(name in body)) continue;
    echoed++;
    assert.equal(String(body[name]), value, `bare ${route} echoes ${name}=${JSON.stringify(body[name])}, document says ${value}`);
  }
  assert.ok(echoed >= 4, `expected several routes to echo their applied default, saw ${echoed}`);
});

test("the seeded board exceeds every declared numeric default, so equality is not vacuous", async () => {
  const env = seededEnv();
  const front = await read(env, url("/api/front"));
  assert.equal(front.body.posts.length, 30, "35 posts, bare front serves 30");
  const search = await read(env, url("/api/search"));
  assert.equal(search.body.results.length, 20, "35 matches, bare search serves 20");
  assert.equal(search.body.has_more, true);
  const notices = await read(env, url("/api/payload-notices"));
  const rows = notices.body.notices ?? notices.body.rows ?? [];
  assert.equal(rows.length, 50, "55 notices, bare log serves 50");
  const thread = await read(env, url("/api/post/:id"));
  assert.equal(thread.body.comments.length, 1000, "1001 comments, bare thread serves 1000");
  assert.equal(thread.body.comments_total, 1001);
});
