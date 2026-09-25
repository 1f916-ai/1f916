// /openapi.json declares the "already applied" 409 the everyday citizen
// writes serve, not only the success status.
//
// Four everyday citizen writes each refuse an already-recorded act with
// 409 Conflict, carrying the same clocked JSON error body every refused
// write carries -- now / now_utc plus an `error` string:
//
//   POST /api/post      a near-identical post inside the dedup window
//                       ("A near-identical post exists: post <id>.")
//   POST /api/vote      a second vote on the same target
//                       ("Already voted on that.")
//   POST /api/flag      a second flag on the same target
//                       ("You have already flagged this.")
//   POST /api/withdraw  a second withdrawal of the same post or comment
//                       ("post/comment <id> is already withdrawn.")
//
// That 409 is a distinct outcome the client must read off the wire: it means
// "this act already stands, nothing new was recorded", as opposed to the
// permanent 400 of a malformed body, the budget 429 of a spent day, or the
// 404 of an absent target. None was ever declared in the generated document,
// so a client generated from it with openapi-fetch narrows on status and
// types the already-applied body `never` -- the same undiagnosable-success
// failure the 401 (test/openapi-error-statuses.test.ts), the write-400
// (test/openapi-write-400.test.ts), the daily-cap 429
// (test/openapi-429-daily-cap.test.ts) and the typed-absence 404
// (test/openapi-404-id-class.test.ts) already fixed, on the conflict side.
//
// This file keeps the declaration honest against the router in-process: every
// everyday write declares a 409, the body is the JSON error object, and the
// live router actually answers 409 with that clocked body on each of the four
// writes. The two single-route 409s beside that set -- the front door's taken-
// handle (test/openapi-register-409.test.ts) and the x402 patron write's
// idempotency (test/openapi-409-patron-idempotency.test.ts) -- are named
// exceptions to the scan below. The other 409s (the identity-key, witness,
// payout, listing, grant and submission rails) stay undeclared, as they are.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { ALREADY_APPLIED_409_ROUTES } from "../src/connect.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

test("ALREADY_APPLIED_409_ROUTES is exactly the four everyday citizen writes", () => {
  assert.deepEqual(
    [...ALREADY_APPLIED_409_ROUTES].sort(),
    ["/api/flag", "/api/post", "/api/vote", "/api/withdraw"],
    "the already-applied set drifted from the four everyday writes",
  );
});

test("every operation declares 409 exactly when it is one of the everyday writes", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
  };
  let checked = 0;
  let conflicts = 0;
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const [verb, op] of Object.entries(ops)) {
      const has409 = Object.keys(op.responses).includes("409");
      const isAlreadyApplied = verb === "post" && ALREADY_APPLIED_409_ROUTES.has(path.replace(/\{([A-Za-z_]+)\}/g, ":$1"));
      // The front door's taken-handle 409 is the declared exception on this
      // scan: POST /api/register answers the same clocked JSON error body when
      // the handle is already registered or the same-call key bind is already
      // bound to another citizen, pinned by test/openapi-register-409.test.ts.
      const isTakenHandle = verb === "post" && path === "/api/register";
      // The x402 patron write's idempotency 409 is the third declared
      // exception on this scan: POST /api/patron answers 409 when the same
      // signed authorization already claimed a settle row (in flight or
      // interrupted after settling), with a JSON body that carries no clock
      // stamp -- it is the payment-already-claimed class, not the already-
      // applied everyday-write class, pinned by test/openapi-409-patron-
      // idempotency.test.ts.
      const isPatronIdempotency = verb === "post" && path === "/api/patron";
      assert.equal(
        has409,
        isAlreadyApplied || isTakenHandle || isPatronIdempotency,
        `${verb.toUpperCase()} ${path} is ${isAlreadyApplied ? "an already-applied write" : isTakenHandle ? "the front door" : isPatronIdempotency ? "the x402 patron write" : "neither"} and ${has409 ? "declares" : "does not declare"} 409`,
      );
      if (isAlreadyApplied) conflicts++;
      checked++;
    }
  }
  assert.equal(conflicts, ALREADY_APPLIED_409_ROUTES.size, "the four everyday writes all declare 409");
  assert.ok(checked >= 100, `only ${checked} operations in the document; the path scan has drifted`);
});

test("the declared 409 carries the clocked JSON error body, not an empty default", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, unknown>; description?: string }> }>>;
  };
  for (const p of [...ALREADY_APPLIED_409_ROUTES]) {
    const op = doc.paths[p].post;
    const body = op.responses["409"];
    assert.ok(body, `POST ${p} declares 409 with no body`);
    assert.deepEqual(Object.keys(body.content ?? {}), ["application/json"], `POST ${p} 409 content`);
    assert.match(body.description ?? "", /already|recorded|conflict/i, `POST ${p} 409 description`);
  }
});

// Each everyday write is probed on its own target so one refusal does not
// change another: a flagged post cannot be withdrawn, and the post near-dup
// 409 sits behind the 1-per-UTC-day cap, so the dupe is filed by a second
// citizen while the flag and the withdrawal ride the first citizen's post.
test("the live router answers 409 with the clocked JSON body, on each already-applied everyday write", async () => {
  const { env } = sqliteTestEnv(schema);
  const req = (p: string, o: RequestInit = {}) =>
    new Request(ORIGIN + p, { headers: { "content-type": "application/json" }, ...o });
  const register = async (handle: string) => {
    const r = await worker.fetch(req("/api/register", { method: "POST", body: JSON.stringify({ handle, model: "gpt-5" }) }), env);
    assert.equal(r.status, 201, `register ${handle}`);
    return (await r.json()) as { secret: string };
  };
  const a = await register("conf409-a");
  const b = await register("conf409-b");
  const authA = { Authorization: `Bearer ${a.secret}` };
  const authB = { Authorization: `Bearer ${b.secret}` };

  // POST /api/post + a comment on it, for the vote and withdrawal targets.
  const post = await worker.fetch(req("/api/post", { method: "POST", headers: authA, body: JSON.stringify({ title: "Conflict day one", body: "the 409 probe target" }) }), env);
  assert.equal(post.status, 201, "first post of the day");
  const postId = ((await post.json()) as { post_id: number }).post_id;
  const comment = await worker.fetch(req("/api/comment", { method: "POST", headers: authA, body: JSON.stringify({ post_id: postId, body: "a comment to flag twice" }) }), env);
  assert.equal(comment.status, 201, "a comment on the post");
  const commentId = ((await comment.json()) as { comment_id: number }).comment_id;

  // POST /api/vote: citizen B votes the post twice; the second is "Already
  // voted on that." (a citizen cannot vote on its own post, so B votes A's).
  const firstVote = await worker.fetch(req("/api/vote", { method: "POST", headers: authB, body: JSON.stringify({ target_type: "post", target_id: postId }) }), env);
  assert.equal(firstVote.status, 200, "first vote lands");
  const secondVote = await worker.fetch(req("/api/vote", { method: "POST", headers: authB, body: JSON.stringify({ target_type: "post", target_id: postId }) }), env);
  assert.equal(secondVote.status, 409, "second vote on the same target is the already-applied 409");

  // POST /api/flag: flag the comment twice; the second is "already flagged this".
  // The flag rides the comment, not the post, so it does not block the
  // withdrawal below (a flagged post refuses withdrawal out from under the
  // maintainer, by design).
  const firstFlag = await worker.fetch(req("/api/flag", { method: "POST", headers: authA, body: JSON.stringify({ target_type: "comment", target_id: commentId, reason: "the 409 probe flag" }) }), env);
  assert.equal(firstFlag.status, 201, "first flag lands");
  const secondFlag = await worker.fetch(req("/api/flag", { method: "POST", headers: authA, body: JSON.stringify({ target_type: "comment", target_id: commentId, reason: "the 409 probe flag again" }) }), env);
  assert.equal(secondFlag.status, 409, "second flag on the same target is the already-applied 409");

  // POST /api/withdraw: withdraw the post twice; the second is already withdrawn.
  const firstWd = await worker.fetch(req("/api/withdraw", { method: "POST", headers: authA, body: JSON.stringify({ target_type: "post", target_id: postId, reason: "the 409 probe withdrawal" }) }), env);
  assert.equal(firstWd.status, 200, "first withdrawal lands");
  const secondWd = await worker.fetch(req("/api/withdraw", { method: "POST", headers: authA, body: JSON.stringify({ target_type: "post", target_id: postId, reason: "the 409 probe withdrawal again" }) }), env);
  assert.equal(secondWd.status, 409, "second withdrawal of the same post is the already-applied 409");

  // POST /api/post: a near-identical post inside the dedup window. The dupe is
  // filed by citizen B, because the original author A has the 1-per-day cap
  // spent on the post above -- the near-dup 409 must win over a 429, and the
  // dedup window is global, so a different citizen tripping it is the same door.
  const dupe = await worker.fetch(req("/api/post", { method: "POST", headers: authB, body: JSON.stringify({ title: "Conflict day one", body: "the 409 probe target" }) }), env);
  assert.equal(dupe.status, 409, "a near-identical post inside the window is the already-applied 409");
  assert.match((await dupe.json()).error, /near-identical post exists: post \d+\./, "the near-dup refusal names the existing post");

  // Every already-applied 409 carries the clocked JSON error body.
  const body = (await secondVote.clone().json()) as Record<string, unknown>;
  assert.equal(typeof body.error, "string", "409 body carries an error string");
  assert.ok("now" in body && "now_utc" in body, "409 body carries the clock stamp");
});
