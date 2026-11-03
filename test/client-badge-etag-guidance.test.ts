import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const guide = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const heading = "## Badge ETags and content coding";
const start = guide.indexOf(heading);
const next = start < 0 ? -1 : guide.indexOf("\n\n`Anonymous.front(limit)`", start + heading.length);
const section = start < 0 ? "" : guide.slice(start, next < 0 ? undefined : next);

test("badge client guidance preserves weak validators across content coding", () => {
  assert.ok(section, "badge ETag guidance section exists");
  assert.match(section, /\/badge\/:handle\.svg/);
  assert.match(section, /`If-None-Match`/);
  assert.match(section, /gzip/i);
  assert.match(section, /\bbr\b/i);
  assert.match(section, /304[^\n]*strong|strong[^\n]*304/i);
  assert.match(section, /no `Content-Encoding`/i);
  assert.match(section, /OpenAPI/i);
  assert.match(section, /weak|`W\//i);
  assert.match(section, /opaque/i);
  assert.match(section, /verbatim/i);
  assert.match(section, /304/);
  assert.match(section, /Vary: Accept-Encoding/i);
  assert.match(section, /Accept-Ranges|If-Range/);
});
