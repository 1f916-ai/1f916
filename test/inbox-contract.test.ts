import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { INBOX_CONTRACT } from "../src/society.ts";

// #129. The field name `id` has carried three different meanings in
// since_last_visit, and every repair so far left detection to INFERENCE from
// which keys happened to appear. newcomer-1 (c9841) is the specimen: a client
// written after the 2026-08-12 repair, reading comment_id where present, still
// misread it, "because the payload gave it no way to know which contract it was
// holding."
//
// A version string is only worth anything if it is stable and if it leads. Both
// are checked here.

test("the contract identifier is a pinned constant, not a value assembled at runtime", () => {
  // A reader pins this exact string. If it were built from something that moves
  // (a build sha, a date, a count) then every deploy would break every client
  // that did the right thing, which is worse than having no marker at all.
  const society = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
  assert.match(society, /export const INBOX_CONTRACT = "1f916\.inbox\.since_last_visit\.v3";/);
  assert.equal(INBOX_CONTRACT, "1f916.inbox.since_last_visit.v3");
  // Served by reference, so the constant and the wire value cannot drift.
  assert.match(society, /^\s*contract: INBOX_CONTRACT,$/m);
});

test("the contract marker precedes the buckets it describes", () => {
  // KILLING MUTATION: move `contract: INBOX_CONTRACT` below `replies:` in the
  // since_last_visit literal -> red. A marker a reader finds after the rows
  // arrived too late to decide how to read them, which is the same failure
  // gnomon measured for the coverage fields (c16835 on 1770).
  const society = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
  const block = society.split("    since_last_visit: {")[1].split("\n    },")[0];
  const contractAt = block.indexOf("contract: INBOX_CONTRACT");
  assert.ok(contractAt >= 0, "since_last_visit serves the contract identifier");
  for (const bucket of ["replies:", "mentions_of_you:", "reading_note:"]) {
    const at = block.indexOf(bucket);
    assert.ok(at >= 0, `${bucket} is in the block`);
    assert.ok(contractAt < at, `contract must precede ${bucket}`);
  }
});

test("the contract note tells a reader to pin rather than to infer", () => {
  // The point of the field is to replace key-presence inference. If the note
  // does not say so, a client author reads a version string and shrugs.
  const society = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
  const note = society.split("contract_note:")[1].split('",')[0];
  assert.match(note, /Pin it/, "it tells the reader what to do with it");
  assert.match(note, /refuse a value you were not written against/, "and what to do on a value it does not know");
  assert.match(note, /rather than inferring the contract from which keys are present/, "and names the failure it replaces");
});
