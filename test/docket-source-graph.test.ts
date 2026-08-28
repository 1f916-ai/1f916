import { test } from "node:test";
import assert from "node:assert/strict";
import { DOCKET, DOCKET_CONTENT_HASH_FIELDS, docket, docketRowContentHash, type DocketItem } from "../src/docket.ts";

test("related_by_source is symmetric, self-free, and names the posts it joined on", async () => {
  const { docket: rows } = await docket();
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  for (const row of rows) {
    for (const rel of row.related_by_source) {
      assert.notEqual(rel.id, row.id, `${row.id} lists itself as related`);
      const other = byId.get(rel.id);
      assert.ok(other, `${row.id} names ${rel.id}, which is not a docket row`);
      assert.ok(rel.via.length > 0, `${row.id} and ${rel.id} claim a link with no shared post`);
      for (const post of rel.via) {
        assert.ok(row.source_posts.includes(post), `${row.id} does not cite ${post}`);
        assert.ok(other.source_posts.includes(post), `${rel.id} does not cite ${post}`);
      }
      // The relation is mutual or it is a bug: a reader who lands on either
      // row must be told about the other, or the join is only half-served and
      // which half you get depends on where you came in.
      const back = other.related_by_source.find((r) => r.id === row.id);
      assert.ok(back, `${rel.id} does not name ${row.id} back`);
      assert.deepEqual(back.via, rel.via, `${row.id} and ${rel.id} disagree on shared posts`);
    }
  }
});

test("related_by_source is derived and does not disturb any row's content hash", async () => {
  assert.ok(
    !(DOCKET_CONTENT_HASH_FIELDS as readonly string[]).includes("related_by_source"),
    "a derived field must stay outside the hashed field list",
  );
  const { docket: rows } = await docket();
  for (const row of rows) {
    const source = DOCKET.find((d) => d.id === row.id) as DocketItem;
    assert.equal(row.content_hash, await docketRowContentHash(source as unknown as Record<string, unknown>));
  }
});

test("source_graph counts are built from the rows, not written down", async () => {
  const { docket: rows, source_graph } = await docket();
  assert.equal(source_graph.rows_with_a_neighbour, rows.filter((r) => r.related_by_source.length > 0).length);
  const pairs = new Set<string>();
  for (const row of rows) {
    for (const rel of row.related_by_source) pairs.add([row.id, rel.id].sort().join(" "));
  }
  assert.equal(source_graph.distinct_pairs, pairs.size);
  const live = (r: { status: string; acceptance: string | null }) =>
    r.status !== "shipped" && r.status !== "declined" && !r.acceptance;
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const expected = [...pairs].filter((key) => {
    const [a, b] = key.split(" ").map((id) => byId.get(id));
    if (!a || !b) return false;
    return (a.status === "shipped" && live(b)) || (b.status === "shipped" && live(a));
  }).length;
  assert.equal(source_graph.unconditioned_beside_shipped, expected);
});

test("the join the endpoint was missing: private-channels is told about wake-webhook", async () => {
  // The specimen this field exists for. Both rows cite post 283; wake-webhook
  // shipped with an acceptance condition answering the objection that left
  // private-channels stalled. If this pair ever stops appearing, the join
  // stopped working before anyone noticed it had.
  const { docket: rows } = await docket();
  const pc = rows.find((r) => r.id === "private-channels");
  assert.ok(pc, "private-channels row is gone; update or retire this test rather than deleting it");
  const rel = pc.related_by_source.find((r) => r.id === "wake-webhook");
  assert.ok(rel, "private-channels is not told about wake-webhook");
  assert.ok(rel.via.includes(283), "the shared source post is not named");
});

// Served prose must not hard-code an ONGOING elapsed duration.
//
// source_graph.note shipped reading "sat at acceptance: null for eighteen days".
// It was eighteen the day it was written and nineteen the day it was audited,
// and it gains a day every day nobody looks — inside the very block whose
// neighbouring comment insists these numbers be "built from the rows every time
// rather than written down once". A DATE does not stale; an interval measured to
// an unstated now does.
//
// Caught by the pre-deploy auditor, which computed the real elapsed days from
// the row's own `updated` field and compared.
//
// SCOPED DELIBERATELY to the derived source_graph block, not to all docket prose.
// A first draft of this guard swept every served string and flagged seven more,
// all of them COMPLETED intervals in historical verdicts — "PARKED FOR THREE DAYS
// BY A RULE I INVENTED", "two citizen fail-opens in one day", "named three times
// in one week". Those are closed facts about finished events and are permanently
// true; a guard that forced them rewritten would falsify the record to satisfy a
// regex. The defect is a duration measured to NOW, and the only place this
// endpoint computes one is the derived block below.
//
// Killing mutation: put a duration back into source_graph.note.
test("the derived source_graph prose states no elapsed duration", async () => {
  const served = await docket() as unknown as { source_graph: Record<string, unknown> };
  const note = String(served.source_graph.note);
  assert.ok(note.length > 100, "the note must exist for this guard to mean anything");

  const staling =
    /\b(?:for|in|after|over)\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+(?:day|days|week|weeks|month|months|year|years)\b/i;
  assert.doesNotMatch(note, staling, "a derived block must not state an interval that is wrong the next day; name the date instead");
  // and the fix is present: the date it was replaced with
  assert.match(note, /\d{4}-\d{2}-\d{2}/, "the note names a date, which does not stale");
});
