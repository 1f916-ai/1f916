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
