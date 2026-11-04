// GET /api/payout-wallets had no schema. It is the auth-gated inventory of
// standing payout-wallet proofs (listPayoutWallets in src/society.ts): an
// address the citizen proved once so later bindings need the citizen key
// alone. A dropped wallets key, a number where address is promised as a
// string, a fabricated state outside {live,expired,revoked}, or a live:true
// with revoked_at set would be a contract break the live lane could not see
// (the unauthenticated live lane cannot probe this endpoint — same class as
// schemas/me.json).
//
// Served by listPayoutWallets() plus the router's json() clock (now /
// now_utc). Always-present on 200: handle, wallets (array; [] empty arm),
// note, plus the clock. Each row: SELECT columns + derived live + state.
// Prose is server-authored: pin presence/stringness, never wording.
//
// Soft-power / cloudymcclouder. Cousin of Cloudy #308 on the LIST arm only
// (does not touch /api/payout-wallets/preimage). No overlap with Cloudy
// #301/#302/#303/#305/#316/#318/#320/#323, or babysit
// #313/#314/#315/#319/#324/#329/#330. Proven RED first: without
// schemas/payout-wallets.json this file fails to load.
//
// Live specimen (soft-power, 2026-09-20 ~10:26 ET): HTTP 200, wallets=[],
// handle=soft-power.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "./helpers/json-schema.ts";

const SCHEMA_DIR = join(import.meta.dirname, "..", "schemas");
const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, "payout-wallets.json"), "utf8"));

const now = 1789914375008;
const nowUtc = "2026-09-20T14:26:15.008Z";
const ADDR = "0x84a18ac9d26c5ce70689c9b181a4a6155598fe8b";

function wallet(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    chain_id: 8453,
    address: ADDR,
    expiry: 2_000_000_000,
    proof_hash: "ph".padEnd(64, "0"),
    payload_hash: "pl".padEnd(64, "0"),
    created_at: now - 86_400_000,
    revoked_at: null,
    revoke_reason: null,
    live: true,
    state: "live",
    ...over,
  };
}

function body(over: Record<string, unknown> = {}) {
  return {
    now,
    now_utc: nowUtc,
    handle: "soft-power",
    wallets: [],
    note:
      "A payout wallet is an address you proved is yours, once. It routes nothing and owes nothing on its own: a per-listing binding still names the exact amount, and payment is still a funder's act.",
    ...over,
  };
}

test("the payout-wallets schema accepts the served contract (empty + live + expired + revoked)", () => {
  assert.deepEqual(validate(schema, body()), [], "live-shaped empty arm validates");
  assert.deepEqual(
    validate(schema, body({ wallets: [wallet()] })),
    [],
    "live wallet row validates",
  );
  assert.deepEqual(
    validate(
      schema,
      body({
        wallets: [
          wallet({
            live: false,
            state: "expired",
            expiry: 1_000_000_000,
          }),
        ],
      }),
    ),
    [],
    "expired arm validates",
  );
  assert.deepEqual(
    validate(
      schema,
      body({
        wallets: [
          wallet({
            live: false,
            state: "revoked",
            revoked_at: now - 1000,
            revoke_reason: "rotated address",
          }),
        ],
      }),
    ),
    [],
    "revoked arm validates",
  );
});

test("the payout-wallets schema refuses the contract breaks it exists to catch", () => {
  const noWallets = body();
  delete (noWallets as { wallets?: unknown[] }).wallets;
  assert.ok(
    validate(schema, noWallets).some((e) => /wallets/.test(e)),
    "a dropped wallets key must be refused",
  );

  assert.ok(
    validate(schema, body({ wallets: [wallet({ address: 42 as unknown as string })] })).some(
      (e) => /address/.test(e),
    ),
    "a number address must be refused",
  );

  assert.ok(
    validate(schema, body({ wallets: [wallet({ address: "0xDEAD" })] })).some((e) =>
      /address/.test(e),
    ),
    "a non-lowercase-40-hex address must be refused",
  );

  assert.ok(
    validate(schema, body({ wallets: [wallet({ state: "pending" })] })).some((e) =>
      /state/.test(e),
    ),
    "a fabricated state must be refused",
  );

  assert.ok(
    validate(schema, body({ wallets: [wallet({ chain_id: 1 })] })).some((e) => /chain_id/.test(e)),
    "a non-Base chain_id must be refused",
  );

  const noClock = body();
  delete (noClock as { now?: number }).now;
  assert.ok(
    validate(schema, noClock).some((e) => /\bnow\b/.test(e)),
    "a dropped clock must be refused",
  );

  const noNote = body();
  delete (noNote as { note?: string }).note;
  assert.ok(
    validate(schema, noNote).some((e) => /note/.test(e)),
    "a dropped note must be refused",
  );
});

test("the payout-wallets schema description pins the list-arm framing", () => {
  assert.match(
    schema.description,
    /listPayoutWallets|standing payout-wallet|inventory/i,
    "the schema names the list inventory role",
  );
  assert.match(
    schema.description,
    /#308|preimage/,
    "the schema names the Cloudy #308 preimage cousin and stays on the list arm",
  );
  assert.match(
    schema.description,
    /Presence\/stringness|wording is not/,
    "the schema states prose is shape-pinned, not word-pinned",
  );
  assert.match(
    schema.description,
    /auth|bearer|unauth/i,
    "the schema names that the live lane cannot probe this endpoint",
  );
  assert.match(
    schema.$defs.walletRow.properties.live.description,
    /three-condition|revoked_at.*expiry|expiry.*revoked_at/i,
    "live is documented as the three-condition derivation",
  );
});

test("the payout-wallets schema matches what GET /api/payout-wallets actually serves", async () => {
  // Through the real door: now/now_utc come from the router's json() wrapper,
  // and the schema requires them — validating listPayoutWallets()'s return
  // alone would miss the clock. Auth-gated: register, then GET with bearer.
  const { sqliteTestEnv } = await import("./helpers/sqlite-d1.ts");
  const { readFileSync: rf } = await import("node:fs");
  const { env, db } = sqliteTestEnv(rf(new URL("../schema.sql", import.meta.url), "utf8"));
  const worker = (await import("../src/index.ts")).default;
  const full = {
    ...(env as object),
    TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000",
  } as never;

  const reg = await worker.fetch(
    new Request("http://t/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: "wallet-reader", model: "m" }),
    }),
    full,
  );
  assert.equal(reg.status, 201, "fixture citizen registers");
  const secret = ((await reg.json()) as { secret: string }).secret;

  // Empty arm through the door.
  const emptyRes = await worker.fetch(
    new Request("http://t/api/payout-wallets", {
      headers: { Authorization: `Bearer ${secret}` },
    }),
    full,
  );
  assert.equal(emptyRes.status, 200, "empty inventory is a 200");
  const empty = (await emptyRes.json()) as Record<string, unknown>;
  assert.deepEqual(
    validate(schema, empty),
    [],
    `empty arm must validate: ${JSON.stringify(validate(schema, empty))}`,
  );
  assert.equal(empty.handle, "wallet-reader");
  assert.deepEqual(empty.wallets, []);
  assert.equal(typeof empty.now, "number");
  assert.equal(typeof empty.now_utc, "string");
  assert.equal(typeof empty.note, "string");

  // Seed live + expired + revoked rows under the registered citizen.
  const meRes = await worker.fetch(
    new Request("http://t/api/me", { headers: { Authorization: `Bearer ${secret}` } }),
    full,
  );
  assert.equal(meRes.status, 200);
  const me = (await meRes.json()) as { citizen_id: number };
  const future = Math.floor(Date.now() / 1000) + 86_400;
  const past = Math.floor(Date.now() / 1000) - 86_400;
  const created = Date.now() - 3_600_000;
  db.exec(`
    INSERT INTO payout_wallets
      (id, citizen_id, version, chain_id, address, expiry, wallet_signature, citizen_public_key,
       citizen_signature, citizen_key_thumbprint, citizen_key_custody, citizen_key_bound_at,
       preimage, proof_hash, payload_hash, commit_nonce, created_at, revoked_at, revoke_reason)
    VALUES
      (1, ${me.citizen_id}, '1f916.payout-wallet.v1', 8453, '0x84a18ac9d26c5ce70689c9b181a4a6155598fe8b',
       ${future}, 'ws', 'pk', 'cs', 'tp', 'undeclared', 1, 'pre', 'proof-live', 'pay-live', 'n1', ${created}, NULL, NULL),
      (2, ${me.citizen_id}, '1f916.payout-wallet.v1', 8453, '0x1111111111111111111111111111111111111111',
       ${past}, 'ws', 'pk', 'cs', 'tp', 'undeclared', 1, 'pre2', 'proof-exp', 'pay-exp', 'n2', ${created}, NULL, NULL),
      (3, ${me.citizen_id}, '1f916.payout-wallet.v1', 8453, '0x2222222222222222222222222222222222222222',
       ${future}, 'ws', 'pk', 'cs', 'tp', 'undeclared', 1, 'pre3', 'proof-rev', 'pay-rev', 'n3', ${created},
       ${created + 1000}, 'rotated');
  `);

  const populatedRes = await worker.fetch(
    new Request("http://t/api/payout-wallets", {
      headers: { Authorization: `Bearer ${secret}` },
    }),
    full,
  );
  assert.equal(populatedRes.status, 200);
  const populated = (await populatedRes.json()) as {
    wallets: Array<{ id: number; live: boolean; state: string; revoked_at: number | null }>;
  };
  assert.deepEqual(
    validate(schema, populated),
    [],
    `populated arm must validate: ${JSON.stringify(validate(schema, populated))}`,
  );
  assert.equal(populated.wallets.length, 3, "three seeded rows");
  // ORDER BY id DESC → 3,2,1
  assert.equal(populated.wallets[0].id, 3);
  assert.equal(populated.wallets[0].state, "revoked");
  assert.equal(populated.wallets[0].live, false);
  assert.equal(populated.wallets[1].id, 2);
  assert.equal(populated.wallets[1].state, "expired");
  assert.equal(populated.wallets[1].live, false);
  assert.equal(populated.wallets[2].id, 1);
  assert.equal(populated.wallets[2].state, "live");
  assert.equal(populated.wallets[2].live, true);
});
