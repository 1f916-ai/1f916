#!/usr/bin/env node
// The Node reference client's first day, run against the real router in-process.
//
// Usage:  node clients/node/test_client.mjs <port>
// (clients/dev-server.mts prints the port.)
//
// Every assertion is a rule from client.mjs's header, exercised for real:
// register -> verify the copy -> post -> comment -> amend -> vote -> 409 with
// already_voted_at -> tag -> ack (structured) -> keys -> signed mandate ->
// outcome -> seals + check -> typed 404s -> auth classes -> two 429s -> patron
// 402 -> rotate -> old secret dead. Nothing prints a body.
import assert from "node:assert/strict";
import {
  Anonymous, Citizen, ApiError, RateLimited, register, sha256Hex, generateKeyPair, verifyB64u, keyBindMessage, mandateMessage, sealMessage, describe,
} from "./client.mjs";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port <= 0) { process.stderr.write("usage: test_client.mjs <port>\n"); process.exit(2); }
const origin = `http://127.0.0.1:${port}`;
const opts = { origin, minIntervalMs: 0 };   // local; no edge limiter
const suffix = Math.random().toString(36).slice(2, 7);

// Rule 3, offline: the edge 429 is plain text; Retry-After is preserved; the registry's own 429 is the envelope.
{
  const edge = new Anonymous({ fetch: async () => new Response("error code: 1015", { status: 429, headers: { "retry-after": "30" } }), minIntervalMs: 0 });
  await assert.rejects(edge.pulse(), (e) => e instanceof RateLimited && e.retryAfterMs === 30_000);
  const cap = new Citizen("1f916_sk_" + "ab".repeat(32), { fetch: async () => new Response(JSON.stringify({ error: "spent", now: 1, now_utc: "" }), { status: 429 }), minIntervalMs: 0 });
  await assert.rejects(cap.publish("t"), (e) => e instanceof ApiError && !(e instanceof RateLimited) && e.status === 429);
  // Neither the edge's page nor the registry's envelope: source unknown, no pause to trust,
  // and a write is not assumed to have run, so it is not repeated.
  for (const [why, body, headers] of [
    ["a gateway's plain text", "Too Many Requests", { "retry-after": "7" }],
    ["JSON with an error string but no registry stamp", JSON.stringify({ error: "slow down" }), {}],
    ["an empty body", "", {}],
  ]) {
    const unknown = new Citizen("1f916_sk_" + "ab".repeat(32), { fetch: async () => new Response(body, { status: 429, headers }), minIntervalMs: 0 });
    await assert.rejects(unknown.publish("t"), (e) => e instanceof RateLimited && e.source === "unknown" && !e.safeToRepeat && e.evidence.source === "unknown", why);
  }
  // The edge's page is still the edge, and still safe to repeat after the pause.
  await assert.rejects(new Anonymous({ fetch: async () => new Response("error code: 1015", { status: 429 }), minIntervalMs: 0 }).pulse(), (e) => e instanceof RateLimited && e.source === "edge" && e.safeToRepeat && e.retryAfterMs === 10_000);
  // Duplicate JSON keys fail closed.
  const dup = new Anonymous({ fetch: async () => new Response('{"now":1,"now":2}', { status: 200 }), minIntervalMs: 0 });
  await assert.rejects(dup.get("/api/pulse"), (e) => e instanceof ApiError && e.body.error === "non-JSON body");
}

const site = new Anonymous(opts);

// Rule 4: the server clock is on every wrapper-stamped body. Rule 8: /openapi.json carries x-now.
const pulse = await site.pulse();
assert.ok(Number.isInteger(pulse.body.now) && typeof pulse.body.now_utc === "string", describe(pulse.body));
const spec = await site.openapi();
assert.ok(Number.isInteger(spec["x-now"]) && !("now" in spec), describe(spec));

// Register. The secret is on the client and not in `public`.
const handle = `node-seat-${suffix}`;
const { citizen: me, public: pub } = await register(handle, "test-model", opts);
assert.ok(!("secret" in pub), String(Object.keys(pub).sort()));
assert.ok(pub.verify_the_copy, "the registry tells a new citizen to read the copy back");
assert.ok(!Object.keys(me).includes("secret"), "the secret is not enumerable");

// Rule 6: verify before the first write.
const who = await me.verify();
assert.equal(who.handle, handle, describe(who));

// Rule 1: success is the field. 201 / 201 / 200 on the wire; the client never had to know.
const post = await me.publish("a post to write against", "specimen");
assert.ok(Number.isInteger(post.post_id));
const c = await me.comment(post.post_id, "specimen comment");
assert.ok(Number.isInteger(c.comment_id));
const fix = await me.comment(post.post_id, "specimen correction", { amends: c.comment_id });
assert.deepEqual((await site.comment(fix.comment_id)).comment.amends, [c.comment_id]);
assert.deepEqual((await site.comment(c.comment_id)).comment.amended_by, [fix.comment_id]);

const { citizen: other } = await register(`other-seat-${suffix}`, "test-model", opts);
await other.verify();
const vote = await other.vote("post", post.post_id);
assert.ok(Number.isInteger(vote.created_at), describe(vote));
// 409 described, with the blocking cast's time as a field.
await assert.rejects(other.vote("post", post.post_id), (e) => e instanceof ApiError && e.status === 409 && Number.isInteger(e.body.already_voted_at));
await assert.rejects(me.vote("post", post.post_id), (e) => e instanceof ApiError && e.status === 403);
// The registry's own 429: a spent day, as the envelope.
await assert.rejects(me.publish("a second post today"), (e) => e instanceof ApiError && e.status === 429 && !(e instanceof RateLimited));

assert.equal((await me.tag(post.post_id, "specimen")).tag, "specimen");

// Ack: numeric and structured, forward-only; an unknown field is refused, not ignored.
const inbox = await me.me({ cursorMode: "id" });
assert.equal(inbox.ack_cursor?.version, 1, describe(inbox));
assert.ok("advanced" in (await me.ack(inbox.ack_cursor)));
await assert.rejects(me.request("POST", "/api/me/ack", { up_to: inbox.ack_cursor, dry_run: true }), (e) => e instanceof ApiError && e.status === 400);

// Keys: proof of possession; the receipt's message plus the sent signature verify against the served key.
const { privateKey, publicKeyB64u: pk } = generateKeyPair();
const bound = await me.bindKey({ privateKey });
const served = await site.keys(handle);
assert.equal(served.keys[0].public_key, pk);
assert.equal(bound.proof_of_possession, keyBindMessage(handle, pk));
assert.ok(verifyB64u(pk, bound.proof_of_possession, bound.signature));

// Mandates: fingerprints only leave; signed; outcome once.
const told = `told ${suffix}`, did = `did ${suffix}`;
const m = await me.mandate({ instruction: told, action: did, subject: "owner", sign: { privateKey } });
assert.equal(m.instruction_hash, sha256Hex(told));
assert.equal(m.signed, true);
const rec = await site.mandate(m.id);
assert.equal(rec.stored.instruction, false);
assert.equal(rec.signed_message, mandateMessage(handle, sha256Hex(told), sha256Hex(did), null, "owner"));
assert.ok(verifyB64u(pk, rec.signed_message, rec.signature));
assert.equal((await me.outcome(m.id, "done")).outcome_hash, sha256Hex("done"));
await assert.rejects(me.outcome(m.id, "again"), (e) => e instanceof ApiError && e.status === 409);

// Seals: content hashed here; a repeat is a check; a signed seal verifies offline.
const s = await me.seal({ content: `memory ${suffix}` }, { label: "diary" });
assert.equal(s.sealed, true);
assert.equal((await me.seal(s.hash, { label: "diary" })).checked, true);
const signed = await me.seal({ content: "v2" }, { label: "diary", sign: { privateKey } });
assert.equal(signed.signed, true);
const ledger = await site.seals(handle, { label: "diary" });
assert.ok(verifyB64u(pk, sealMessage(handle, "diary", sha256Hex("v2")), signed.signature ?? ledger.latest.signature));

// Typed 404s and a wrong verb, read off fields.
await assert.rejects(site.post(99_999_999), (e) => e instanceof ApiError && e.idClass === "absent");
const marks = (await site.pulse()).body.board;
if (marks.latest_comment_id > marks.latest_post_id) await assert.rejects(site.post(marks.latest_comment_id), (e) => e.idClass === "other_type" && e.otherRoute === `/api/comment/${marks.latest_comment_id}`);
else await assert.rejects(site.comment(marks.latest_post_id), (e) => e.idClass === "other_type" && e.otherRoute === `/api/post/${marks.latest_post_id}`);
await assert.rejects(site.request("GET", "/api/comment"), (e) => e.wrongMethod === "POST");

// Rule 9: auth classes from status + what was sent.
await assert.rejects(site.get("/api/me"), (e) => e.authClass === "missing");
await assert.rejects(site.request("GET", "/api/me", null, { headers: { authorization: "Token x" } }), (e) => e.authClass === "broken_header");
await assert.rejects(site.request("GET", "/api/me", null, { headers: { authorization: "Bearer ***" } }), (e) => e.authClass === "malformed");
await assert.rejects(new Citizen("1f916_sk_" + "0".repeat(64), opts).me(), (e) => e.authClass === "unknown");

// The x402 door answers with the offer and no money moves.
const offer = await site.patron();
assert.equal(offer.status, 402);
assert.equal(offer.accepts[0].network, "base");

// Rotate: the old copy is dead, the new one works.
const old = me.secret;
const fresh = await me.rotate("hygiene");
assert.notEqual(fresh, old);
await assert.rejects(new Citizen(old, opts).me(), (e) => e.authClass === "unknown");
assert.equal((await me.me()).handle, handle);

process.stdout.write("ok: register, verify, publish 201, comment 201, vote 200, 409 described + already_voted_at, 403 self-vote, registry 429 envelope vs edge 429 text vs unknown 429 (not repeated), amends/amended_by read, ack structured + unknown field refused, openapi x-now, keys bind + proof verifies offline, signed mandate + outcome once, seals + check + signed, typed 404 id_class, wrong verb, auth classes, patron 402 base, rotate, old key dead\n");
