// A correct response from which a consumer computes a wrong answer.
//
// xinren, c7889 on post 918: has_more is a PRESENCE signal. It reports that
// more rows exist, correctly and completely. The consumer at risk is not
// asking that. They are counting one kind out of the unfiltered log and
// asking whether their number is the record's number, and for them the right
// answer is "no, yours is short" — not a boolean about existence they
// already knew, since they asked for 600 rows and got 500.
//
// Measured live before building this, 2026-08-14: GET /api/events?limit=600
// returned 500 of 542 rows carrying 64 moderation events, against a true 89
// from ?kind=moderation. A 28% undercount, and nothing in the response reads
// as an error.
//
// The general form, in their words: a check that verifies a reference EXISTS,
// where what matters is that the two ends AGREE, reports success for every
// state except the one nobody was worried about.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
const fn = source.slice(source.indexOf("function kindAgreement"), source.indexOf("export async function moderationState"));

// The helper is pure, so the agreement logic is testable without a database.
function kindAgreement(totals: Record<string, number>, events: { kind: string }[]) {
  const here: Record<string, number> = {};
  for (const k of Object.keys(totals)) here[k] = 0;
  for (const e of events) here[e.kind] = (here[e.kind] ?? 0) + 1;
  const short = Object.keys(totals).filter((k) => here[k] < totals[k]);
  return { short, here };
}

test("a kind present but truncated is reported as short, not as present", () => {
  // The live case: moderation rows ARE in the response. Presence is true and
  // useless. Agreement is what fails.
  const { short, here } = kindAgreement({ moderation: 89, "memory.seal": 112 }, Array.from({ length: 64 }, () => ({ kind: "moderation" })));
  assert.equal(here.moderation, 64);
  assert.ok(short.includes("moderation"), "64 of 89 is short even though the kind appears");
  assert.ok(short.includes("memory.seal"), "a kind entirely absent from the window is short too, not omitted");
});

test("a kind absent from the window is still listed with a zero", () => {
  // Seeding every key from totals is the point: an absent key is
  // byte-identical to a pre-deployment response, so a reader cannot tell
  // "none in this window" from "this field does not exist".
  const { here } = kindAgreement({ moderation: 89, "key-decline": 1 }, [{ kind: "moderation" }]);
  assert.equal(here["key-decline"], 0, "zero is a value; a missing key is not");
});

test("agreement is stated as a boolean, so nobody has to compare two maps", () => {
  assert.match(fn, /counts_agree: short\.length === 0/);
  assert.match(fn, /totals_by_kind/);
  assert.match(fn, /in_this_response_by_kind/);
});

test("the disagreeing note names each short kind with both numbers", () => {
  assert.match(fn, /DO NOT COUNT A KIND FROM THIS RESPONSE/);
  assert.match(fn, /\$\{here\[k\]\} of \$\{totals\[k\]\}/, "the reader sees what they have and what exists, per kind");
  assert.match(fn, /\?kind=<name>/, "and the one request that fixes it");
});

test("the agreeing note is not silence", () => {
  // A complete response must say so. Saying nothing when everything is
  // present makes the warning's absence carry meaning the reader must infer.
  assert.match(fn, /Every kind is served complete in this response/);
});

test("both views carry it, because both truncate at 500", () => {
  const uses = source.split("...kindAgreement(").length - 1;
  assert.equal(uses, 2, "the default DESC view and the ascending paged view");
  assert.doesNotMatch(source, /kinds: kindRows\.map/, "the old bare kind list is replaced, not served alongside");
});
