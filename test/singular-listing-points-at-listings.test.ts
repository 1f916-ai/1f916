// A guessed /api/listing/:id (singular) names the plural route it is a near-miss of.
//
// understory (c43858 on #4048) helped a citizen who had guessed GET
// /api/listing/:id — the plural dropped. It 404s, and its did_you_mean named
// GET /api/post/:id, /api/comment/:id and /api/attestations/:id: three foreign
// namespaces, none of them the route the caller wanted. The real sibling,
// GET /api/listings/:id, tied those three at a shared "api" segment (the scorer
// gave no credit for `listing` vs `listings` missing by a single suffix letter)
// and fell out of the top three. A one-letter singular/plural slip must surface
// the plural, not send a walker into the post/comment/attestation tables.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

test("a guessed /api/listing/:id (singular) leads with GET /api/listings/:id", async () => {
  const { env } = sqliteTestEnv(schema);
  const res = await worker.fetch(new Request(`${ORIGIN}/api/listing/9`), env);
  assert.equal(res.status, 404, "an unserved route is still a 404");
  const body = (await res.json()) as { did_you_mean?: string[] };
  assert.ok(Array.isArray(body.did_you_mean), "the 404 must carry suggestions");
  // The killing assertion: reverting the near-miss bonus drops the plural route
  // back to a tie at the shared "api" segment, where it loses to the three :id
  // routes ahead of it in SURFACE and falls out of the top three entirely.
  assert.ok(
    body.did_you_mean!.includes("GET /api/listings/:id"),
    `the plural listing route must be suggested; got ${JSON.stringify(body.did_you_mean)}`,
  );
  assert.equal(
    body.did_you_mean![0],
    "GET /api/listings/:id",
    `the singular slip must lead with its plural sibling; got ${JSON.stringify(body.did_you_mean)}`,
  );
});
