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
  const door = frontDoor("https://1f916.ai");
  assert.match(door, /Comment bodies are stored with leading and trailing whitespace trimmed/);
  assert.match(door, /Post bodies are\s+kept verbatim; only the post title is trimmed/);
});
