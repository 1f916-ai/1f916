// A served sentence that says "measure the gaps between `at` timestamps
// yourself" while carrying a typed instant the log does not contain is the
// same defect it is warning about, one level up. The cadence guard beside this
// one matches PHRASES and is blind to VALUES: it passed a served string
// asserting the dispatch leg died at 2026-08-17T19:15Z when the witness log
// has no such observation at all, and the last sub-five-minute `at` was
// 19:17:59.241Z. Found by the pre-deploy auditor, 2026-08-20.
//
// So: any instant appearing in a served string near witness/dispatch/cadence
// language must be an OBSERVATION present in the committed witness file for
// its own day, or be named below as something else (a config change, a
// deploy) with the reason written down.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// Instants that are deliberately NOT witness observations. Each one needs a
// reason, because "it is not in the log" is exactly the bug this test exists
// to catch, and an unexplained entry here would re-open it. The second test
// below deletes an entry the moment the log does contain it: 2026-08-12T03:41Z
// was exempted here on the assumption it was config-only, and the log holds
// 03:41:04Z, the first run under the new cadence. Guess once, get caught once.
const NOT_OBSERVATIONS: Record<string, string> = {
  "2026-08-12T03:36:59Z":
    "the moment the registry's cron config changed from hourly to a five-minute dispatch. A configuration change, not a run: nothing is appended to the witness log when a cron schedule is edited.",
};

const INSTANT = /2026-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?Z/g;
const CONTEXT = /witness|dispatch|cadence|checkpoint/i;

function observedThatDay(instant: string): boolean {
  const file = join(root, "witness", `${instant.slice(0, 10)}.jsonl`);
  if (!existsSync(file)) return false;
  // Compare to second precision: the log carries milliseconds, served prose
  // usually does not, and a second is far finer than the claim being made.
  const want = instant.length >= 20 ? instant.slice(0, 19) : instant.slice(0, 16);
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let at: unknown;
    try {
      at = (JSON.parse(line) as { at?: unknown }).at;
    } catch {
      continue;
    }
    if (typeof at === "string" && at.startsWith(want)) return true;
  }
  return false;
}

test("every witness instant in a served string is an instant the log actually recorded", () => {
  const offenders: string[] = [];
  for (const name of readdirSync(join(root, "src")).filter((f) => f.endsWith(".ts")).sort()) {
    const source = readFileSync(join(root, "src", name), "utf8");
    for (const match of source.matchAll(INSTANT)) {
      const from = Math.max(0, match.index - 220);
      const to = Math.min(source.length, match.index + match[0].length + 220);
      if (!CONTEXT.test(source.slice(from, to))) continue;
      const instant = match[0];
      if (instant in NOT_OBSERVATIONS) continue;
      if (observedThatDay(instant)) continue;
      const line = source.slice(0, match.index).split("\n").length;
      offenders.push(`src/${name}:${line}: ${instant}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "these instants are asserted about the witness in served prose but appear as no `at` value in " +
      "the committed witness file for their own day. Either quote the instant the log actually holds, " +
      "or add it to NOT_OBSERVATIONS with the reason it is not a run:\n" + offenders.join("\n"),
  );
});

test("nothing sits in NOT_OBSERVATIONS without a reason, or after becoming observable", () => {
  for (const [instant, reason] of Object.entries(NOT_OBSERVATIONS)) {
    assert.ok(reason.length > 40, `${instant} needs a real reason, not a placeholder`);
    assert.equal(
      observedThatDay(instant),
      false,
      `${instant} IS present in the witness log, so it is an observation and the exemption is now a lie. Remove it from NOT_OBSERVATIONS.`,
    );
  }
});
