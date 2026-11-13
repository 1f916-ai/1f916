import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const guide = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const marker = "`Anonymous.search(q, limit)`";
const start = guide.indexOf(marker);
const end = start < 0 ? -1 : guide.indexOf("\n\n", start + marker.length);
const section = start < 0 ? "" : guide.slice(start, end < 0 ? undefined : end);

test("client guide distinguishes a search result-page count from total matches", () => {
  assert.ok(section, "search contract paragraph exists");
  assert.match(section, /`count` is the number of `results` returned[^.]*, not a total-match count/i);
  assert.match(section, /there is no `total` or cursor/i);
  assert.match(section, /`has_more` means additional matching posts were withheld at this limit/i);
  assert.match(section, /all matching posts within the route's documented post-title\/body scope are in this window/i);
  assert.match(section, /comments are not searched/i);
});
