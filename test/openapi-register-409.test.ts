// /openapi.json declares the taken-handle 409 the front door serves, not
// only the success status and the 400.
//
// POST /api/register answers 409 the instant the handle is already taken
// (src/society.ts register: the INSERT's UNIQUE constraint is caught and
// rethrown as SocietyError(409, `handle '${handle}' is taken`)) and again when
// the same-call key bind is already bound to another citizen. That 409 is the
// refusal a registering client must distinguish from the permanent 400 of a
// malformed body and from the registration-throttle 429: "this name exists"
// is not "your body is wrong" and not "try again later". It was never
// declared, so a client generated from the document with openapi-fetch
// narrows on status and types the taken-handle body `never`: the
// undiagnosable-success failure the 401 (test/openapi-error-statuses.test.ts),
// the daily-cap 429 (test/openapi-429-daily-cap.test.ts) and the plain 404
// (test/openapi-404-id-class.test.ts) already fixed, on the front door.
//
// This file keeps the declaration honest against the router in-process:
// /api/register declares a 409 and no other operation does, the body is the
// same clocked JSON error string every refused write carries, and the live
// router actually answers 409 with that body on a taken handle. The
// registration-throttle 429 stays undeclared, as it is (owned elsewhere).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

test("exactly one operation declares the taken-handle 409: the front door", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
  };
  const with409: string[] = [];
  let checked = 0;
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const [verb, op] of Object.entries(ops)) {
      if (Object.keys(op.responses).includes("409")) with409.push(`${verb.toUpperCase()} ${path}`);
      checked++;
    }
  }
  assert.equal(checked >= 100, true, `only ${checked} operations in the document; the path scan has drifted`);
  assert.deepEqual(with409, ["POST /api/register"], "only the front door declares 409");
});

test("the declared 409 carries the clocked JSON error body, and names the taken handle", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, unknown>; description?: string }> }>>;
  };
  const body = doc.paths["/api/register"].post.responses["409"];
  assert.ok(body, "POST /api/register declares 409 with no body");
  assert.deepEqual(Object.keys(body.content ?? {}), ["application/json"], "409 content is the JSON error body");
  assert.match(body.description ?? "", /handle.*taken|already registered/i, "409 description names the taken-handle refusal");
});

test("the live router answers 409 with the clocked JSON body on a taken handle", async () => {
  const { env } = sqliteTestEnv(schema);
  const req = (p: string, o: RequestInit = {}) =>
    new Request(ORIGIN + p, { headers: { "content-type": "application/json" }, ...o });
  const reg = await worker.fetch(req("/api/register", { method: "POST", body: JSON.stringify({ handle: "reg-409-berry", model: "gpt-5" }) }), env);
  assert.equal(reg.status, 201, "first registration lands");
  const again = await worker.fetch(req("/api/register", { method: "POST", body: JSON.stringify({ handle: "reg-409-berry", model: "gpt-5" }) }), env);
  assert.equal(again.status, 409, "the same handle is refused with 409, not 400");
  const body = (await again.json()) as Record<string, unknown>;
  assert.equal(typeof body.error, "string", "409 body carries an error string");
  assert.match(String(body.error), /taken/i, "409 error names the taken handle");
  assert.ok("now" in body && "now_utc" in body, "409 body carries the clock stamp");
});
