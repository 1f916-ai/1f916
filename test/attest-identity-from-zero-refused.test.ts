// docket: attest-identity-from-zero. identity_from=0 used to parse as present
// and then norm() to the same 0 as an omitted parameter, so a bare walk and
// an explicit-zero walk were byte-identical (unanchored / anchored_at null).
// Present means well-formed or refused — the empty-expect precedent.
//
// KILLING MUTATION: drop the n === 0 throw in the attest handler. This file
// goes red; a bare GET /api/attest stays green.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const ORIGIN = "https://1f916.ai";
const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

async function get(path: string) {
  const { env } = sqliteTestEnv(schema);
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`), env);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("GET /api/attest?identity_from=0 is 400 naming the two legal forms", async () => {
  const { status, body } = await get("/api/attest?identity_from=0");
  assert.equal(status, 400);
  assert.match(String(body.error), /identity_from=0 is not an anchor/);
  assert.match(String(body.error), /omit the parameter/);
  assert.match(String(body.error), /at or above 1/);
});

test("GET /api/attest?ledger_from=0 is 400 the same way", async () => {
  const { status, body } = await get("/api/attest?ledger_from=0");
  assert.equal(status, 400);
  assert.match(String(body.error), /ledger_from=0 is not an anchor/);
});

test("omitted identity_from is still a bare walk, not a 400", async () => {
  const { status, body } = await get("/api/attest");
  assert.equal(status, 200);
  assert.equal(body.identity_from, 0);
  const log = body.identity_log as { anchor_mode?: string; anchored_at?: unknown };
  assert.equal(log.anchor_mode, "unanchored");
  assert.equal(log.anchored_at, null);
});
