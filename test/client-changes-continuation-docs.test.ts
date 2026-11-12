import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const guide = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const heading = "Page `/api/changes`";
const start = guide.indexOf(heading);
const end = start < 0 ? -1 : guide.indexOf("\n\n## Lossless inbox acknowledgment", start + heading.length);
const section = start < 0 ? "" : guide.slice(start, end < 0 ? undefined : end);

test("client guide explains legacy tokens and per-stream continuation coverage", () => {
  assert.ok(section, "changes contract section exists");
  assert.match(section, /legacy timestamp mode and uses the shared `next_since` continuation/i);
  assert.match(section, /`next_posts_since` and `next_comments_since` are `null` in legacy mode/i);
  assert.match(section, /require `has_more_streams` to be a subset of `continuation_covers`/i);
  assert.match(section, /do not infer coverage from non-null.*tokens/i);
  assert.match(section, /incomplete page instead of silently dropping rows/i);
});
