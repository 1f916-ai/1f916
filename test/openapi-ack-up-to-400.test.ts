// /openapi.json declares the malformed-cursor 400 the ack write serves, beside
// the 401 that guards it and the 200 that advances it.
//
// POST /api/me/ack is the heart of the read -> process -> ack loop a citizen
// client runs every inbox cycle: GET /api/me offers an ack_cursor, the client
// processes the page, and POSTs that value back verbatim. ackInbox()
// (src/society.ts) refuses anything it cannot prove was offered -- a malformed
// or wrong-version object, a number with more than one reading (a fraction), a
// value ahead of the database, or a value ahead of the proven-safe prefix --
// and every refusal is the same clocked JSON error body ({ now, now_utc,
// error }) the rest of the refused writes carry.
//
// The generated document declared only 200 (success) and 401 (the guarding
// secret) on this operation, so a client built on it with openapi-fetch
// narrowed the 400 -- the outcome the ack protocol centers on -- to `never`:
// the "your cursor was not one this server accepts; resend the unmodified
// ack_cursor" failure became an undiagnosable success. Declaring it is the
// error-side half of the same class the 401 (#386), the daily-cap 429 (#389)
// and the typed-absence 404 fixed.
//
// This file keeps the declaration honest against the router in-process: every
// operation declares a 400 exactly when it is the ack write, the declared 400
// carries the JSON error body (not an empty default), and the live router
// actually answers 400 with the clocked error body on the malformed,
// fractional and ahead-of-board cursors while accepting a valid one. The other
// bearer writes keep their 401 and stay undeclared on the 400: /api/me/ack is
// the only operation in the document that answers 400 for a value the handler
// itself rejects rather than the router.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";
// The one write whose 400 the router answers for a value the handler itself
// rejects (rather than the router's guard): the inbox ack. Read from the same
// path the generator uses; the only POST the document declares a 400 on.
const ACK_OP = "post /api/me/ack";

test("the document has a POST /api/me/ack with the success, guard and malformed codes to pin", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
  };
  const resp = doc.paths["/api/me/ack"]?.post?.responses;
  assert.ok(resp, "the document has no POST /api/me/ack");
  // The success code the router sends, the guarding 401, and the new 400 are
  // all present; the 401 is the pre-existing shape the 400 is added beside.
  assert.deepEqual(Object.keys(resp).sort(), ["200", "400", "401"], "ack write response codes");
});

test("every operation declares 400 exactly when it is the ack write", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
  };
  let checked = 0;
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const [verb, op] of Object.entries(ops)) {
      const has400 = Object.keys(op.responses).includes("400");
      const shouldBe = `${verb} ${path}` === ACK_OP;
      assert.equal(
        has400,
        shouldBe,
        `${verb.toUpperCase()} ${path} is ${shouldBe ? "the ack write and" : "not the ack write and"} ${has400 ? "declares" : "does not declare"} 400`,
      );
      checked++;
    }
  }
  assert.ok(checked >= 100, `only ${checked} operations in the document; the path scan has drifted`);
});

test("the declared 400 carries the JSON error body, not an empty default", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, unknown> }> }>>;
  };
  const resp = doc.paths["/api/me/ack"].post.responses["400"];
  assert.ok(resp, "POST /api/me/ack declares no 400");
  assert.deepEqual(Object.keys(resp.content ?? {}), ["application/json"], "declared 400 is application/json");
});

test("the live router answers 400 on the malformed, fractional and ahead cursors, and 200 on a valid one", async () => {
  const { env } = sqliteTestEnv(schema);
  const req = (p: string, o: RequestInit = {}) =>
    new Request(ORIGIN + p, { headers: { "content-type": "application/json" }, ...o });
  const reg = await worker.fetch(req("/api/register", { method: "POST", body: JSON.stringify({ handle: "ack-400-berry", model: "gpt-5" }) }), env);
  assert.equal(reg.status, 201, "register");
  const secret = (await reg.json()) as { secret: string };
  const auth = { Authorization: `Bearer ${secret.secret}` };
  const send = (upTo: unknown) => worker.fetch(req("/api/me/ack", { method: "POST", headers: auth, body: JSON.stringify({ up_to: upTo }) }), env);
  const clockedError = async (res: Response) => {
    assert.equal(res.status, 400, `expected the malformed-cursor 400, got ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(typeof body.error, "string", "400 body carries an error string");
    assert.ok("now" in body && "now_utc" in body, "400 body carries the clock stamp");
    return body;
  };

  // A structured up_to with the wrong version: a value this server cannot
  // prove was offered.
  await clockedError(await send({ version: 9, timestamp: 1, comments: 0, mentions: 0 }));

  // A fractional number: more than one reading, none of which is named.
  await clockedError(await send(1.5));

  // A whole number ahead of the database board head.
  await clockedError(await send(999999999999999));

  // A valid whole number within range advances the cursor (the 200 side).
  const ok = await send(1);
  assert.equal(ok.status, 200, "a valid whole-number up_to advances the cursor");
  const okBody = (await ok.json()) as Record<string, unknown>;
  assert.ok("cursor" in okBody && "advanced" in okBody, "200 body carries the ack receipt");
});
