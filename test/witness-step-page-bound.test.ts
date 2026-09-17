// The witness step across the VERIFY_PAGE crossing (fix/witness-attest-page-bound, post 5095).
//
// /api/attest serves at most VERIFY_PAGE (20,000) rows per call. The witness job
// read one call as if it were the chain, so the day line it writes every five
// minutes flips to `unverified` the moment identity_events passes 20,000 rows
// with nothing tampered — a crossing the live log reaches in 2026-09. The fix
// anchors each run at the previous verified line and follows next_from while a
// log reads `incomplete`.
//
// head-of-engineering (c57979 on 5095) named the trap in the fix itself: no live
// response has ever carried next_from, so a loop written today is written
// against a shape nobody has observed, and guessing wrong fails as a silently
// short read — the defect, not the fix. These tests are the observation. They
// run the workflow's own bash+jq step (test/helpers/witness-step.ts) against
// chains seeded through schema.sql and served by the real attest(), at sizes the
// deployment has not reached: below the page, at it, over it by one page, over
// it by two; anchored and cold; with a tamper on the page the old step never
// read; with a wrong saved head; with a continuation fetch that dies. And one
// mutation: with the follow loop disabled the crossing case must go red, or
// nothing here is testing the loop.
//
// One row pins a cost rather than a guarantee: an anchored line covers the rows
// since the previous line plus the saved head at its position. An edit below
// the anchor that leaves the stored hashes in place reads `verified` on that
// line; the unanchored read (first line after a gap) and the signed checkpoint
// leg are what cover the prefix. Pinned so the meaning of a line is a tested
// statement, not a paragraph in README.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { attest, VERIFY_PAGE } from "../src/chain.ts";
import { SqliteD1 } from "./helpers/sqlite-d1.ts";
import { headLine, rowHash, runStep, seedChain, stepScript, tooling } from "./helpers/witness-step.ts";

const tools = tooling();
const skip = "skip" in tools ? tools.skip : undefined;
const bash = "skip" in tools ? "" : tools.bash;
const t = (name: string, fn: () => Promise<void> | void) => test(name, { skip }, fn);

const OVER = VERIFY_PAGE + 431; // 20,431: one page plus the tail head-of-engineering used as the worked example
const ANCHOR = 13047; // where the live log stood on 2026-09-13
const dir = skip ? "" : mkdtempSync(join(tmpdir(), "witness-page-bound-"));
const chain = skip
  ? ({} as Record<string, string>)
  : {
      under: await seedChain(dir, { identity: VERIFY_PAGE - 1 }),
      exact: await seedChain(dir, { identity: VERIFY_PAGE }),
      over: await seedChain(dir, { identity: OVER }),
      twoOver: await seedChain(dir, { identity: 2 * VERIFY_PAGE + 1000 }),
      tamperPage2: await seedChain(dir, { identity: OVER, tamper: VERIFY_PAGE + 100 }),
      tamperPage1: await seedChain(dir, { identity: OVER, tamper: 5000 }),
    };
test.after(() => {
  // Windows can still hold a handle on a database a child just read; a
  // leftover scratch file is not a failed test.
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const identity = (r: { line: Record<string, any> }) => r.line.identity as Record<string, any>;

t("the field the loop follows is the one attest() serves past the page: next_from, at VERIFY_PAGE", async () => {
  const db = new DatabaseSync(chain.over, { readOnly: true });
  try {
    const d1 = new SqliteD1(db);
    const first = (await attest(d1)).identity_log;
    assert.equal(first.status, "incomplete");
    assert.equal(first.next_from, VERIFY_PAGE, "the page is VERIFY_PAGE rows counted from id 0, legacy prefix included");
    assert.equal(first.verified_through_id, VERIFY_PAGE);
    const second = (await attest(d1, 0, { identityFrom: first.next_from })).identity_log;
    assert.equal(second.status, "verified");
    assert.equal(second.verified_through_id, OVER);
  } finally {
    db.close();
  }
});

t("under the page, cold: one call, verified, pages 1", () => {
  const r = runStep(bash, chain.under);
  assert.equal(r.exit, 0, r.stderr);
  assert.deepEqual(r.attestQueries, [""]);
  assert.equal(r.line.status, "verified");
  assert.equal(identity(r).status, "verified");
  assert.equal(identity(r).verified_through_id, VERIFY_PAGE - 1);
  assert.equal(identity(r).pages, 1);
  assert.equal(identity(r).anchor_mode, "unanchored");
});

t("exactly VERIFY_PAGE rows, cold: one call, verified (the sentinel row, not rows.length, decides the end)", () => {
  const r = runStep(bash, chain.exact);
  assert.equal(r.exit, 0, r.stderr);
  assert.deepEqual(r.attestQueries, [""]);
  assert.equal(r.line.status, "verified");
  assert.equal(identity(r).verified_through_id, VERIFY_PAGE);
  assert.equal(identity(r).pages, 1);
});

t("over the page, cold: the step follows next_from and writes verified through the tip, pages 2", () => {
  const r = runStep(bash, chain.over);
  assert.equal(r.exit, 0, r.stderr);
  assert.equal(r.attestQueries.length, 2, `calls: ${JSON.stringify(r.attestQueries)}`);
  assert.equal(r.attestQueries[0], "", "first read is unanchored: no day file to anchor on");
  assert.match(r.attestQueries[1], /^identity_from=20000&/, "the continuation starts where page one stopped");
  assert.doesNotMatch(r.attestQueries[1], /identity_expect=/, "no expect on a continuation; the witness comparison is page one's");
  assert.match(r.attestQueries[1], /ledger_from=11&ledger_expect=[0-9a-f]{64}$/, "a log already verified is re-passed at its own tip");
  assert.equal(r.line.status, "verified");
  assert.equal(identity(r).status, "verified");
  assert.equal(identity(r).verified_through_id, OVER, "not 20,000: a short read would stop there and this line would still say verified");
  assert.equal(identity(r).total_rows, OVER);
  assert.equal(identity(r).pages, 2);
  assert.equal(identity(r).anchor_mode, "unanchored");
  assert.equal(identity(r).anchored_at, null);
  assert.equal(r.line.treasury.status, "verified");
  assert.ok(r.git.some((g) => g.startsWith("git commit")), "the step reached git commit");
});

t("over the page, anchored at yesterday's line: one call, verified, expect_matches true", () => {
  const r = runStep(bash, chain.over, { yesterday: headLine(chain.over, ANCHOR) });
  assert.equal(r.exit, 0, r.stderr);
  assert.equal(r.attestQueries.length, 1, `calls: ${JSON.stringify(r.attestQueries)}`);
  assert.equal(
    r.attestQueries[0],
    `identity_from=${ANCHOR}&identity_expect=${rowHash(chain.over, "identity_events", ANCHOR)}&ledger_from=11&ledger_expect=${rowHash(chain.over, "ledger", 11)}`,
    "the anchor is the previous line's heads at their positions, both logs",
  );
  assert.equal(r.line.status, "verified");
  assert.equal(identity(r).status, "verified");
  assert.equal(identity(r).verified_through_id, OVER);
  assert.equal(identity(r).expect_matches, true);
  assert.equal(identity(r).anchor_mode, "anchored");
  assert.equal(identity(r).anchored_at, ANCHOR);
  assert.equal(identity(r).pages, 1);
  assert.equal(r.line.treasury.expect_matches, true);
});

t("an anchor more than a page behind (a gap of days): the anchored read is incomplete and the loop finishes it", () => {
  const r = runStep(bash, chain.over, { yesterday: headLine(chain.over, 31) });
  assert.equal(r.exit, 0, r.stderr);
  assert.equal(r.attestQueries.length, 2, `calls: ${JSON.stringify(r.attestQueries)}`);
  assert.match(r.attestQueries[0], /^identity_from=31&identity_expect=/);
  assert.match(r.attestQueries[1], /^identity_from=20031&/, "page one from 31 covers 32..20031; the continuation resumes there");
  assert.equal(r.line.status, "verified");
  assert.equal(identity(r).verified_through_id, OVER);
  assert.equal(identity(r).expect_matches, true, "the witness verdict is page one's and survives the continuation");
  assert.equal(identity(r).anchored_at, 31, "anchor fields on the line are page one's, not the continuation's");
  assert.equal(identity(r).pages, 2);
});

t("two pages over: three calls, each resuming at the previous next_from", () => {
  const r = runStep(bash, chain.twoOver);
  assert.equal(r.exit, 0, r.stderr);
  assert.deepEqual(
    r.attestQueries.map((q) => q.replace(/&ledger_from=.*$/, "")),
    ["", "identity_from=20000", "identity_from=40000"],
  );
  assert.equal(r.line.status, "verified");
  assert.equal(identity(r).verified_through_id, 2 * VERIFY_PAGE + 1000);
  assert.equal(identity(r).pages, 3);
});

t("MUTATION: with the follow loop disabled, the crossing case is the defect the fix exists for", () => {
  const script = stepScript();
  const mutated = script.replace('[ "$pages" -lt 8 ]', '[ "$pages" -lt 1 ]');
  assert.notEqual(mutated, script, "the loop bound is where this test expects it; if the step changed, move the mutation with it");
  const r = runStep(bash, chain.over, { script: mutated });
  assert.equal(r.exit, 0, r.stderr);
  assert.deepEqual(r.attestQueries, [""], "one read, as before the fix");
  assert.equal(r.line.status, "unverified", "nothing tampered, and the line says unverified: that is the finding");
  assert.equal(identity(r).status, "incomplete");
  assert.equal(identity(r).verified_through_id, VERIFY_PAGE);
  assert.equal(identity(r).pages, 1);
});

t("a tamper on the second page, cold: the continuation finds it and the line is unverified/broken", () => {
  const r = runStep(bash, chain.tamperPage2);
  assert.equal(r.exit, 0, r.stderr);
  assert.equal(r.attestQueries.length, 2);
  assert.equal(r.line.status, "unverified");
  assert.equal(identity(r).status, "broken", "the old step never read this page; a silently short read would say verified here");
  assert.equal(identity(r).pages, 2);
});

t("a tamper on the second page, anchored: the anchored read covers it and the line is unverified/broken", () => {
  const r = runStep(bash, chain.tamperPage2, { yesterday: headLine(chain.tamperPage2, ANCHOR) });
  assert.equal(r.exit, 0, r.stderr);
  assert.equal(r.line.status, "unverified");
  assert.equal(identity(r).status, "broken");
  assert.equal(identity(r).expect_matches, true, "the saved head at 13,047 is intact; the damage is above it");
});

t("a tamper on the first page, cold: broken on page one, no continuation attempted", () => {
  const r = runStep(bash, chain.tamperPage1);
  assert.equal(r.exit, 0, r.stderr);
  assert.deepEqual(r.attestQueries, [""], "broken is not incomplete; the loop does not run");
  assert.equal(r.line.status, "unverified");
  assert.equal(identity(r).status, "broken");
});

t("SCOPE: a tamper below the anchor with stored hashes intact reads verified on an anchored line", () => {
  // The cost of anchoring, stated as a test rather than discovered. An anchored
  // call hashes rows above the anchor and compares the saved head at it; row
  // 5,000's edited detail is below both. The cold read above (first line after
  // a gap) and the signed checkpoint leg cover the prefix; a line does not.
  const r = runStep(bash, chain.tamperPage1, { yesterday: headLine(chain.tamperPage1, ANCHOR) });
  assert.equal(r.exit, 0, r.stderr);
  assert.equal(r.line.status, "verified");
  assert.equal(identity(r).status, "verified");
  assert.equal(identity(r).expect_matches, true);
  assert.equal(identity(r).anchored_at, ANCHOR);
});

t("a wrong saved head: mismatch, expect_matches false, line unverified — the alarm the anchor exists for", () => {
  const r = runStep(bash, chain.over, { yesterday: headLine(chain.over, ANCHOR, 11, { identityHead: "f".repeat(64) }) });
  assert.equal(r.exit, 0, r.stderr);
  assert.equal(r.line.status, "unverified");
  assert.equal(identity(r).status, "mismatch");
  assert.equal(identity(r).expect_matches, false);
  assert.equal(r.line.treasury.expect_matches, true, "the other log's witness is independent");
});

t("a continuation fetch that fails: the line is written from page one, unverified/incomplete, and the step still commits", () => {
  const r = runStep(bash, chain.over, { failUrlContaining: "identity_from=20000" });
  assert.equal(r.exit, 0, r.stderr);
  assert.equal(r.attestQueries.length, 2, "the continuation was attempted");
  assert.equal(r.line.status, "unverified");
  assert.equal(identity(r).status, "incomplete");
  assert.equal(identity(r).verified_through_id, VERIFY_PAGE);
  assert.equal(identity(r).pages, 1, "pages counts responses received, not requests made");
  assert.ok(r.git.some((g) => g.startsWith("git commit")), "a recorded null, not a crash (hermes, #468)");
});

t("a checkpoint fetch that fails: the head line is still written, verified, with checkpoints fetch_failed", () => {
  const r = runStep(bash, chain.over, { failUrlContaining: "/api/checkpoint" });
  assert.equal(r.exit, 0, r.stderr);
  assert.equal(r.line.status, "verified");
  assert.equal(r.line.checkpoints, "fetch_failed");
  assert.equal(identity(r).pages, 2);
  assert.equal(r.line.lag.identity.state, "unpaired");
});

t("every key the line carries is named in witness/README.md", () => {
  const readme = readFileSync(join(fileURLToPath(new URL("../", import.meta.url)), "witness", "README.md"), "utf8");
  const r = runStep(bash, chain.over, { yesterday: headLine(chain.over, ANCHOR) });
  const keys = new Set<string>(Object.keys(r.line));
  for (const block of ["identity", "treasury", "lag"]) for (const k of Object.keys(r.line[block] ?? {})) keys.add(k);
  const undocumented = [...keys].filter((k) => !new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(readme));
  assert.deepEqual(undocumented, [], "a reader of the day file learns each field from README, not from the workflow");
});
