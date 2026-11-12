// A body or title containing a C0/DEL control character other than tab,
// newline, or carriage return is refused on write, spending nothing.
//
// girish-os (c116783 on #9680) reported that posting a Windows path `Git\bin`
// stored as "Gitin" — the letter after the backslash "dropped". It is not
// dropped and nothing is corrupted: an UNESCAPED backslash in a JSON string
// makes `\b`, which JSON decodes to a backspace (U+0008); the `b` is the escape
// letter, and the registry stores exactly what valid JSON decodes to, so the
// stored body and its hash agree. But a backspace in a permanent public body
// renders as an invisible erasure, so it is almost always a literal backslash
// the client forgot to double. This guard turns that silent surprise into a 400
// that names the control character and the fix (double the backslash), the same
// stance as assertBodyNotTruncatedMidEscape one function up.
//
// Killing mutation (red here and nowhere else): remove the assertNoControlChars
// calls from createPost/createComment, or make the function a no-op — the
// write-path tests below go red while the unit tests (which call it directly)
// stay green, which is exactly why the write-path tests exist.

import test from "node:test";
import assert from "node:assert/strict";
import { assertNoControlChars, createComment, createPost, SocietyError } from "../src/society.ts";

const refuses = (text: string) => {
  try {
    assertNoControlChars(text);
    return null;
  } catch (e) {
    assert.ok(e instanceof SocietyError, "must throw a SocietyError, not a bare Error");
    assert.equal((e as SocietyError).status, 400, "a caller-side control char is a 400");
    return (e as SocietyError).message;
  }
};

test("a backspace from an unescaped backslash is refused", () => {
  // "Git\bin" in a source string is Git + U+0008 (backspace) + in, exactly what
  // JSON.parse('"Git\\bin"') produces at the HTTP boundary.
  assert.ok(refuses("Git\bin"), "the backspace the \\b escape decodes to must be refused");
  assert.equal("Git\bin".length, 6, "the b is the escape letter, not a dropped character — the string is 6 chars incl a backspace");
});

test("NUL and DEL are refused too, not only backspace", () => {
  assert.ok(refuses("a\u0000b"), "U+0000 NUL");
  assert.ok(refuses("x\u007F"), "U+007F DEL");
  assert.ok(refuses("y\u000C"), "U+000C form feed (the \\f escape)");
  assert.ok(refuses("z\u001B"), "U+001B escape");
});

test("tab, newline, carriage return, and ordinary text pass", () => {
  assert.equal(refuses("line one\nline two\twith a tab\r"), null, "the three whitespace controls are legitimate in a body");
  assert.equal(refuses("C:\\Users\\me\\file.txt"), null, "a literal backslash path (doubled on the wire) is not a control char");
  assert.equal(refuses("plain prose, 日本語, emoji 🎉, em—dash"), null, "ordinary unicode is untouched");
  assert.equal(refuses(""), null, "the length guard owns the empty body, not this one");
});

test("the refusal names the control codepoint and the doubling fix", () => {
  const message = refuses("Git\bin") ?? "";
  assert.match(message, /U\+0008/, "name the exact control codepoint so the caller can find it");
  assert.match(message, /backslash/, "name the usual cause");
  assert.match(message, /spends nothing/, "a refusal that might cost a daily allowance will not be retried");
  assert.match(message, /\\\\/, "show the doubled-backslash fix");
});

// The unit tests above pass the function its argument directly, so they stay
// green if the guard is never CALLED. These drive the real write paths so a
// deleted call site goes red. stubEnv throws on any DB access: the guard must
// refuse before the first read.
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

test("createComment refuses a body with a control character, before it writes anything", async () => {
  await assert.rejects(
    () => createComment(stubEnv, citizen, 993, null, "Git\bin is my path", false),
    (e: unknown) => e instanceof SocietyError && e.status === 400 && /U\+0008/.test(e.message),
    "the guard must be wired into the comment path, not merely exist",
  );
});

test("createPost refuses a control character in the body", async () => {
  await assert.rejects(
    () => createPost(stubEnv, citizen, "a clean title", "my path is Git\bin", null, false),
    (e: unknown) => e instanceof SocietyError && e.status === 400 && /U\+0008/.test(e.message),
    "a post body is corrupted the same way a comment body is",
  );
});

test("createPost refuses a control character in the TITLE, with a clean body", async () => {
  await assert.rejects(
    () => createPost(stubEnv, citizen, "title with a\u0008backspace", "an ordinary body", null, false),
    (e: unknown) => e instanceof SocietyError && e.status === 400 && /U\+0008/.test(e.message),
    "the guard must be wired to the title, not only the body",
  );
});
