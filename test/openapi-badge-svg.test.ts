// The badge route serves SVG for both known and unknown handles. A generated
// client must not treat its 200 response as JSON, and the document must name
// the visible unknown-handle outcome clients can actually observe.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

type BadgeHeader = { description?: string; schema?: Record<string, unknown> };
type BadgeResponse = {
  description: string;
  content?: Record<string, { schema?: { $ref?: string } }>;
  headers?: Record<string, BadgeHeader>;
};
type BadgeOperation = {
  summary: string;
  description: string;
  parameters?: Array<{ name: string; schema: Record<string, unknown> }>;
  responses: Record<string, BadgeResponse>;
};
type OpenApiDocument = { paths: Record<string, { get?: BadgeOperation }> };

test("the OpenAPI badge response is SVG and documents the unknown badge", async () => {
  const { env } = sqliteTestEnv(schema);
  const response = await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env);
  assert.equal(response.status, 200);
  const doc = (await response.json()) as OpenApiDocument;
  const badge = doc.paths["/badge/{handle}.svg"]?.get;
  assert.ok(badge, "the badge route is in OpenAPI");
  assert.deepEqual(Object.keys(badge.responses).sort(), ["200", "304", "404"]);
  assert.deepEqual(Object.keys(badge.responses["200"].content ?? {}), ["image/svg+xml"]);
  const notModified = badge.responses["304"];
  assert.ok(notModified, "a matching If-None-Match has an explicit response");
  assert.equal(notModified.content, undefined, "a conditional response has no body");
  assert.match(notModified.description, /If-None-Match.*no body/i);
  assert.equal(badge.responses["200"].description, "SVG image, not JSON. No now/now_utc clock fields.");
  assert.deepEqual(badge.parameters?.find((p) => p.name === "handle")?.schema, {
    type: "string",
    minLength: 2,
    maxLength: 32,
    pattern: "^[A-Za-z0-9_-]{2,32}$",
  });
  const headers = badge.responses["200"].headers ?? {};
  assert.deepEqual(headers["X-Handle-Status"]?.schema, { type: "string", enum: ["known", "unknown"] });
  assert.match(headers["X-Handle-Status"]?.description ?? "", /does not report key state/i);
  // WQ-712: the finer key state that sets Cache-Control is now a readable header,
  // and the route carries a validator (ETag) it never had.
  assert.deepEqual(headers["X-Badge-State"]?.schema, { type: "string", enum: ["bound", "revoked", "none", "unknown"] });
  assert.ok(headers["ETag"], "the badge 200 declares an ETag");
  assert.deepEqual(headers["Access-Control-Expose-Headers"]?.schema, { type: "string", const: "ETag, X-Handle-Status, X-Badge-State" });
  assert.match(headers["Cache-Control"]?.description ?? "", /max-age=60.*max-age=3600/i);
  const unchangedHeaders = notModified.headers ?? {};
  assert.ok(unchangedHeaders["ETag"], "the badge 304 declares its validator");
  assert.deepEqual(unchangedHeaders["X-Badge-State"]?.schema, headers["X-Badge-State"]?.schema);
  assert.deepEqual(unchangedHeaders["X-Handle-Status"]?.schema, headers["X-Handle-Status"]?.schema);
  assert.deepEqual(unchangedHeaders["Access-Control-Expose-Headers"]?.schema, headers["Access-Control-Expose-Headers"]?.schema);
  assert.match(unchangedHeaders["Cache-Control"]?.description ?? "", /max-age=60.*max-age=3600/i);
  assert.deepEqual(badge.responses["404"].content["application/json"]?.schema, { $ref: "#/components/schemas/Error" });
  assert.match(badge.responses["404"].description, /handle.*grammar/i);
  // summary is the surface text truncated to OPENAPI_SUMMARY_CAP at a word
  // boundary; the full text (with the new X-Handle-Status / cache facts) is the
  // description, which the regex below still matches.
  assert.equal(badge.summary, "README badge linked to the dossier; returns image/svg+xml. Unknown handles return a grey SVG labeled unknown and carry…");
  assert.match(badge.description, /unknown handles return a grey SVG labeled unknown/i);
  assert.match(badge.description, /X-Handle-Status: unknown/);
  assert.match(badge.description, /no active key yet.*cached only 60s/i);
});

test("a malformed badge handle is a router 404 with the declared JSON error envelope", async () => {
  const { env } = sqliteTestEnv(schema);
  const response = await worker.fetch(new Request(`${ORIGIN}/badge/a.svg`), env);
  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json(?:;|$)/);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(typeof body.error, "string");
  assert.equal(typeof body.now, "number");
  assert.equal(typeof body.now_utc, "string");
  assert.ok("did_you_mean" in body && "hint" in body, "router-level path misses may carry suggestions and a route hint");
});

test("an unknown badge is a 200 SVG whose visible value is unknown, marked X-Handle-Status unknown and cached only briefly", async () => {
  const { env } = sqliteTestEnv(schema);
  const response = await worker.fetch(new Request(`${ORIGIN}/badge/no-such-name.svg`), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^image\/svg\+xml(?:;|$)/);
  assert.match(await response.text(), />unknown</);
  // WQ-686: the absent case is discriminable without parsing the image, and its
  // short cache lets a freshly-registered handle's badge heal within a minute.
  assert.equal(response.headers.get("x-handle-status"), "unknown");
  assert.equal(response.headers.get("cache-control"), "public, max-age=60");
  assert.match(response.headers.get("access-control-expose-headers") ?? "", /X-Handle-Status/i);
});

test("a bound-key citizen's badge carries X-Handle-Status known and the 1h cache (the settled case)", async () => {
  const { env, db } = sqliteTestEnv(schema);
  db.exec("INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (1, 'real-one', 'm', 'h', 0, 1756684800000, 0)");
  db.exec("INSERT INTO keys (citizen_id, public_key, thumbprint, custody, status, bound_at) VALUES (1, 'pk', 'tp-bound', 'undeclared', 'active', 1756684800000)");
  const response = await worker.fetch(new Request(`${ORIGIN}/badge/real-one.svg`), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-handle-status"), "known");
  assert.equal(response.headers.get("cache-control"), "public, max-age=3600");
});

test("a known-but-keyless citizen's badge is known yet cached only 60s, so it heals fast after a key bind (WQ-687)", async () => {
  const { env, db } = sqliteTestEnv(schema);
  db.exec("INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (1, 'keyless-one', 'm', 'h', 0, 1756684800000, 0)");
  const response = await worker.fetch(new Request(`${ORIGIN}/badge/keyless-one.svg`), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-handle-status"), "known", "the citizen exists, so the handle is known");
  assert.match(await response.text(), /no key/, "its caption is the keyless one that a bind will change");
  assert.equal(response.headers.get("cache-control"), "public, max-age=60", "a keyless badge heals fast like the unknown case, not after an hour");
});

test("a revoked-key citizen's badge is also cached only 60s (no active key, a re-bind will change it)", async () => {
  const { env, db } = sqliteTestEnv(schema);
  db.exec("INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (1, 'revoked-one', 'm', 'h', 0, 1756684800000, 0)");
  db.exec("INSERT INTO keys (citizen_id, public_key, thumbprint, custody, status, bound_at, ended_at) VALUES (1, 'pk', 'tp-revoked', 'undeclared', 'revoked', 1756684800000, 1756684900000)");
  const response = await worker.fetch(new Request(`${ORIGIN}/badge/revoked-one.svg`), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-handle-status"), "known");
  assert.equal(response.headers.get("cache-control"), "public, max-age=60", "no active key is an unsettled caption too");
});
