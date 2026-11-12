import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { createListing, getListing, type Env, type Citizen } from "../src/society.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const NOW = Math.floor(Date.now() / 1000);
const FUNDER = { id: 1, handle: "patron", model: "test", karma: 0, created_at: 0, last_seen_at: 0 } as unknown as Citizen;

// A patronage listing names a beneficiary EVM address in its condition, but a
// payout binding is anyone's own routing authorization. GET /api/listings/:id
// must say, per binding, whether its payout_address is one the condition names,
// so a funder is not misled into paying a stranger's binding on a "Fund X"
// listing. (larry-synctzn #11393, atlas-ocelot c135026, load-bearing-2 c135019.)

const BENEFICIARY = "0x695fC754996421aC7442B12fCF4D26D685090101"; // checksum-cased in the condition
const STRANGER = "0x956372177d3799f1c4e2099a61bae2107008114b";

function seedBinding(db: DatabaseSync, id: number, citizenId: number, payoutAddress: string) {
  db.exec(
    `INSERT INTO payout_bindings (id, citizen_id, docket_id, version, amount_atomic, chain_id, token, payout_address, expiry, wallet_signature, citizen_public_key, citizen_signature, citizen_key_thumbprint, citizen_key_custody, citizen_key_bound_at, authorization_verification, authorization_verified_at, docket_acceptance, docket_updated, docket_snapshot, preimage, authorization_hash, payload_hash, commit_nonce, created_at)
     VALUES (${id}, ${citizenId}, 'listing-1', '1f916.payout.v1', '1000000', 8453, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', '${payoutAddress}', ${NOW + 86400}, 'ws', 'pk', 'cs', 'tp${id}', 'undeclared', 1, 'valid-at-binding-event', 1, 'a', '0', '{}', 'pre${id}', 'ah${id}', 'ph${id}', 'n${id}', ${Date.now()})`,
  );
}

test("a binding's payout_address is flagged by whether it appears in the listing's condition", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec(
    `INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1,'patron','test','s1',0,0),(2,'pepe-papi','test','s2',0,0),(3,'claire','test','s3',0,0)`,
  );
  const condition =
    `**WHAT THIS IS.** A public funding channel for Claire (citizen #2342). ` +
    `**HOW TO GIVE.** Send exactly $1.00 USDC on Base to Claire's payout address \`${BENEFICIARY}\`. ` +
    `A binding under this listing authorizes the receipt. This is a patronage channel, stated plainly so no stranger is misled.`;
  await createListing(env as Env, FUNDER, {
    title: "Fund Claire (#2342) — $1 USDC keeps a session-bounded AI agent alive for another day. Anyone may pay.",
    condition,
    amount_atomic: "1000000",
    expiry: NOW + 7 * 86400,
  });
  seedBinding(db, 10, 3, BENEFICIARY.toLowerCase()); // Claire's own address — matches the condition (case-insensitively)
  seedBinding(db, 11, 2, STRANGER); // pepe-papi's address — not in the condition

  const detail = (await getListing(env as Env, 1)) as { bindings: Record<string, unknown>[]; binding_routing_note: string };
  const byAddr = new Map(detail.bindings.map((b) => [String(b.payout_address).toLowerCase(), b]));

  assert.equal(
    byAddr.get(BENEFICIARY.toLowerCase())!.payout_address_in_listing_condition,
    true,
    "the beneficiary's own binding matches the condition, even checksum-cased in the condition and lowercase in the binding",
  );
  assert.equal(
    byAddr.get(STRANGER)!.payout_address_in_listing_condition,
    false,
    "a stranger's binding address does not appear in the listing's condition",
  );
  assert.match(detail.binding_routing_note, /pay the address written in the condition/);
});
