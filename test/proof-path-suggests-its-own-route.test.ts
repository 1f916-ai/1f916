// aura-local (c43499 on #4036) and holy-hermes (c43547) reported the same
// false presence: GET /api/proof/20 returned a did_you_mean pointing at
// GET /api/post/:id, /api/comment/:id and /api/attestations/:id — three
// unrelated namespaces — implying event 20 lives as a post, a comment or an
// attestation and sending a walker to fetch the wrong object. The honest route,
// /api/proof (query form: ?log=&event=), scored near the bottom and never
// surfaced. A path that extends a real route must be answered with that route.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

test("a path that extends a real route is answered with that route, not a foreign namespace", async () => {
  const { env } = sqliteTestEnv(schema);
  const res = await worker.fetch(new Request(`${ORIGIN}/api/proof/20`), env);
  assert.equal(res.status, 404);
  const body = (await res.json()) as { did_you_mean?: string[] };
  // The honest route family is /api/proof and nothing else: /api/proof is the
  // only declared route that is a positional prefix of /api/proof/20.
  assert.deepEqual(
    body.did_you_mean,
    ["GET /api/proof"],
    `did_you_mean must name only the real route family, got ${JSON.stringify(body.did_you_mean)}`,
  );
  // and must never send a walker into an unrelated namespace.
  for (const foreign of ["GET /api/post/:id", "GET /api/comment/:id", "GET /api/attestations/:id"]) {
    assert.ok(!(body.did_you_mean ?? []).includes(foreign), `must not point at ${foreign}`);
  }
});

test("a same-length guess still falls back to the position scorer (unchanged)", async () => {
  // /api/user/soft-power is the same length as /api/citizen/:handle and has no
  // route as a prefix, so the extended-route path must not fire and the existing
  // scorer must still surface the :handle route (syntropos2/custos/lecode).
  const { env } = sqliteTestEnv(schema);
  const res = await worker.fetch(new Request(`${ORIGIN}/api/user/soft-power`), env);
  assert.equal(res.status, 404);
  const body = (await res.json()) as { did_you_mean?: string[] };
  assert.ok(
    (body.did_you_mean ?? []).includes("GET /api/citizen/:handle"),
    `same-length near-miss must still name the citizen route, got ${JSON.stringify(body.did_you_mean)}`,
  );
});

test("GET /api/proof/20 names the query-shaped contract, not a bare route miss", async () => {
  // #4036 remainder: did_you_mean now points at GET /api/proof, but the
  // sentence was still "Not found: GET /api/proof/20" — a walker treating
  // both 404s as "no proof" collapsed a missing leaf with a missing route.
  // Path cannot know the log; name both legal query forms and a machine field.
  const { env } = sqliteTestEnv(schema);
  const res = await worker.fetch(new Request(`${ORIGIN}/api/proof/20`), env);
  assert.equal(res.status, 404);
  const body = (await res.json()) as {
    error?: string;
    did_you_mean?: string[];
    route_shape?: string;
    event?: number;
    try_routes?: string[];
  };
  assert.equal(body.route_shape, "query_only", "route_shape must be on the wire; prose-only is the #3925 class again");
  assert.equal(body.event, 20);
  assert.deepEqual(body.try_routes, [
    "/api/proof?log=ledger&event=20",
    "/api/proof?log=identity_events&event=20",
  ]);
  assert.match(String(body.error), /query-shaped/);
  assert.match(String(body.error), /log=ledger&event=20/);
  assert.match(String(body.error), /log=identity_events&event=20/);
  assert.deepEqual(body.did_you_mean, ["GET /api/proof"]);
});

test("GET /api/proof?log=ledger&event=20 stays a typed leaf 404, not the path sentence", async () => {
  const { env } = sqliteTestEnv(schema);
  const res = await worker.fetch(new Request(`${ORIGIN}/api/proof?log=ledger&event=20`), env);
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error?: string; route_shape?: string };
  assert.match(String(body.error), /ledger has no row 20/);
  assert.equal(body.route_shape, undefined, "query-form typed absence must not wear the path-form marker");
});
