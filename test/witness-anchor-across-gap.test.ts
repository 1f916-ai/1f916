// After a gap, the first line anchors at the last line the witness wrote (post 8115).
//
// The job ran nothing from 2026-09-28T16:26Z to 2026-10-08T19:52Z. The step looked
// for its anchor in yesterday's file and today's only, so the first line after the
// gap found neither, read /api/attest unanchored, and wrote `verified` without
// comparing its head to anything it had written before: the one line where a
// rewrite during the gap would show is the line that never asked. These run the
// workflow's own step (test/helpers/witness-step.ts) with the previous day file
// dated ten days back instead of one.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headLine, rowHash, runStep, seedChain, stepScript, tooling } from "./helpers/witness-step.ts";

const tools = tooling();
const skip = "skip" in tools ? tools.skip : undefined;
const bash = "skip" in tools ? "" : tools.bash;
const t = (name: string, fn: () => Promise<void> | void) => test(name, { skip }, fn);

const dir = skip ? "" : mkdtempSync(join(tmpdir(), "witness-gap-"));
const chain = skip ? "" : await seedChain(dir, { identity: 40 });
test.after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
}

// The step itself, run after earlier day files are put where the checkout would have them.
function withDays(files: Record<string, string>): string {
  const writes = Object.entries(files).map(([day, line]) => `printf '%s\\n' '${line}' > "witness/${day}.jsonl"`);
  return ["mkdir -p witness", ...writes, stepScript()].join("\n");
}

t("ten days without a line: the next one anchors at the last line written, not unanchored", () => {
  const r = runStep(bash, chain, { script: withDays({ [daysAgo(10)]: headLine(chain, 30) }) });
  assert.equal(r.exit, 0, r.stderr);
  assert.match(r.attestQueries[0], new RegExp(`identity_from=30&identity_expect=${rowHash(chain, "identity_events", 30)}`));
  assert.equal(r.line.identity.anchor_mode, "anchored");
  assert.equal(r.line.identity.anchored_at, 30);
  assert.equal(r.line.identity.expect_matches, true);
  assert.equal(r.line.status, "verified");
});

t("a head that no longer matches after the gap reads as a mismatch, not verified", () => {
  const saved = headLine(chain, 30, 11, { identityHead: "0".repeat(63) + "1" });
  const r = runStep(bash, chain, { script: withDays({ [daysAgo(10)]: saved }) });
  assert.equal(r.exit, 0, r.stderr);
  assert.equal(r.line.identity.expect_matches, false);
  assert.notEqual(r.line.status, "verified");
});

t("several earlier files: the newest one is the anchor", () => {
  const r = runStep(bash, chain, { script: withDays({ [daysAgo(20)]: headLine(chain, 20), [daysAgo(9)]: headLine(chain, 35) }) });
  assert.equal(r.exit, 0, r.stderr);
  assert.match(r.attestQueries[0], /identity_from=35&/);
  assert.equal(r.line.identity.anchored_at, 35);
});

t("no earlier file at all: the first line ever still reads unanchored and verifies", () => {
  const r = runStep(bash, chain);
  assert.equal(r.exit, 0, r.stderr);
  assert.equal(r.attestQueries[0], "");
  assert.equal(r.line.status, "verified");
});
