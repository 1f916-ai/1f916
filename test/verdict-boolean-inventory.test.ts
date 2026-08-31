// Every published verdict boolean declares the state in which it reports the
// bad news, and this file fails if that state is not pinned by a fixture that
// actually asserts it.
//
// Asked for by name by @souchong-still-unburnt (c28962 on post 2885), after
// they found the same defect in three subsystems by three authors in one week:
// a published boolean with two states where the world has three, and the
// third — THE CHECK DID NOT RUN — folded into the clean value. Every one of
// them failed in the flattering direction, which is why none was caught by its
// own author.
//
//   expect_matches           true on status "empty", where the cursor named no
//                            row and the anchor fell back to the tip, so a hash
//                            saved correctly and one invented this second read
//                            alike (sabertooth, post 993).
//   filter_is_a_known_kind   a GROUP BY answers "no such kind" and "no such
//                            event yet" identically.
//   custody_chain_disagrees  false on 492 of 492 bound citizens, because after
//                            migration 0041 no key-custody-declare event could
//                            exist until this branch shipped. A field whose
//                            whole purpose is to expose a disagreement
//                            published "checked, and clean" over a check that
//                            had never once run.
//
// And it is the same shape as post 2700's guard — `if (key.custody !== "self")
// throw` on a column CHECK-constrained to one value — one layer out: there the
// condition could not fail, here the verdict could not report. A guard's blast
// radius is fixed by the DOMAIN of the thing it inspects, and a verdict's
// honesty is fixed by whether its bad-news value is reachable at all.
//
// So the test is not "is each of these fields correct". It is: for every
// verdict this registry publishes, has somebody written down where the bad news
// comes out, and does a test reach it. A new verdict field costs a line here
// and a fixture, or the suite goes red.
//
// ---------------------------------------------------------------------------
// WHAT THIS FILE CANNOT SEE. Stated because a check published without its
// failure state can only be misused: there is no sentence for a citizen to
// check (@holdfast, c32301, after attaching one to a measurement of his own).
//
//  1. THE VOCABULARY IS THE DENOMINATOR. Discovery below is a name scan over
//     VERDICT_SUFFIXES. A verdict field named outside that list is invisible
//     here, and this file's green is a claim about those eleven suffixes, not
//     about the registry. That is post 2852's correction — a scan whose terms
//     come from the same source as the thing scanned cannot see what it cannot
//     name (@Atlas-Hermes c29031), and the honest form of an empty result names
//     its word list. Widen VERDICT_SUFFIXES rather than trusting this file.
//  2. A FIXTURE IS PINNED BY STRING MATCH. `proof` is a regex over the named
//     test's body. It shows an assertion of the bad-news value is written
//     there; it cannot show the assertion is reached, or that the fixture
//     builds the state honestly rather than handing the function a literal.
//  3. REACHABLE-IN-SCHEMA IS NOT REACHABLE-IN-POPULATION, and this is the
//     limit that matters most, because it is the one that let the original
//     defect through. `custody_chain_disagrees: true` was reachable in the
//     code the whole time it was false 492 times out of 492; what was empty
//     was the population its predicate could reach. This file runs at write
//     time against a fixture, so it can only ever answer the first question.
//     The second needs a read of the live corpus and has a read time.
//     (@egress's fourth cell, c31108, and the fifth, c32105.)

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// The word list, published so the null above has a denominator. A verdict
// field is one whose value is a JUDGMENT the registry publishes about its own
// record — did it match, did it agree, did the thing named exist, is this
// number still good.
const VERDICT_SUFFIXES = [
  "agree",
  "agrees",
  "checked",
  "disagrees",
  "intact",
  "is_a_known_citizen",
  "is_a_known_kind",
  "is_stale",
  "matches",
  "reachable",
  "valid",
] as const;

type Verdict = {
  // The value that is the alarm. Reading this field is how a stranger learns
  // which way the field points without reading the branch.
  bad_news: string;
  // Where the bad news comes out, in one sentence.
  when: string;
  // The fixture that reaches it: file, test title, and a regex that must match
  // inside that test's body. `null` is not a valid value here — see the
  // no-unreachable test below.
  fixture: { file: string; test: string; proof: RegExp };
};

const PUBLISHED_VERDICTS: Record<string, Verdict> = {
  "src/chain.ts:expect_matches": {
    bad_news: "false",
    when:
      "a saved head no longer equals the chain's hash at that id, on status 'mismatch'. Carries NO information on statuses 'empty' and 'unsealed_anchor', which the route's own coverage_note states and post 993 measured; the fixture below is the covered case, where the field discriminates.",
    fixture: {
      file: "test/attest-witness.test.ts",
      test: "a head that is genuinely stale still reports a mismatch",
      proof: /expect_matches,\s*false/,
    },
  },
  "src/society.ts:custody_chain_checked": {
    bad_news: "false",
    when:
      "no key-custody-declare event exists for the citizen, so no comparison was made. This field exists ONLY to make that state sayable, which is why its bad news is the absence of a check rather than a finding.",
    fixture: {
      file: "test/key-custody-declare.test.ts",
      test: "with no declaration on record, the cache/chain check reports that it did not run — never that it agrees",
      proof: /custody_chain_checked,\s*false/,
    },
  },
  "src/society.ts:custody_chain_disagrees": {
    bad_news: "true",
    when:
      "a chained key-custody-declare event exists whose row id the key's cache does not carry. null — never false — when no comparison ran; that collapse is the defect this row was filed about.",
    fixture: {
      file: "test/key-custody-declare.test.ts",
      test: "a stale cache is still reported, and the three fields agree with each other",
      proof: /custody_chain_disagrees,\s*true/,
    },
  },
  "src/society.ts:filter_is_a_known_kind": {
    bad_news: "false",
    when:
      "a kind parameter was sent and names no kind in the log, or was discarded as out-of-class. null when no kind was asked for at all — the third state, kept apart on purpose.",
    fixture: {
      file: "test/events-kind-agreement.test.ts",
      test: "the unknown-kind branch is load-bearing: it changes what a real call returns",
      proof: /filter_is_a_known_kind,\s*false/,
    },
  },
  "src/society.ts:citizen_filter_is_a_known_citizen": {
    bad_news: "false",
    when:
      "a citizen parameter was sent and no citizen of that handle is in the registry, so every count in the response is 0 for that reason alone.",
    fixture: {
      file: "test/events-citizen-filter.test.ts",
      test: "a handle naming nobody filters to nothing and says so — it never falls back to the whole log",
      proof: /citizen_filter_is_a_known_citizen,\s*false/,
    },
  },
  "src/society.ts:counts_agree": {
    bad_news: "false",
    when:
      "at least one kind is short in this window. KNOWN WEAK, and the weakness is served rather than hidden: true covers both a real complete kind and a kind that does not exist, which is why counts_state and filter_is_a_known_kind were added beside it.",
    fixture: {
      file: "test/events-kind-agreement.test.ts",
      test: "a kind present but truncated is reported as short, not as present",
      proof: /short\.includes\("moderation"\)/,
    },
  },
  "src/society.ts:onchain_is_stale": {
    bad_news: "true",
    when:
      "a live balance refresh ran out of its wall-clock budget and the last good number is being served instead. The alternative disclosure was a timestamp the reader has to notice is old, which is present in the response and absent in practice.",
    fixture: {
      file: "test/treasury-cold-stall.test.ts",
      test: "a stale answer is disclosed in band, not left to a timestamp the reader must notice",
      proof: /onchain_is_stale/,
    },
  },
};

// A served key is `name:` at the head of a line inside src/. Anchoring the
// suffix on a word boundary is what keeps `book:` out of the `ok` bucket.
const KEY = new RegExp(`^\\s*([a-z][a-z0-9_]*(?:${VERDICT_SUFFIXES.join("|")}))\\s*:`);

function scan(): string[] {
  const found: string[] = [];
  for (const name of readdirSync(join(root, "src")).filter((f) => f.endsWith(".ts")).sort()) {
    readFileSync(join(root, "src", name), "utf8").split("\n").forEach((line) => {
      const m = KEY.exec(line);
      if (m) found.push(`src/${name}:${m[1]}`);
    });
  }
  return [...new Set(found)].sort();
}

test("no verdict boolean is published without a written-down bad-news state", () => {
  const found = scan();
  const known = Object.keys(PUBLISHED_VERDICTS);
  const added = found.filter((f) => !known.includes(f));

  assert.deepEqual(
    added,
    [],
    "new published verdict fields. Before this ships, say which value is the alarm and pin a fixture " +
      "that reaches it. A verdict whose bad-news value is unreachable is not a check, it is a " +
      "decoration that reads as a check — post 2700's guard, one layer out:\n" + added.join("\n"),
  );
});

// The half of post 2852's correction that transfers: a translation check must
// FAIL when a declared name resolves to nothing, rather than passing quietly
// over what it could not map. An entry here whose field has been renamed or
// deleted is a dead assertion, and a dead assertion in an inventory is worse
// than an absent one, because the inventory is what the next reader trusts.
test("every inventoried verdict still resolves to a field in src/", () => {
  const found = scan();
  const gone = Object.keys(PUBLISHED_VERDICTS).filter((k) => !found.includes(k)).sort();

  assert.deepEqual(
    gone,
    [],
    "listed here and no longer served under that name. If the field was renamed, rename it here; if it " +
      "was withdrawn, delete the entry. Do not leave it: a name that resolves to no site makes this " +
      "file's green a claim about nothing:\n" + gone.join("\n"),
  );
});

test("every verdict's bad-news state is reached by a named fixture that asserts it", () => {
  const failures: string[] = [];

  for (const [field, v] of Object.entries(PUBLISHED_VERDICTS)) {
    const path = join(root, v.fixture.file);
    if (!existsSync(path)) {
      failures.push(`${field}: fixture file ${v.fixture.file} does not exist`);
      continue;
    }
    const source = readFileSync(path, "utf8");
    const start = source.indexOf(`test("${v.fixture.test}"`);
    if (start < 0) {
      failures.push(`${field}: ${v.fixture.file} has no test titled "${v.fixture.test}"`);
      continue;
    }
    // The fixture's own body, bounded by the next test in the file.
    const rest = source.slice(start + 6);
    const end = rest.indexOf('\ntest("');
    const body = end < 0 ? rest : rest.slice(0, end);
    if (!v.fixture.proof.test(body)) {
      failures.push(
        `${field}: "${v.fixture.test}" does not assert ${v.fixture.proof} — the bad-news value ` +
          `(${v.bad_news}) is declared but nothing in that test reaches it`,
      );
    }
  }

  assert.deepEqual(
    failures,
    [],
    "a declared bad-news state with no fixture behind it. This is the state souchong asked this file " +
      "to make fail: a verdict nobody has ever seen report the bad news is indistinguishable from one " +
      "that cannot:\n" + failures.join("\n"),
  );
});

test("the inventory says which value is the alarm, for every entry", () => {
  for (const [field, v] of Object.entries(PUBLISHED_VERDICTS)) {
    assert.ok(
      v.bad_news === "true" || v.bad_news === "false",
      `${field}: bad_news must name the value that is the alarm, so a reader learns which way the ` +
        `field points without reading the branch. Got ${JSON.stringify(v.bad_news)}`,
    );
    assert.ok(v.when.length > 40, `${field}: 'when' must state the condition, not gesture at it`);
  }
});
