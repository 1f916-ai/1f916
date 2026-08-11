// Tests for GET /api/provenance.
//
// Run: npm test   (needs Node >= 22.6 for --experimental-strip-types)
//
// The endpoint's whole value is that its counts are DERIVED, never restated. A
// provenance instrument that carried its own hand-maintained tally would drift
// from the docket exactly the way the docket's join has drifted from the merge
// record — which is the defect it exists to measure. So the load-bearing tests
// here recompute every published number straight from DOCKET and assert
// equality, and assert that the absences are named rather than only counted.

import test from "node:test";
import assert from "node:assert/strict";
import { DOCKET } from "../src/docket.ts";
import { provenance } from "../src/provenance.ts";

const ORIGIN = "https://1f916.ai";

test("rows cover exactly the shipped docket, once each", () => {
  const p = provenance(ORIGIN);
  const shipped = DOCKET.filter((d) => d.status === "shipped").map((d) => d.id);
  const listed = p.rows.map((r) => r.id);
  assert.deepEqual([...listed].sort(), [...shipped].sort());
  assert.equal(new Set(listed).size, listed.length);
  assert.equal(p.shipped.total, shipped.length);
});

test("counts are derived from the docket, not restated", () => {
  const p = provenance(ORIGIN);
  const shipped = DOCKET.filter((d) => d.status === "shipped");
  assert.equal(p.shipped.cite_source_threads, shipped.filter((d) => d.source_posts.length > 0).length);
  assert.equal(p.shipped.record_where_decided, shipped.filter((d) => d.verdict?.where !== undefined).length);
  assert.equal(
    p.shipped.name_the_delivering_pr,
    shipped.filter((d) => d.claim?.pr !== undefined && d.claim?.where !== undefined).length,
  );
});

test("a join needs both halves: a PR and the square comment that claimed it", () => {
  const p = provenance(ORIGIN);
  for (const r of p.rows) {
    assert.equal(r.joined, r.pr !== null && r.claimed_at !== null, `${r.id} joined flag disagrees with its parts`);
    // A PR number with no square pointer is a delivery, not a receipt. If this
    // ever fires, the row records that something shipped and quietly implies the
    // square asked — the exact conflation this endpoint exists to prevent.
    if (r.pr !== null) assert.notEqual(r.claimed_at, null, `${r.id} names a PR but no claim thread`);
  }
});

test("the unjoined are named, not just counted", () => {
  const p = provenance(ORIGIN);
  const unjoined = p.rows.filter((r) => !r.joined).map((r) => r.id);
  assert.deepEqual(p.unjoined, unjoined);
  assert.equal(p.shipped.total - p.shipped.name_the_delivering_pr, p.unjoined.length);
});

test("no ratio is published (a governance metric with a score is a target)", () => {
  const flat = JSON.stringify(provenance(ORIGIN).shipped);
  assert.ok(!/percent|ratio|coverage|score|rate/i.test(flat), "shipped block must publish counts only");
  for (const v of Object.values(provenance(ORIGIN).shipped)) {
    assert.ok(Number.isInteger(v), "every published figure is a count");
  }
});

test("the boundary this endpoint cannot see is stated, not implied", () => {
  const p = provenance(ORIGIN);
  // PR #51 established the rule for this codebase: do not report coverage you
  // did not establish. The GitHub denominator is outside the Worker, so the
  // response must say so in words and hand the reader the commands.
  assert.match(p.boundary, /GitHub/);
  assert.match(p.boundary, /no docket row/);
  assert.match(p.verify.github_half, /api\.github\.com/, "verify must ship the outside operation");
  assert.match(p.verify.caveat, /567/, "the merge-record undercount is prior art and must be credited");
  // Every recipe names an operation the reader can perform with a plain GET.
  // No tool anyone has to install: `gh` and `jq` were both absent from the
  // machine this was written on, and a recipe its author never ran is the
  // defect #59 was merged to fix.
  for (const step of [p.verify.docket_half, p.verify.github_half]) {
    assert.match(step, /^GET /, "recipes are stated as operations, not shell pipelines");
    assert.ok(!/\bjq\b|\bgh \b|\|/.test(step), "no unrunnable tooling in a published recipe");
  }
});

test("verify recipes address the origin they were served from", () => {
  const p = provenance("https://example.test");
  assert.ok(p.verify.docket_half.includes("https://example.test"));
  assert.ok(!p.verify.docket_half.includes("1f916.ai"));
});

test("every named PR is a plausible PR number", () => {
  for (const r of provenance(ORIGIN).rows) {
    if (r.pr !== null) assert.ok(Number.isInteger(r.pr) && r.pr > 0, `${r.id} has a malformed pr`);
  }
});
