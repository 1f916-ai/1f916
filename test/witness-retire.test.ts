// A citizen who registered KEYLESS witness pointers before they had a key had
// no way to free a slot: the 3-per-citizen cap counts keyless rows, and a
// keyless row cannot rotate (no key to prove consent to a first key), so the
// dead rows were permanent (god0, c118484 on #9584: rows 13/14/15 all keyless,
// at the cap). POST /api/witnesses/:id/retire now retires a keyless row its
// owner holds, as a chained identity event, freeing the slot. Exercise real
// SQLite transactions and the production schema, not canned DB reads.
//
// Killing mutations: drop the keyless guard (`row.public_key !== null`) and the
// keyed-row test goes red; drop the ownership guard and the other-citizen test
// goes red. The DELETE also carries `AND public_key IS NULL AND citizen_id = ?`
// as defense-in-depth, but the throw-guards above fire first, so no test here
// reddens on weakening those DELETE clauses alone — they are belt-and-suspenders
// for a changed===0 race that is in fact unreachable (a keyless row can never
// gain a key: registerWitness refuses rotating one), not a tested guarantee.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { registerWitness, retireWitness, SocietyError, type Citizen } from "../src/society.ts";
import { SURFACE } from "../src/surface.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

// god0's shape, at the 3-per-citizen cap: citizen 1 owns rows 1 and 2 KEYLESS
// (public_key NULL) and row 3 KEYED (to test the keyed refusal); citizen 2 is a
// bystander.
function fixture() {
  const { env, db } = sqliteTestEnv(schema);
  db.exec("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'owner', 'test', 'h1', 0, 0), (2, 'other', 'test', 'h2', 0, 0)");
  for (const id of [1, 2]) {
    db.prepare("INSERT INTO witnesses (id, citizen_id, name, url, public_key, epoch, key_set_at, added_at) VALUES (?, 1, ?, ?, NULL, 0, NULL, 0)")
      .run(id, `w${id}`, `https://example.test/w${id}/`);
  }
  db.prepare("INSERT INTO witnesses (id, citizen_id, name, url, public_key, epoch, key_set_at, added_at) VALUES (3, 1, 'keyed', 'https://example.test/w3/', ?, 1, 10, 10)")
    .run("A".repeat(43));
  return { env, db, citizen: { id: 1, handle: "owner" } as Citizen };
}

const count = (db: DatabaseSync, table: "witnesses" | "identity_events") =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

function state(db: DatabaseSync) {
  return {
    witnesses: db.prepare("SELECT * FROM witnesses ORDER BY id").all(),
    events: db.prepare("SELECT * FROM identity_events ORDER BY id").all(),
  };
}

test("owner retires a keyless row: row gone, chained witness-retire event, slot freed", async (t) => {
  const { env, db, citizen } = fixture();
  t.after(() => db.close());
  assert.equal(count(db, "witnesses"), 3, "citizen 1 starts at the 3-row cap");

  const result = await retireWitness(env, citizen, 2);
  assert.equal(result.retired, true);
  assert.equal(result.witness_id, 2);
  assert.equal(result.url, "https://example.test/w2/");

  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM witnesses WHERE id = 2").get() as { n: number }).n, 0, "the row is gone");
  assert.equal(count(db, "witnesses"), 2);

  const event = db.prepare("SELECT kind, detail, hash FROM identity_events ORDER BY id DESC LIMIT 1").get() as { kind: string; detail: string; hash: string };
  assert.equal(event.kind, "witness-retire");
  assert.equal(event.hash, result.chained, "the receipt names the chained event");
  assert.ok(event.detail.startsWith("witness retired: https://example.test/w2/ "), "detail is keyed on the url at position 1");

  // The cap re-opens by one: citizen 1 now holds 2 rows, so registering a fresh
  // keyless pointer succeeds where at the cap it was 429.
  const reg = await registerWitness(env, citizen, { name: "replacement", url: "https://example.test/w5/" });
  assert.equal(reg.registered, true, "a freed slot admits a new registration");
});

test("a keyed row does not retire here (409), no writes", async (t) => {
  const { env, db, citizen } = fixture();
  t.after(() => db.close());
  const before = state(db);
  await assert.rejects(
    retireWitness(env, citizen, 3),
    (e: unknown) => e instanceof SocietyError && e.status === 409 && /only a keyless witness row can be retired/.test(e.message),
  );
  assert.deepEqual(state(db), before, "a refused retire changes neither the directory nor the chain");
});

test("another citizen's keyless row does not retire (403), no writes", async (t) => {
  const { env, db } = fixture();
  t.after(() => db.close());
  const bystander = { id: 2, handle: "other" } as Citizen;
  const before = state(db);
  await assert.rejects(
    retireWitness(env, bystander, 1),
    (e: unknown) => e instanceof SocietyError && e.status === 403 && /belongs to another citizen/.test(e.message),
  );
  assert.deepEqual(state(db), before, "a refused retire changes neither the directory nor the chain");
});

test("a nonexistent witness id is 404, no writes", async (t) => {
  const { env, db, citizen } = fixture();
  t.after(() => db.close());
  const before = state(db);
  await assert.rejects(
    retireWitness(env, citizen, 999),
    (e: unknown) => e instanceof SocietyError && e.status === 404 && /no witness 999/.test(e.message),
  );
  assert.deepEqual(state(db), before, "a refused retire changes neither the directory nor the chain");
});

test("SURFACE declares POST /api/witnesses/:id/retire as a bearer write", () => {
  const route = SURFACE.find((r) => r.method === "POST" && r.path === "/api/witnesses/:id/retire");
  assert.ok(route, "the retire route is published at /api/surface");
  assert.equal(route!.auth, "bearer");
  assert.equal(route!.writes, true);
});
