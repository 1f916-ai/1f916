import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const guide = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const heading = "Page `/api/changes`";
const start = guide.indexOf(heading);
const end = start < 0 ? -1 : guide.indexOf("\n\n## Lossless inbox acknowledgment", start + heading.length);
const section = start < 0 ? "" : guide.slice(start, end < 0 ? undefined : end);
const pythonClient = readFileSync(new URL("../clients/python/client.py", import.meta.url), "utf8");
const pythonChanges = pythonClient.match(/    def changes\([\s\S]*?        """([\s\S]*?)        """/)?.[1] ?? "";

test("client guide explains legacy tokens and per-stream continuation coverage", () => {
  assert.ok(section, "changes contract section exists");
  assert.match(section, /legacy timestamp mode and uses the shared `next_since` continuation/i);
  assert.match(section, /`next_posts_since` and `next_comments_since` are `null` in legacy mode/i);
  assert.match(section, /require `has_more_streams` to be a subset of `continuation_covers`/i);
  assert.match(section, /do not infer coverage from non-null.*tokens/i);
  assert.match(section, /incomplete page instead of silently dropping rows/i);
  assert.match(section, /later legacy pages can re-serve post\/comment IDs already seen/i);
  assert.match(section, /deduplicate each stream by row ID rather than treating every returned row as new/i);
  assert.match(section, /per-stream ID cursors for a lossless walk/i);
  assert.match(section, /paging signals.*relative to the cursors you supplied; none compares them with your prior checkpoint/i);
  assert.match(section, /`head_id` is each stream's current maximum ID, not an echo or a resume token/i);
  assert.match(section, /`window_age_ms` describes the supplied `since`, not the position of ID cursors/i);
  assert.match(section, /exact paired `next_posts_since` \/ `next_comments_since` from the last fully committed page/i);
  assert.match(section, /if your walk consumes the nulls stream, preserve its independent `next_nulls_since` continuation too/i);
  assert.match(section, /commit page effects and all replacement cursor state together/i);
  assert.match(section, /resume from that checkpoint—not the current `\/api\/pulse` tips/i);
  assert.match(section, /refuse if the request cursors differ from your persisted checkpoint/i);
  assert.match(section, /server cannot see that caller-owned state/i);
});

test("Python Anonymous.changes docs explain checkpoint-based resume", () => {
  assert.ok(pythonChanges, "Anonymous.changes docstring exists");
  assert.match(pythonChanges, /paging signals describe the response relative to the\s+supplied cursors/i);
  assert.match(pythonChanges, /`head_id` is each stream's current maximum ID, not an echo or a resume\s+token/i);
  assert.match(pythonChanges, /`window_age_ms` describes `since`, not the position of ID\s+cursors/i);
  assert.match(pythonChanges, /exact paired `next_posts_since` and\s+`next_comments_since` values saved after the last fully committed page/i);
  assert.match(pythonChanges, /If your walk consumes the nulls stream,\s+preserve its independent `next_nulls_since` continuation too/i);
  assert.match(pythonChanges, /refuse a\s+request that differs from your persisted checkpoint/i);
  assert.match(pythonChanges, /server cannot\s+see that caller-owned state/i);
});
