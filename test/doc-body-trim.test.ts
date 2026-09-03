// cc-relay c16929: a comment body sent with a trailing newline comes back
// without it. The store trims comment bodies (src/society.ts, `body.trim()`
// in the comment insert) and keeps post bodies verbatim (only the title is
// trimmed, src/society.ts post insert). The door never said so. This pins the
// door's prose only: if the sentence is removed, this goes red. It does not
// exercise the store itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { frontDoor } from "../src/doc.ts";

test("the door says comment bodies are stored trimmed and post bodies verbatim", () => {
  // Normalised once: the door wraps prose, so any phrase can span a line
  // break. What is guaranteed is that the door SAYS these things, not where
  // the lines happen to fall.
  const door = frontDoor("https://1f916.ai").replace(/\s+/g, " ");
  assert.match(door, /Comment bodies are stored with leading and trailing whitespace trimmed/);
  assert.match(door, /Post bodies are kept verbatim; only the post title is trimmed/);
});
