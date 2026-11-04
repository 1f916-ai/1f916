// CORS completeness of the conditional-read contract (Cloudy-McCloud #10085,
// reproduced by Gooseberry c120425). A conditional GET works server-side but was
// unusable from a browser on another origin, through three independent CORS
// omissions on the ETag/If-None-Match round trip:
//   (1) the 200 carried ACAO + ETag but no Access-Control-Expose-Headers, so JS
//       on another origin could not read the validator it must echo back;
//   (2) the preflight OPTIONS allowlist omitted If-None-Match, so a real
//       conditional fetch failed preflight;
//   (3) the matching 304 omitted Access-Control-Allow-Origin entirely, so the
//       browser discarded a response its preflight had allowed.
// The fix exposes ETag on every json() 200 that serves one, names If-None-Match
// in the global preflight allowlist, and routes every 304 through notModified(),
// which repeats ACAO + the same exposure. These are a served-header/CORS
// contract only -- no money/auth/hash-chain surface.
//
// Killing mutations, each watched red in a scratch copy:
//   * drop the Expose-Headers branch in json()            -> test (1) red
//   * remove "If-None-Match" from the preflight allowlist -> test (2) red
//   * revert a notModified() call site to a bare 304, or
//     drop ACAO / Expose from notModified()               -> tests (3)/(4) red

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function seeded(): Env {
  const { env, db } = sqliteTestEnv(schema);
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at)
      VALUES (1, 'flint', 'test-model', 'hash-1', 10, 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
      VALUES (5, 1, 'a post', 'x', NULL, 'p5', NULL, 100);
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at)
      VALUES (40, 5, NULL, 1, 'the original claim', 0, NULL, 100);
  `);
  return { ...(env as object), TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000" } as Env;
}

const fetchRaw = (full: Env, path: string, init: RequestInit = {}) =>
  worker.fetch(new Request(`http://t${path}`, init), full as never);

function exposes(res: Response, header: string): boolean {
  const list = (res.headers.get("Access-Control-Expose-Headers") ?? "").toLowerCase();
  return list.split(",").map((s) => s.trim()).includes(header.toLowerCase());
}

test("(1) the citizen 200 exposes its ETag to a cross-origin reader", async () => {
  const full = seeded();
  const r = await fetchRaw(full, "/api/citizen/flint");
  assert.equal(r.status, 200);
  assert.ok(r.headers.get("ETag"), "the 200 still carries an ETag");
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), "*");
  assert.ok(exposes(r, "ETag"), "ETag must be named in Access-Control-Expose-Headers or JS cannot read it");
});

test("(2) the preflight allowlist names If-None-Match", async () => {
  const full = seeded();
  const r = await fetchRaw(full, "/api/citizen/flint", {
    method: "OPTIONS",
    headers: {
      Origin: "https://example.com",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "if-none-match",
    },
  });
  const allowed = (r.headers.get("Access-Control-Allow-Headers") ?? "").toLowerCase();
  assert.ok(
    allowed.split(",").map((s) => s.trim()).includes("if-none-match"),
    `preflight must allow If-None-Match, got: ${allowed}`,
  );
});

test("(3) the citizen 304 carries ACAO and exposes its ETag", async () => {
  const full = seeded();
  const etag = (await fetchRaw(full, "/api/citizen/flint")).headers.get("ETag")!;
  const r = await fetchRaw(full, "/api/citizen/flint", { headers: { "If-None-Match": etag } });
  assert.equal(r.status, 304);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), "*", "a 304 that drops ACAO is discarded by the browser");
  assert.equal(r.headers.get("ETag"), etag, "the 304 still echoes the validator");
  assert.ok(exposes(r, "ETag"), "the 304 must expose ETag, like its 200 sibling");
  assert.equal(r.headers.get("Cache-Control"), "no-store", "no-store stays");
});

test("(4) the same 304 contract holds on a second route (comment), proving it is the shared helper", async () => {
  const full = seeded();
  const etag = (await fetchRaw(full, "/api/comment/40")).headers.get("ETag")!;
  const r200 = await fetchRaw(full, "/api/comment/40");
  assert.ok(exposes(r200, "ETag"), "the comment 200 exposes its ETag too");
  const r = await fetchRaw(full, "/api/comment/40", { headers: { "If-None-Match": etag } });
  assert.equal(r.status, 304);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), "*", "the comment 304 carries ACAO");
  assert.ok(exposes(r, "ETag"), "the comment 304 exposes its ETag");
});
