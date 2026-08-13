import { test } from "node:test";
import assert from "node:assert/strict";
import { DOCKET, docket, type DocketItem } from "../src/docket.ts";

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

function assertPostLandingDelivery(d: DocketItem) {
  if (d.delivery !== undefined) {
    assert.equal(d.status, "shipped", `${d.id} records delivery before shipping`);
    assert.ok(Number.isInteger(d.delivery.pr) && d.delivery.pr > 0, `${d.id} has a malformed delivery PR`);
    assert.match(d.delivery.commit, /^[0-9a-f]{40}$/, `${d.id} must name the full mainline commit`);
    assert.ok(d.delivery.method === "github-merge" || d.delivery.method === "rebased");
  }
  if (d.status === "shipped" && d.claim !== undefined) {
    assert.ok(d.delivery, `${d.id} shipped after a public claim without a landing receipt`);
  }
}

test("shipped claims carry a complete post-landing delivery receipt", () => {
  for (const d of DOCKET) assertPostLandingDelivery(d);

  const shippedAfterPlan: DocketItem = {
    id: "plan-only-claim",
    lane: "fix",
    title: "synthetic plan-only claim",
    updated: "2026-08-11",
    status: "shipped",
    size: "trivial",
    source_posts: [1],
    claim: { by: "builder", at: "2026-08-11", where: 1 },
  };
  assert.throws(
    () => assertPostLandingDelivery(shippedAfterPlan),
    /without a landing receipt/,
    "a claim need not name a proposal PR before its eventual delivery needs a receipt",
  );
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

test("became is published as a graph, so nobody builds a double-counting metric on it", () => {
  const d = docket() as unknown as {
    decomposition: { child_links: number; distinct_children: number; children_with_multiple_parents: Record<string, string[]> };
  };
  const dec = d.decomposition;
  // The whole point: these two numbers are allowed to differ, and a reader
  // must be told which one to use. loki (c6518) found the gap by checking all
  // eight links rather than trusting the array.
  assert.ok(dec.child_links >= dec.distinct_children, "links can exceed distinct children; that is the shape being disclosed");
  for (const [child, parents] of Object.entries(dec.children_with_multiple_parents)) {
    assert.ok(parents.length > 1, `${child} is listed as shared but has one parent`);
  }
  // Every named child must resolve to a real row, or the graph points at nothing.
  const ids = new Set((docket() as unknown as { docket: { id: string }[] }).docket.map((r) => r.id));
  for (const child of Object.keys(dec.children_with_multiple_parents)) {
    assert.ok(ids.has(child), `became names a row that does not exist: ${child}`);
  }
});
