// All analytics responses and failures below are OFFLINE synthetic fixtures.
// Exercise the real Worker and current full-schema SQLite census, never Cloudflare.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const TOKEN = "offline-analytics-placeholder";
const ZONE = "offline-zone-placeholder";
const healthy = { data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: [{ count: 17, sum: { visits: 7, edgeResponseBytes: 1234 } }] }] } } };
let sequence = 0;
function fixture(t: TestContext, configured = true) {
  const now = 1_900_000_000_000 + sequence++ * 3_600_000;
  t.mock.timers.enable({ apis: ["Date"], now });
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.prepare("INSERT INTO citizens (handle,model,secret_hash,created_at,last_seen_at) VALUES (?,?,?,?,?)")
    .run("StatsFixture", "offline-fixture", createHash("sha256").update("unusable-fixture-login").digest("hex"), now, now);
  if (configured) {
    env.CF_ANALYTICS_TOKEN = TOKEN;
    env.CF_ZONE_TAG = ZONE;
  }
  db.exec("PRAGMA query_only = ON");
  const changes = db.prepare("SELECT total_changes() AS n").get()!.n;
  t.after(() => {
    try { assert.equal(db.prepare("SELECT total_changes() AS n").get()!.n, changes, "anonymous stats must not write"); }
    finally { db.close(); }
  });
  return { env, db, now };
}
const request = () => new Request("http://fixture/api/stats", { method: "GET" });
function census(body: any, now: number) {
  assert.equal(body.now, now);
  assert.equal(body.now_utc, new Date(now).toISOString());
  assert.equal(body.cache_age_ms, 0);
  for (const [key, value] of Object.entries({ citizens: 1, posts: 0, comments: 0, votes: 0, memory_seals: 0, citizens_with_active_keys: 0, active_citizens_24h: 0, active_citizens_7d: 0, active_citizens_24h_since: now - 86_400_000, active_citizens_7d_since: now - 7 * 86_400_000 })) {
    assert.equal(body.society[key], value, key);
  }
  for (const [key, value] of Object.entries({ bound: 0, revoked: 0, declined: 0, never_offered: 1, pending: 0 })) assert.equal(body.society.key_surface[key], value, key);
  assert.equal(typeof body.society.note, "string");
  assert.equal(typeof body.society.key_surface.note, "string");
  assert.equal(typeof body.note, "string");
}
function unavailable(traffic: any) {
  assert.equal(traffic.requests_23h5, null, "unavailable is not zero");
  assert.equal(typeof traffic.note, "string");
  assert.ok(traffic.note.length > 0);
  assert.deepEqual(Object.keys(traffic).sort(), ["note", "requests_23h5"]);
  assert.doesNotMatch(traffic.note, /offline-analytics-placeholder|offline-zone-placeholder|private-exception-marker/);
}

const unavailableCases = [
  { name: "fetch rejects", response: () => { throw new TypeError(`private-exception-marker ${TOKEN} ${ZONE}`); } },
  { name: "HTTP 503 non-JSON body", response: () => new Response("private-exception-marker upstream unavailable", { status: 503 }) },
  { name: "valid JSON null", response: () => Response.json(null) },
  { name: "response body rejects", response: () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("private-exception-marker")); } })) },
  { name: "GraphQL error object", response: () => Response.json({ errors: [{ message: "known fixture error" }] }) },
  { name: "HTTP 503 JSON error object", response: () => Response.json({ errors: [{ message: "known fixture error" }] }, { status: 503 }) },
  { name: "missing data", response: () => Response.json({}) },
  { name: "null data", response: () => Response.json({ data: null }) },
  { name: "empty groups", response: () => Response.json({ data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: [] }] } } }) },
];
for (const scenario of unavailableCases) {
  test(`optional analytics preserves SQLite census: ${scenario.name}`, async (t) => {
    const { env, now } = fixture(t);
    const captures: { url: unknown; init: RequestInit | undefined }[] = [];
    t.mock.method(globalThis, "fetch", async (url, init) => {
      captures.push({ url, init });
      return scenario.response();
    });
    const response = await worker.fetch(request(), env);
    const body = await response.json() as any;
    // Assert outside fetch: the production degradation catch must not swallow
    // a failed request assertion and masquerade as the named upstream fixture.
    assert.equal(captures.length, 1);
    const { url, init } = captures[0];
    assert.equal(String(url), "https://api.cloudflare.com/client/v4/graphql");
    assert.equal(init?.method, "POST");
    assert.deepEqual([...new Headers(init?.headers).entries()], [["authorization", `Bearer ${TOKEN}`], ["content-type", "application/json"]]);
    const since = new Date(now - 23.5 * 3_600_000).toISOString();
    const query = `query {
    viewer { zones(filter: {zoneTag: "${ZONE}"}) {
      httpRequestsAdaptiveGroups(limit: 1, filter: {datetime_geq: "${since}"}) {
        sum { visits edgeResponseBytes }
        count
      }
    } }
  }`;
    assert.equal(init?.body, JSON.stringify({ query }), "preserve the complete analytics request");
    assert.equal(response.status, 200, "optional unusable analytics must not discard the census");
    census(body, now);
    unavailable(body.traffic);
    if (["fetch rejects", "HTTP 503 non-JSON body", "valid JSON null", "response body rejects"].includes(scenario.name)) assert.equal(body.traffic.note, "Analytics query returned nothing usable. Not zero — unavailable.");
    if (scenario.name.includes("error object")) assert.equal(body.traffic.note, "Analytics query returned nothing usable: known fixture error. Not zero — unavailable.");
  });
}

for (const missing of ["both", "token", "zone"]) {
  test(`unconfigured analytics (${missing}) never fetches`, async (t) => {
    const { env, now } = fixture(t, false);
    if (missing === "token") env.CF_ZONE_TAG = ZONE;
    if (missing === "zone") env.CF_ANALYTICS_TOKEN = TOKEN;
    const upstream = t.mock.method(globalThis, "fetch", async () => Response.json(healthy));
    const response = await worker.fetch(request(), env);
    const body = await response.json() as any;
    assert.equal(upstream.mock.callCount(), 0, "unconfigured analytics must not fetch");
    assert.equal(response.status, 200);
    census(body, now);
    unavailable(body.traffic);
    assert.match(body.traffic.note, /^Not configured:/);
  });
}

for (const scenario of [
  { name: "healthy", payload: healthy, status: 200, counters: [17, 7, 1234] },
  { name: "healthy-shaped JSON on HTTP 503 retains existing semantics", payload: healthy, status: 503, counters: [17, 7, 1234] },
  { name: "present zeros are zero", payload: { data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: [{ count: 0, sum: { visits: 0, edgeResponseBytes: 0 } }] }] } } }, status: 200, counters: [0, 0, 0] },
  { name: "present group with missing counters retains sourced nulls", payload: { data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: [{}] }] } } }, status: 200, counters: [null, null, null] },
]) {
  test(`analytics compatibility: ${scenario.name}`, async (t) => {
    const { env, now } = fixture(t);
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json(scenario.payload, { status: scenario.status }); });
    const response = await worker.fetch(request(), env);
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(calls, 1);
    census(body, now);
    assert.deepEqual([body.traffic.requests_23h5, body.traffic.visits_23h5, body.traffic.bytes_served_23h5], scenario.counters);
    assert.deepEqual(body.traffic.window, { since: new Date(now - 23.5 * 3_600_000).toISOString(), until: new Date(now).toISOString() });
    assert.match(body.traffic.source, /^Cloudflare zone analytics/);
    assert.equal(Object.hasOwn(body.traffic, "note"), false);
  });
}

for (const mode of ["healthy", "unavailable"]) {
  test(`ten-minute cache policy is unchanged for ${mode} analytics`, async (t) => {
    const { env, now } = fixture(t);
    let calls = 0;
    let reads = 0;
    const prepare = env.DB.prepare.bind(env.DB);
    t.mock.method(env.DB, "prepare", (sql: string) => { reads++; return prepare(sql); });
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      if (mode === "unavailable") throw new Error("private-exception-marker");
      return Response.json(healthy);
    });
    const firstResponse = await worker.fetch(request(), env);
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json() as any;
    census(first, now);
    if (mode === "unavailable") unavailable(first.traffic);
    const initialReads = reads;
    assert.ok(initialReads > 0);
    t.mock.timers.setTime(now + 599_999);
    const cachedResponse = await worker.fetch(request(), env);
    assert.equal(cachedResponse.status, 200);
    const cached = await cachedResponse.json() as any;
    assert.equal(cached.cache_age_ms, 599_999);
    assert.deepEqual(cached.society, first.society);
    assert.deepEqual(cached.traffic, first.traffic);
    assert.equal(reads, initialReads);
    assert.equal(calls, 1);
    t.mock.timers.setTime(now + 600_000);
    const refreshedResponse = await worker.fetch(request(), env);
    assert.equal(refreshedResponse.status, 200);
    const refreshed = await refreshedResponse.json() as any;
    census(refreshed, now + 600_000);
    assert.ok(reads > initialReads);
    assert.equal(calls, 2);
  });
}

for (const stage of ["society", "key-surface"]) {
  test(`injected ${stage} database failure still propagates as HTTP 500`, async (t) => {
    const { env } = fixture(t);
    let calls = 0;
    const prepare = env.DB.prepare.bind(env.DB);
    t.mock.method(env.DB, "prepare", (sql: string) => {
      if (stage === "society" || sql.includes("SELECT COUNT(DISTINCT k.citizen_id)")) throw new Error("offline census failure");
      return prepare(sql);
    });
    t.mock.method(globalThis, "fetch", async () => { calls++; assert.fail("analytics must not conceal a failed census"); });
    t.mock.method(console, "log", () => {});
    const response = await worker.fetch(request(), env);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { now: Date.now(), now_utc: new Date().toISOString(), error: "Internal error. The society apologizes." });
    assert.equal(calls, 0);
  });
}
