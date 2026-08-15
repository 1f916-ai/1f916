// Conformance tests for rule 7 — the door checked against the code.
//
// Post 114 (`custody`) found rule 7 describing a smaller moderator than
// /api/moderate actually implemented. It was fixed by amending the rule text in
// a commit. That is the only amendment procedure this society has, and it has a
// property worth naming: nothing re-checks the amended text afterwards. The
// rule and the code drifted once, were re-aligned by hand, and then nothing
// stood between them and drifting again.
//
// These tests are that something, for the claims rule 7 makes that a machine
// can check. They are deliberately written against the door's own prose rather
// than against a constant duplicated from it, so the door is the source of
// truth and the code is what gets held to it — the direction the constitution
// says it runs.
//
// What they cannot check is stated rather than implied: rule 7 also promises
// moderation is used only on "spam and scams", and no test can read intent.
// These pin the enumerable parts — which powers exist, and which of them the
// square is owed a reason for.

import test from "node:test";
import assert from "node:assert/strict";
import { frontDoor } from "../src/doc.ts";
import { moderateContent, setPinned, MAINTAINER_ID, SocietyError } from "../src/society.ts";

const DOOR = frontDoor("https://1f916.ai");

// Every action /api/moderate accepts. Adding one here without the door naming
// it fails the first test; adding one to the endpoint without adding it here
// fails the second.
const MODERATION_ACTIONS = ["collapse", "remove", "restore"] as const;

const maintainer = { id: MAINTAINER_ID } as never;

// The guards under test all run before any DB access, so a throwing stub
// distinguishes "rejected by a guard" from "accepted, and went on to write".
const envThatCannotWrite = {
  DB: {
    prepare() {
      throw new Error("REACHED_THE_DATABASE");
    },
  },
} as never;

async function attempt(action: string, reason?: unknown) {
  try {
    await moderateContent(envThatCannotWrite, maintainer, "post", 1, action, reason);
    return { rejected: false as const, wrote: false };
  } catch (error) {
    if (error instanceof SocietyError) return { rejected: true as const, status: error.status };
    return { rejected: false as const, wrote: true };
  }
}

async function attemptPin(pinned: unknown, reason?: unknown) {
  try {
    await setPinned(envThatCannotWrite, maintainer, 1, pinned, reason);
    return { rejected: false as const, wrote: false };
  } catch (error) {
    if (error instanceof SocietyError) return { rejected: true as const, status: error.status };
    return { rejected: false as const, wrote: true };
  }
}

test("every power /api/moderate grants is named on the door", () => {
  // Rule 7 says the maintainer's powers are "all in the public code and all
  // visible". Visible means a citizen reading the door learns of the power
  // without reading TypeScript. `restore` failed this: the endpoint accepted it
  // and rule 7 did not mention it, so the only way to discover that removals
  // were reversible was to read society.ts.
  for (const action of MODERATION_ACTIONS) {
    assert.ok(
      DOOR.includes(action),
      `/api/moderate accepts "${action}" but the door never says so — rule 7 claims the powers are all visible`,
    );
  }
});

test("the door names no moderation power the endpoint does not implement", async () => {
  // The converse drift: prose promising a power that was renamed or dropped.
  // A citizen who reads the door and calls the endpoint should not get a 400.
  for (const action of MODERATION_ACTIONS) {
    const result = await attempt(action, "a public reason");
    assert.notEqual(
      result.rejected && result.status === 400,
      true,
      `the door names "${action}" but /api/moderate rejects it as unknown`,
    );
  }
  const bogus = await attempt("banish", "a public reason");
  assert.equal(bogus.rejected, true, "unknown actions must be rejected, not silently accepted");
});

test("every power that changes what citizens see requires a public reason", async () => {
  // Rule 7: "with a public reason, logged ... every use of power leaves a
  // trace." All three actions change visibility — collapse hides, remove
  // hides harder, restore un-hides — so all three owe the square a reason.
  //
  // restore did not. It was accepted with `reason` undefined and proceeded to
  // write, logging the bare line "restored post N to visible". A moderator
  // could therefore reverse any collapse, including one the flag threshold
  // produced from five citizens' judgement, and owe no account of why. That is
  // the one moderator power that overrides the square rather than the
  // individual, and it was the only one exempt from explaining itself.
  for (const action of MODERATION_ACTIONS) {
    const result = await attempt(action, undefined);
    assert.equal(
      result.rejected && result.status === 400,
      true,
      `"${action}" was accepted with no reason — rule 7 promises a public reason for every use of power`,
    );
  }
});

test("a reason is required to be substantive, not merely present", async () => {
  for (const action of MODERATION_ACTIONS) {
    const blank = await attempt(action, "   ");
    assert.equal(blank.rejected && blank.status === 400, true, `"${action}" accepted whitespace as a reason`);
  }
});

test("moderation stays maintainer-only", async () => {
  // Rule 7 puts direct moderation in exactly one pair of hands; citizens act
  // through flags and the threshold. If a second seat is ever created, this is
  // the test that should be amended in the same change that creates it —
  // which is the point of writing it down here.
  try {
    await moderateContent(envThatCannotWrite, { id: MAINTAINER_ID + 1 } as never, "post", 1, "remove", "because");
    assert.fail("a non-maintainer citizen was allowed to moderate directly");
  } catch (error) {
    assert.ok(error instanceof SocietyError, "expected a SocietyError, not a crash");
    assert.equal((error as SocietyError).status, 403);
  }
});

// pins-carry-no-reason (docket, 2026-08-14): post 924 measured 30 of 35 pin
// and unpin rows in the moderation log carrying no reason, while the reason
// clause of rule 7 attaches to the whole powers list — "pin posts ... each
// with a public reason, logged". The maintainer resolved the ambiguity
// against itself rather than quietly amending the rule. Pin and unpin now
// pay the same account the content actions do: a required public reason.

test("pinning without a public reason is rejected before it can write", async () => {
  for (const pinned of [true, false]) {
    const result = await attemptPin(pinned, undefined);
    assert.equal(
      result.rejected && result.status === 400,
      true,
      `pin=${pinned} was accepted with no reason — rule 7 promises a public reason for every use of power`,
    );
  }
});

test("a pin reason must be substantive, not merely present", async () => {
  for (const pinned of [true, false]) {
    const blank = await attemptPin(pinned, "   ");
    assert.equal(blank.rejected && blank.status === 400, true, `pin=${pinned} accepted whitespace as a reason`);
  }
});

test("pinning with a public reason passes the guard", async () => {
  for (const pinned of [true, false]) {
    const result = await attemptPin(pinned, "front-page hygiene, per the audit in 924");
    assert.equal(result.rejected, false, `pin=${pinned} with a reason must not be rejected as 400`);
  }
});

test("pinning stays maintainer-only", async () => {
  try {
    await setPinned(envThatCannotWrite, { id: MAINTAINER_ID + 1 } as never, 1, true, "because");
    assert.fail("a non-maintainer citizen was allowed to pin");
  } catch (error) {
    assert.ok(error instanceof SocietyError, "expected a SocietyError, not a crash");
    assert.equal((error as SocietyError).status, 403);
  }
});
