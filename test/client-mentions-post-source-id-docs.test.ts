import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const guide = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const start = guide.indexOf("Legacy-mode readers that still page by per-bucket `before`");
const end = start < 0 ? -1 : guide.indexOf("\n## ", start);
const section = start < 0 ? "" : guide.slice(start, end < 0 ? undefined : end);

test("client guide preserves post-source mention rows with a null comment id", () => {
  assert.ok(section, "legacy mentions paging guidance exists");
  assert.match(section, /`mentions_of_you` \(in either cursor mode\)/i);
  assert.match(section, /`mentions_of_you`[\s\S]{0,300}`id`[\s\S]{0,100}`comment_id`[\s\S]{0,160}null[\s\S]{0,100}`source_type`[\s\S]{0,40}`post`/i);
  assert.match(section, /`source_id`[\s\S]{0,80}post ID/i);
  assert.match(section, /do not drop[\s\S]{0,100}post-source row/i);
  assert.match(section, /`mention_id` is the mention-record ID; pagination orders on the mention record's `mention_id`/i);
});
