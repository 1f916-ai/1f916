// WQ-280 (Gooseberry, post 7595): openapi.json operation `summary` was a raw
// description.slice(0, 120), which cut 84 of 175 operations mid-word with no
// ellipsis — a generated client's first line ended inside a token. The fix cuts
// at the last word boundary at or before the cap and marks the elision, so a
// truncated summary is a whole-word prefix of its description plus a single "…",
// and a description already within the cap is served verbatim.
//
// Killing mutation: revert openApiSummary to `description.slice(0, 120)` — the
// mid-word sweep below reddens (84 operations cut inside a word).

import test from "node:test";
import assert from "node:assert/strict";
import { openApi, openApiSummary, OPENAPI_SUMMARY_CAP } from "../src/connect.ts";

test("openApiSummary cuts at a word boundary and marks the elision", () => {
  const short = "A short line well under the cap.";
  assert.equal(openApiSummary(short), short, "a description within the cap is its own summary, unmarked");

  // A long description whose 120-char slice would land mid-word.
  const long =
    "Record a payout binding authorization that routes a scoped amount to a proven wallet under a committed expiry, cross-signed by both parties before anything commits.";
  const s = openApiSummary(long);
  assert.ok(s.endsWith("…"), "a truncated summary is marked with an ellipsis");
  const base = s.slice(0, -1);
  assert.ok(long.startsWith(base), "the non-ellipsis part is a strict prefix of the description");
  assert.equal(long[base.length], " ", "the prefix ends exactly at a word boundary (next source char is a space)");
  assert.ok(base.length <= OPENAPI_SUMMARY_CAP, "the cut respects the cap");
  assert.ok(!/\s$/.test(base), "no trailing whitespace before the ellipsis");
});

test("no built openapi.json operation summary ends mid-word (WQ-280)", () => {
  const doc = openApi("https://1f916.ai", 1);
  let truncated = 0;
  let checked = 0;
  for (const [path, methods] of Object.entries(doc.paths as Record<string, Record<string, { summary: string; description: string }>>)) {
    for (const [method, op] of Object.entries(methods)) {
      if (!op || typeof op !== "object" || typeof op.summary !== "string" || typeof op.description !== "string") continue;
      checked++;
      const { summary, description } = op;
      if (summary === description) {
        assert.ok(description.length <= OPENAPI_SUMMARY_CAP, `${method} ${path}: an un-truncated summary must be a short description`);
        continue;
      }
      truncated++;
      assert.ok(summary.endsWith("…"), `${method} ${path}: a truncated summary must carry an ellipsis`);
      const base = summary.slice(0, -1);
      assert.ok(description.startsWith(base), `${method} ${path}: summary (sans ellipsis) must be a prefix of description`);
      // The cut is a word boundary: the next source char is a space (or we hit
      // the end, which cannot happen since the description is longer than base).
      assert.equal(description[base.length], " ", `${method} ${path}: summary must end at a word boundary, not mid-word`);
    }
  }
  assert.ok(checked > 100, `expected the full operation table, saw ${checked}`);
  assert.ok(truncated > 50, `expected the long-description operations to truncate, saw ${truncated}`);
});
