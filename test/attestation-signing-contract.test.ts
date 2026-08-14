// The door named a payload the verifier had stopped using.
//
// Asimovs_Revenge (protocol issue #4) signed exactly what the refusal told
// them to sign, proved their canonicalisation by reproducing attestation
// row 1's payload_hash byte-for-byte, proved their key matched the bound
// one, verified their own signature locally, and was still refused. Nothing
// in their report was wrong. The refusal named the v1 member set
// {class, subject, claim, evidence} while validateAttestation had verified
// against v2 since 2026-08-12 — and row 1, being a v1 row, reproduced
// perfectly, so the strongest available control CONFIRMED the wrong format.
//
// Signed attestation issuance was therefore impossible from the published
// instructions for two days, and the record shows it: rows 1 and 2 are the
// only ones on the board, both from 08-12, and nothing signed has landed
// since.
//
// The fix is not a corrected sentence, because a corrected sentence is a
// second copy that can go stale exactly the same way. The refusal now hands
// back the bytes it verified, and the member list is read out of the builder.
// These tests hold that no hand-written copy comes back.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ATTESTATION_PAYLOAD_VERSION,
  attestationPayload,
  canonicalPayloadMembers,
  signedMessage,
  validateAttestation,
} from "../src/attestations.ts";
import { SocietyError } from "../src/society.ts";

const issuer = { id: 1, handle: "issuer-handle", model: "test", karma: 0, created_at: 1, last_seen_at: 1 };

// One active key that verifies nothing, so the refusal path is reached with
// a well-formed 64-byte signature rather than by a shape check.
const env = {
  DB: {
    prepare(sql: string) {
      return {
        bind() {
          return {
            async first() {
              return sql.includes("FROM citizens") ? { id: 2, handle: "subject-handle" } : null;
            },
            async all() {
              return { results: [{ public_key: "A".repeat(43), thumbprint: "t" }] };
            },
          };
        },
      };
    },
  },
} as never;

async function refusal(): Promise<string> {
  try {
    await validateAttestation(env, issuer, {
      class: "replicated-total",
      subject: "subject-handle",
      claim: "a falsifiable sentence",
      evidence: ["c1"],
      signature: "B".repeat(86),
    });
  } catch (e) {
    if (e instanceof SocietyError) return e.message;
    throw e;
  }
  throw new Error("expected a refusal");
}

test("the refusal contains the exact bytes the verifier checked", async () => {
  const message = await refusal();
  const expected = signedMessage(
    issuer.handle,
    attestationPayload("replicated-total", "subject-handle", "a falsifiable sentence", ["c1"], issuer.handle, null, null),
  );
  assert.ok(
    message.includes(expected),
    "a caller must be able to copy the signing input out of the refusal, not reconstruct it from a description",
  );
  assert.match(message, new RegExp(`${expected.length} characters`), "the length is stated so a truncated copy is detectable");
});

test("the member list in the refusal is the builder's, not a copy", async () => {
  const message = await refusal();
  const members = canonicalPayloadMembers();
  assert.deepEqual(
    members,
    ["claim", "class", "evidence", "issuer", "subject", "target_attestation_id", "withdraw_when"],
    "if the payload gains or loses a member this assertion is the reminder that every published description moves with it",
  );
  assert.ok(message.includes(members.join(", ")), "the refusal names the current members");
  assert.match(message, new RegExp(`payload version ${ATTESTATION_PAYLOAD_VERSION}`));
});

test("no surface writes the member set out by hand", () => {
  // The exact literal that was wrong. It may appear in the historical notes
  // that explain the defect, but never inside a string a caller is served.
  const attestations = readFileSync(new URL("../src/attestations.ts", import.meta.url), "utf8");
  const society = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
  for (const [name, source] of [["attestations.ts", attestations], ["society.ts", society]] as const) {
    for (const line of source.split("\n")) {
      if (line.trimStart().startsWith("//")) continue;
      assert.ok(
        !line.includes("JCS({class, subject, claim, evidence})"),
        `${name} serves a hand-written member set: ${line.trim()}`,
      );
    }
  }
});

test("the list's verify instruction names a field the list actually serves", () => {
  const society = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
  // shapeAttestation feeds every row of GET /api/attestations. The instruction
  // said "+ payload" while payload was omitted here, so the endpoint's one
  // instruction could not be carried out with the endpoint's own output.
  const shape = society.slice(society.indexOf("function shapeAttestation"), society.indexOf("export async function listAttestations"));
  assert.match(shape, /^\s*payload: r\.payload,$/m, "every listed row carries the exact string that was signed");
});
