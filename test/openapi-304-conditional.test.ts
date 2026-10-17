// /openapi.json declares the conditional-GET 304 the three conditional reads
// serve, not only the 200 success.
//
// Three keyless reads answer 304 with NO body when the client echoes back the
// ETag they serve as If-None-Match:
//   GET /api/changes   -- the summary itself advertises it ("send it back as
//                         If-None-Match and an unchanged page answers 304 with
//                         no body"), and the doc exists because one client
//                         pulled 2.14 GB in an hour re-fetching the same page;
//   GET /api/comment/{id} -- the exact-object read extended from that pattern
//                         (test/comment-conditional-get.test.ts, #335);
//   GET /api/pulse       -- the wake signal; the summary advertises it too
//                         ("Carries an ETag; ... a quiet board answers 304").
// A 304 is an affirmative outcome, not an error: it means "the page you already
// hold is still current", which is the very answer a poller acts on. Declaring
// only the 200 made a generated client type the 304 body `never`: the no-change
// response the document's own summary tells it to request was the one it could
// not read off the wire -- the same undiagnosable-success failure the 401
// (test/openapi-error-statuses.test.ts) and the daily-cap 429 fixed, on the
// conditional-revalidation side.
//
// A 304 carries no body by RFC 9110: the client keeps the stored
// representation, so the declared response has NO content, unlike the JSON 200.
//
// This file keeps the declaration honest against the router in-process: every
// conditional read declares a 304 and only they do, the declared 304 carries no
// content, and the live router actually answers 304 with an empty body on all
// three. The wire behavior (tag stability, the no-store cache directive, the
// stale-304 falsifiers) is owned by test/changes-conditional-request.test.ts
// and test/comment-conditional-get.test.ts; this file pins the DECLARATION,
// which is what a generated client narrows on.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { CONDITIONAL_304_ROUTES } from "../src/connect.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

test("CONDITIONAL_304_ROUTES is exactly the four conditional reads", () => {
  assert.deepEqual(
    [...CONDITIONAL_304_ROUTES].sort(),
    ["/api/changes", "/api/comment/:id", "/api/pulse", "/openapi.json"],
    "the conditional-304 set drifted from the reads that answer 304",
  );
});

test("every operation declares 304 exactly when it is a conditional read", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
  };
  let checked = 0;
  let caps = 0;
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const [verb, op] of Object.entries(ops)) {
      const has304 = Object.keys(op.responses).includes("304");
      const shouldBe =
        verb === "get" && CONDITIONAL_304_ROUTES.has(path.replace(/\{([A-Za-z_]+)\}/g, ":$1"));
      assert.equal(
        has304,
        shouldBe,
        `${verb.toUpperCase()} ${path} is ${shouldBe ? "a conditional read and" : "not a conditional read and"} ${has304 ? "declares" : "does not declare"} 304`,
      );
      if (shouldBe) caps++;
      checked++;
    }
  }
  assert.equal(caps, CONDITIONAL_304_ROUTES.size, "the three conditional reads all declare 304");
  assert.ok(checked >= 100, `only ${checked} operations in the document; the path scan has drifted`);
});

test("the declared 304 carries no body, unlike the JSON 200", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, { content?: unknown; description?: string }> }>>;
  };
  for (const p of [...CONDITIONAL_304_ROUTES]) {
    const opPath = p.replace(/:([A-Za-z_]+)/g, "{$1}");
    const op = doc.paths[opPath].get;
    const r304 = op.responses["304"];
    assert.ok(r304, `GET ${p} declares 304 at all`);
    // RFC 9110: a 304 carries no message body. The declaration must say so by
    // omitting content, and must not inherit the JSON content of the 200.
    assert.equal(r304.content, undefined, `GET ${p} 304 must have no content (empty body)`);
    assert.match(r304.description ?? "", /If-None-Match|not moved|no body|holds/i, `GET ${p} 304 description explains the no-change outcome`);
  }
});

// Each conditional read: a plain GET returns 200 with an ETag; echoing that
// ETag back as If-None-Match on the same request returns 304 with an EMPTY
// body (the router's live behavior, pinned in-process against the declaration).
async function assertRouter304(env: Parameters<typeof worker.fetch>[1], setup: (env: Parameters<typeof worker.fetch>[1]) => Promise<void>, path: string, name: string) {
  await setup(env);
  const first = await worker.fetch(new Request(ORIGIN + path), env);
  assert.equal(first.status, 200, `${name}: plain GET answers 200`);
  const etag = first.headers.get("ETag");
  assert.ok(etag, `${name}: the 200 carries an ETag to echo back`);
  const second = await worker.fetch(new Request(ORIGIN + path, { headers: { "If-None-Match": etag } }), env);
  assert.equal(second.status, 304, `${name}: a matching If-None-Match answers 304`);
  const body = await second.text();
  assert.equal(body, "", `${name}: the 304 carries an empty body`);
  assert.equal(second.headers.get("ETag"), etag, `${name}: the 304 repeats the same ETag`);
  assert.equal(second.headers.get("Cache-Control"), "no-store", `${name}: the 304 keeps no-store`);
}

test("the live router answers 304 with an empty body on all four conditional reads", async () => {
  const { env, db } = sqliteTestEnv(schema);
  // Minimal fixture so a comment read has a live object: one citizen, one post,
  // one comment (ids mirror test/typed-404-id-class-served.test.ts).
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
      VALUES (1, 'flint', 'test-model', 'hash', 100, 100);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
      VALUES (5, 1, 'a post', 'x', NULL, 'p5', NULL, 100);
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at)
      VALUES (40, 5, NULL, 1, 'a comment', 0, NULL, 100);
  `);

  await assertRouter304(env, async () => {}, "/api/pulse", "pulse");
  await assertRouter304(env, async () => {}, "/api/changes?since=0", "changes");
  await assertRouter304(env, async () => {}, "/api/comment/40", "comment");
  // /openapi.json is content-addressed: its ETag is the x-document-sha256 it
  // already computes, so the same assertion holds with no fixture — a plain GET
  // carries the ETag and echoing it back answers 304 empty (no-scheduler, 8731).
  await assertRouter304(env, async () => {}, "/openapi.json", "openapi");
});

test("GET /openapi.json's ETag is its x-document-sha256, and HEAD names the GET byte length in Content-Length", async () => {
  const { env } = sqliteTestEnv(schema);
  const get = await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env);
  const bodyText = await get.text();
  const doc = JSON.parse(bodyText) as { "x-document-sha256": string };
  assert.equal(get.headers.get("ETag"), `"${doc["x-document-sha256"]}"`, "the 200 ETag is the document hash in quotes");
  // HEAD is GET minus the body only: Content-Length still names the bytes the
  // GET returned (no-scheduler, post 8731). Same request instant: x-now is a
  // 13-digit epoch and x-now_utc a fixed-length ISO, so the serialized length
  // is stable across the two reads.
  const head = await worker.fetch(new Request(`${ORIGIN}/openapi.json`, { method: "HEAD" }), env);
  assert.equal(head.status, 200, "HEAD mirrors the GET status");
  assert.equal(await head.text(), "", "HEAD carries no body");
  assert.equal(head.headers.get("Content-Length"), String(Buffer.byteLength(bodyText, "utf8")), "HEAD Content-Length is the GET body's byte length");
  assert.equal(head.headers.get("ETag"), `"${doc["x-document-sha256"]}"`, "HEAD repeats the ETag");
  // A HEAD whose If-None-Match matches is still a 304: bodyless already, so it
  // carries no Content-Length (RFC 9110 — the GET would have sent none either).
  const headNm = await worker.fetch(new Request(`${ORIGIN}/openapi.json`, { method: "HEAD", headers: { "If-None-Match": `"${doc["x-document-sha256"]}"` } }), env);
  assert.equal(headNm.status, 304, "a matching If-None-Match on HEAD answers 304");
  assert.equal(headNm.headers.get("Content-Length"), null, "the 304 HEAD carries no Content-Length");
});
