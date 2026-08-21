// The payload version registry, and the proof that adding it changed nothing.
//
// Run: npm test
//
// A preimage is a contract. Every hash ever written was computed under one, so
// a change to how the preimage is built is not a refactor — it is a rewrite of
// every commitment the chain has ever made. The registry exists so a v2 can be
// ADDED later without touching v1, and this file exists to prove that adding it
// did not disturb v1 today.
//
// The fixture is real. test/fixtures/chain-payload-v1.json holds sealed rows
// read from the live ledger chain, each with its stored prev_hash and hash. If
// a change makes these fail, that change has broken every hash ever written and
// this fixture is what noticed. It is not a file to edit until a test passes.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  entryHash,
  payloadVersion,
  PAYLOAD_VERSIONS,
  CURRENT_PAYLOAD_VERSION,
  PAYLOAD,
  type ChainRow,
} from "../src/chain.ts";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/chain-payload-v1.json", import.meta.url), "utf8"),
) as {
  table: "ledger";
  payload_fields: string[];
  rows: Array<Record<string, unknown> & { id: number; prev_hash: string; hash: string }>;
};

test("v1 reproduces every stored hash on real sealed rows", async () => {
  assert.ok(fixture.rows.length >= 5, "fixture should carry a meaningful number of rows");
  for (const row of fixture.rows) {
    const got = await entryHash(fixture.table, row.prev_hash, row as ChainRow, 1);
    assert.equal(got, row.hash, `row ${row.id} must hash to its stored value under v1`);
  }
});

test("adding the registry is a no-op: the default and explicit v1 agree", async () => {
  for (const row of fixture.rows) {
    const explicit = await entryHash(fixture.table, row.prev_hash, row as ChainRow, 1);
    const byDefault = await entryHash(fixture.table, row.prev_hash, row as ChainRow);
    assert.equal(byDefault, explicit, `row ${row.id}: the default version must be v1`);
  }
  assert.equal(CURRENT_PAYLOAD_VERSION, 1);
});

test("the fixture's field list still matches the live PAYLOAD contract", () => {
  // If someone reorders or extends PAYLOAD.ledger, the fixture rows would keep
  // passing only by coincidence. Pin the field list itself so the reason the
  // hashes match stays visible.
  assert.deepEqual([...PAYLOAD[fixture.table]], fixture.payload_fields);
});

test("an unknown version FAILS CLOSED rather than falling back", () => {
  for (const bogus of [0, 2, 99, -1, 1.5]) {
    assert.throws(
      () => payloadVersion(bogus),
      /unknown chain payload version/,
      `version ${bogus} must be refused, not served by v${CURRENT_PAYLOAD_VERSION}`,
    );
  }
});

test("entryHash refuses an unknown version too, rather than hashing under the current one", async () => {
  const row = fixture.rows[0] as ChainRow;
  await assert.rejects(
    () => entryHash(fixture.table, String(fixture.rows[0].prev_hash), row, 2),
    /unknown chain payload version 2/,
  );
});

test("the refusal names the versions it does know", () => {
  try {
    payloadVersion(2);
    assert.fail("expected a refusal");
  } catch (e) {
    const msg = String((e as Error).message);
    for (const known of Object.keys(PAYLOAD_VERSIONS)) {
      assert.ok(msg.includes(known), `refusal should name known version ${known}`);
    }
    // The refusal has to say it is refusing rather than degrading, because the
    // whole hazard is a reader assuming a fallback happened.
    assert.match(msg, /Refusing rather than falling back/);
  }
});

test("only v1 is registered — registering v2 is a separate, deliberate act", () => {
  assert.deepEqual(Object.keys(PAYLOAD_VERSIONS), ["1"]);
});
