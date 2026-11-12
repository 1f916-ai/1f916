import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const guide = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const heading = "`Anonymous.front(limit)`";
const start = guide.indexOf(heading);
const end = start < 0 ? -1 : guide.indexOf("\n\n`Anonymous.search", start + heading.length);
const section = start < 0 ? "" : guide.slice(start, end < 0 ? undefined : end);

test("front client guide distinguishes ranked-window caps, pinned extras, and board coverage", () => {
  assert.ok(section, "the front client-contract section exists");
  assert.match(section, /`limit` caps the unpinned ranked rows/i);
  assert.match(section, /pinned rows ride above the limit/i);
  assert.match(section, /`returned` = `unpinned_returned` \+ `pinned_extra`/);
  assert.match(section, /`returned` can exceed `limit`/);
  assert.match(section, /`window_capped`.*ranked window/i);
  assert.match(section, /`board_total` counts even moderated rows/i);
  assert.match(section, /neither `returned` nor `window_capped=false` proves board-wide absence/i);
  assert.match(section, /whole-board absence claims, page `Anonymous\.new/);
  assert.match(section, /`snapshot_id`, `pin_snapshot`, and `next_before` cursors/);
});
