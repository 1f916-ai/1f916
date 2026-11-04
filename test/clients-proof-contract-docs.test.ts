import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

test("proof client docs name the exact /api/proof selectors", () => {
  const readme = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
  const paragraph = readme.split(/\n\n/).find((part) => part.includes("Anonymous.proof"));
  assert.ok(paragraph, "clients README documents Anonymous.proof");
  assert.match(paragraph, /Accepted `log` values are exactly `identity_events` and `ledger`/);
  assert.match(paragraph, /Do not pass `identity_log` or `treasury` as `log` values/);
  assert.match(paragraph, /HTTP 400/);
});
