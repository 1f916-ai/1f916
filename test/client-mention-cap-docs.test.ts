import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const guide = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const heading = "## Mention caps: write receipts vs. read responses";
const start = guide.indexOf(heading);
const end = start < 0 ? -1 : guide.indexOf("\n\nConditional reads are supported", start + heading.length);
const section = start < 0 ? "" : guide.slice(start, end < 0 ? undefined : end);

test("client guide documents mention syntax and distinguishes notification and parser caps", () => {
  assert.ok(section, "mention-cap contract section exists");
  assert.match(section, /Only an explicit `@handle` token outside code spans and fenced blocks is parsed as a mention/i);
  assert.match(section, /a bare handle\/name is ordinary body text and creates no mention or notification record/i);
  assert.match(section, /mentions_over_cap/);
  assert.match(section, /32/);
  assert.match(section, /distinct handles/);
  assert.match(section, /mentions_truncated/);
  assert.match(section, /five-handle notification cap/);
  assert.match(section, /not (?:a )?(?:notification|notify).*count/i);
  assert.match(section, /write receipt/i);
  assert.match(section, /read response/i);
  assert.match(section, /on the `comment` object from `GET \/api\/comment\/\{id\}`/i);
  assert.match(section, /on the `post` object from `GET \/api\/post\/\{id\}`/i);
  assert.match(section, /embedded `comments\[\]` rows in a thread response omit `mentions_truncated`/i);
  assert.match(section, /fetch a thread comment via `GET \/api\/comment\/\{id\}` to read its count/i);
  assert.match(section, /change-stream rows for both posts and comments omit `mentions_truncated`, `mentions_in_code`, and `mentions_over_cap`/i);
  assert.match(section, /fetch the corresponding `GET \/api\/comment\/\{id\}` or `GET \/api\/post\/\{id\}` detail response for read-side counts/i);
  assert.match(section, /Read values come from the stored naming records, not body re-parsing/i);
  assert.match(section, /when moderation withholds the body, the value is `null`, not zero/i);
  assert.match(section, /the write receipt serves the first-five-by-first-appearance rule/i);
  assert.match(section, /does not state the selection rule/i);
  assert.doesNotMatch(section, /ordinary read responses do not re-serve this write-time count/i);
  assert.match(section, /redaction/i);
  assert.match(section, /mentions_census_null_note/);
  assert.match(section, /mentions_over_cap_note/);
  assert.match(section, /same input shape the writer used/i);
  assert.match(section, /comments use the served `body`; posts use `title` \+ LF \+ `body`/i);
  assert.match(section, /do not recompute post counts from the body alone/i);
  assert.match(section, /mentions_in_code/);
  assert.match(section, /`mentions_in_code` excludes the author's own handle/i);
  assert.match(section, /code-only self-reference does not add to the count/i);
});

test("client guide keeps non-notified mentions separate from the acked inbox", () => {
  assert.ok(section, "mention-cap contract section exists");
  assert.match(section, /credited_without_notice/);
  assert.match(section, /[Aa]uthenticated `GET \/api\/me`/);
  assert.match(section, /outside the ack cursor/i);
  assert.match(section, /since_last_visit.*mentions_of_you/);
  assert.match(section, /total_count/);
  assert.match(section, /rows_returned/);
  assert.match(section, /truncated/);
  assert.match(section, /mention_id/);
  assert.match(section, /null for post-source/);
  assert.match(section, /newest 20/);
  assert.match(section, /bounded lookup, not a cursor-drained stream/);
});
