import { test } from "node:test";
import assert from "node:assert/strict";
import { DOCKET, docket } from "../src/docket.ts";

test("docket ids are unique slugs", () => {
  const ids = DOCKET.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[a-z0-9][a-z0-9-]*$/);
});

test("every non-shipped row cites at least one source thread (receipts, not assertions)", () => {
  for (const d of DOCKET) {
    if (d.status !== "shipped") {
      assert.ok(d.source_posts.length > 0, `${d.id} has no source_posts`);
    }
  }
});

test("decision-pending rows name their decision thread", () => {
  for (const d of DOCKET) {
    if (d.status === "decision-pending") assert.ok(d.decision_thread, `${d.id} lacks decision_thread`);
  }
});

test("counts sum to the docket length", () => {
  const { counts } = docket();
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), DOCKET.length);
});

test("every row carries a dated update stamp", () => {
  for (const d of DOCKET) {
    assert.match((d as { updated: string }).updated, /^\d{4}-\d{2}-\d{2}$/, `${d.id} lacks updated`);
  }
});

test("acceptance, where present, is a checkable sentence and not a placeholder", () => {
  for (const d of DOCKET) {
    if (d.acceptance === undefined) continue;
    assert.equal(typeof d.acceptance, "string", `${d.id} acceptance is not a string`);
    assert.ok(d.acceptance.trim().length >= 40,
      `${d.id} acceptance is too short to be checkable by someone who did not write it`);
    assert.doesNotMatch(d.acceptance, /^(tbd|todo|n\/a)\b/i, `${d.id} acceptance is a placeholder`);
  }
});

test("every row exposes acceptance explicitly — a missing key is silence, not an absence", () => {
  for (const row of docket().docket) {
    assert.ok("acceptance" in row, `${row.id} omits acceptance instead of nulling it`);
  }
});

test("acceptance_coverage counts the live rows it claims to", () => {
  const { docket: rows, acceptance_coverage: cov } = docket();
  const live = rows.filter((d) => d.status !== "shipped" && d.status !== "declined");
  assert.equal(cov.live_rows, live.length);
  assert.equal(cov.with_acceptance + cov.without_acceptance, cov.live_rows);
  assert.equal(cov.with_acceptance, live.filter((d) => d.acceptance).length);
  const laned = Object.values(cov.by_lane).reduce((a, l) => a + l.with + l.without, 0);
  assert.equal(laned, cov.live_rows, "by_lane drops rows");
});
