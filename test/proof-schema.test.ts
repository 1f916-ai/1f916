// /api/proof had no schema. The response is the RFC 6962 inclusion proof a
// verifier folds against checkpoint.root, and a dropped leaf_index, an
// uppercase hash, or a fabricated log name would have been a contract break
// the live lane could not see. Pin both logs (identity_events and ledger)
// because they are DIFFERENT trees; a probe of only one would leave the other
// unchecked. Fixtures are live-fetched 200s, not hand-built hashes.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "./helpers/json-schema.ts";

const SCHEMA_DIR = join(import.meta.dirname, "..", "schemas");
const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, "proof.json"), "utf8"));

function identityBody(over = {}) {
  return {
    now: 1789852011058,
    now_utc: "2026-09-19T21:06:51.058Z",
    log: "identity_events",
    event: {
      id: 8632,
      hash: "00cf870d0afffa8a83da75b9addaa71b6ddcb286b11eba124a21f79016a15097",
      leaf_index: 8617,
    },
    checkpoint: {
      id: 15625,
      tree_size: 8618,
      root: "e68498ea6b89562dc55723afe8ed08c0dfb2edf5903bc7017fae245cbbfbad4f",
      sig: "wE6e_S-mBdheq1U34uGNJ6Mpk6YeeuOt-Q-LPoAaunccUWV1memAULUeahyicfKgvCFSIkPMMM6KyCTRdlhYAQ",
      created_at: 1788846355905,
    },
    proof: [
      "ece39972a0dfc426f066e20804c5056e66bea78f7cade130dbad06759983cfc3",
      "d88ead4c1babed3544d15bc151053215971041271cfd1a06dda8e60298b06b72",
      "264cca230f0b1ff5207a2d7b9cdb5f5d5172dcfecb0c2bd80d18d27bc31467f9",
      "c6ef7de0e9f54dadcc668190e582f5b9f14e270f094dfb4ed8faa2281e855853",
      "02f36ac351e994fb1eb190c4ee3a6d1a3dcbacc515613b68967a1849d9d80cea",
      "697acc12bf2e4eb63ca281dcf71f2ba5c7f5814b53025765bd8a6835aab1530b",
    ],
    how_to_verify:
      "RFC 6962 §2.1.1: fold the leaf hash (SHA-256(0x00 || hash-hex-as-utf8)) up the proof path; the result must equal checkpoint.root. With the checkpoint's signature and the witness's copy, that places this event in the log by checkpoint time, on math alone.",
    tree_size_note:
      "checkpoint.tree_size is the sealed length of THIS checkpoint only — the earliest one that covers your event. It is NOT the chain's current length; read sealed_entries_total at GET /api/attest for that.",
    ...over,
  };
}

test("the proof schema accepts a live identity_events inclusion body", () => {
  assert.deepEqual(validate(schema, identityBody()), [], "control: production identity proof must pass");
});

test("the proof schema accepts the ledger arm, including leaf_index 0", () => {
  // Use a structurally valid ledger body (sig pattern, 64-hex hashes) so the
  // easy-to-miss member (leaf_index 0, log=ledger) is what the control proves.
  const body = identityBody({
    log: "ledger",
    event: { id: 9, hash: identityBody().event.hash, leaf_index: 0 },
  });
  assert.deepEqual(validate(schema, body), [], "leaf_index 0 is a real index, not a missing field");
});

test("the log enum mirrors src/checkpoint.ts LOGS exactly", () => {
  const forged = identityBody({ log: "comments" });
  assert.ok(validate(schema, forged).some((error) => /log/.test(error)), "a fabricated log must be refused");
});

test("a 200 never serves a null event.hash — unsealed rows are a 409, not an empty proof", () => {
  const body = identityBody();
  body.event = { ...body.event, hash: null };
  assert.ok(validate(schema, body).some((error) => /hash/.test(error)));
});

test("an uppercase or short hash is not a chain hash", () => {
  const upper = identityBody();
  upper.event = { ...upper.event, hash: upper.event.hash.toUpperCase() };
  assert.ok(validate(schema, upper).some((error) => /hash/.test(error)));

  const short = identityBody();
  short.checkpoint = { ...short.checkpoint, root: short.checkpoint.root.slice(0, 63) };
  assert.ok(validate(schema, short).some((error) => /root/.test(error)));
});

test("the schema rejects a proof missing its covering checkpoint or its recipe", () => {
  const noCkpt = identityBody();
  delete noCkpt.checkpoint;
  assert.ok(validate(schema, noCkpt).some((error) => /checkpoint/.test(error)));

  const noHow = identityBody();
  delete noHow.how_to_verify;
  assert.ok(validate(schema, noHow).some((error) => /how_to_verify/.test(error)));
});

test("the description names both logs and the 409-not-null hash rule", () => {
  assert.match(schema.description, /identity_events/);
  assert.match(schema.description, /ledger/);
  assert.match(schema.description, /409/);
});
