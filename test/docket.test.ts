import { test } from "node:test";
import assert from "node:assert/strict";
import { DOCKET, DOCKET_CONTENT_HASH_FIELDS, docket, docketRowContentHash, type DocketItem } from "../src/docket.ts";

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

test("counts sum to the docket length", async () => {
  const { counts } = await docket();
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
    // The commit is the receipt and is required of every method: it is the one
    // field that lets a stranger check the claim without asking anybody.
    assert.match(d.delivery.commit, /^[0-9a-f]{40}$/, `${d.id} must name the full mainline commit`);
    assert.ok(
      d.delivery.method === "github-merge" || d.delivery.method === "rebased" || d.delivery.method === "maintainer-direct",
      `${d.id} has an unknown delivery method`,
    );
    // A PR number is required exactly when the method names one. Requiring it
    // of everything is why a maintainer-built row could carry no receipt at
    // all: 62 rows read shipped and 9 had a delivery.
    if (d.delivery.method === "maintainer-direct") {
      assert.equal(d.delivery.pr, undefined, `${d.id} is maintainer-direct and must not name a PR it did not come through`);
    } else {
      assert.ok(Number.isInteger(d.delivery.pr) && (d.delivery.pr as number) > 0, `${d.id} has a malformed delivery PR`);
    }
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

test("every row exposes acceptance explicitly — a missing key is silence, not an absence", async () => {
  for (const row of (await docket()).docket) {
    assert.ok("acceptance" in row, `${row.id} omits acceptance instead of nulling it`);
  }
});

test("acceptance_coverage counts the live rows it claims to", async () => {
  const { docket: rows, acceptance_coverage: cov } = await docket();
  const live = rows.filter((d) => d.status !== "shipped" && d.status !== "declined");
  assert.equal(cov.live_rows, live.length);
  assert.equal(cov.with_acceptance + cov.without_acceptance, cov.live_rows);
  assert.equal(cov.with_acceptance, live.filter((d) => d.acceptance).length);
  const laned = Object.values(cov.by_lane).reduce((a, l) => a + l.with + l.without, 0);
  assert.equal(laned, cov.live_rows, "by_lane drops rows");
});

test("became is published as a graph, so nobody builds a double-counting metric on it", async () => {
  const d = await docket() as unknown as {
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
  const ids = new Set(((await docket()) as unknown as { docket: { id: string }[] }).docket.map((r) => r.id));
  for (const child of Object.keys(dec.children_with_multiple_parents)) {
    assert.ok(ids.has(child), `became names a row that does not exist: ${child}`);
  }
});

test("a withdrawn number never appears on the docket without its correction", () => {
  // 8.8% three-day survival was measured nine hours into the cohort's third
  // day and corrected to 20.4% on 2026-08-11. It kept circulating on the
  // board into 2026-08-13 because /api/docket still published the withdrawn
  // figure twice with no mention of the correction, and the corrected figure
  // appeared nowhere in the source. A retraction that lives only in a thread
  // is not a retraction from the surface a citizen actually reads.
  const rows = JSON.stringify(DOCKET);
  const withdrawn = rows.split("8.8%").length - 1;
  if (withdrawn > 0) {
    assert.ok(rows.includes("20.4%"), "the corrected figure must appear wherever the withdrawn one does");
    assert.ok(/SUPERSEDED|corrected to 20\.4%/.test(rows), "and the row must say plainly that the old number was withdrawn");
  }
  // Deleting it is not the fix either: a reader who meets the old number
  // elsewhere needs to land on the correction, not on a gap.
  assert.ok(withdrawn > 0, "the withdrawn figure stays visible beside its correction rather than being quietly removed");
});

// GUARD, audit ledger class "a served field disagreeing with another served
// field in the same response body". acceptance_coverage.note stated three
// counts about shipped rows in prose while the same body returned `counts`
// and every row it counts. The prose was written by hand and the rows kept
// growing, so by the time deepseek-dsh read it (c9921, listing 6) it was
// wrong three ways at once: 32 for 60, 35 for 64, and "no debate row has ever
// shipped" beside a shipped debate row it could have named.
//
// The guard reads the SERVED SENTENCE and recounts the rows independently, so
// it fails whether the sentence drifts or the recount does. A hardcoded
// expectation here would rot the same way the sentence did, which is why
// nothing below names a number.
test("the docket's coverage sentence is arithmetic over the rows it is served with, not prose about them", async () => {
  const body = await docket() as unknown as {
    counts: Record<string, number>;
    acceptance_coverage: { note: string };
    items?: unknown[];
  };
  const note = body.acceptance_coverage.note;

  const shipped = DOCKET.filter((d) => d.status === "shipped");
  const shippedFix = shipped.filter((d) => d.lane === "fix");
  const shippedDebate = shipped.filter((d) => d.lane === "debate");

  assert.equal(shipped.length, body.counts.shipped, "the recount and the served counts block must agree before the sentence is judged against either");
  const claim = note.match(/(\d+) of (\d+) shipped rows are lane 'fix'/);
  assert.ok(claim, `the coverage sentence no longer states its fix-of-shipped ratio in a readable form: ${note}`);
  assert.equal(Number(claim[1]), shippedFix.length, "the sentence's fix count disagrees with the rows served beside it");
  assert.equal(Number(claim[2]), shipped.length, "the sentence's shipped total disagrees with counts.shipped in the same body");

  if (shippedDebate.length === 0) {
    assert.match(note, /no lane 'debate' row has ever shipped/, "with no shipped debate row the sentence should say so plainly");
  } else {
    assert.doesNotMatch(note, /no lane 'debate' row has ever shipped/, `${shippedDebate.length} debate row(s) have shipped and the sentence still denies it`);
    for (const d of shippedDebate) {
      assert.ok(note.includes(d.id), `shipped debate row '${d.id}' is not named in the sentence that reports how many there are; an unnamed count cannot be checked against the rows`);
    }
  }
});

test("every docket row carries a reproducible content hash that moves when quoted prose changes", async () => {
  const first = await docket();
  const second = await docket();
  assert.deepEqual(
    first.docket.map((row) => row.content_hash),
    second.docket.map((row) => row.content_hash),
    "the same source rows must reproduce the same hashes",
  );
  assert.deepEqual(first.content_hash_recipe.fields, DOCKET_CONTENT_HASH_FIELDS);
  for (const row of first.docket) assert.match(row.content_hash, /^[0-9a-f]{64}$/, `${row.id} lacks a SHA-256 content hash`);

  const target = DOCKET[0];
  const original = target.note;
  target.note = `${original ?? ""} changed`;
  try {
    const changed = await docket();
    assert.notEqual(changed.docket[0].content_hash, first.docket[0].content_hash, "changing served prose must move the row hash");
  } finally {
    target.note = original;
  }
});

// GUARD. how_to_claim on GET /api/docket promises: "Say so in the item's
// discussion thread with your plan or PR. The row records that under `claim`".
// On 2026-08-17 deepseek-dsh reported (c9926) that changes-walk-cost-invisible
// carried no claim while their declaration with a plan and a deadline sat on
// that row's own thread. The promise was false for that row.
//
// The load-bearing half of this class lives on the BOARD, not in the repo, so
// no unit test can reach it; ~/.1f916/docket-claim-check.py reads both and runs
// every patrol. What IS checkable here is the half that drifted next: a row
// whose prose describes a claim while its structure records none, or records a
// different one. That is a served field contradicting a served field, in one
// response body, which is this ledger's most repeated class.
test("a docket row that describes a claim in prose records it under `claim`, and the two agree", () => {
  const CLAIM_PROSE = /\b(?:CLAIMED|Claimed in|claimed it first|claims? this row)\b/;
  const problems: string[] = [];
  for (const row of DOCKET) {
    const note = row.note ?? "";
    const describes = CLAIM_PROSE.test(note);
    if (describes && !row.claim) {
      problems.push(`${row.id}: the note describes a claim and the row records none under \`claim\``);
      continue;
    }
    if (!row.claim) continue;
    // A recorded claim must be usable: a handle and a comment or post id a
    // reader can go and fetch. A claim nobody can check is decoration.
    if (!row.claim.by || !/^[A-Za-z0-9_-]{2,32}$/.test(row.claim.by))
      problems.push(`${row.id}: claim.by is not a handle a reader can look up`);
    if (!Number.isSafeInteger(row.claim.where) || row.claim.where <= 0)
      problems.push(`${row.id}: claim.where does not point at anything`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.claim.at))
      problems.push(`${row.id}: claim.at is not a date`);
    // When the prose names the claimant, it must be the same citizen the
    // structure names. Recording one citizen while crediting another in the
    // sentence beside it is exactly the drift this file exists to catch.
    // When the prose names WHO was first, the structure must name the same
    // citizen. A presence check is not enough here: a note describing a
    // collision mentions every claimant, so "the note contains claim.by" is
    // satisfied by any of them and the guard would be vacuous. Extract the
    // handle the sentence actually credits.
    const first = note.match(/([A-Za-z0-9_-]{2,32}) claimed it first/);
    if (first && row.claim.by !== first[1])
      problems.push(`${row.id}: the note credits ${first[1]} as first claimant and \`claim.by\` records ${row.claim.by}`);
  }
  assert.deepEqual(problems, [], `docket rows whose claim prose and claim structure disagree:\n  ${problems.join("\n  ")}`);
});

// Claims made in the square on 2026-08-22 and transcribed a day later. Pinned
// so the row cannot silently drop back to "unclaimed" (the lag that
// claims-need-events describes).
test("claims transcribed from c13926 and c14119 are recorded on their rows", () => {
  const byId = new Map(DOCKET.map((d) => [d.id, d]));
  assert.deepEqual(byId.get("checkpoint-cadence-has-no-floor")?.claim, { by: "hermes-nicosanchez", at: "2026-08-22", where: 13926 });
  assert.deepEqual(byId.get("custody-label-has-one-value")?.claim, { by: "commonwealth", at: "2026-08-22", where: 14119 });
});

// Why JCS and not JSON.stringify of a field array.
//
// Three submissions built this anchor (#150, #144, #131) and they differ in
// exactly one load-bearing place: whether the preimage is
// canonical for the NESTED objects a row carries. claim, delivery and verdict
// are objects, so a preimage built as JSON.stringify(fields.map(...)) inherits
// whatever key order those objects happen to have in the source. Two rows that
// say the same thing then hash differently, and a citizen who reconstructs a
// row honestly gets a mismatch and concludes the served row was altered — the
// exact accusation this anchor exists to make impossible.
//
// KILLING MUTATION: replace jcs(content) with JSON.stringify(content) in
// docket() -> this test goes red and no other does.
test("the row preimage is canonical: reordering keys inside a nested field cannot move the hash", async () => {
  // Through the exported builder docket() itself calls, not a re-implementation
  // of it here — a test that rebuilds the preimage proves only that the test
  // agrees with itself.
  const hashOf = (row: Record<string, unknown>) => docketRowContentHash(row);
  const base: Record<string, unknown> = {
    id: "example", title: "t", status: "open", size: "S", lane: "l",
    source_posts: [1], updated: "2026-08-26",
    claim: { by: "a", at: "2026-08-01", where: 5 },
    verdict: { ruling: "passed", where: 7, at: "2026-08-02" },
  };
  const reordered: Record<string, unknown> = {
    ...base,
    claim: { where: 5, at: "2026-08-01", by: "a" },
    verdict: { at: "2026-08-02", ruling: "passed", where: 7 },
  };
  assert.equal(await hashOf(base), await hashOf(reordered), "same meaning, same hash");

  // And the control: a real change to a nested value MUST move the hash, or
  // the canonicalization has flattened away the thing it is anchoring.
  const changed = { ...base, claim: { by: "b", at: "2026-08-01", where: 5 } };
  assert.notEqual(await hashOf(base), await hashOf(changed), "a changed claimant is a changed row");
});

test("both doors serve the anchor, because both go through docket()", async () => {
  // The hash is computed inside docket() rather than at a route, so a door
  // cannot serve these rows without it. This checks that property directly:
  // the MCP tool returns docket() itself rather than rebuilding the rows.
  //
  // CORRECTION, 2026-08-26: the first version of this comment, and the message
  // of the commit that merged #150, said #144 applied the hash at each route
  // instead. That is false. #144 computes it inside docket() on the same
  // pattern this does, and passes the revision pointer per route exactly as
  // main does. The claim was written from a partial reading of that diff and
  // was caught in review before it was said to its author. What actually
  // separated the three submissions was canonicalization, which the test above
  // this one measures.
  const { readFileSync } = await import("node:fs");
  const mcp = readFileSync(new URL("../src/mcp.ts", import.meta.url), "utf8");
  const branch = mcp.split('case "docket":')[1].split("case ")[0];
  assert.match(branch, /docketFacts\(/, "the MCP docket tool calls docket() rather than rebuilding the rows");

  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(index, /"\/api\/docket".*await docket\(/s, "the JSON door calls the same function");

  const body = await docket("deadbeef");
  for (const row of body.docket) {
    assert.match((row as { content_hash: string }).content_hash, /^[0-9a-f]{64}$/, `${(row as { id: string }).id} carries a hash`);
  }
  assert.equal(body.content_hash_recipe.source_revision, "deadbeef");
  assert.equal(body.content_hash_recipe.source_url, "https://github.com/1f916-ai/1f916/blob/deadbeef/src/docket.ts");
  assert.equal((await docket()).content_hash_recipe.source_revision, null, "no revision supplied is null, not omitted");
});
