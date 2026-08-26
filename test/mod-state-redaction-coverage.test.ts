// Every mod_state the code can WRITE must be redacted on every path that
// reads it. This test exists because that was false for four surfaces at once
// and nothing noticed.
//
// The post_title redaction was written as raw SQL and then copied verbatim
// into four queries: the comment record, the inbox, mentions, and the thread
// reader. Each copy hardcoded 'removed' and 'collapsed' and ended `ELSE
// p.title`. So adding any third state leaked the title on all four at the same
// moment, and the leak was silent, because those queries return a post_title
// beside a comment and no test compared it to applyModState's answer.
//
// Found 2026-08-23 while adding 'withdrawn', which is the worst possible state
// to have discovered it with: a withdrawal is a PRIVACY act, and three of the
// four author-requested takedowns on record were an operator's identity
// sitting in a title or a url.
//
// The redaction now has one definition. This test is what keeps it that way:
// it reads the source, finds every state the code assigns, and fails if one of
// them is missing from either the read-time redactor or the SQL expression.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyModState, POST_TITLE_REDACTION_SQL } from "../src/society.ts";

const SOURCE = readFileSync(fileURLToPath(new URL("../src/society.ts", import.meta.url)), "utf8");

// Every literal state this code can put into a mod_state column.
function statesTheCodeWrites(): string[] {
  const found = new Set<string>();
  for (const m of SOURCE.matchAll(/mod_state\s*=\s*'([a-z-]+)'/g)) found.add(m[1]!);
  // The moderate path assigns through a variable rather than a literal, so its
  // states are named where that variable is built.
  for (const m of SOURCE.matchAll(/act === "collapse" \? "([a-z-]+)" : "([a-z-]+)"/g)) {
    found.add(m[1]!);
    found.add(m[2]!);
  }
  return [...found].sort();
}

test("the states the code writes are the states we think they are", () => {
  // A canary. If this list changes, the two tests below are about to start
  // testing something other than what you changed, and you should look.
  assert.deepEqual(statesTheCodeWrites(), ["collapsed", "removed", "withdrawn"]);
});

test("every writable mod_state is redacted by applyModState", () => {
  for (const state of statesTheCodeWrites()) {
    const shown = applyModState({ mod_state: state, title: "SECRET-TITLE", body: "SECRET-BODY", url: "https://secret.example" }) as Record<string, unknown>;
    assert.ok(!String(shown.title).includes("SECRET-TITLE"), `${state} leaks the title through applyModState`);
    assert.ok(!String(shown.body).includes("SECRET-BODY"), `${state} leaks the body through applyModState`);
    assert.equal(shown.url, null, `${state} leaks the url through applyModState`);
  }
});

test("every writable mod_state is redacted by the post_title SQL, which is the copy that got missed", () => {
  for (const state of statesTheCodeWrites()) {
    assert.ok(
      POST_TITLE_REDACTION_SQL.includes(`mod_state = '${state}'`),
      `${state} has no branch in POST_TITLE_REDACTION_SQL, so every query carrying a post_title beside a comment serves its real title`,
    );
  }
});

test("the redaction has exactly one definition, so a fifth copy cannot drift", () => {
  // The literal CASE must appear nowhere but in the exported constant. A new
  // hand-rolled copy is the exact mistake this file exists to prevent, and it
  // would pass every other test in the suite.
  const inlineCopies = SOURCE.split("CASE WHEN p.mod_state").length - 1;
  assert.equal(
    inlineCopies,
    1,
    "the post_title redaction CASE appears more than once in src/society.ts; it has one home, POST_TITLE_REDACTION_SQL, and callers interpolate it",
  );
});
