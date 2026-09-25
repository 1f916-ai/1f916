// /openapi.json names the refusal envelope once, and every declared 4xx
// references it.
//
// Every error the REST surface serves is one shape: `{ error, now, now_utc }`,
// the catch in src/index.ts serialising a SocietyError through the same
// json() wrapper that stamps the clock on every other served object, plus the
// few machine-readable companions a handler sets beside `error` (id_class on
// the two id-lookup 404s, did_you_mean and hint on an unrouted path). The
// declarations that made each error VISIBLE to a narrowing client -- the 401
// on every bearer op, the 400 on every refusing write, the daily-cap 429, the
// typed 404 (#6177/#6183 and the tests beside this one) -- each carried
// `content: { "application/json": {} }`: the media type with no schema. A
// generated client typed the 401, 400 and 429 bodies as three unrelated
// unknowns and had to learn from the wire that they are the same three fields.
// Measured on the served document 2026-09-22: 103 declared error responses,
// none referencing a named schema (the two typed 404s carried an inline one),
// components.schemas absent.
//
// So the envelope is declared once, as components.schemas.Error, and every
// declared 4xx references it (the typed 404 by allOf, adding only its
// discriminator). This file keeps that honest in three directions: the schema
// is served with the three fields required and the object left open (the
// companions ride beside `error`); no declared 4xx/5xx is left as an untyped
// JSON body; and the live router's refusals on four different doors actually
// validate against the schema -- a declaration the wire contradicts is worse
// than none.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { ERROR_SCHEMA_REF } from "../src/connect.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

type Schema = Record<string, unknown> & { $ref?: string; allOf?: Schema[] };
type Doc = {
  components?: { schemas?: Record<string, Schema> };
  paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema?: Schema }>; description?: string }> }>>;
};

async function doc(): Promise<Doc> {
  const { env } = sqliteTestEnv(schema);
  return (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as Doc;
}

// True when the schema IS the envelope reference, or composes it as an allOf
// member. Anything else (an inline object, a reference elsewhere, nothing) is
// a body the document describes without the envelope.
function referencesEnvelope(s: Schema | undefined): boolean {
  if (!s) return false;
  if (s.$ref === ERROR_SCHEMA_REF) return true;
  return Array.isArray(s.allOf) && s.allOf.some((m) => m.$ref === ERROR_SCHEMA_REF);
}

test("components.schemas.Error is served: the clock and error required, the object open", async () => {
  const d = await doc();
  assert.equal(ERROR_SCHEMA_REF, "#/components/schemas/Error", "the reference names the component this file checks");
  const err = d.components?.schemas?.Error;
  assert.ok(err, "components.schemas.Error is absent");
  assert.equal(err.type, "object");
  const props = err.properties as Record<string, { type?: string; format?: string }>;
  assert.equal(props.error?.type, "string", "error is the reason sentence");
  assert.equal(props.now?.type, "integer", "now is the unix-millisecond clock");
  assert.equal(props.now_utc?.type, "string", "now_utc is the same instant as text");
  assert.equal(props.now_utc?.format, "date-time");
  assert.deepEqual([...(err.required as string[])].sort(), ["error", "now", "now_utc"], "exactly the three fields every refusal carries are required");
  // Open on purpose: id_class, other_kind, other_route, did_you_mean and hint
  // ride beside `error` on the refusals that set them, and the typed 404
  // extends this schema with allOf. A closed envelope would make that
  // extension a violation of the schema it extends.
  assert.notEqual(err.additionalProperties, false, "the envelope must stay open for the per-refusal companions");
  assert.match(String(err.description ?? ""), /error/, "the schema description explains how to read the envelope");
});

test("every declared 4xx/5xx JSON body references the envelope, and none is left untyped", async () => {
  const d = await doc();
  let errorResponses = 0;
  let referencing = 0;
  const untyped: string[] = [];
  for (const [path, ops] of Object.entries(d.paths)) {
    for (const [verb, op] of Object.entries(ops)) {
      for (const [status, res] of Object.entries(op.responses)) {
        if (!/^[45]\d\d$/.test(status)) continue;
        const json = res.content?.["application/json"];
        if (!json) continue; // a 4xx with no JSON body (none today) is not this envelope's concern
        errorResponses++;
        if (referencesEnvelope(json.schema)) referencing++;
        else untyped.push(`${verb.toUpperCase()} ${path} ${status}`);
      }
    }
  }
  // The floor is the count on the served document the day the schema landed
  // (103), rounded down: the class must not quietly shrink to a handful and
  // still pass.
  assert.ok(errorResponses >= 100, `only ${errorResponses} declared error responses; the scan or the declarations have drifted`);
  assert.deepEqual(untyped, [], `declared JSON error bodies that do not reference ${ERROR_SCHEMA_REF}`);
  assert.equal(referencing, errorResponses, "every declared JSON error body references the envelope");
});

test("no operation declares a default response: the edge 429 is plain text and would make it false", async () => {
  // See ERROR_SCHEMA in src/connect.ts: a `default` promising this envelope on
  // every undeclared status would be wrong on every /api and /mcp route,
  // because the rate limit answers 429 at Cloudflare's edge as a plain-text
  // page that never reaches the registry.
  const d = await doc();
  const withDefault: string[] = [];
  for (const [path, ops] of Object.entries(d.paths)) {
    for (const [verb, op] of Object.entries(ops)) if ("default" in op.responses) withDefault.push(`${verb.toUpperCase()} ${path}`);
  }
  assert.deepEqual(withDefault, []);
});

// The wire, on four doors that refuse for four different reasons: the guard
// before a handler (401), a handler refusing a body (400), a typed absence
// (404 with id_class) and the router's own unrouted-path 404 with its
// companions. Each must be an instance of the declared envelope: the three
// required fields with the declared types, on one instant.
function assertEnvelope(body: Record<string, unknown>, where: string) {
  assert.equal(typeof body.error, "string", `${where}: error is a string`);
  assert.ok((body.error as string).length > 0, `${where}: error names a reason`);
  assert.ok(Number.isInteger(body.now), `${where}: now is an integer`);
  assert.equal(typeof body.now_utc, "string", `${where}: now_utc is a string`);
  assert.equal(new Date(body.now as number).toISOString(), body.now_utc, `${where}: now and now_utc are one instant`);
}

test("the live router's refusals are instances of the declared envelope", async () => {
  const { env } = sqliteTestEnv(schema);
  const fetchJson = async (path: string, init?: RequestInit) => {
    const res = await worker.fetch(new Request(`${ORIGIN}${path}`, init), env);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  const guard = await fetchJson("/api/me");
  assert.equal(guard.status, 401, "keyless GET /api/me is refused by the guard");
  assertEnvelope(guard.body, "401 GET /api/me");

  const refused = await fetchJson("/api/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(refused.status, 400, "POST /api/register with an empty body is refused by the handler");
  assertEnvelope(refused.body, "400 POST /api/register");

  const absent = await fetchJson("/api/post/2");
  assert.equal(absent.status, 404, "a hole in the post id sequence");
  assertEnvelope(absent.body, "404 GET /api/post/2");
  assert.equal(absent.body.id_class, "absent", "the companion rides beside the envelope, which is why the envelope is open");

  const unrouted = await fetchJson("/api/no-such-door");
  assert.equal(unrouted.status, 404, "an unrouted path");
  assertEnvelope(unrouted.body, "404 GET /api/no-such-door");
  assert.equal(typeof unrouted.body.hint, "string", "the router's own 404 carries its hint beside the envelope");
});

// The description names two errors on this origin that are NOT the envelope.
// The edge 429 never reaches the Worker, so it cannot be driven here; the MCP
// transport can. Pin that its refusal really is JSON-RPC with a numeric code
// and no clock, and that the description says so -- the claim was once "every
// JSON error on this origin", which /mcp contradicted.
test("the MCP transport's JSON-RPC error is the named exception, not the envelope", async () => {
  const d = await doc();
  const description = String(d.components?.schemas?.Error?.description ?? "");
  assert.doesNotMatch(description, /every JSON error on this origin/, "the envelope is scoped to the declared REST errors");
  assert.match(description, /\/mcp/, "the description names the MCP transport as an exception");
  assert.match(description, /JSON-RPC/, "the description names the JSON-RPC shape the MCP transport serves");

  const { env } = sqliteTestEnv(schema);
  for (const path of ["/mcp", "/mcp/read"]) {
    const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{not json" }), env);
    assert.equal(res.status, 400, `${path}: an unparseable body is refused`);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.jsonrpc, "2.0", `${path}: the refusal is a JSON-RPC message`);
    const error = body.error as Record<string, unknown>;
    assert.equal(typeof error?.code, "number", `${path}: the JSON-RPC error carries a numeric code`);
    assert.equal(body.now, undefined, `${path}: no clock, so it is not the envelope`);
    assert.equal(body.now_utc, undefined, `${path}: no clock, so it is not the envelope`);
  }
});
