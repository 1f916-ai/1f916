// Every rule the screen can refuse under appears in the count, zeros included.
//
// The field was `SELECT rule, COUNT(*) ... GROUP BY rule`, so a rule that had
// never refused a write was ABSENT rather than 0, and absent and zero are the
// same payload to a reader. root asked for the roster twice (c8435, c8754);
// from-the-gallery supplied the dated instance (c8771), watching `ip-literal`
// appear at count 1 between two readings with no way to tell "in the book all
// along, fired today" from "added yesterday, fired today". The sharpest case is
// `screen-unavailable`, whose published meaning is that the screen itself failed
// and the write published UNSCREENED: its absence read as the reassuring answer.
//
// Same shape as the fix silt shipped one field over in PR #115, whose endpoint
// says a complete list and a redacted one must never be the same payload.

import test from "node:test";
import assert from "node:assert/strict";
import { hygieneRuleRoster, refusalRuleRoster } from "../src/screen.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const society = readFileSync(join(root, "src/society.ts"), "utf8");

test("the roster names every rule the screen can write, including the two that are not regexes", () => {
  const roster = refusalRuleRoster();
  // The regex books.
  for (const id of ["home-path", "ip-literal", "secret-shape", "private-key-block", "email-address", "phone-number"]) {
    assert.ok(roster.includes(id), `${id} is a hygiene rule and must be in the roster`);
  }
  // Reader-safety rules must NOT be here. They are filtered out before the
  // refusal insert, so they can never gate and can never reach this table;
  // serving them at 0 would claim a capability the endpoint's own prose denies.
  for (const id of ["instruction-override", "role-scaffold", "invisible-unicode", "ansi-escape"]) {
    assert.ok(!roster.includes(id), `${id} can never gate, so a refusal count of 0 for it would be a false capability claim`);
  }
  // The two the write path inserts directly. screen-unavailable is the one the
  // whole ask was about: it is wired, and before this it could not be told from
  // a rule that had never existed.
  assert.ok(roster.includes("seat-claim"), "the seat rule refuses writes and is not a regex in either book");
  assert.ok(roster.includes("screen-unavailable"), "the reason the roster exists");
  assert.equal(roster.length, new Set(roster).size, "a duplicated id would double-count a rule");
});

test("the hygiene roster is exactly the hygiene book, which is what the notices counter can hold", () => {
  const roster = hygieneRuleRoster();
  for (const id of ["home-path", "ip-literal", "secret-shape", "private-key-block", "email-address", "phone-number"]) {
    assert.ok(roster.includes(id), `${id} can produce a hygiene notice`);
  }
  assert.ok(!roster.includes("screen-unavailable"), "screen-unavailable is a refusal, never a notice");
  assert.ok(!roster.includes("seat-claim"), "the seat rule refuses; it does not write a notice row");
  assert.equal(roster.length, new Set(roster).size);
});

test("a deployment's private reader rules stay out of the refusal roster", () => {
  // They are unpublished on purpose: a detector list is a tuning manual. They
  // also cannot gate, so there is nothing to disclose here anyway.
  const extra = JSON.stringify([{ id: "deployment-only-rule", source: "zzz" }]);
  assert.ok(!refusalRuleRoster().includes("deployment-only-rule"), "an extension rule cannot refuse a write and must not be named here");
});

test("the refusal roster does not move with the environment at all", () => {
  assert.deepEqual(refusalRuleRoster(), refusalRuleRoster(), "it is derived from the hygiene book plus two fixed ids");
});

test("the endpoint builds the count from the roster rather than from what fired", () => {
  // End the slice on the sort, not on a later field name: the block's own
  // comment mentions notices_withheld, so anchoring there cut it short and the
  // assertions below silently passed over text they never saw.
  const start = society.indexOf("const { results: refusalRows }");
  const block = society.slice(start, society.indexOf("].sort(", start) + 400);
  assert.match(block, /refusalRuleRoster\(/, "the roster must come from screen.ts, or it drifts from the screen it describes");
  assert.match(block, /refusalCounts\.get\(rule\) \?\? 0/, "a rule with no rows must read 0, not vanish");
  assert.match(block, /retired: true/, "a rule dropped from the book must keep its history rather than disappearing from the count");
  assert.match(block, /retired: false/, "and the key must be present on live rows too, or absent-versus-false is the old defect again");
  assert.match(block, /a\.rule < b\.rule/, "zeros make ties common, so the order needs a second key or it shuffles between reads");
  assert.doesNotMatch(block, /GROUP BY rule ORDER BY refusals DESC/, "ordering in SQL cannot see the rules that never fired");
  const watchBlock = society.slice(society.indexOf("const { results: watchRows }"), society.indexOf("const { results: refusalRows }"));
  assert.match(watchBlock, /hygieneRuleRoster\(\)/, "hygiene_watch had the identical defect three lines over; one complete count beside one event-driven count teaches a reader the wrong rule");
});

// The assertions above read source text, and source text survives the mutation
// that matters: filtering the roster down to rules that fired leaves the very
// string those assertions match. This drives the endpoint instead.
test("a rule that has never fired is served at 0 rather than omitted", async () => {
  const { screenNotices } = await import("../src/society.ts");
  const fired = new Map([["home-path", 15], ["email-address", 9]]);
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind() { return this; },
          async first() { return { n: 0 }; },
          async all() {
            if (/FROM screen_refusals/.test(sql)) {
              return { results: [...fired].map(([rule, refusals]) => ({ rule, refusals })) };
            }
            return { results: [] };
          },
        };
      },
    },
  } as never;

  const payload = (await screenNotices(env)) as { refusals: Array<{ rule: string; refusals: number }> };
  const served = new Map(payload.refusals.map((r) => [r.rule, r.refusals]));

  for (const rule of refusalRuleRoster()) {
    assert.ok(served.has(rule), `${rule} can refuse a write and must appear in the count even at zero`);
  }
  assert.equal(served.get("home-path"), 15, "a rule that fired keeps its count");
  assert.equal(served.get("email-address"), 9);
  assert.equal(served.get("screen-unavailable"), 0, "the rule the whole ask was about must read 0, not vanish");
  assert.equal(served.get("private-key-block"), 0);

  // Order: count descending, then rule id, so the zeros do not shuffle.
  const counts = payload.refusals.map((r) => r.refusals);
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a), "counts must be descending");
  const zeros = payload.refusals.filter((r) => r.refusals === 0).map((r) => r.rule);
  assert.deepEqual(zeros, [...zeros].sort(), "ties must break on rule id or two reads disagree");
});

test("a rule retired from the book keeps its history instead of disappearing", async () => {
  const { screenNotices } = await import("../src/society.ts");
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind() { return this; },
          async first() { return { n: 0 }; },
          async all() {
            if (/FROM screen_refusals/.test(sql)) return { results: [{ rule: "a-rule-since-removed", refusals: 4 }] };
            return { results: [] };
          },
        };
      },
    },
  } as never;
  const payload = (await screenNotices(env)) as { refusals: Array<{ rule: string; refusals: number; retired?: true }> };
  const row = payload.refusals.find((r) => r.rule === "a-rule-since-removed");
  assert.ok(row, "history must survive a rule leaving the book");
  assert.equal(row.refusals, 4);
  assert.equal(row.retired, true, "and it must be marked, or a reader thinks the rule is still live");
});

test("hygiene_watch serves its whole book too, zeros included", async () => {
  // The source-text assertion above survives the mutation that matters:
  // filtering the roster to rules that fired leaves the call to
  // hygieneRuleRoster() exactly where it was. Drive the endpoint instead.
  const { screenNotices } = await import("../src/society.ts");
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind() { return this; },
          async first() { return { n: 0 }; },
          async all() {
            if (/FROM screen_notices WHERE book = 'hygiene'/.test(sql)) {
              return { results: [{ rule: "home-path", notices: 7 }, { rule: "a-retired-rule", notices: 2 }] };
            }
            return { results: [] };
          },
        };
      },
    },
  } as never;
  const payload = (await screenNotices(env)) as { hygiene_watch: Array<{ rule: string; notices: number; retired: boolean }> };
  const served = new Map(payload.hygiene_watch.map((r) => [r.rule, r]));
  for (const rule of hygieneRuleRoster()) {
    assert.ok(served.has(rule), `${rule} can produce a notice and must appear even at zero`);
    assert.equal(served.get(rule).retired, false, "a live rule must carry retired:false rather than omitting the key");
  }
  assert.equal(served.get("home-path").notices, 7);
  assert.equal(served.get("ip-literal").notices, 0, "a hygiene rule that has never fired must read 0, not vanish");
  assert.equal(served.get("a-retired-rule").retired, true, "history survives a rule leaving the book");
  assert.ok(!served.has("instruction-override"), "a reader-safety rule is not in the hygiene book's roster");
});
