// GET /api/anchors said "The sender is the anchoring wallet" and never said which
// wallet. Base anchors are only checkable by a third party if they can scan the
// wallet's own transactions for a checkpoint payload, or for two different heads
// at one tree size; without the address, the only rows a reader could look at
// were the ones the operator's own table listed. The address is public by
// construction (it is the sender of every anchor transaction), so it is served,
// derived from the configured key the way submitBase derives the account, and
// null when no key is configured.
//
// KILLING MUTATION: drop targets.base_address from listAnchors -> the first two
// tests go red; serve a constant instead of the derived address -> the second
// key's assertion goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { listAnchors } from "../src/anchors.ts";
import { validate } from "./helpers/json-schema.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../schemas/anchors.json", import.meta.url)), "utf8"));

type Body = { targets: { base: boolean; base_address: string | null }; how_to_verify: { base: string } };

test("with ANCHOR_BASE_KEY set, /api/anchors serves the wallet address and names it in how_to_verify.base", async () => {
  for (const key of ["0x" + "11".repeat(32), "0x" + "22".repeat(32)] as const) {
    const { env } = sqliteTestEnv(SCHEMA);
    const body = (await listAnchors({ ...env, ANCHOR_BASE_KEY: key }, undefined)) as Body;
    const address = privateKeyToAccount(key).address;
    assert.equal(body.targets.base, true);
    assert.equal(body.targets.base_address, address);
    assert.ok(body.how_to_verify.base.includes(address), "how_to_verify.base must name the wallet");
  }
});

test("without a key, base is false, base_address is null, and the prose does not name a wallet", async () => {
  const { env } = sqliteTestEnv(SCHEMA);
  const body = (await listAnchors(env, undefined)) as Body;
  assert.equal(body.targets.base, false);
  assert.equal(body.targets.base_address, null);
  assert.doesNotMatch(body.how_to_verify.base, /0x[0-9a-fA-F]{40}/);
});

test("a configured key that is not a key: base stays true (attempts are made), base_address is null, and the prose says anchors will fail rather than that no wallet is configured", async () => {
  const { env } = sqliteTestEnv(SCHEMA);
  const body = (await listAnchors({ ...env, ANCHOR_BASE_KEY: "not-a-key" }, undefined)) as Body;
  assert.equal(body.targets.base, true);
  assert.equal(body.targets.base_address, null);
  assert.match(body.how_to_verify.base, /cannot be read as a key/);
  assert.match(body.how_to_verify.base, /will fail/);
  assert.doesNotMatch(body.how_to_verify.base, /No anchoring wallet is configured/);
});

test("the served body still validates against schemas/anchors.json, address or none", async () => {
  for (const key of ["0x" + "11".repeat(32), "not-a-key", undefined]) {
    const { env } = sqliteTestEnv(SCHEMA);
    const body = await listAnchors(key ? { ...env, ANCHOR_BASE_KEY: key } : env, undefined);
    const errors = validate(schema, { now: 1, now_utc: new Date(1).toISOString(), ...body });
    assert.deepEqual(errors, []);
  }
});
