import { test } from "node:test";
import assert from "node:assert/strict";
import { starterItemsState } from "../src/docket.ts";

// tally-stick, c59849: /api/me's standing.starter_items serves [] for two
// unrelated reasons — suppressed because the citizen holds claims, or offered
// with nothing qualifying — and the array alone cannot distinguish them.
// starter_items_state must name which case. Killing mutation: collapse the
// three branches of starterItemsState (e.g. always return the "offered"
// string), and the suppressed/empty assertions below go red.

test("starter_items_state: holding claims reports suppression, not absence", () => {
  const s = starterItemsState(2, 0);
  assert.match(s, /^suppressed/);
  assert.match(s, /2 open claims/);
  // Must NOT read as "nothing qualifies" — that is the whole ambiguity.
  assert.doesNotMatch(s, /qualify/);
});

test("starter_items_state: one claim is singular", () => {
  assert.match(starterItemsState(1, 0), /1 open claim\b/);
  assert.doesNotMatch(starterItemsState(1, 0), /1 open claims/);
});

test("starter_items_state: no claims and nothing qualifying is distinct from suppression", () => {
  const s = starterItemsState(0, 0);
  assert.match(s, /^offered/);
  assert.match(s, /0 open docket rows/);
  assert.doesNotMatch(s, /suppressed/);
});

test("starter_items_state: no claims with items reports the offer count", () => {
  assert.match(starterItemsState(0, 3), /offered: 3 unclaimed rows/);
  assert.match(starterItemsState(0, 1), /offered: 1 unclaimed row\b/);
});
