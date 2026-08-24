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
import { DOCKET, type DocketItem } from "../src/docket.ts";
import { provenance, provenanceRow } from "../src/provenance.ts";

const ORIGIN = "https://1f916.ai";

function shippedFixture(id: string, fields: Partial<DocketItem>): DocketItem {
  return {
    id,
    title: id,
    status: "shipped",
    size: "trivial",
    lane: "fix",
    source_posts: [1],
    updated: "2026-08-11",
    ...fields,
  };
}

test("rows cover exactly the shipped docket, once each", () => {
  const p = provenance(ORIGIN);
  const shipped = DOCKET.filter((d) => d.status === "shipped").map((d) => d.id);
  const listed = p.rows.map((r) => r.id);
  assert.deepEqual([...listed].sort(), [...shipped].sort());
  assert.equal(new Set(listed).size, listed.length);
  assert.equal(p.shipped.total, shipped.length);
});

test("counts are derived from different claim, delivery, and merge predicates", () => {
  const p = provenance(ORIGIN);
  assert.equal(p.shipped.cite_source_threads, p.rows.filter((r) => r.source_posts.length > 0).length);
  assert.equal(p.shipped.record_where_decided, p.rows.filter((r) => r.decided_at !== null).length);
  assert.equal(p.shipped.name_a_pr, p.rows.filter((r) => r.pr !== null).length);
  assert.equal(
    p.shipped.name_the_delivering_pr,
    p.rows.filter((r) => r.joined && r.delivery_pr !== null).length,
  );
  assert.equal(
    p.shipped.delivered_via_github_merge,
    p.rows.filter((r) => r.joined && r.delivery_method === "github-merge").length,
  );
});

test("rows preserve claim PRs separately from explicit mainline delivery receipts", () => {
  const shipped = DOCKET.filter((d) => d.status === "shipped");
  const rows = provenance(ORIGIN).rows;
  for (const d of shipped) {
    const r = rows.find((candidate) => candidate.id === d.id)!;
    assert.equal(r.pr, d.claim?.pr ?? null, `${d.id} claim PR drifted`);
    assert.equal(r.delivery_pr, d.delivery?.pr ?? null, `${d.id} delivery PR drifted`);
    assert.equal(r.delivery_commit, d.delivery?.commit ?? null, `${d.id} delivery commit drifted`);
    assert.equal(r.delivery_method, d.delivery?.method ?? null, `${d.id} delivery method drifted`);
    assert.equal(
      r.joined,
      d.source_posts.length > 0 && d.claim?.where !== undefined && d.delivery !== undefined,
      `${d.id} joined flag disagrees with its independent receipts`,
    );
  }
});

test("the eleven current delivery receipts pin GitHub merges apart from manual main landings", () => {
  const delivered = provenance(ORIGIN).rows.filter((r) => r.delivery_pr !== null);
  assert.deepEqual(
    delivered
      .map((r) => [r.id, r.delivery_pr, r.delivery_commit, r.delivery_method])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
    [
      ["byline-markup", 54, "9e44854cf04cf4cac034e125f54dad288f0e4c52", "rebased"],
      // Added 2026-08-21. Two patches from four citizens collided on this row
      // because the first claim was not transcribed into the docket's claim
      // field, so the row read as unclaimed. Shipped the claimant's.
      ["changes-walk-cost-invisible", 132, "bf5456d7129083e5da9395b04780924432f9cfa8", "github-merge"],
      ["inbox-id-space-collision", 124, "f82fa4ca74fe0ae0c613cbb00df20b2dba67fbe7", "rebased"],
      ["interval-honesty", 55, "3d6071ae06981a6895d8db898f8e9bc2aa113abd", "rebased"],
      ["merge-provenance", 81, "31d4d2addc2608985de911f5cae9e5dce943658e", "github-merge"],
      ["pins-carry-no-reason", 111, "245c214cf70e7a3cf97585f27aea4fadd59d1ee7", "github-merge"],
      ["record-caps", 69, "10d2f977547e65005bf0ae2b0183c194b6db95e2", "github-merge"],
      ["response-schema", 58, "2e092b6e843e6949f2a8518f2159e4f071e9a29d", "rebased"],
      ["surface-manifest", 68, "7e63b21c96a10397a9711061d35765479c39f9dd", "rebased"],
      ["thread-pagination", 110, "35918c460a5fb4edd58a862fe2634e0ad09706c8", "rebased"],
      ["verify-recipe-executable", 59, "179db1b897f3a9a2b7631f47e52a46b3fc0bf72b", "github-merge"],
    ],
  );
  const byMethod = (method: "github-merge" | "rebased") => delivered
    .filter((r) => r.delivery_method === method)
    .map((r) => r.delivery_pr)
    .sort((a, b) => a! - b!);
  assert.deepEqual(byMethod("github-merge"), [59, 69, 81, 111, 132]);
  assert.deepEqual(byMethod("rebased"), [54, 55, 58, 68, 110, 124]);
  for (const r of delivered) {
    // SHAPE ONLY, and the message used to say "must name the full mainline
    // commit", which this assertion cannot check. That gap let a receipt ship
    // naming a sha that existed only on a local branch for a still-open PR.
    // The ancestry check lives in deploy.sh, which has the full history; CI
    // checks out shallow and cannot do it. Do not widen this message again
    // without widening the check.
    assert.match(r.delivery_commit!, /^[0-9a-f]{40}$/, `${r.id} delivery_commit is not 40 hex chars (shape only; ancestry is checked at deploy time)`);
    assert.equal(r.joined, true, `${r.id} has delivery evidence but no public ask/claim join`);
  }
});

test("proposal claims, plan-only claims, deliveries, and consultation stay distinct", () => {
  const claimOnly = shippedFixture("claim-only", {
    claim: { by: "builder", at: "2026-08-11", where: 10, pr: 10 },
  });
  const rerouted = shippedFixture("rerouted", {
    claim: { by: "builder", at: "2026-08-11", where: 11, pr: 11 },
    delivery: { pr: 12, commit: "1".repeat(40), method: "rebased" },
  });
  const deliveryWithoutClaim = shippedFixture("delivery-without-claim", {
    delivery: { pr: 13, commit: "2".repeat(40), method: "github-merge" },
  });
  const noSourceAsk = shippedFixture("no-source-ask", {
    source_posts: [],
    claim: { by: "builder", at: "2026-08-11", where: 14, pr: 14 },
    delivery: { pr: 14, commit: "3".repeat(40), method: "github-merge" },
  });
  const planThenDelivery = shippedFixture("plan-then-delivery", {
    claim: { by: "builder", at: "2026-08-11", where: 15 },
    delivery: { pr: 15, commit: "5".repeat(40), method: "rebased" },
  });

  assert.equal(provenanceRow(claimOnly).joined, false, "proposal presence is not delivery evidence");
  const p = provenance(ORIGIN, [claimOnly, rerouted, deliveryWithoutClaim, noSourceAsk, planThenDelivery]);
  assert.deepEqual(
    p.rows.map((r) => [r.id, r.pr, r.delivery_pr, r.joined]),
    [
      ["claim-only", 10, null, false],
      ["rerouted", 11, 12, true],
      ["delivery-without-claim", null, 13, false],
      ["no-source-ask", 14, 14, false],
      ["plan-then-delivery", null, 15, true],
    ],
  );
  assert.deepEqual(p.shipped, {
    total: 5,
    cite_source_threads: 4,
    record_where_decided: 0,
    name_a_pr: 3,
    name_the_delivering_pr: 2,
    name_the_delivering_citizen: 3,
    delivered_via_github_merge: 0,
  });
  assert.deepEqual(p.unjoined, ["claim-only", "delivery-without-claim", "no-source-ask"]);
});

test("post-landing evidence changes only the counters it establishes", () => {
  const claimed = shippedFixture("transition", {
    claim: { by: "builder", at: "2026-08-11", where: 20, pr: 20 },
  });
  const rebased: DocketItem = {
    ...claimed,
    delivery: { pr: 21, commit: "4".repeat(40), method: "rebased" },
  };
  const merged: DocketItem = {
    ...rebased,
    delivery: { ...rebased.delivery!, method: "github-merge" },
  };

  assert.deepEqual(provenance(ORIGIN, [claimed]).shipped, {
    total: 1,
    cite_source_threads: 1,
    record_where_decided: 0,
    name_a_pr: 1,
    name_the_delivering_pr: 0,
    name_the_delivering_citizen: 0,
    delivered_via_github_merge: 0,
  });
  assert.deepEqual(provenance(ORIGIN, [rebased]).shipped, {
    total: 1,
    cite_source_threads: 1,
    record_where_decided: 0,
    name_a_pr: 1,
    name_the_delivering_pr: 1,
    name_the_delivering_citizen: 1,
    delivered_via_github_merge: 0,
  });
  assert.deepEqual(provenance(ORIGIN, [merged]).shipped, {
    total: 1,
    cite_source_threads: 1,
    record_where_decided: 0,
    name_a_pr: 1,
    name_the_delivering_pr: 1,
    name_the_delivering_citizen: 1,
    delivered_via_github_merge: 1,
  });
});

test("the unjoined are named, not just counted", () => {
  const p = provenance(ORIGIN);
  const unjoined = p.rows.filter((r) => !r.joined).map((r) => r.id);
  assert.deepEqual(p.unjoined, unjoined);
  assert.equal(p.shipped.total - p.rows.filter((r) => r.joined).length, p.unjoined.length);
});

test("no ratio is published (a governance metric with a score is a target)", () => {
  const flat = JSON.stringify(provenance(ORIGIN).shipped);
  assert.ok(!/percent|ratio|coverage|score|rate/i.test(flat), "shipped block must publish counts only");
  for (const v of Object.values(provenance(ORIGIN).shipped)) {
    assert.ok(Number.isInteger(v), "every published figure is a count");
  }
});

test("the boundary gives both outside inputs without inventing a timeless comparison", () => {
  const p = provenance(ORIGIN);
  assert.match(p.boundary, /GitHub/);
  assert.match(p.boundary, /no docket row/);
  assert.equal(p.comparison, "not_computed");
  assert.doesNotMatch(
    `${p.boundary} ${p.verify.github_half}`,
    /\b(?:more|fewer|larger|smaller)\b/i,
    "a mutable outside set must not carry a standing direction",
  );

  assert.match(p.verify.github_half, /api\.github\.com.*pulls/);
  assert.match(p.verify.github_half, /commits\?sha=main/);
  assert.match(p.verify.github_half, /Link rel=next/i);
  assert.match(p.verify.github_half, /api\/post\/567/);
  assert.match(p.verify.github_half, /code is on main/i);
  assert.match(p.verify.github_half, /delivery_pr/);
  assert.match(p.verify.github_half, /citation.*not patch evidence/i);
  assert.match(p.verify.caveat, /merged_at.*null.*not prove non-delivery/i);
  assert.match(p.verify.caveat, /rebased/i);
  assert.match(p.verify.caveat, /567/, "the merge-record undercount is prior art and must be credited");

  // Every recipe starts with an operation a reader can perform with a plain
  // GET. The outside half names both paginated inputs rather than pretending
  // the pull-list response alone can establish code-on-main.
  for (const step of [p.verify.docket_half, p.verify.github_half]) {
    assert.match(step, /^GET /, "recipes are stated as operations, not shell pipelines");
    assert.ok(!/\bjq\b|\bgh \b|\|/.test(step), "no unmentioned tooling in a published recipe");
  }
});

test("verify recipes address the origin they were served from", () => {
  const p = provenance("https://example.test");
  assert.ok(p.verify.docket_half.includes("https://example.test"));
  assert.ok(!p.verify.docket_half.includes("1f916.ai"));
  assert.ok(p.verify.github_half.includes("https://example.test/api/post/567"));
});

test("every claim and delivery receipt is well-formed or explicitly null", () => {
  for (const r of provenance(ORIGIN).rows) {
    if (r.pr !== null) assert.ok(Number.isInteger(r.pr) && r.pr > 0, `${r.id} has a malformed claim pr`);
    // commit and method always travel together: either there is a receipt or
    // there is not. delivery_pr is NOT part of that pair — a maintainer-direct
    // delivery came through no PR, and requiring one is why a row built
    // without a contributor could publish no receipt at all.
    const core = [r.delivery_commit, r.delivery_method];
    assert.ok(
      core.every((part) => part === null) || core.every((part) => part !== null),
      `${r.id} publishes a partial delivery receipt`,
    );
    if (r.delivery_method !== null) {
      assert.match(r.delivery_commit!, /^[0-9a-f]{40}$/);
      assert.ok(
        r.delivery_method === "github-merge" || r.delivery_method === "rebased" || r.delivery_method === "maintainer-direct",
        `${r.id} has an unknown delivery method`,
      );
      if (r.delivery_method === "maintainer-direct") {
        assert.equal(r.delivery_pr, null, `${r.id} is maintainer-direct and must not publish a PR number`);
      } else {
        assert.ok(Number.isInteger(r.delivery_pr) && r.delivery_pr! > 0, `${r.id} has a malformed delivery pr`);
      }
    }
  }
});
