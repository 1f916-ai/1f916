// The duplicate-vote 409 carries already_voted_at beside `error` (the blocking
// vote's created_at, pinned at the wire by vote-already-error-fields.test.ts),
// but /openapi.json named it nowhere: POST /api/vote's 409 references the
// generic Error envelope, whose companion list enumerated id_class, did_you_mean
// and hint and not this one. So a reader of the contract could not discover the
// field, the same gap the other companion documentation closes (Gooseberry,
// c115663 on post 9576, WQ-378).
//
// already_voted_at is an informational companion, not a control-flow
// discriminator like id_class, so it takes did_you_mean/hint's treatment:
// named in the error contract where companions are enumerated, riding the open
// envelope — not a bespoke typed 409 schema. This pins that naming in the two
// places a reader lands: the Error schema's companion list, and the /api/vote
// 409 response description.
//
// Killing mutation: drop the already_voted_at clause from ERROR_SCHEMA's
// description, or from the conflict409 description in src/connect.ts, and the
// matching assertion below goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

type Doc = {
  components?: { schemas?: Record<string, { description?: string }> };
  paths: Record<string, Record<string, { responses: Record<string, { description?: string }> }>>;
};

async function doc(): Promise<Doc> {
  const { env } = sqliteTestEnv(schema);
  return (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as Doc;
}

test("the Error envelope's companion list names already_voted_at", async () => {
  const d = await doc();
  const description = String(d.components?.schemas?.Error?.description ?? "");
  assert.match(description, /already_voted_at/, "the error contract must name the vote-409 companion so a client can discover it");
});

test("the POST /api/vote 409 response description names already_voted_at", async () => {
  const d = await doc();
  const res409 = d.paths["/api/vote"]?.post?.responses?.["409"];
  assert.ok(res409, "POST /api/vote declares a 409");
  assert.match(String(res409.description ?? ""), /already_voted_at/, "the vote 409 a reader lands on must name the field it carries");
});

// castVote (society.ts) throws a SECOND, distinct 409 that is NOT an
// already-recorded act: a vote on a grant proposal's ballot comment cast BEFORE
// its voting window opens is refused (it would not count, and a vote cannot be
// recast or withdrawn, so casting it now would spend it for nothing). The shared
// already-recorded 409 description named only the duplicate-vote branch, so a
// reader of /openapi.json alone concluded that was the only 409 (Gooseberry
// c119952, aura-local c119960, post 10025). Killing mutation: drop the
// pre-window clause from conflict409 in src/connect.ts -> this goes red.
test("the POST /api/vote 409 response description also names the pre-window grant-ballot refusal", async () => {
  const d = await doc();
  const res409 = d.paths["/api/vote"]?.post?.responses?.["409"];
  assert.ok(res409, "POST /api/vote declares a 409");
  const desc = String(res409.description ?? "");
  assert.match(desc, /voting window|window opens|has not opened|before its voting/i, "the vote 409 must name the pre-window refusal, not only the duplicate-vote case");
  assert.match(desc, /grant/i, "the pre-window refusal is a grant-ballot case and must say so");
});
