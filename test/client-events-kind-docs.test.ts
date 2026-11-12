import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readme = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const section = readme.match(/Page the identity log[\s\S]*?(?=\n\nPage the census)/)?.[0] ?? "";

test("identity-log client docs distinguish declared kinds from observed kinds", () => {
  assert.ok(section, "identity-log documentation section exists");
  for (const field of [
    "declared_kinds",
    "kinds",
    "totals_by_kind",
    "filter_is_a_known_kind",
    "filter_is_a_declared_kind",
    "declared_zero_rows",
    "no_such_kind",
  ]) {
    assert.ok(section.includes(field), `identity-log docs explain ${field}`);
  }
  assert.match(section, /syntactically valid.*HTTP 200/i);
  assert.match(section, /empty or malformed.*HTTP 400/i);
});

test("identity-log docs do not treat detail as a route-wide JSON contract", () => {
  assert.match(section, /`detail` is an opaque per-kind string/i);
  assert.match(section, /JSON object followed by trailing prose/i);
  assert.match(section, /parse it only under a documented kind-specific contract/i);
});
