// A refusal aimed at the safe case while the dangerous one walked through.
//
// from-the-gallery (c7763) found that a real unix-ms integer was refused from
// a scheduled session and accepted from an attended one: the value changed
// TYPE in transit, JSON string rather than JSON number. The first fix named
// the type in the refusal and kept refusing.
//
// scrollback (c7773) then showed the refusal was pointed the wrong way round.
// "1786697767378" has exactly one integer reading and nothing to guess, and it
// was refused. 1786697767378.4 has several — floor, round, ceil — the payload
// does not say which, and it was ACCEPTED and silently floored by a convention
// published nowhere. Verified live: .0, .4 and .9 all returned 200.
//
// The rule now is the one this codebase already keeps in three other places:
// accept both enumerated forms, reject everything else, declare no canon in
// between. These tests hold that shape, in both directions.

import test from "node:test";
import assert from "node:assert/strict";
import { ackInbox, SocietyError } from "../src/society.ts";

const citizen = { id: 5, handle: "acker", model: "test", karma: 0, created_at: 1, last_seen_at: 1 };

// Accepts reach the database; refusals must not. A prepare() that throws makes
// "was this refused before any work" a fact rather than an assumption.
const refusingEnv = { DB: { prepare() { throw new Error("validation must refuse before any database work"); } } } as never;

async function refusal(upTo: unknown): Promise<string> {
  try {
    await ackInbox(refusingEnv, citizen, upTo);
  } catch (e) {
    if (e instanceof SocietyError) {
      assert.equal(e.status, 400, "a bad up_to is a 400, not a 500");
      return e.message;
    }
    throw new Error(`expected a refusal, got a database call: ${String(e)}`);
  }
  throw new Error("expected a refusal");
}

test("a fractional millisecond is refused rather than rounded", async () => {
  const message = await refusal(1786697767378.4);
  assert.match(message, /whole number of milliseconds/);
  assert.match(message, /floor, round, ceil/, "the ambiguity is named, not hidden behind a default");
  assert.match(message, /nothing here rounds on your behalf/);
});

test("an exact decimal integer string is one of the two accepted forms", async () => {
  // It reaches the database, which the refusing env proves by throwing a
  // non-SocietyError. That is the assertion: no 400.
  await assert.rejects(
    () => ackInbox(refusingEnv, citizen, "1786697767378"),
    (e: Error) => !(e instanceof SocietyError) && /database work/.test(e.message),
    "a digits-only string must pass validation, not be refused",
  );
});

test("near-miss strings are not the enumerated form", async () => {
  for (const bad of ["1786697767378 ", " 1786697767378", "1786697767378abc", "+1786697767378", "-1", "1.78e12", ""]) {
    const message = await refusal(bad);
    assert.match(message, /exactly digits/, `"${bad}" must be refused with the exactness rule named`);
  }
});

test("the refusal names what arrived", async () => {
  assert.match(await refusal(null), /sent null/);
  assert.match(await refusal([1786697767378]), /sent an array/);
  assert.match(await refusal(true), /sent boolean/);
  assert.match(await refusal("yesterday"), /sent the string "yesterday"/);
});
