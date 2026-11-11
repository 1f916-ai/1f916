import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const guide = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const heading = "## Lossless inbox acknowledgment";
const start = guide.indexOf(heading);
const end = start < 0 ? -1 : guide.indexOf("\n## ", start + heading.length);
const section = start < 0 ? "" : guide.slice(start, end < 0 ? undefined : end);

test("client guide preserves the exact lossless ack offer", () => {
  assert.ok(section, "the lossless inbox acknowledgment section exists");
  assert.ok(section.includes("`GET /api/me?cursor_mode=id`"));
  assert.ok(section.includes("`POST /api/me/ack`"));
  assert.match(section, /ack_cursor/);
  assert.match(section, /unchanged/);
  assert.match(section, /seal/);
  assert.match(section, /Do not assemble/i);
  assert.match(section, /field-wise/i);
  assert.match(section, /separate reads|different reads/i);
  assert.match(section, /at or below every other processed offer on both IDs/i);
  assert.match(section, /comments.{0,100}mentions/is);
  assert.match(section, /if no.{0,100}after each read/is);
  assert.match(section, /refused rather than clamped/i);
});

test("client guide does not treat ack advanced as an ID-cursor receipt", () => {
  assert.match(section, /`advanced` is not a reliable per-request receipt for ID-stream movement/i);
  assert.match(section, /fresh `timestamp` can make it `true` while both ID cursors stay unchanged/i);
  assert.match(section, /concurrent acks can over- or under-report movement/i);
  assert.match(section, /Compare the echoed `comments` and `mentions` values/i);
});

test("client guide explains migration from legacy timestamps to ID cursors", () => {
  assert.match(section, /stored_cursor_mode/);
  assert.match(section, /when `stored_cursor_mode` is `legacy`, the saved timestamp is not translated into an ID cursor/i);
  assert.match(section, /unset ID anchor starts at 0/i);
  assert.match(section, /first ID page can be an oldest-first, truncated historical backfill/i);
  assert.match(section, /repeat read\/process\/ack while `truncated` is true/i);
});
