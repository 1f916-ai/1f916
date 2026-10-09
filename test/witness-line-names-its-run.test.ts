// A head line names the run that wrote it (c98350 on post 8115).
//
// A line written by GitHub's schedule and one written by a workflow_dispatch
// were byte-for-byte the same kind of thing, so the schedule delivering about a
// quarter of its slots from 2026-09-05 showed in GitHub's runs API and nowhere
// in the day files. These run the workflow's own step (test/helpers/witness-step.ts)
// with and without the two variables Actions sets, on both kinds of head line
// the step writes: the attest line and the fetch_failed line.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStep, seedChain, tooling } from "./helpers/witness-step.ts";

const tools = tooling();
const skip = "skip" in tools ? tools.skip : undefined;
const bash = "skip" in tools ? "" : tools.bash;
const t = (name: string, fn: () => Promise<void> | void) => test(name, { skip }, fn);

const dir = skip ? "" : mkdtempSync(join(tmpdir(), "witness-run-id-"));
const chain = skip ? "" : await seedChain(dir, { identity: 40 });
test.after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

// runStep hands the step a copy of process.env; set the two variables for one
// run and put back whatever the suite's own runner had (Actions sets both).
function withRun<T>(vars: { GITHUB_EVENT_NAME?: string; GITHUB_RUN_ID?: string }, fn: () => T): T {
  const saved = { GITHUB_EVENT_NAME: process.env.GITHUB_EVENT_NAME, GITHUB_RUN_ID: process.env.GITHUB_RUN_ID };
  for (const k of ["GITHUB_EVENT_NAME", "GITHUB_RUN_ID"] as const) {
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of ["GITHUB_EVENT_NAME", "GITHUB_RUN_ID"] as const) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

t("a scheduled run: the line says schedule and carries its run id", () => {
  const r = withRun({ GITHUB_EVENT_NAME: "schedule", GITHUB_RUN_ID: "36441785432" }, () => runStep(bash, chain));
  assert.equal(r.exit, 0, r.stderr);
  assert.equal(r.line.status, "verified");
  assert.equal(r.line.trigger, "schedule");
  assert.equal(r.line.run_id, "36441785432", "a string: the id is a join key, not a quantity");
});

t("a run started by hand: the line says workflow_dispatch", () => {
  const r = withRun({ GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ID: "36451023633" }, () => runStep(bash, chain));
  assert.equal(r.exit, 0, r.stderr);
  assert.equal(r.line.trigger, "workflow_dispatch");
  assert.equal(r.line.run_id, "36451023633");
});

t("outside Actions: both keys are present and null, and set -u does not kill the step", () => {
  const r = withRun({}, () => runStep(bash, chain));
  assert.equal(r.exit, 0, r.stderr);
  assert.equal(r.line.status, "verified");
  assert.ok("trigger" in r.line && "run_id" in r.line, "absent and null are different answers; the line gives null");
  assert.equal(r.line.trigger, null);
  assert.equal(r.line.run_id, null);
});

t("a fetch_failed line names its run too: the run that could not reach the registry is the one most worth joining", () => {
  const r = withRun({ GITHUB_EVENT_NAME: "schedule", GITHUB_RUN_ID: "1" }, () => runStep(bash, chain, { failUrlContaining: "/api/attest" }));
  assert.equal(r.exit, 0, r.stderr);
  assert.equal(r.line.status, "fetch_failed");
  assert.equal(r.line.trigger, "schedule");
  assert.equal(r.line.run_id, "1");
});
