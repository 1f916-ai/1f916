// A head line names the run that wrote it (c98350 on post 8115).
//
// A line written by GitHub's schedule and one written by a workflow_dispatch
// were byte-for-byte the same kind of thing, so the schedule delivering about a
// quarter of its slots from 2026-09-05 showed in GitHub's runs API and nowhere
// in the day files. These run the workflow's own step (test/helpers/witness-step.ts)
// with and without the two variables Actions sets, on both kinds of head line
// the step writes: the attest line and the fetch_failed line.
//
// A scheduled line also names the cron line that fired it (c104324 on post
// 8395): the workflow carries two, :07 and :23, and neither `trigger` nor the
// runs API says which started a given run. Actions puts the string in the
// event payload at GITHUB_EVENT_PATH; these hand the step such a file.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// An event payload as Actions writes it, at a path bash can open on any OS.
function payload(name: string, body: unknown): string {
  const p = join(dir, name);
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
  return p.replace(/\\/g, "/");
}

// runStep hands the step a copy of process.env; set the variables for one run
// and put back whatever the suite's own runner had (Actions sets all three,
// so a run of this suite inside Actions must not leak its own push payload).
const RUN_VARS = ["GITHUB_EVENT_NAME", "GITHUB_RUN_ID", "GITHUB_EVENT_PATH"] as const;
type RunVars = Partial<Record<(typeof RUN_VARS)[number], string>>;
function withRun<T>(vars: RunVars, fn: () => T): T {
  const saved: RunVars = {};
  for (const k of RUN_VARS) saved[k] = process.env[k];
  for (const k of RUN_VARS) {
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of RUN_VARS) {
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

t("a scheduled run names the cron line that fired it, so :07 and :23 starts can be told apart", () => {
  for (const cron of ["7 * * * *", "23 * * * *"]) {
    const event = payload(`schedule-${cron.split(" ")[0]}.json`, { schedule: cron });
    const r = withRun({ GITHUB_EVENT_NAME: "schedule", GITHUB_RUN_ID: "2", GITHUB_EVENT_PATH: event }, () => runStep(bash, chain));
    assert.equal(r.exit, 0, r.stderr);
    assert.equal(r.line.status, "verified");
    assert.equal(r.line.schedule, cron);
  }
});

t("schedule is null when the run was not scheduled, even if the payload carries one", () => {
  const event = payload("dispatch.json", { schedule: "7 * * * *" });
  const r = withRun({ GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ID: "3", GITHUB_EVENT_PATH: event }, () => runStep(bash, chain));
  assert.equal(r.exit, 0, r.stderr);
  assert.ok("schedule" in r.line);
  assert.equal(r.line.schedule, null);
});

t("a missing, unreadable or non-string schedule gives null and never kills the step", () => {
  const cases: RunVars[] = [
    { GITHUB_EVENT_NAME: "schedule", GITHUB_RUN_ID: "4" },
    { GITHUB_EVENT_NAME: "schedule", GITHUB_RUN_ID: "5", GITHUB_EVENT_PATH: payload("absent.json", {}) },
    { GITHUB_EVENT_NAME: "schedule", GITHUB_RUN_ID: "6", GITHUB_EVENT_PATH: payload("garbage.json", "not json {") },
    { GITHUB_EVENT_NAME: "schedule", GITHUB_RUN_ID: "7", GITHUB_EVENT_PATH: payload("number.json", { schedule: 7 }) },
    { GITHUB_EVENT_NAME: "schedule", GITHUB_RUN_ID: "8", GITHUB_EVENT_PATH: join(dir, "no-such-file.json").replace(/\\/g, "/") },
  ];
  for (const vars of cases) {
    const r = withRun(vars, () => runStep(bash, chain));
    assert.equal(r.exit, 0, `${vars.GITHUB_EVENT_PATH}: ${r.stderr}`);
    assert.equal(r.line.status, "verified");
    assert.equal(r.line.schedule, null, String(vars.GITHUB_EVENT_PATH));
  }
});

t("a run started by hand: the line says workflow_dispatch", () => {
  const r = withRun({ GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ID: "36451023633" }, () => runStep(bash, chain));
  assert.equal(r.exit, 0, r.stderr);
  assert.equal(r.line.trigger, "workflow_dispatch");
  assert.equal(r.line.run_id, "36451023633");
});

t("outside Actions: all three keys are present and null, and set -u does not kill the step", () => {
  const r = withRun({}, () => runStep(bash, chain));
  assert.equal(r.exit, 0, r.stderr);
  assert.equal(r.line.status, "verified");
  assert.ok("trigger" in r.line && "run_id" in r.line && "schedule" in r.line, "absent and null are different answers; the line gives null");
  assert.equal(r.line.trigger, null);
  assert.equal(r.line.run_id, null);
  assert.equal(r.line.schedule, null);
});

t("a fetch_failed line names its run too: the run that could not reach the registry is the one most worth joining", () => {
  const event = payload("schedule-ff.json", { schedule: "23 * * * *" });
  const r = withRun({ GITHUB_EVENT_NAME: "schedule", GITHUB_RUN_ID: "1", GITHUB_EVENT_PATH: event }, () =>
    runStep(bash, chain, { failUrlContaining: "/api/attest" }),
  );
  assert.equal(r.exit, 0, r.stderr);
  assert.equal(r.line.status, "fetch_failed");
  assert.equal(r.line.trigger, "schedule");
  assert.equal(r.line.run_id, "1");
  assert.equal(r.line.schedule, "23 * * * *");
});
