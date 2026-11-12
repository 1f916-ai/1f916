// GET /api/witnesses/:id/history read only the live witnesses table, so the
// retire route (POST /api/witnesses/:id/retire) broke the history it promised
// to keep: retireWitness chains `witness retired: <url> id=<id> keyless`
// "so the directory's history stays complete even though the row is gone",
// yet the history door answered 404 for every retired id and served the
// retire row nowhere. And because a retired URL may register again as a new
// row, the new row's history absorbed its predecessor's register row as if it
// were its own.
//
// Killing mutations:
//  - restore the 404 for a missing live row and the retired-id test goes red;
//  - drop the lower id bound (`id > ?` after the previous retire of the URL)
//    and the reuse test goes red (the new row re-absorbs the old register);
//  - drop the upper bound for a retired id and the reuse test goes red (the
//    old id absorbs the new lineage's register);
//  - the id lookup is pinned by the 404 test (id 5 must not answer from id
//    15's retire row, nor id 7 from a register row whose free-text name ends
//    in ` id=7 keyless`). The exact-id parse after the SQL match is defense in
//    depth: no served URL can contain a space, so no mutation of it alone
//    reddens a test here.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { registerWitness, retireWitness, witnessHistory, SocietyError, type Citizen } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { validate } from "./helpers/json-schema.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const historySchema = JSON.parse(readFileSync(join(import.meta.dirname, "..", "schemas", "witness-history.json"), "utf8"));

function fixture() {
  const { env, db } = sqliteTestEnv(schema);
  db.exec("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'owner', 'test', 'h1', 0, 0), (2, 'other', 'test', 'h2', 0, 0)");
  return { env, db, owner: { id: 1, handle: "owner" } as Citizen, other: { id: 2, handle: "other" } as Citizen };
}

// The served body carries now/now_utc from the router wrapper; add them so the
// schema check covers exactly what the door serves.
const served = (body: object) => JSON.parse(JSON.stringify({ now: 1, now_utc: "2026-10-24T00:00:00.000Z", ...body }));

test("a retired keyless witness still answers its history, retire row last, block marked retired", async (t) => {
  const { env, db, owner } = fixture();
  t.after(() => db.close());
  const reg = await registerWitness(env, owner, { name: "old pointer", url: "https://example.test/w/" });
  const id = reg.witness_id as number;
  await retireWitness(env, owner, id);

  const h = await witnessHistory(env, id);
  assert.deepEqual(h.events.map((e) => e.kind), ["witness-register", "witness-retire"]);
  assert.equal(h.total, 2);
  assert.equal(h.count, 2);
  assert.equal(h.has_more, false);
  assert.equal(h.predates_chaining, undefined);
  const w = h.witness as Record<string, unknown>;
  assert.equal(w.id, id);
  assert.equal(w.url, "https://example.test/w/");
  assert.equal(w.name, "old pointer");
  assert.equal(w.public_key, null);
  assert.equal(w.operator, "owner");
  assert.equal(w.retired, true);
  assert.equal(w.retired_event, h.events[1].id);
  assert.deepEqual(validate(historySchema, served(h)), [], "the retired arm conforms to the published schema");
});

test("a live witness carries no retired marker and still validates", async (t) => {
  const { env, db, owner } = fixture();
  t.after(() => db.close());
  const reg = await registerWitness(env, owner, { name: "live", url: "https://example.test/live/" });
  const h = await witnessHistory(env, reg.witness_id as number);
  assert.equal((h.witness as Record<string, unknown>).retired, undefined);
  assert.deepEqual(h.events.map((e) => e.kind), ["witness-register"]);
  assert.deepEqual(validate(historySchema, served(h)), []);
});

test("a URL registered again after a retire: each id serves only its own lineage", async (t) => {
  const { env, db, owner, other } = fixture();
  t.after(() => db.close());
  const url = "https://example.test/reused/";
  const first = (await registerWitness(env, owner, { name: "first", url })).witness_id as number;
  await retireWitness(env, owner, first);
  const second = (await registerWitness(env, other, { name: "second", url })).witness_id as number;
  assert.notEqual(first, second);

  const now = await witnessHistory(env, second);
  assert.equal(now.total, 1, "the new row does not absorb its predecessor's register row");
  assert.equal(now.events.length, 1);
  assert.match(now.events[0].detail, /name="second"/);

  const then = await witnessHistory(env, first);
  assert.deepEqual(then.events.map((e) => e.kind), ["witness-register", "witness-retire"]);
  assert.match(then.events[0].detail, /name="first"/, "the old id does not absorb the new lineage");
  assert.equal((then.witness as Record<string, unknown>).operator, "owner");
});

test("an id that was never a witness is still 404, and id 5 does not answer from id 15's retire row", async (t) => {
  const { env, db, owner } = fixture();
  t.after(() => db.close());
  db.prepare("INSERT INTO witnesses (id, citizen_id, name, url, public_key, epoch, key_set_at, added_at) VALUES (15, 1, 'w15', 'https://example.test/15/', NULL, 0, NULL, 0)").run();
  await retireWitness(env, owner, 15);
  // A register row whose free-text name ends like a retire detail is not a
  // retire row and must not make id 7 answer either.
  await registerWitness(env, owner, { name: "x id=7 keyless", url: "https://example.test/n/" });
  for (const missing of [5, 7, 999]) {
    await assert.rejects(
      witnessHistory(env, missing),
      (e: unknown) => e instanceof SocietyError && e.status === 404 && e.message === `no witness ${missing}`,
    );
  }
  const h = await witnessHistory(env, 15);
  assert.equal((h.witness as Record<string, unknown>).retired, true);
  assert.equal(h.witness.name, "", "a pre-chaining row has no register row to name it");
  assert.deepEqual(h.events.map((e) => e.kind), ["witness-retire"]);
});
