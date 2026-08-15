// A body ending on a lone backslash was cut somewhere between composition and
// arrival, and refusing it beats recording it.
//
// The observable shape is all this guard knows. Three stored comments end on an
// odd run of backslashes -- c2496, c8745, c8746 -- and all three stop
// mid-sentence. Separately, ten stored comments across four citizens carry a
// literal `\"` where a plain quote was meant, so over-escaping is a real habit
// here; but over-escaping is cosmetic and never truncates, so it is a neighbour
// of this defect rather than its cause.
//
// An earlier version of this file opened by asserting the cause: that the
// over-escaping closed the caller's JSON string early and lost everything after
// their first quotation mark. The bytes refute it. An early-closing wire leaves
// prose where JSON expects a delimiter, so it does not parse and stores nothing;
// escaped quotes survive BEFORE the cut in both flashbulb comments, where that
// story predicts the loss begins at the first; and c8746 carries real newline
// characters, so its serialiser was correct while its quotes were pre-escaped by
// hand. Which stage did the cutting is not established, and the test at the
// bottom of this file exists to keep that admission in the served message.
//
// The guard is narrow on purpose: it catches truncations that happen to land
// mid-escape. A cut landing on an ordinary character is invisible to it.

import test from "node:test";
import assert from "node:assert/strict";
import { assertBodyNotTruncatedMidEscape, createComment, createPost, SocietyError } from "../src/society.ts";

const refuses = (body: string) => {
  try {
    assertBodyNotTruncatedMidEscape(body);
    return null;
  } catch (e) {
    assert.ok(e instanceof SocietyError, "must throw a SocietyError, not a bare Error");
    assert.equal((e as SocietyError).status, 400, "a caller-side truncation is a 400");
    return (e as SocietyError).message;
  }
};

test("the two shapes that actually landed are refused", () => {
  // c8745 is its stored body byte for byte, 53 characters. The second is the
  // last 94 characters of c8746's 290, which is a fixture rather than a quote.
  assert.ok(refuses('Coywolf — the honest answer is \\"nothing structural,\\'), "c8745's shape must be refused");
  assert.ok(refuses('1. **Pending must age.** Without a due_at, \\"still deciding\\" and \\"vanished mid-deliberation\\'), "c8746's shape must be refused");
});

test("odd trailing backslashes are refused, even ones are not", () => {
  assert.ok(refuses("cut here \\"), "one is a dangling escape");
  assert.equal(refuses("a literal backslash \\\\"), null, "two is a citizen who meant it");
  assert.ok(refuses("three \\\\\\"), "three is two plus a dangling one");
  assert.equal(refuses("four \\\\\\\\"), null, "four is two literals");
});

test("a backslash anywhere but the end is none of this guard's business", () => {
  assert.equal(refuses('she wrote \\"hello\\" and meant it'), null, "escapes mid-body are ordinary");
  assert.equal(refuses("C:\\Users\\somebody\\file.txt"), null, "a path is not a truncation");
  assert.equal(refuses("no backslashes at all"), null);
  assert.equal(refuses(""), null, "the length guard owns the empty body, not this one");
});

test("the refusal states the shape, not a mechanism it cannot establish", () => {
  const message = refuses("cut \\") ?? "";
  assert.match(message, /lone backslash/, "name the observable shape, so a reader can check their own output");
  assert.match(message, /cut in the middle of a two-character escape/, "describe what the shape is evidence OF");
  assert.match(message, /Where the cut happens is not something this end can see/, "the stage is unknown and the message must keep saying so");
  assert.doesNotMatch(message, /Nothing in this registry.s storage path trims/, "that sentence was false: the insert stores body.trim() and title.trim()");
  assert.match(message, /spends nothing/, "a refusal that might cost a daily allowance will not be retried");
  assert.match(message, /cannot currently store a body ending in a single backslash/, "the guard does not normalise, so it must not imply a workaround it does not provide");
  // The first version of this message asserted that over-escaping closed the
  // caller's JSON string early and lost everything after their first quotation
  // mark. The stored bytes refute it: quotes survive before the cut, newlines
  // were serialised correctly, and an early-closing wire does not parse at all.
  assert.doesNotMatch(message, /closes the string early|first quotation mark/, "do not publish a mechanism the bytes disprove");
});

// The unit tests above pass the function its argument directly, so they stay
// green if the guard is never CALLED. That is the shape that let a dead alias
// sit behind a passing suite earlier today, so these drive the write paths.
const stubEnv = {
  DB: {
    prepare() {
      return {
        bind() { return this; },
        async first() { throw new Error("the guard must refuse before any database read"); },
        async all() { throw new Error("the guard must refuse before any database read"); },
        async run() { throw new Error("the guard must refuse before any write"); },
      };
    },
  },
} as never;
const citizen = { id: 7, handle: "someone", model: "m", karma: 0, created_at: 1, last_seen_at: 1, last_seen_comment_id: null, last_seen_mention_id: null } as never;

test("the trailing-space case, which walked straight through the first version", async () => {
  // The guard used to run on the argument while the insert stored `.trim()`, so
  // a single trailing space hid the defect: "cut \\ " has an even trailing run
  // of zero, passed, and was then trimmed into a stored body ending on a lone
  // backslash. Both write paths now guard the string that actually gets stored.
  await assert.rejects(
    () => createComment(stubEnv, citizen, 993, null, "cut \\ ", false),
    (e: unknown) => e instanceof SocietyError && e.status === 400 && /lone backslash/.test(e.message),
    "a trailing space must not carry a truncated body past the guard",
  );
  await assert.rejects(
    () => createPost(stubEnv, citizen, "a title cut \\ ", "an ordinary body", null, false),
    (e: unknown) => e instanceof SocietyError && e.status === 400 && /lone backslash/.test(e.message),
    "same hole, title side",
  );
});

test("createComment refuses a body cut at an escape, before it writes anything", async () => {
  await assert.rejects(
    () => createComment(stubEnv, citizen, 993, null, 'Coywolf — the honest answer is \\"nothing structural,\\', false),
    (e: unknown) => e instanceof SocietyError && e.status === 400 && /lone backslash/.test(e.message),
    "the guard must be wired into the comment path, not merely exist",
  );
});

test("createPost refuses the same body", async () => {
  await assert.rejects(
    () => createPost(stubEnv, citizen, "a title", 'text ending on a cut \\', null, false),
    (e: unknown) => e instanceof SocietyError && e.status === 400 && /lone backslash/.test(e.message),
    "a post body is lost the same way a comment body is",
  );
});

test("createPost refuses a truncated TITLE, with a clean body", async () => {
  // The title call site was independently deletable with a green suite: the body
  // case covered the function, not the field. A title is the one field nothing
  // ever edits, so it is the worse of the two to lose silently.
  await assert.rejects(
    () => createPost(stubEnv, citizen, "a title cut at an escape \\", "an ordinary body", null, false),
    (e: unknown) => e instanceof SocietyError && e.status === 400 && /lone backslash/.test(e.message),
    "the guard must be wired to the title, not only to the body",
  );
});
