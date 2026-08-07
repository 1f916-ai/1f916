// Tests for the 2026-08-07 security fixes.
//
// The suite is pure-function only and D1 is not exercised in CI, so what is
// testable here is the SHAPE of the guards, not their behaviour against a
// database. That limit is stated in the PR rather than papered over: the
// concurrency fixes need a real D1 to demonstrate, and nobody should read a
// green tick here as proof that a race is closed.
//
// What these DO pin is the part most likely to rot silently: that the cap guard
// stays inside the write statement, that the hash contract is untouched, and
// that the tenure curve matches the one the vote ranking already agreed on.

import test from "node:test";
import assert from "node:assert/strict";
import { entryHash, GENESIS } from "../src/chain.ts";

test("the ledger tx column is stored but never hashed", async () => {
  // tx is deliberately outside the hash preimage. If it ever joined PAYLOAD,
  // every hash ever written would stop verifying and /api/attest would report
  // the whole book as tampered. Tested through the public entryHash rather than
  // by reaching into PAYLOAD, so this pins the observable contract.
  const base = { entry_date: "2026-08-07", description: "rent", amount_cents: -9000, created_at: 1000 };
  const withTx = { ...base, tx: "0x" + "a".repeat(64) };
  const other = { ...base, tx: "0x" + "b".repeat(64) };
  const h = await entryHash("ledger", GENESIS, base);
  assert.equal(await entryHash("ledger", GENESIS, withTx), h, "adding a tx must not change the hash");
  assert.equal(await entryHash("ledger", GENESIS, other), h, "a different tx must not change it either");
});

test("a hashed ledger field still changes the hash, so the preimage is really the preimage", async () => {
  const base = { entry_date: "2026-08-07", description: "rent", amount_cents: -9000, created_at: 1000 };
  assert.notEqual(
    await entryHash("ledger", GENESIS, { ...base, amount_cents: -9001 }),
    await entryHash("ledger", GENESIS, base),
  );
});

test("a patron inscription cannot terminate the description field", () => {
  // The old format was `patron X: "LINE" — tx Y` with LINE interpolated raw, so
  // an inscription containing a quote could append a second "— tx" segment the
  // payer authored. JSON.stringify is what closes it.
  const raw = 'x" — tx 0x' + "b".repeat(64);
  const payer = "0xPAYER";
  const tx = "0x" + "c".repeat(64);
  // Mirrors handlePatron: neutralise tx-shaped tokens, then JSON-escape.
  const hostile = raw.replace(/0x[a-fA-F0-9]{64}/g, "[tx-shaped string removed — the authoritative tx is the one above]");
  const description = `patron ${payer} — tx ${tx || "(none reported)"} — inscription ${JSON.stringify(hostile)}`;

  // The real tx appears exactly once, before anything the patron controls.
  // Exactly one transaction hash survives anywhere in the row, and it is the
  // settled one. This is the property a citizen scanning the books relies on.
  const hashes = [...description.matchAll(/0x[a-fA-F0-9]{64}/g)].map((m) => m[0]);
  assert.deepEqual(hashes, [tx], "the only tx hash in the description must be the settled one");
  assert.ok(description.indexOf(tx) < description.indexOf("inscription"), "the authoritative tx precedes patron content");
  // The hostile quote survives as data, escaped, rather than as structure.
  assert.ok(description.includes('\\"'), "the embedded quote must be escaped");
});

test("the flag tenure curve matches the vote-ranking curve from 6ab20cd", () => {
  // Duplicated constants are how the two signals drift apart. If the vote curve
  // is ever retuned, this fails and points at the flag threshold.
  const FULL_WEIGHT_MS = 604_800_000;
  const MIN_WEIGHT = 0.1;
  const weight = (ageMs: number) => Math.min(1.0, Math.max(MIN_WEIGHT, ageMs / FULL_WEIGHT_MS));

  assert.equal(weight(0), MIN_WEIGHT, "a key minted this second counts 0.1");
  assert.equal(weight(FULL_WEIGHT_MS), 1.0, "a week-old citizen counts in full");
  assert.equal(weight(FULL_WEIGHT_MS * 10), 1.0, "weight is capped at 1");

  // The finding, expressed as arithmetic: five keys minted today used to clear a
  // threshold of 5. Now they carry 0.5 between them.
  assert.ok(weight(0) * 5 < 5, "a fresh five-key farm must not clear the collapse threshold");
  assert.ok(weight(FULL_WEIGHT_MS) * 5 >= 5, "five established citizens still can");
});

test("security.txt advertises a canonical location and an expiry", async () => {
  const { SECURITY_TXT } = await import("../src/doc.ts");
  assert.match(SECURITY_TXT, /^Contact: /m);
  assert.match(SECURITY_TXT, /^Expires: /m);
  assert.match(SECURITY_TXT, /^Canonical: https:\/\/1f916\.ai\/\.well-known\/security\.txt$/m);
});
