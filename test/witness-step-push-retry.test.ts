// One retry on the witness push (fix/witness-push-retry, c76755 on post 5095).
//
// On 2026-09-23 two witness runs (35834326441 at 07:55Z, 35871037409 at 14:00Z)
// verified both logs, countersigned, committed and pulled up to date, then lost
// the line: `git push` got "remote: Internal Server Error" from GitHub and the
// step had no second try. These run the step itself with a git shim that fails
// the first N pushes. One failure is recovered; two still fail the run, so a
// rejection one retry cannot fix (auth, a longer outage) stays red. And one
// mutation: the step without the retry must go red on the single 500, or
// nothing here is testing the retry.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStep, seedChain, stepScript, tooling } from "./helpers/witness-step.ts";

const tools = tooling();
const skip = "skip" in tools ? tools.skip : undefined;
const bash = "skip" in tools ? "" : tools.bash;
const t = (name: string, fn: () => Promise<void> | void) => test(name, { skip }, fn);

const RETRY = "git push || { sleep 15; git pull --rebase origin main && git push; }";
const dir = skip ? "" : mkdtempSync(join(tmpdir(), "witness-push-retry-"));
const chain = skip ? "" : await seedChain(dir, { identity: 40 });
test.after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const pushes = (git: string[]) => git.filter((g) => g === "git push");
/** The git calls after the commit, in order. */
const afterCommit = (git: string[]) => git.slice(git.findIndex((g) => g.startsWith("git commit")) + 1);

test("the step carries the retry as one line", () => {
  assert.ok(stepScript().includes(RETRY), "the retry line moved; move RETRY and the mutation below with it");
});

t("a push that succeeds: one push, no wait, no second pull", () => {
  const r = runStep(bash, chain);
  assert.equal(r.exit, 0, r.stderr);
  assert.deepEqual(afterCommit(r.git), ["git pull --rebase origin main", "git push"]);
  assert.deepEqual(r.sleeps, []);
});

t("one remote 500 on push: the step waits, rebases, pushes again and succeeds", () => {
  const r = runStep(bash, chain, { failPushes: 1 });
  assert.equal(r.exit, 0, r.stderr);
  assert.deepEqual(afterCommit(r.git), ["git pull --rebase origin main", "git push", "git pull --rebase origin main", "git push"]);
  assert.deepEqual(r.sleeps, ["sleep 15"]);
});

t("two remote 500s: the run still fails, after exactly one retry", () => {
  const r = runStep(bash, chain, { failPushes: 2 });
  assert.notEqual(r.exit, 0, "a push the retry could not land is a failed run, not a silent one");
  assert.equal(pushes(r.git).length, 2, "one retry, not a loop");
  assert.match(r.stderr, /Internal Server Error/);
});

t("mutation: the step without the retry fails on a single 500", () => {
  const script = stepScript();
  const mutated = script.replace(RETRY, "git push");
  assert.notEqual(mutated, script);
  const r = runStep(bash, chain, { failPushes: 1, script: mutated });
  assert.notEqual(r.exit, 0);
  assert.equal(pushes(r.git).length, 1);
});
