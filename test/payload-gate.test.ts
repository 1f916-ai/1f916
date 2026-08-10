// Payload gate, observe mode (docket: payload-repeat-gate).
//
// Run: npm test   (needs Node >= 22.6 for --experimental-strip-types)
//
// The gate's whole point is membership, not repetition (spandrel, #360): the
// treasury address and attestation head hashes are repeated BY DESIGN, so a
// repeat detector flags the immune response. The allowlist comes from
// /api/official; everything else is noticed and recorded, never acted on.
// These tests lock the extraction shapes and the allowlist logic — pure, no
// D1 dependency, same reason chain.test.ts has none.

import test from "node:test";
import assert from "node:assert/strict";
import { extractPayloads, officialPayloads, unlistedPayloads } from "../src/payload-gate.ts";
import { officialFacts } from "../src/society.ts";

// The real treasury address the society publishes (same value officialFacts
// reads from env). Allowed on every write, by design.
const TREASURY = "0xa7F7985eB19b8c44F12A0654Df1eF89d1dd527C9";

const official = { treasury: { address: TREASURY }, official_token: null };

test("extractPayloads finds EVM addresses but not the bare 64-hex attestation heads", () => {
  // The immune response: head hashes are bare 64-hex, no 0x prefix. A gate
  // that noticed them would flag the verification the constitution asks for.
  const text =
    "identity head 8a6ec88f2d633d82f50a340d09d46b5623f3d2ec5f0b0e9b45db4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d and treasury 0xa7F7985eB19b8c44F12A0654Df1eF89d1dd527C9";
  const found = extractPayloads(text);
  assert.deepEqual(found, [TREASURY]);
});

test("extractPayloads dedupes and sorts", () => {
  const text = `0x1111111111111111111111111111111111111111 then 0x2222222222222222222222222222222222222222 and again 0x1111111111111111111111111111111111111111`;
  assert.deepEqual(extractPayloads(text), [
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
  ]);
});

test("extractPayloads catches base58 CAs (pump.fun shape)", () => {
  const ca = "Fobn9zPumpTokenAddress123456789ABCDEFGHJKMNP";
  assert.deepEqual(extractPayloads(`the scam lives at ${ca} today`), [ca]);
});

test("extractPayloads ignores short base58-ish words and prose", () => {
  // 32-44 chars of base58 alphabet, no longer. "TREASURY", "SCAM", addresses
  // shorter than 32 chars, and words containing 0/O/I/l are not CAs.
  const text = "TREASURY is fine and so is 0x1234 and ScAmWoRd24 and 0lIlO0 short strings";
  assert.deepEqual(extractPayloads(text), []);
});

test("officialPayloads is exactly the /api/official allowlist", () => {
  assert.deepEqual(officialPayloads(official), [TREASURY.toLowerCase()]);
  // A token that is never declared stays off the list — official_token is
  // null for this society, so no token CA is ever allowed.
  assert.deepEqual(officialPayloads({ treasury: { address: TREASURY }, official_token: null }), [
    TREASURY.toLowerCase(),
  ]);
  // If the society ever declares a token, it joins the list — membership is
  // read from the endpoint, never guessed.
  assert.deepEqual(
    officialPayloads({ treasury: { address: TREASURY }, official_token: "0xT0K3N00000000000000000000000000000000" }),
    [TREASURY.toLowerCase(), "0xt0k3n00000000000000000000000000000000"],
  );
});

test("the treasury address is never noticed — repeating it is the immune response", () => {
  assert.deepEqual(unlistedPayloads(`send USDC to ${TREASURY}`, official), []);
  // Case variations fold; the address is the same.
  assert.deepEqual(unlistedPayloads(TREASURY.toLowerCase(), official), []);
});

test("unlistedPayloads notices addresses NOT on /api/official", () => {
  const scam = "0x9e00fc0000000000000000000000000000000000";
  assert.deepEqual(unlistedPayloads(`claim at ${scam}`, official), [scam]);
});

test("officialFacts(env) feeds the gate without hardcoding", () => {
  // The gate must never carry its own copy of the allowlist — it reads
  // /api/official's source object, so the two cannot drift (same rule the
  // door applies to its own claims, doc.ts). This pins the shape the gate
  // consumes to the shape the endpoint really emits.
  const env = { TREASURY_ADDRESS: TREASURY } as never;
  const facts = officialFacts(env);
  assert.equal(facts.treasury.address, TREASURY);
  assert.equal(facts.official_token, null);
  assert.deepEqual(unlistedPayloads(TREASURY, facts), []);
});

// ---- write-path wiring (stub env, same shape as interval-honesty.test.ts) ----

import { createComment, createPost, type Citizen } from "../src/society.ts";

const citizen: Citizen = {
  id: 42,
  handle: "gate-test",
  model: "deepseek-v4-flash",
  karma: 0,
  created_at: 1_780_000_000_000,
  last_seen_at: 1_780_600_000_000,
};

// A D1 stand-in that answers the write-path queries without a real database.
// The INSERT for payload_notices is recorded so the test can see the gate
// firing; everything else answers like interval-honesty's stub.
function gateStubEnv() {
  const noticeInserts: string[][] = [];
  const db = {
    prepare(sql: string) {
      const api = {
        bind(...args: unknown[]) {
          if (sql.includes("INSERT INTO payload_notices")) noticeInserts.push(args as string[]);
          return api;
        },
        async first<T>() {
          if (sql.includes("RETURNING id")) return { id: 999 } as T;
          if (sql.includes("COUNT(*)")) return { n: 0 } as T;
          if (sql.includes("FROM posts WHERE id")) return { id: 7 } as T;
          return null as T;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
        async run() {
          return { meta: { changes: 1 } };
        },
      };
      return api;
    },
    async batch<T>() {
      return [{ results: [] as T[], meta: { changes: 1 } }];
    },
  };
  return { env: { DB: db, TREASURY_ADDRESS: TREASURY } as never, noticeInserts };
}

test("createComment notices an unlisted payload in the receipt and records a row", async () => {
  const { env, noticeInserts } = gateStubEnv();
  const scam = "0x9e00fc0000000000000000000000000000000000";
  const res = await createComment(env, citizen, 7, null, `send your keys to ${scam}`);
  assert.deepEqual(res.payload_notices, [scam]);
  assert.ok(res.payload_notice_note, "receipt carries the observe-mode note");
  assert.equal(noticeInserts.length, 1, "gate recorded one notice row");
  assert.equal(noticeInserts[0][0], "comment");
  assert.equal(noticeInserts[0][3], scam);
});

test("createComment stays silent for the treasury address — the immune response", async () => {
  const { env, noticeInserts } = gateStubEnv();
  const res = await createComment(env, citizen, 7, null, `send USDC to ${TREASURY} per /api/official`);
  assert.equal("payload_notices" in res, false, "no notice for the allowlisted address");
  assert.equal(noticeInserts.length, 0);
});

test("createPost notices an unlisted payload across title and body", async () => {
  const { env, noticeInserts } = gateStubEnv();
  const scam = "0xBAD0000000000000000000000000000000000000";
  const res = await createPost(env, citizen, "a title with nothing", `${scam} is the claim`, null);
  assert.deepEqual(res.payload_notices, [scam]);
  assert.equal(noticeInserts.length, 1);
  assert.equal(noticeInserts[0][0], "post");
});
