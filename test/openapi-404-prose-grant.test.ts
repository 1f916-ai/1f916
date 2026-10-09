// /openapi.json declares the clocked-error 404 the prose grants door serves,
// not only the 200 text page and the query 400.
//
// GET /grants/:slug is the human prose door for one grant (produces text/plain,
// negotiated like /porch). When the slug in the path names no grant -- or the
// grant is still a draft, which is invisible to anyone but its sponsor until
// it opens -- readGrant (src/grants.ts) answers through openGrant with
// SocietyError(404, "no grant <slug>"), the same clocked JSON error body every
// other refused read carries: now, now_utc and a single prose `error` string.
// That refusal is answered BEFORE the content negotiation runs, so the client
// receives a JSON 404 whether it asked for HTML or plain text. The JSON twin,
// GET /api/grants/:slug, already declares this 404 (it is in PLAIN_404_ROUTES);
// the prose door declared only the 200 and the query 400. A client following
// the human link cannot tell "the grant is gone (or not open yet)" from
// "the endpoint is missing": openapi-fetch narrows on the declared codes and
// types the miss `never`. This declares the prose door's 404 beside its
// success so the two doors of the same grant carry the same absence contract.
// test/openapi-404-plain-miss.test.ts keeps the JSON side honest.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

type SchemaOpDoc = {
  responses: Record<string, { content?: Record<string, { schema?: Record<string, unknown> }>; description?: string }>;
};
async function docPaths(): Promise<Record<string, Record<string, SchemaOpDoc>>> {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, SchemaOpDoc>>;
  };
  return doc.paths;
}

test("the prose grants door declares the clocked-error 404 beside its 200", async () => {
  const doc = await docPaths();
  const op = doc["/grants/{slug}"]?.get;
  assert.ok(op, "the prose grants door is in the document");
  const codes = Object.keys(op.responses).sort();
  assert.ok(codes.includes("200"), "the prose grants door declares the 200 text page");
  assert.ok(codes.includes("404"), "the prose grants door declares the miss 404");
  // The success stays the text page; the miss is a JSON error body.
  assert.deepEqual(Object.keys(op.responses["200"].content ?? {}), ["text/plain"], "the 200 is the text page");
  const body = op.responses["404"];
  assert.deepEqual(Object.keys(body.content ?? {}), ["application/json"], "the miss 404 body is JSON, not text");
  const s = body.content?.["application/json"]?.schema;
  // The shared refusal envelope by reference, unextended: the clock and
  // `error`, no id_class discriminator beside them.
  assert.deepEqual(s, { $ref: "#/components/schemas/Error" }, "the miss 404 schema is the shared refusal envelope");
  // The JSON twin already declares this same 404; the prose door must match it.
  const twin = doc["/api/grants/{slug}"]?.get?.responses?.["404"];
  assert.ok(twin, "the JSON twin declares the same 404");
});

test("the live router serves the prose-door clocked 404 as JSON, for both content types", async () => {
  const { env } = sqliteTestEnv(schema);
  for (const accept of ["text/html", "text/plain"]) {
    const res = await worker.fetch(new Request(`${ORIGIN}/grants/no-such-slug`, { headers: { Accept: accept } }), env);
    assert.equal(res.status, 404, `GET /grants/no-such-slug (Accept: ${accept}) answers 404 on a miss`);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/, `the miss is a JSON error body, not a ${accept} page`);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok("now" in body && "now_utc" in body, "the 404 carries the clock stamp like every served object");
    assert.match(String(body.error), /no grant no-such-slug/, "the 404 names the absent grant");
  }
});
