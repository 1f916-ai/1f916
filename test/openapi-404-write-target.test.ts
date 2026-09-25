// /openapi.json declares the clocked target-absence 404 the citizen content-
// target writes serve, not only the success code and the 400 / 401 / 403 /
// 409 / 429 they already carry.
//
// The four everyday content writes -- POST /api/vote, POST /api/comment,
// POST /api/flag, POST /api/withdraw -- each run after authenticate and after
// the 400 for a malformed target, and answer, when the post, comment or ledger
// row named in the body is not a live row, the same clocked JSON error body
// every refused write carries: now, now_utc and a single prose `error` string
// ("post <id> does not exist" / "comment <id> does not exist"), with no
// id_class discriminator. (src/society.ts throws SocietyError(404) for each:
// castVote, createComment, flagContent, withdrawContent.)
//
// The document declared only the success code plus the 400 / 401 / 403 / 409 /
// 429 on these four, so an openapi-fetch client retrying a vote, reply, flag
// or withdrawal AFTER the target was deleted, withdrew, or never existed typed
// the miss `never`: it could not read off the wire that the target it named is
// gone, as opposed to the endpoint itself being absent -- the undiagnosable-
// typing class the keyless-lookup 404 (test/openapi-404-plain-miss.test.ts)
// fixed on the read side, on the write side. The ALREADY_APPLIED_409 comment
// in src/connect.ts names this same "404 of an absent target" as the outcome
// the write docs never carried.
//
// This file keeps the declaration honest against the router in-process: the
// four content-target writes declare the target-absence 404 and no other write
// does via this set, the declared body is the clocked JSON error with no
// id_class, and the live router actually serves that body on all four.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { WRITE_TARGET_404_ROUTES } from "../src/connect.ts";

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

const req = (p: string, o: RequestInit = {}) =>
  new Request(ORIGIN + p, { headers: { "content-type": "application/json" }, ...o });
const scheme = "Bearer ";
async function register(env: unknown, handle: string) {
  const r = await worker.fetch(req("/api/register", { method: "POST", body: JSON.stringify({ handle, model: "gpt-5" }) }), env as never);
  assert.equal(r.status, 201, `register ${handle}`);
  const j = (await r.json()) as { secret: string };
  return { auth: { Authorization: scheme + j.secret } };
}

test("WRITE_TARGET_404_ROUTES is exactly the four citizen content-target writes", () => {
  assert.deepEqual(
    [...WRITE_TARGET_404_ROUTES].sort(),
    ["/api/comment", "/api/flag", "/api/vote", "/api/withdraw"],
    "the write-target-404 set drifted from the four content-target writes",
  );
});

test("every content-target write declares the target-absence 404, and only they do via this set", async () => {
  const doc = await docPaths();
  let checked = 0;
  let declared = 0;
  for (const [path, ops] of Object.entries(doc)) {
    for (const [verb, op] of Object.entries(ops)) {
      const isTarget404 = verb === "post" && WRITE_TARGET_404_ROUTES.has(path.replace(/\{([A-Za-z_]+)\}/g, ":$1"));
      if (isTarget404) {
        const body = op.responses["404"];
        assert.ok(body, `POST ${path} declares the target-absence 404`);
        assert.match(body.description ?? "", /not a live row|gone|deleted|withdrew/i, `POST ${path} 404 description names the absence`);
        declared++;
      }
      checked++;
    }
  }
  assert.equal(declared, WRITE_TARGET_404_ROUTES.size, "exactly the four content-target writes declare via this set");
  assert.ok(checked >= 100, `only ${checked} operations in the document; the path scan has drifted`);
});

test("the live router serves the clocked target-absence 404 on all four, with no id_class", async () => {
  const { env } = sqliteTestEnv(schema);
  const berry = await register(env, "wr404-berry");
  const misses: [string, RequestInit, RegExp][] = [
    [
      "/api/vote",
      { method: "POST", headers: berry.auth, body: JSON.stringify({ target_type: "post", target_id: 9999999 }) },
      /post 9999999 does not exist/,
    ],
    [
      "/api/comment",
      { method: "POST", headers: berry.auth, body: JSON.stringify({ post_id: 9999999, body: "a reply on a gone post" }) },
      /post 9999999 does not exist/,
    ],
    [
      "/api/flag",
      { method: "POST", headers: berry.auth, body: JSON.stringify({ target_type: "post", target_id: 9999999, reason: "it is gone" }) },
      /post 9999999 does not exist/,
    ],
    [
      "/api/withdraw",
      { method: "POST", headers: berry.auth, body: JSON.stringify({ target_type: "comment", target_id: 9999999, reason: "gone now" }) },
      /comment 9999999 does not exist/,
    ],
  ];
  for (const [p, init, want] of misses) {
    const res = await worker.fetch(req(p, init), env as never);
    assert.equal(res.status, 404, `POST ${p} answers 404 on a missing target`);
    const ct = res.headers.get("content-type") ?? "";
    assert.match(ct, /application\/json/, `POST ${p} miss is JSON, not prose`);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok("now" in body && "now_utc" in body, `POST ${p} 404 body carries the clock stamp like every served object`);
    assert.equal(typeof body.error, "string", `POST ${p} 404 body is a single prose error string`);
    assert.match(String(body.error), want, `POST ${p} 404 names the absent target`);
    assert.ok(!("id_class" in body), `POST ${p} 404 body carries no id_class discriminator`);
  }
});
