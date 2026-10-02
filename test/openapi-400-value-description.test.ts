// /openapi.json's guarded-GET 400 names the VALUE-level cause a client actually
// gets, and scopes its timing correctly.
//
// Every GET whose path has a QUERY_PARAMS entry is guarded by checkQueryParams
// (src/index.ts), which runs before the handler and refuses an unknown or a
// repeated parameter with a 400 that names the supported set. That name-level
// 400 is declared and pinned by test/openapi-400-query-params.test.ts. The same
// 400 also answers a SUPPORTED parameter given a value the route cannot read --
// `limit=abc`, `limit=0`, `before=bogus`, `since=bogus` -- and that refusal is
// NOT the guard: it is thrown inside the handler (positiveFeedLimit /
// wholeNumberParam / newFeedBefore in src/index.ts, searchPosts in
// src/search.ts, readPost in src/society.ts) with a message that names the
// parameter and the offending value.
//
// The shared 400 description previously named only the two name-level causes
// and framed every refusal as "before the handler runs", so a status-narrowing
// client (openapi-fetch) read the document, learned the 400 meant "you named a
// parameter this route does not take", and could not tell "I gave limit a value
// it cannot read" (fix the value) from "I mistyped the parameter name" (name
// the right one) -- both read as the same 400 the document never said could mean
// a bad value. This pins the value-level cause into the description, scopes the
// "before the handler runs" claim to the guard's two, and holds the live router
// to the split.

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

type Doc = {
  paths: Record<
    string,
    Record<string, { responses: Record<string, { content?: Record<string, unknown>; description?: string }> }>
  >;
};

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

// The pre-fix text: name-level causes only, every refusal framed as pre-handler.
const PRE_FIX =
  "A query parameter this route does not support, or one repeated. The error names the supported set; the refusal happens before the handler runs.";

test("every guarded GET's 400 names the value-level cause and scopes the pre-handler claim", async () => {
  const d = await doc();
  const guarded = guardedGets();
  let checked = 0;
  for (const path of guarded) {
    const body = d.paths[path]?.get?.responses["400"];
    assert.ok(body, `GET ${path} declares no 400`);
    const desc = (body.description ?? "").trim();
    // The text actually moved away from the pre-fix string.
    assert.notEqual(desc, PRE_FIX, `GET ${path} 400 is still the pre-fix text`);
    // Both name-level causes remain named (the guard's two).
    assert.match(desc, /does not support/i, `GET ${path} 400 dropped the unsupported-parameter cause`);
    assert.match(desc, /repeat/i, `GET ${path} 400 dropped the repeated-parameter cause`);
    // A supported parameter's unreadable value is the same 400, now named.
    assert.match(desc, /value/i, `GET ${path} 400 does not name the value-level cause a client gets`);
    assert.match(desc, /cannot be read|unreadable|handler/i, `GET ${path} 400 does not tie the value-level refusal to the handler`);
    checked++;
  }
  assert.ok(checked >= 30, `only ${checked} guarded GETs checked; the table or mapping drifted`);
});

test("the live router answers the value-level 400 on the guarded GETs that take a supported parameter", async () => {
  const { env } = sqliteTestEnv(schema);
  // Keyless routes. Their value-level 400 fires while the handler reads the
  // parameter, before any board read, so it holds on an empty board.
  const cases: Array<{ url: string; re: RegExp }> = [
    { url: "/api/new?limit=abc", re: /limit/ },
    { url: "/api/new?limit=0", re: /limit/ },
    { url: "/api/new?limit=-1", re: /limit/ },
    { url: "/api/new?before=bogus", re: /before/ },
    { url: "/api/front?limit=abc", re: /limit/ },
    { url: "/api/payload-notices?limit=abc", re: /limit/ },
    { url: "/api/post/1?limit=abc", re: /limit/ },
    { url: "/api/post/1?since=bogus", re: /since/ },
  ];
  let probed = 0;
  for (const c of cases) {
    const res = await worker.fetch(new Request(`${ORIGIN}${c.url}`), env);
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    assert.equal(res.status, 400, `${c.url} answered ${res.status}: ${String(body.error ?? "").slice(0, 120)}`);
    assert.match(String(body.error ?? ""), c.re, `${c.url} value-level 400 does not name the parameter`);
    probed++;
  }
  assert.equal(probed, cases.length, "probe count drifted");
});

test("an over-max limit is clamped to the disclosed cap, not refused", async () => {
  const { env } = sqliteTestEnv(schema);
  const res = await worker.fetch(new Request(`${ORIGIN}/api/new?limit=1000`), env);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(res.status, 200, `over-max limit should clamp, not error: ${String(body.error ?? "").slice(0, 120)}`);
  assert.equal(body.limit, 100, `over-max limit clamped to FEED_MAX (100), got ${String(body.limit)}`);
});
