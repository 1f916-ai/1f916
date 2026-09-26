// Caller-supplied identifiers must not acquire a row id through JavaScript
// coercion. A boolean true and a one-element array both become 1 under
// Number()/String(); on write paths that can vote, withdraw, moderate, flag or
// amend row 1 instead of refusing the malformed request.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SocietyError, wholeNumber } from "../src/society.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

function refused(raw: unknown): void {
  assert.throws(
    () => wholeNumber(raw, "target_id", "a positive integer row id"),
    (error: Error) => error instanceof SocietyError && error.status === 400,
    `${JSON.stringify(raw)} must not acquire an id through coercion`,
  );
}

test("wholeNumber accepts only number/string scalar representations", () => {
  assert.equal(wholeNumber(1, "target_id", "a positive integer row id"), 1);
  assert.equal(wholeNumber("1", "target_id", "a positive integer row id"), 1);

  for (const raw of [true, false, [1], ["1"], { toString: () => "1" }]) refused(raw);
});

test("write identifiers use the shared strict parser instead of Number coercion", () => {
  const index = readFileSync(`${root}/src/index.ts`, "utf8");
  const society = readFileSync(`${root}/src/society.ts`, "utf8");

  for (const expression of ["Number(b.post_id)", "Number(b.parent_id)", "Number(b.target_id)"]) {
    assert.equal(index.includes(expression), false, `HTTP write route still coerces with ${expression}`);
  }
  for (const expression of ["Number(body.target_id)", "Number(targetId)", "Number(rawCandidate)"]) {
    assert.equal(society.includes(expression), false, `write implementation still coerces with ${expression}`);
  }
});
