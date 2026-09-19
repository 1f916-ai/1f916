// /api/witnesses/:id/history had no schema. The response is a verifier's
// re-derivation input: the register/rotate identity-log rows for one witness,
// plus the pre-chaining disclaimer. Two live arms exist (society.ts
// witnessHistory): a post-2026-08-12 witness serves a populated events array
// and NO predates_chaining key; a pre-chaining witness serves events: [] plus
// predates_chaining, which means NOT RECORDED — not "nothing happened". The
// coupling is pinned one-way (history rows exclude the disclaimer); the
// reverse direction (empty events ⟹ disclaimer present) is stated in the
// schema description because the subset validator has no maxItems to express
// "events is empty".

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "./helpers/json-schema.ts";

const SCHEMA_DIR = join(import.meta.dirname, "..", "schemas");
const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, "witness-history.json"), "utf8"));

// Live-fetched values, not hand-built: the witness block and the register row
// are production's own (GET /api/witnesses/8/history), so a hand-typed hash
// that failed its own pattern cannot hide in the control.
function modernBody(over = {}) {
  return {
    now: 1789834254438,
    now_utc: "2026-09-19T16:10:54.438Z",
    witness: {
      id: 8,
      name: "liveness witness",
      url: "https://raw.githubusercontent.com/wyeshunf/1f916-witness/main/witness-state/countersignatures.jsonl",
      public_key: "NgHCVDwGuYeHX0qnuOKBgufNwgu804x1ZDyTU63sJwE",
      epoch: 0,
      key_set_at: 1788846079060,
      added_at: 1788846079060,
      operator: "liveness",
      alg: "ed25519",
    },
    events: [
      {
        id: 8632,
        kind: "witness-register",
        detail:
          'witness registered: https://raw.githubusercontent.com/wyeshunf/1f916-witness/main/witness-state/countersignatures.jsonl name="liveness witness" key=NgHCVDwGuYeHX0qnuOKBgufNwgu804x1ZDyTU63sJwE epoch=0',
        created_at: 1788846079060,
        prev_hash: "672b9267756f711f361ea96b17de240bec496be99de6b495e0d4a7d3b80f6aa0",
        hash: "00cf870d0afffa8a83da75b9addaa71b6ddcb286b11eba124a21f79016a15097",
      },
    ],
    chained:
      "Each event above is an identity-log row: its hash chains to the previous row and is covered by the next signed checkpoint, so this history is verifiable with the same proofs as anything else. GET /api/proof?log=identity_events&event=<id>.",
    ...over,
  };
}

// The legacy arm, exactly as production serves witness 1: no events, the
// disclaimer present. Not a guess — fetched live (witness 1, pre-chaining).
function legacyBody(over = {}) {
  const body = modernBody({ events: [] });
  body.chained =
    "Each event above is an identity-log row: its hash chains to the previous row and is covered by the next signed checkpoint, so this history is verifiable with the same proofs as anything else. GET /api/proof?log=identity_events&event=<id>.";
  body.predates_chaining =
    "This witness was registered before registration became a chained event (2026-08-12). No history exists for it, which means NOT RECORDED rather than nothing happened. Treat its current key as trust-on-first-use and pin it out of band.";
  return { ...body, ...over };
}

test("the witness-history schema accepts the modern arm: a witness with chain rows and no disclaimer", () => {
  assert.deepEqual(validate(schema, modernBody()), [], "control: a populated history must pass");
});

test("the modern arm must not carry the predates disclaimer — the coupling the schema pins", () => {
  const violated = modernBody({ predates_chaining: "This witness predates chaining." });
  const errors = validate(schema, violated);
  assert.ok(errors.length > 0, "a witness WITH history rows must not carry the NOT RECORDED disclaimer");
  // The refusal must be the implication firing (the then-branch's `not`),
  // not an incidental type failure elsewhere in the document.
  assert.ok(
    errors.some((error) => /matched a forbidden schema/.test(error)),
    `the then-branch not-required guard must be what fires; got: ${JSON.stringify(errors)}`,
  );
});

test("the legacy arm — empty events WITH the disclaimer — still passes", () => {
  assert.deepEqual(validate(schema, modernBody({ events: [], predates_chaining: "not recorded" })), []);
});

test("the schema rejects a history missing its verification prose or wrapper clock", () => {
  const noChained = modernBody();
  delete noChained.chained;
  assert.ok(validate(schema, noChained).some((error) => /chained/.test(error)));

  const noNowUtc = modernBody();
  delete noNowUtc.now_utc;
  assert.ok(validate(schema, noNowUtc).some((error) => /now_utc/.test(error)));
});

test("the kind enum mirrors the source WHERE clause exactly", () => {
  const badKind = modernBody();
  badKind.events[0].kind = "witness-register-forged";
  assert.ok(validate(schema, badKind).length > 0, "a fabricated kind must be refused");
  // the easy-to-miss legitimate member: a rotate row must also pass
  const rotated = modernBody();
  rotated.events = [{ ...rotated.events[0], id: 9001, kind: "witness-rotate", detail: "witness rotated: https://x/ id=1" }];
  assert.deepEqual(validate(schema, rotated), [], "witness-rotate is a real kind and must pass");
});

test("a null chain hash is a distinct, code-anticipated state — not a broken response", () => {
  const pending = modernBody();
  pending.events = [{ ...pending.events[0], hash: null }];
  assert.deepEqual(validate(schema, pending), [], "null hash (awaiting first checkpoint) must pass");

  const shortHash = modernBody();
  shortHash.events[0].hash = "00cf870d0afffa8a83da75b9addaa71b6ddcb286b11eba124a21f79016a150";
  assert.ok(
    validate(schema, shortHash).some((error) => /hash/.test(error)),
    "a 63-character hash is not a chain hash",
  );
});

test("the one-way coupling prose is present in the schema description", () => {
  assert.match(
    schema.description,
    /predates_chaining/,
    "the description must name the disclaimer it conditions on",
  );
  assert.match(
    schema.description,
    /must NOT carry predates_chaining/,
    "the enforced direction must be stated in prose the presence test guards",
  );
});
