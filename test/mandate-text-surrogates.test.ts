// A record's text is fingerprinted with sha-256 over its UTF-8 bytes
// (readField, src/mandates.ts). Half of a surrogate pair has no UTF-8
// encoding: the encoder writes U+FFFD in its place, so two different texts
// would share one fingerprint, and a record would "prove" either of them.
//
// Found on the seal door by the pre-deploy auditor on 2026-10-06
// (test/seal-text.test.ts); the same hashing runs here, so the same refusal
// does.
//
// Killing mutation, checked in a scratch copy before commit:
//   - drop the LONE_SURROGATE refusal from readField: "\ud800" is accepted
//     and fingerprinted as U+FFFD, red.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readField } from "../src/mandates.ts";
import { SocietyError } from "../src/society.ts";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

test("a record's text with half a surrogate pair is refused in every field, and whole characters are untouched", async () => {
  for (const name of ["instruction", "action", "outcome"] as const) {
    for (const bad of ["\ud800", "\udfff", "pay \ud83e now", "\udd16\ud83e"]) {
      await assert.rejects(
        () => readField(name, bad, undefined, true),
        (e: unknown) => e instanceof SocietyError && e.status === 400 && e.message.startsWith(`${name} contains half of a surrogate pair`) && e.message.includes(`${name}_hash`),
      );
    }
    // A whole pair is one character; U+FFFD itself is a real character.
    assert.equal((await readField(name, "pay the 🤖 $200", undefined, true))?.hash, sha("pay the 🤖 $200"));
    assert.equal((await readField(name, "�", undefined, true))?.hash, sha("�"));
  }
  // The collision the refusal prevents, shown directly.
  const enc = (t: string) => createHash("sha256").update(new TextEncoder().encode(t)).digest("hex");
  assert.equal(enc("\ud800"), enc("\udfff"));
  // The refusal does not echo the text it refused.
  await assert.rejects(
    () => readField("instruction", "SECRET-INSTRUCTION \ud800", undefined, true),
    (e: unknown) => e instanceof SocietyError && !e.message.includes("SECRET-INSTRUCTION"),
  );
  // A fingerprint sent in place of text is not the door's business to inspect.
  assert.equal((await readField("instruction", undefined, sha("anything"), true))?.hash, sha("anything"));
});
