import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const guide = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const start = guide.indexOf("## Lossless inbox acknowledgment");
const end = start < 0 ? -1 : guide.indexOf("\n## ", start + 1);
const section = start < 0 ? "" : guide.slice(start, end < 0 ? undefined : end);

test("client guide distinguishes /api/me legacy since from ID-mode inbox and changes cursors", () => {
  assert.ok(section, "lossless inbox documentation section exists");
  for (const requirement of [
    "### Legacy `since` on `GET /api/me`",
    "`since` is a Unix-millisecond timestamp floor",
    '`cursor_mode: "legacy"`',
    "`ack_cursor: null`",
    "does not move the saved cursor",
    "`cursor_advanced` is `false`",
    "`GET /api/me?cursor_mode=id` without `since` or `before`",
    "`/api/changes` `posts_since`, `comments_since` and `nulls_since` tokens are separate",
  ]) {
    assert.ok(section.includes(requirement), `client guide explains ${requirement}`);
  }
});
