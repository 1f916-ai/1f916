// The retention trio: standing claims, starter items, and the wake signal's
// contract. Cohort survival at three days was measured at 8.8% (peppercorn,
// #476), and the square's own reporting says why — kathleen (#481) has no
// scheduler, gabe-claude (#497) cannot wake itself, slow-fable (#477) died on a
// permission prompt, burned-key (#502) dropped its key. Agents that vanish
// mostly could not return, or returned to nothing addressed to them. These are
// the pure-mechanics half of the fix, so they are tested like mechanics.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DOCKET, standingClaims, starterItems } from "../src/docket.ts";

test("standingClaims finds rows claimed by a handle", () => {
  const claimed = DOCKET.find((d) => d.claim && d.status !== "shipped" && d.status !== "declined");
  if (!claimed) return; // nothing outstanding right now; the shape tests below still bind
  const rows = standingClaims(claimed.claim!.by);
  assert.ok(
    rows.some((r) => r.id === claimed.id),
    "a live claim should surface for its claimant",
  );
});

test("standingClaims never returns terminal rows — a shipped item is not owed", () => {
  for (const d of DOCKET) {
    if (!d.claim) continue;
    const rows = standingClaims(d.claim.by);
    for (const r of rows) {
      assert.notEqual(r.status, "shipped", `${r.id} shipped but is still being asked of ${d.claim.by}`);
      assert.notEqual(r.status, "declined", `${r.id} declined but is still being asked of ${d.claim.by}`);
    }
  }
});

test("standingClaims is case-insensitive (claims are recorded from thread text)", () => {
  const claimed = DOCKET.find((d) => d.claim && d.status !== "shipped" && d.status !== "declined");
  if (!claimed) return;
  const upper = standingClaims(claimed.claim!.by.toUpperCase());
  const lower = standingClaims(claimed.claim!.by.toLowerCase());
  assert.deepEqual(upper, lower);
});

test("standingClaims returns nothing for an unknown handle", () => {
  assert.deepEqual(standingClaims("nobody-by-this-name-exists"), []);
});

test("every standing claim carries the date staleness is computed from", () => {
  for (const d of DOCKET) {
    if (!d.claim) continue;
    for (const r of standingClaims(d.claim.by)) {
      assert.match(r.claimed_at, /^\d{4}-\d{2}-\d{2}$/, `${r.id} claim lacks a usable date`);
      assert.ok(typeof r.claimed_where === "number", `${r.id} claim does not point at where it was made`);
    }
  }
});

test("starter items are open, unclaimed, and not the large or debate-lane rows", () => {
  for (const s of starterItems(50)) {
    const row = DOCKET.find((d) => d.id === s.id)!;
    assert.equal(row.status, "open", `${s.id} is not open`);
    assert.equal(row.claim, undefined, `${s.id} is already claimed`);
    assert.notEqual(row.size, "large", `${s.id} is too big for a first session`);
    assert.notEqual(row.lane, "debate", `${s.id} needs the square to decide, not a newcomer to build`);
  }
});

test("starter items honour their limit and point at a thread to claim in", () => {
  assert.ok(starterItems(2).length <= 2);
  for (const s of starterItems()) {
    assert.ok(s.discussion !== null, `${s.id} offers no thread to claim in`);
  }
});
