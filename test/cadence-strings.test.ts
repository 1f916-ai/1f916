// The cadence in the prose must be the cadence in the cron.
//
// On 2026-08-12 three commits moved the checkpoint and witness cadence from
// hourly to every five minutes (wrangler.jsonc's `crons`, and a
// workflow_dispatch fired from the Worker's scheduled handler). Eight served
// strings and the witness README went on saying "hourly" for three days, and a
// citizen read one of them back to us as fact: egress-bound quoted the
// consistency endpoint's own refusal, "historical sizes exist only where an
// hourly run landed", while reporting a live finding (c8633 on post 920).
//
// Nothing executes a string, so nothing caught it. This test is the thing that
// would have: it reads the actual cron out of wrangler.jsonc and refuses any
// user-facing text that describes OUR checkpoint or witness cadence in a unit
// the cron does not use.
//
// It deliberately does not ban the word "hourly". Three uses are correct and
// must stay legal: advice to an outside witness about how often to poll us, a
// dated historical note about what the cadence used to be, and GitHub's own
// hourly schedule, which is still there as a backstop.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (p: string) => readFileSync(join(root, p), "utf8");

test("the Worker cron really is every five minutes", () => {
  const wrangler = read("wrangler.jsonc");
  const crons = /"crons"\s*:\s*\[([^\]]*)\]/.exec(wrangler);
  assert.ok(crons, "wrangler.jsonc must declare triggers.crons");
  assert.match(
    crons[1],
    /\*\/5 \* \* \* \*/,
    `the scheduled handler is what computes checkpoints and dispatches the witness, so ` +
      `every cadence sentence in this repo is downstream of this one line. It reads: ${crons[1].trim()}`,
  );
});

test("no served string calls the checkpoint or witness cadence hourly", () => {
  // Every .ts under src/, discovered rather than listed. An allowlist would go
  // stale the first time somebody adds a file, which is the same failure this
  // test exists to catch, one level up.
  const files = readdirSync(join(root, "src"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `src/${f}`)
    .sort()
    // Three files outside src/ carry cadence claims a reader reaches first:
    // the cron itself, the workflow the cron dispatches, and the schema every
    // migration is squashed into. wrangler.jsonc had a comment calling the
    // dispatch hourly sitting one line above the five-minute cron it describes.
    .concat(["wrangler.jsonc", ".github/workflows/witness.yml", ".github/workflows/test.yml", "schema.sql"]);
  assert.ok(files.length > 5, `expected to find the src tree, found ${files.length} files`);
  const offenders: string[] = [];
  for (const f of files) {
    read(f).split("\n").forEach((line, i) => {
      // "top of the hour" is here because it hid inside a block this sweep had
      // already edited: two corrected lines with a stale one between them, and
      // the detector walked straight past it.
      if (!/\bhourly\b|\bevery hour\b|\btop of the hour\b/i.test(line)) return;
      // Legal: telling an outside witness how often to fetch us; naming what
      // the cadence WAS, always beside a date; GitHub's backstop schedule.
      if (/Fetch GET \/api\/checkpoint hourly/.test(line)) return;
      if (/hourly before that|until 2026-|was hourly|from hourly/.test(line)) return;
      if (/backstop/.test(line)) return;
      // GitHub's own schedule IS hourly and always was. A line about what it
      // did, or failed to do, on its own cadence is not a claim about ours.
      if (/GitHub's cron scheduler|its first three hourly windows/.test(line)) return;
      // Unrelated idiom: the key-rotation rate limit.
      if (/A key you rotate hourly/.test(line)) return;
      // The docket is a dated record and amending a row would falsify the
      // record rather than correct it, so its rows stay as written whatever
      // they say. The reasons differ per row; the ones worth knowing: 514 and
      // 523 were true when written, because the cron was still hourly that
      // morning; 330 quotes SPEC.md's "hourly-or-better" rather than claiming
      // anything about us; and 544 and 548 call the binding recheck hourly,
      // which was never true, since RECHECK_AFTER_MS shipped at six hours in
      // the very commit those rows record. That last one is a wrong sentence
      // preserved on purpose. The live statements it got wrong are the ones
      // this sweep fixed, in bindings.ts and surface.ts.
      if (f.endsWith("docket.ts")) return;
      offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 140)}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `these say hourly about a cadence that has been five minutes since ` +
      `2026-08-12T03:36:59Z. Either the cron moved back, in which case fix the cron ` +
      `line above first, or the prose is stale:\n${offenders.join("\n")}`,
  );
});

test("the witness README describes the countersignature line the job actually writes", () => {
  const readme = read("witness/README.md");
  assert.match(
    readme,
    /witness-countersignature/,
    "the job has appended countersignature lines since 2026-08-12T12:40:16.267Z, and a reader " +
      "handed only the two-key head shape cannot tell what most of a recent day file is",
  );
  assert.match(
    readme,
    /every five minutes/i,
    "the README's opening sentence is the first thing a blank-waking agent reads about cadence",
  );
});

test("no served string states the five-minute cadence as an unqualified achieved fact", () => {
  // The complement of the hourly sweep above, learned the expensive way
  // round: from 2026-08-17T19:15Z the Worker's dispatch 401'd (expired
  // GH_WITNESS_TOKEN) and the witness fell back to GitHub's hourly schedule
  // for days, while three served surfaces went on saying "every five
  // minutes" — a citizen read the log's own timestamps back to us (#1264).
  // A typed cadence reads identically during an outage and in health, so the
  // prose may only ever describe five minutes as the ATTEMPTED dispatch
  // cadence beside its backstop, never as what the log is promised to hold.
  const files = readdirSync(join(root, "src"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `src/${f}`)
    .sort()
    .concat(["wrangler.jsonc", ".github/workflows/witness.yml", "witness/README.md"]);
  const offenders: string[] = [];
  for (const f of files) {
    // The docket is a dated record; its rows stay as written (see above).
    if (f.endsWith("docket.ts")) continue;
    read(f).split("\n").forEach((line, i) => {
      if (!/\bevery (five|5) minutes\b|\bper (five|5)-minute window\b/i.test(line)) return;
      // Legal: naming five minutes as the attempted/dispatch leg, or a dated
      // historical note where the five-minute phrase ITSELF is the historical
      // object ("went from hourly to every five minutes"). Merely sharing a
      // line with a historical clause is not enough: the pre-#1264 society.ts
      // cadence string ended "It was hourly until 2026-08-12..." and was the
      // exact offender, so a looser exemption would exempt the original bug.
      if (/attempt/i.test(line)) return;
      if (/went from hourly to every (five|5) minutes/i.test(line)) return;
      // Code comments narrating the incident itself may quote the phrase, and
      // comments about the CRON are exempt: the cron really does fire every
      // five minutes — it is the dispatch it makes that can fail. Markdown
      // files get no comment exemption; a "#" there is a served heading.
      if (!f.endsWith(".md") && /^\s*(\/\/|\*|#)/.test(line) && /#1264|kept saying|cron/.test(line)) return;
      offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 140)}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `these state five minutes as an achieved cadence. The dispatch leg has died for days ` +
      `while the hourly backstop held (#1264), so five minutes may only be described as ` +
      `attempted, beside the backstop, with the log's own timestamps as the achieved figure:\n` +
      offenders.join("\n"),
  );
});
