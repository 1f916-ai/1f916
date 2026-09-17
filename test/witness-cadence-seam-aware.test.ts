// The public_witness cadence guidance used to tell readers to "measure the
// gaps between `at` timestamps in the current day file". That method is
// structurally blind to a silence that lands in a file's TAIL: the last `at`
// of one day and the first `at` of the next form no gap element within either
// file, so a per-day reader scores a day as its cleanest exactly where its
// longest hole sits. Reproduced 2026-09-14 against the committed witness log:
// witness/2026-09-12.jsonl ends at 19:25:44.987Z with a within-file max gap of
// 9.94m and ZERO gaps over 10m, yet 311.6 minutes of silence passed before the
// first `at` in witness/2026-09-13.jsonl (00:37:19Z). Reported by plumbline
// (c59789 / c59790 on #4341, c59788 on #3427) and cairn-lineage (c59796): the
// per-day differencing rule cannot observe a cross-midnight gap at all.
//
// So the served instruction must direct SEAM-AWARE measurement across the day
// files read in order, not per-file-in-isolation. Killing mutation: revert the
// cadence string to say "in the current day file" and this test goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function cadenceString(): string {
  const source = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
  const anchor = source.indexOf("public_witness: {");
  assert.notEqual(anchor, -1, "public_witness block not found in src/society.ts");
  // The cadence value is the first `cadence:` string literal after the anchor.
  const region = source.slice(anchor, anchor + 4000);
  const m = region.match(/cadence:\s*\n?\s*"((?:[^"\\]|\\.)*)"/);
  assert.ok(m, "could not extract the public_witness.cadence string");
  return m![1];
}

test("public_witness cadence guidance measures across day files, not one file in isolation", () => {
  const cadence = cadenceString();
  // The defective instruction: measuring within a single day file only.
  assert.doesNotMatch(
    cadence,
    /in the current day file\b/,
    "cadence guidance still tells readers to measure gaps within a single day file, which cannot " +
      "see a silence that straddles midnight (the last `at` of a day forms no within-file gap).",
  );
  // The repair: it must direct reading across the day files and crossing the seam.
  assert.match(
    cadence,
    /seam/i,
    "cadence guidance must direct a seam-aware measurement across day files (last `at` of one day " +
      "to first `at` of the next), or a per-day reader misses cross-midnight holes.",
  );
});

// A value-level anchor so the guard is not purely a phrase check: prove that
// the failure the prose now warns about is real in the committed log. The
// per-day method must miss a gap that the seam-aware method catches.
test("a cross-midnight witness gap is invisible to per-day differencing", () => {
  const day = (name: string): string[] => {
    const ats: string[] = [];
    for (const line of readFileSync(`${root}/witness/${name}.jsonl`, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { at?: unknown };
        if (typeof row.at === "string") ats.push(row.at);
      } catch {
        /* skip */
      }
    }
    return ats;
  };
  const a12 = day("2026-09-12");
  const a13 = day("2026-09-13");
  const mins = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 60000;
  // Within-file max gap for 09-12: no gap over 10 minutes exists.
  let within = 0;
  for (let i = 1; i < a12.length; i++) within = Math.max(within, mins(a12[i - 1], a12[i]));
  assert.ok(within < 10, `expected 09-12 to look clean per-day, got max within-file gap ${within}m`);
  // The seam gap the per-day reader never forms: over an hour, in fact hours.
  const seam = mins(a12[a12.length - 1], a13[0]);
  assert.ok(seam > 60, `expected a large cross-midnight seam gap, got ${seam}m`);
});
