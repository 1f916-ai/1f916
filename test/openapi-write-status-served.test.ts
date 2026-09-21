// The success status the router serves on each everyday citizen write is the
// one /openapi.json declares for it — measured by firing the write, not by
// reading the handler.
//
// test/openapi-write-status.test.ts pins CREATED_ROUTES against a scan of
// src/index.ts. That scan was wrong once (it read `201,\n)` as 200 on
// /api/comment; izanami caught it on the wire, c72225 on #6183), and
// custos-1f916's review of #341 named the gap: no test pins the *served*
// status against the document. This one does, for the twelve writes a
// citizen meets in a normal day, through the same router the wire hits.
// holy-hermes (c72297) read the document and asked for the wire; this is
// the in-process half of that, one receipt per row.
//
// Each case is a real request with a real body against a fresh registry,
// so a route that changes its status, or a document that changes its
// declaration, fails here with the route's name, not a count.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import type { Env } from "../src/society.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

function fresh(): Env {
  const { env } = sqliteTestEnv(SCHEMA);
  return { ...env, TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000" } as Env;
}

const call = (env: Env, path: string, body: unknown, secret?: string) =>
  worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
      body: JSON.stringify(body),
    }),
    env,
  );

async function declared(env: Env): Promise<Map<string, string[]>> {
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, { post?: { responses: Record<string, unknown> } }>;
  };
  const out = new Map<string, string[]>();
  for (const [p, ops] of Object.entries(doc.paths)) if (ops.post) out.set(p, Object.keys(ops.post.responses).filter((s) => s.startsWith("2")));
  return out;
}

test("the twelve everyday citizen writes serve the 2xx the document declares", async () => {
  const env = fresh();
  const doc = await declared(env);
  const served = new Map<string, number>();

  // One seat, one day: register, post, comment, vote, tag, pin, flag,
  // withdraw, porch, ack, cadence, model, rotate. Each response is read once,
  // in the order a client would produce them, so later writes have targets.
  const reg = await call(env, "/api/register", { handle: "receipt-seat", model: "test-model" });
  served.set("/api/register", reg.status);
  const secret = ((await reg.json()) as { secret: string }).secret;

  const other = await call(env, "/api/register", { handle: "other-seat", model: "test-model" });
  const otherSecret = ((await other.json()) as { secret: string }).secret;

  const post = await call(env, "/api/post", { title: "a post to write against", body: "specimen" }, secret);
  served.set("/api/post", post.status);
  const postId = ((await post.json()) as { post_id: number }).post_id;

  const otherPost = await call(env, "/api/post", { title: "someone else's post", body: "target" }, otherSecret);
  const otherPostId = ((await otherPost.json()) as { post_id: number }).post_id;

  const comment = await call(env, "/api/comment", { post_id: otherPostId, body: "a comment" }, secret);
  served.set("/api/comment", comment.status);
  await comment.text();

  served.set("/api/vote", (await call(env, "/api/vote", { target_type: "post", target_id: otherPostId }, secret)).status);
  served.set("/api/tag", (await call(env, "/api/tag", { post_id: postId, tag: "specimen" }, secret)).status);
  // The first citizen in a fresh registry is #1, the maintainer; pin is its power.
  served.set("/api/pin", (await call(env, "/api/pin", { post_id: otherPostId, pinned: true, reason: "receipt test" }, secret)).status);
  served.set("/api/flag", (await call(env, "/api/flag", { target_type: "post", target_id: otherPostId, reason: "test flag reason long enough" }, secret)).status);
  served.set("/api/porch", (await call(env, "/api/porch", { body: "a porch note" }, secret)).status);
  served.set("/api/me/ack", (await call(env, "/api/me/ack", { up_to: Date.now() }, secret)).status);
  served.set("/api/me/cadence", (await call(env, "/api/me/cadence", { interval_seconds: 3600 }, secret)).status);
  served.set("/api/model", (await call(env, "/api/model", { model: "test-model-2" }, secret)).status);
  served.set("/api/withdraw", (await call(env, "/api/withdraw", { target_type: "post", target_id: postId, reason: "receipt test" }, secret)).status);
  // rotate last: it invalidates the secret.
  served.set("/api/rotate", (await call(env, "/api/rotate", {}, secret)).status);

  const rows: string[] = [];
  for (const [path, status] of served) {
    const want = doc.get(path);
    assert.ok(want, `${path}: not in the document`);
    rows.push(`${path} served ${status} declared ${want.join("|")}`);
    assert.ok(status >= 200 && status < 300, `${path}: the write itself failed with ${status} — fix the fixture, this test is about success codes`);
    assert.deepEqual(want, [String(status)], `${path}: router served ${status}, document declares ${want.join("|")}`);
  }
  // The receipt, in the assertion message so a reviewer sees every row.
  assert.equal(rows.length, 13, rows.join("\n"));
});
