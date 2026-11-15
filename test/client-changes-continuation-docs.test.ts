import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const guide = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const heading = "Page `/api/changes`";
const start = guide.indexOf(heading);
const end = start < 0 ? -1 : guide.indexOf("\n\n## Lossless inbox acknowledgment", start + heading.length);
const section = start < 0 ? "" : guide.slice(start, end < 0 ? undefined : end);
const pythonClient = readFileSync(new URL("../clients/python/client.py", import.meta.url), "utf8");
const pythonChanges = (pythonClient.match(/    def changes\([\s\S]*?        """([\s\S]*?)        """/)?.[1] ?? "").replace(/\s+/g, " ").trim();
const nodeClient = readFileSync(new URL("../clients/node/client.mjs", import.meta.url), "utf8");
const nodeChanges = (nodeClient.match(/\/\*\*\s*\n\s*\* What moved since a cursor\.([\s\S]*?)\n\s*\*\/\s*changes\(/)?.[1] ?? "")
  .replace(/^[ \t]*\*[ \t]?/gm, " ")
  .replace(/\s+/g, " ")
  .trim();

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
  assert.match(section, /For posts\/comments, `since` is an optional `created_at` floor for streams started with `init` \(default 0\); a live `id:<id>` cursor ignores it for that stream/i);
  assert.match(section, /The shared `next_since` is advisory in ID mode: it echoes the supplied `since` \(or 0\) and does not advance/i);
  assert.match(section, /Never use `next_since` to resume ID-mode progress/i);
  assert.match(section, /exact paired `next_posts_since` \/ `next_comments_since` from the last fully committed page/i);
  assert.match(section, /if your walk consumes the nulls stream, preserve its independent `next_nulls_since` continuation too/i);
  assert.match(section, /A positive `since` still filters the nulls window/i);
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
  assert.match(pythonChanges, /In ID mode, `since` is an optional `created_at` floor for posts\/comments\s+streams started with `init` \(default 0\); a live `id:<id>` cursor ignores\s+it for that stream/i);
  assert.match(pythonChanges, /The shared `next_since` is advisory in ID mode:[\s\S]*?echoes the supplied `since` \(or 0\) and does not advance/i);
  assert.match(pythonChanges, /Never use\s+`next_since` to resume ID-mode progress/i);
  assert.match(pythonChanges, /exact paired `next_posts_since` and\s+`next_comments_since` values saved after the last fully committed page/i);
  assert.match(pythonChanges, /A positive `since` still filters the nulls window/i);
  assert.match(pythonChanges, /preserve its independent `next_nulls_since` if consuming nulls/i);
  assert.match(pythonChanges, /refuse a\s+request that differs from your persisted checkpoint/i);
  assert.match(pythonChanges, /server cannot\s+see that caller-owned state/i);
});

test("Node Anonymous.changes docs distinguish ID-mode next_since from progress", () => {
  assert.ok(nodeChanges, "Anonymous.changes JSDoc exists");
  assert.match(nodeChanges, /`since` is an optional `created_at` floor[\s\S]*?`init`[\s\S]*?live `id:<id>` cursors ignore it/i);
  assert.match(nodeChanges, /`next_since` is advisory in ID mode:[\s\S]*?echoes the[\s\S]*?does not advance/i);
  assert.match(nodeChanges, /Never use `next_since` to\s+resume ID-mode progress/i);
  assert.match(nodeChanges, /use `next_posts_since` and `next_comments_since`/i);
  assert.match(nodeChanges, /positive `since` still filters\s+the nulls window/i);
});
