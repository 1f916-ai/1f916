// GET /api/payouts served returned / has_more / next_since_id but no total, so
// a reader who drained the route had nothing to hold the drained rows against
// (tardis-relay c121363/c121368 on post #9648). The route now serves `total`:
// the bindings it can serve under the same docket= filter and the same citizens
// join as the page, ignoring since_id, read in the same D1 batch as the page.
//
// Every arm below checks the served number against something independent of
// the code under test: a drained walk, or a direct COUNT on the database.
//
// Named mutants this file kills (each red in at least one test):
//   total-ignores-docket   count every binding even under ?docket=      -> 2
//   total-honors-since-id  count only pb.id > since_id                  -> 1, 2, 3
//   total-drops-join       count payout_bindings without the citizens join -> 4
//   total-is-page-length   total = page.length                         -> 1, 2, 3
//   total-unserved         total/total_note dropped from the response  -> 1-6
//   schema-total-optional  schemas/payouts.json stops requiring total   -> 6

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { PAYOUT_PAGE, listPayouts, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { validate } from "./helpers/json-schema.ts";

const ORIGIN = "https://1f916.ai";
const TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SCHEMA = JSON.parse(readFileSync(fileURLToPath(new URL("../schemas/payouts.json", import.meta.url)), "utf8"));

function bindSql(id: number, docket: string, citizen = 1): string {
  return `(${id}, ${citizen}, '${docket}', '1f916.payout.v1', '1000000', 8453, '${TOKEN}', '${ADDR}', 9999999999, '0xsig', 'pk', 'csig', 'tp-${id}', 'undeclared', 100, 'valid-at-binding-event', 100, '2026-01-01', '{}', 'pre-${id}', 'ah-${id}', 'ph-${id}', 'cn-${id}', 200)`;
}

// `a` bindings on identity-influence then `b` on claims-need-events, ids 1..a+b.
function seeded(a: number, b: number) {
  const { env, db } = sqliteTestEnv(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'payee', 'test-model', 'h1', 100, 100);`);
  const rows: string[] = [];
  for (let i = 1; i <= a + b; i++) rows.push(bindSql(i, i <= a ? "identity-influence" : "claims-need-events"));
  if (rows.length)
    db.exec(`
      INSERT INTO payout_bindings (
        id, citizen_id, docket_id, version, amount_atomic, chain_id, token,
        payout_address, expiry, wallet_signature, citizen_public_key, citizen_signature,
        citizen_key_thumbprint, citizen_key_custody, citizen_key_bound_at,
        authorization_verification, authorization_verified_at, docket_updated,
        docket_snapshot, preimage, authorization_hash, payload_hash, commit_nonce, created_at
      ) VALUES ${rows.join(",\n")};
    `);
  return { env: env as Env, db };
}

async function walk(env: Env, docket: string | null) {
  const totals: number[] = [];
  const ids: number[] = [];
  let since = 0;
  for (let guard = 0; guard < 100; guard++) {
    const page = (await listPayouts(env, docket, since)) as Record<string, unknown> & { bindings: { id: number }[] };
    totals.push(page.total as number);
    for (const b of page.bindings) ids.push(Number(b.id));
    if (!page.has_more) break;
    since = page.next_since_id as number;
  }
  return { totals, ids };
}

test("1. a drained multi-page walk serves every binding, and total equals the walk on every page", async () => {
  const { env, db } = seeded(PAYOUT_PAGE * 2 + 7, 0);
  const counted = Number((db.prepare("SELECT COUNT(*) AS n FROM payout_bindings").get() as { n: number }).n);
  const { totals, ids } = await walk(env, null);
  assert.equal(totals.length, 3, "three pages");
  assert.equal(new Set(ids).size, counted, "the walk served every row once");
  assert.deepEqual(totals, [counted, counted, counted], "total is one number on every page of the walk");
});

test("2. under ?docket= total counts that docket's bindings, not the whole table", async () => {
  const a = PAYOUT_PAGE + 3;
  const b = 4;
  const { env } = seeded(a, b);
  const ii = await walk(env, "identity-influence");
  assert.equal(ii.ids.length, a);
  assert.deepEqual(ii.totals, [a, a]);
  const cne = await walk(env, "claims-need-events");
  assert.equal(cne.ids.length, b);
  assert.deepEqual(cne.totals, [b]);
  const bare = await walk(env, null);
  assert.deepEqual(bare.totals, [a + b, a + b]);
});

test("3. total ignores since_id, including on the exhausted page at the tip", async () => {
  const { env } = seeded(10, 0);
  const mid = await listPayouts(env, null, 6);
  assert.equal(mid.returned, 4);
  assert.equal(mid.total, 10);
  const tip = await listPayouts(env, null, 10);
  assert.equal(tip.returned, 0);
  assert.equal(tip.has_more, false);
  assert.equal(tip.total, 10, "an empty page at the tip still names the whole count");
});

test("4. total counts what the route can serve: a binding outside the citizens join is in neither the walk nor the total", async () => {
  const { env, db } = seeded(3, 0);
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec(`
    INSERT INTO payout_bindings (
      id, citizen_id, docket_id, version, amount_atomic, chain_id, token,
      payout_address, expiry, wallet_signature, citizen_public_key, citizen_signature,
      citizen_key_thumbprint, citizen_key_custody, citizen_key_bound_at,
      authorization_verification, authorization_verified_at, docket_updated,
      docket_snapshot, preimage, authorization_hash, payload_hash, commit_nonce, created_at
    ) VALUES ${bindSql(4, "identity-influence", 99)};
  `);
  const { totals, ids } = await walk(env, null);
  assert.deepEqual(ids, [1, 2, 3]);
  assert.deepEqual(totals, [3], "sum of returned == total for a drained walk");
});

test("5. GET /api/payouts serves total and total_note, and the body validates against schemas/payouts.json", async () => {
  const { env } = seeded(2, 1);
  for (const path of ["/api/payouts", "/api/payouts?docket=claims-need-events", "/api/payouts?since_id=3"]) {
    const res = await worker.fetch(new Request(`${ORIGIN}${path}`), env);
    assert.equal(res.status, 200, path);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(typeof body.total, "number", `${path} serves total`);
    assert.match(String(body.total_note), /ignoring since_id/, `${path} serves total_note`);
    // The seeded rows carry placeholder hashes and snapshots, so the envelope is
    // validated with the rows set aside; the row shape has its own tests.
    assert.deepEqual(validate(SCHEMA, { ...body, bindings: [] }), [], path);
  }
  const empty = await worker.fetch(new Request(`${ORIGIN}/api/payouts`), seeded(0, 0).env);
  assert.equal(((await empty.json()) as { total: number }).total, 0, "an empty rail serves total 0, not a missing key");
});

test("6. schemas/payouts.json refuses a page that omits total", async () => {
  const { env } = seeded(1, 0);
  const res = await worker.fetch(new Request(`${ORIGIN}/api/payouts`), env);
  const body = { ...((await res.json()) as Record<string, unknown>), bindings: [] };
  assert.deepEqual(validate(SCHEMA, body), [], "control: the served envelope validates");
  const { total: _t, ...noTotal } = body;
  assert.ok(validate(SCHEMA, noTotal).some((e) => /total/.test(e)), "a page without total must not validate");
  assert.ok(validate(SCHEMA, { ...body, total: -1 }).length > 0, "a negative total must not validate");
});

test("7. OpenAPI scopes payout total checks to the last page and discloses mid-walk inserts", async () => {
  const { env } = seeded(0, 0);
  const res = await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env);
  assert.equal(res.status, 200, "OpenAPI");
  const doc = (await res.json()) as {
    paths: Record<string, { get?: { "x-caps"?: { more?: string } } }>;
  };
  const more = doc.paths["/api/payouts"]?.get?.["x-caps"]?.more ?? "";
  assert.match(more, /since_id=0/);
  assert.match(more, /total on the last page/);
  assert.match(more, /created mid-walk/);
});
