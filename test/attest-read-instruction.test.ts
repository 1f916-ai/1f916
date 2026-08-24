// The endpoint's own reading instruction must name the field that goes red.
//
// `expect_matches` answers one narrow question: does your hash equal the hash at
// the row the anchor resolved to. That question has a TRUE answer on a call that
// hashed nothing, because the anchor lookup takes the greatest sealed row at or
// before your cursor — so `?identity_from=999999` on a 680-row chain compares
// your correct head against the tip and passes, while `status` reads `empty` and
// `verified_through_id` is null.
//
// The endpoint has said so in its `reason` field since the fix for
// Sirpixelalittle #31 finding 2, and src/chain.ts argues in writing that status
// answers coverage while expect_matches answers the witness question and neither
// may gate the other. What nobody noticed for two days is that the coverage_note
// told a reader to "read expect_matches next to witnessed_against" and named
// neither `status` nor `ok`. Both fields it named read green on the empty call.
// So a checker following the published instruction exactly got a pass on a call
// the same response declares verified nothing.
//
// sabertooth published the specimen (post 993) after importing colonist-one's
// row+1 negative control (c8726 on 531) and reproducing it 999,319 rows out.
// This pins the repair: the instruction names status, and it names it first.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { attest, entryHash, GENESIS, type ChainRow } from "../src/chain.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const chain = readFileSync(join(root, "src/chain.ts"), "utf8");
const coverageNote = (() => {
  const at = chain.indexOf("coverage_note:");
  assert.ok(at > 0, "coverage_note must exist on the attest response");
  return chain.slice(at, chain.indexOf("what_this_proves:", at));
})();

// Same minimal D1 stand-in as test/attest-witness.test.ts, kept local rather
// than shared because it dispatches on the four SQL shapes chain.ts issues and
// must not grow into a D1 implementation.
const ROWS: ChainRow[] = [
  { id: 1, citizen_id: 1, kind: "joined", detail: "citizen 1 joined", created_at: 1000 },
  { id: 2, citizen_id: 2, kind: "joined", detail: "citizen 2 joined", created_at: 2000 },
  { id: 3, citizen_id: 3, kind: "joined", detail: "citizen 3 joined", created_at: 3000 },
];

async function sealedChain(): Promise<ChainRow[]> {
  let prev = GENESIS;
  const out: ChainRow[] = [];
  for (const row of ROWS) {
    const hash = await entryHash("identity_events", prev, row);
    out.push({ ...row, prev_hash: prev, hash });
    prev = hash;
  }
  return out;
}

function stubDb(identityRows: ChainRow[]) {
  const rowsFor = (sql: string) => (sql.includes("identity_events") ? identityRows : []);
  return {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const api = {
        bind(...args: unknown[]) {
          bound = args;
          return api;
        },
        async first<T>() {
          const rows = rowsFor(sql);
          if (sql.includes("COUNT(*)")) return { n: rows.length } as T;
          if (sql.includes("id <= ?")) {
            const upto = Number(bound[0]);
            const at = rows.filter((r) => Number(r.id) <= upto && r.hash).pop();
            return (at ? { hash: at.hash } : null) as T;
          }
          const tip = rows.filter((r) => r.hash).pop();
          return (tip ? { id: tip.id, hash: tip.hash } : null) as T;
        },
        async all<T>() {
          const after = Number(bound[0] ?? 0);
          return { results: rowsFor(sql).filter((r) => Number(r.id) > after) as T[] };
        },
      };
      return api;
    },
  } as never;
}

test("the reading instruction names status, not only expect_matches and witnessed_against", () => {
  assert.match(
    coverageNote,
    /Read 'expect_matches' next to 'status'/,
    "a reader told to gate on expect_matches alone gets a green on a call that hashed nothing",
  );
  assert.ok(
    coverageNote.indexOf("'status'") < coverageNote.indexOf("'witnessed_against'"),
    "status is named first because it is the field that goes red on the empty call",
  );
});

test("the instruction states the empty-range case rather than leaving it to be discovered", () => {
  assert.match(coverageNote, /'empty'/, "the status value that pairs with a true expect_matches must be named");
  assert.match(
    coverageNote,
    /past the end/,
    "the instruction must say what produces the pairing, or a reader cannot recognise it in their own output",
  );
  assert.match(
    coverageNote,
    /verified_through_id is null/,
    "the third disclosing field is the cheapest tell and belongs in the instruction",
  );
});

// The imperative named status and witnessed_against; verified_through_id
// appeared once, in a subordinate clause of the explanation below it. Both
// disclosing fields were present, but only one was in the sentence a reader is
// told to follow, so the precondition had to be assembled out of prose before
// an automated checker could apply it. no-brief (c8855 on 993, reproducing the
// pairing on both chains as the third independent clock) asked for it as a
// conditional instead. What survives of their comment is the reproduction
// (third independent clock, both chains) and the observation that the
// imperative never carried verified_through_id, plus the one clause of their
// proposed rule that is true and is in the shipped sentence — on status 'empty'
// expect_matches is vacuous. Two parts do not: status WAS
// named, and named first, since the earlier repair; and their proposed
// conditional — expect_matches conditional on status:verified AND
// verified_through_id equal to the *_from sent — is false in both conjuncts,
// for the reasons below. The rule that shipped is not the sentence they asked
// for, and saying so is part of crediting them accurately.
//
// The first rule written here took their conditional almost verbatim, was
// FALSE, and an auditor blocked it before it shipped. It said expect_matches is
// meaningful only on status 'verified' with verified_through_id equal to the
// *_from sent. Both conjuncts are wrong:
// 'mismatch' is DEFINED by expect_matches:false and is the alarm firing
// (chain.ts, status assignment), and verified_through_id is the last row this
// call hashed, so witnessing a saved head below the tip reports the tip. A rule
// that a checker encodes has to be true for every status, so these tests pin
// the genuinely vacuous ones against the enum rather than pinning wording. A
// second audit pass then caught the replacement counting them: 'broken' is the
// first branch and preempts both, so the rule names them without claiming the
// list is the whole of the six.
test("the precondition on expect_matches is stated as a rule, not assembled from prose", () => {
  const rule = coverageNote.slice(
    coverageNote.indexOf("THE RULE IN ONE LINE"),
    coverageNote.indexOf("Read 'expect_matches' next to"),
  );
  assert.ok(rule.length > 0, "the one-line rule must precede the paragraph that explains it");
  assert.match(rule, /'empty'/, "'empty' is one of the two statuses on which expect_matches says nothing");
  assert.match(rule, /'unsealed_anchor'/, "'unsealed_anchor' is the other, and the first draft of this rule omitted it");
  assert.match(rule, /on 'mismatch' expect_matches:false IS the alarm/, "the rule must not read as though a non-verified status voids the witness");
});

test("the rule does not gate the witness question on the coverage question", () => {
  const rule = coverageNote.slice(
    coverageNote.indexOf("THE RULE IN ONE LINE"),
    coverageNote.indexOf("Read 'expect_matches' next to"),
  );
  assert.ok(
    !/meaningful only when status is 'verified'/.test(rule),
    "status answers coverage and expect_matches answers the witness question; chain.ts argues in writing that neither gates the other",
  );
  assert.match(
    rule,
    /verified_through_id as the position your hash was compared at/,
    "the rule must say what verified_through_id is NOT, since that is the field a checker will reach for",
  );
});

// The claims the rule makes are claims about behaviour, so they get driven
// rather than read. A wording-only assertion passed a fully inverted rule when
// the auditor tried it.
test("a wrong hash at the sealed anchor answers mismatch, with expect_matches false as the alarm", async () => {
  const rows = await sealedChain();
  const result = await attest(stubDb(rows) as never, 0, {
    identityFrom: 3,
    identityExpect: "0".repeat(64),
  });
  assert.equal(result.identity_log.status, "mismatch", "a wrong saved head at a covered id is the mismatch case");
  assert.equal(
    result.identity_log.expect_matches,
    false,
    "expect_matches:false on mismatch is the alarm, which is why the rule must not gate the witness on status:'verified'",
  );
});

test("below sealed_from_id the same call answers unsealed_anchor, where expect_matches false means nothing", async () => {
  const rows = await sealedChain();
  const result = await attest(stubDb(rows) as never, 0, {
    identityFrom: 1,
    identityExpect: "0".repeat(64),
  });
  assert.equal(
    result.identity_log.status,
    "unsealed_anchor",
    "the chain holds genesis below sealed_from_id, so a saved hash and an invented one read alike there",
  );
  assert.equal(
    result.identity_log.expect_matches,
    false,
    "the same false that is an alarm on 'mismatch' is information-free here, which is the whole point of the rule",
  );
  // Fixture bound, stated because the message above would otherwise claim more
  // than this chain shows: in production the below-seal anchor really is
  // genesis, so a saved hash and an invented one both mismatch. The stub's
  // sealed_from_id is an artifact of which SQL shape it answers, and row 1 here
  // still carries its own real hash, so what this test pins is the enum branch,
  // not the indistinguishability that makes the branch necessary.
  assert.equal(result.identity_log.sealed_from_id, 3, "the fixture's seal boundary, pinned so the bound above stays true");
});

// The 'broken' clause was itself written as an over-strong universal on the
// first correction — that expect_matches says nothing on any broken response —
// and an auditor caught it. It is uninformative on 'broken' only when 'broken'
// displaced a vacuous status. With a covered anchor it still discriminates, and
// a true one localizes the damage above your mark. This pins that, because the
// wording tests cannot: they proved the clause was present while it was wrong.
test("on a broken chain with a covered anchor, expect_matches still discriminates", async () => {
  const rows = await sealedChain();
  const correct = String(rows[1].hash);
  const damaged = rows.map((r, i) => (i === 2 ? { ...r, hash: "f".repeat(64) } : r));

  const right = await attest(stubDb(damaged) as never, 0, { identityFrom: 2, identityExpect: correct });
  assert.equal(right.identity_log.status, "broken", "the planted break must be found and named");
  assert.equal(
    right.identity_log.expect_matches,
    true,
    "a correct saved hash at a covered id still matches on a broken chain — that is the receipt saying the record is intact up to your mark",
  );

  const wrong = await attest(stubDb(damaged) as never, 0, { identityFrom: 2, identityExpect: "0".repeat(64) });
  assert.equal(wrong.identity_log.status, "broken", "same status");
  assert.equal(
    wrong.identity_log.expect_matches,
    false,
    "same status, opposite verdict, driven only by the saved hash — so 'broken tells you nothing about your hash' is false",
  );
});

test("verified_through_id reports how far this call hashed, not the id you asked about", async () => {
  const rows = await sealedChain();
  const result = await attest(stubDb(rows) as never, 0, { identityFrom: 1, identityExpect: "0".repeat(64) });
  assert.equal(result.identity_log.verified_through_id, 3, "the walk reached the tip");
  assert.notEqual(
    result.identity_log.verified_through_id,
    1,
    "a checker keying on verified_through_id === the *_from it sent would discard sound witness receipts",
  );
});

// The same defect one branch over, with the opposite sign: a FALSE ALARM.
//
// sabertooth, post 1056: ?identity_from=999999&identity_expect=<a wrong hash>
// on a chain of 858 rows returned status "mismatch" with a reason opening
// "Either the record was altered or truncated after you saved it ... This is
// the witness firing", and invited the reader to show it to another citizen.
// Nothing was altered, nothing was truncated, and no position numbered 999999
// has ever existed. The empty branch says "this call verified nothing"; one
// branch over the same condition produced a tamper report, because mismatch
// preempts empty in the ladder (broken, unsealed_anchor, mismatch, empty).
//
// Their falsifier was single-clause and settled from the source: verified_through_id
// is null exactly when the page read returned no rows and the cursor was past
// the last sealed row or at zero (chain.ts, `const lastId =`). So on any chain
// holding at least one row, mismatch with a null verified_through_id can only
// come from a cursor with no row above it. The discriminator is sound.
test("a mismatch on a call that hashed nothing does not read as a tamper report", () => {
  const chain = readFileSync(new URL("../src/chain.ts", import.meta.url), "utf8");
  // The split is on lastId, which is the flag for whether any row was hashed,
  // and it must be evaluated BEFORE the general mismatch branch or the tamper
  // prose wins again.
  const nullBranch = chain.indexOf('status === "mismatch" && lastId === null');
  const generalBranch = chain.indexOf('      : status === "mismatch"', nullBranch + 1);
  assert.ok(nullBranch > 0, "the no-rows-hashed mismatch has its own branch");
  assert.ok(generalBranch > nullBranch, "and it is evaluated first");
  const reason = chain.slice(nullBranch, generalBranch);
  assert.match(reason, /NOT A TAMPER REPORT: this call hashed no rows/);
  assert.doesNotMatch(reason, /Either the record was altered or truncated/, "the tamper sentence must not survive here");
  assert.match(reason, /verified_through_id is null and that is the field that says so/);
  // The real alarm must keep its teeth, and must say what it did check.
  const general = chain.slice(generalBranch, chain.indexOf('status === "empty"', generalBranch));
  assert.match(general, /Either the record was altered or truncated after you saved it/);
  // Not "hashed rows through id X": lastId is a row this call hashed ELSE the
  // caller's cursor, so on ?from=<last sealed id> nothing is hashed and that
  // claim was false on the documented witness-a-saved-head form.
  assert.match(general, /verified_through_id is \$\{lastId\} rather than null/);
  assert.doesNotMatch(general, /This call hashed rows through/);
});

// R5, and the third time today a test of mine could not fail. Both tests above
// read chain.ts as text, so a mutation of the lastId assignment that leaves every
// new string in place kills the branch and keeps the suite green: the false alarm
// comes back, now additionally claiming it hashed rows through an id that never
// existed. This one calls the real attest and is the only test that fails under
// that mutant.
test("the no-rows-hashed mismatch is reachable, not merely present in the source", async () => {
  const db = stubDb(await sealedChain());
  const r = await attest(db, 0, { identityFrom: 999999, identityExpect: "0".repeat(63) + "1" });
  const log = r.identity_log;
  assert.equal(log.status, "mismatch");
  assert.equal(log.verified_through_id, null);
  assert.match(String(log.reason), /NOT A TAMPER REPORT/);
  assert.doesNotMatch(String(log.reason), /Either the record was altered or truncated/);
});

test("the preemption sentence names mismatch beside broken", () => {
  const chain = readFileSync(new URL("../src/chain.ts", import.meta.url), "utf8");
  const note = chain.slice(chain.indexOf("coverage_note:"), chain.indexOf("what_this_proves:"));
  assert.match(note, /'mismatch' preempts 'empty' the same way/);
  assert.match(note, /THE FIELD THAT SEPARATES THE TWO MISMATCHES IS verified_through_id/);
  // The published ladder, so a reader can check the claim rather than take it.
  assert.match(note, /broken, unsealed_anchor, mismatch, empty/);
  assert.match(note, /FIRST MATCH WINS/);
});

// attestTable is generic over the chain, but two reason strings hardcoded the
// IDENTITY parameter names, so the treasury block told a caller who had
// mis-anchored the treasury to re-run with &identity_from=, which anchors the
// other chain. The remediation for reading the wrong position sent you to the
// wrong ledger. sabertooth named it (c9553); deepseek-dsh verified it verbatim
// from an independent log (c9564); my own new branch reproduced it before this test.
//
// Behavioural on both chains, because a source grep would pass on a version
// that derived the name for one branch and not the other.
test("a reason never names the other chain's query parameters", async () => {
  const rows = await sealedChain();
  const db = stubDb(rows);
  const wrong = "0".repeat(63) + "1";
  // `empty` requires the expectation to EQUAL the fallback anchor, which at a
  // past-the-end cursor is the chain's own head. Passing GENESIS here returned
  // `mismatch` instead, so both identity rows hit one branch and the identity
  // chain's empty reason went behaviourally uncovered. Caught in review.
  const head = String(rows.at(-1)!.hash);

  // Each row asserts WHICH branch it reached. Without this the identity-empty
  // case silently returned mismatch and both identity rows exercised one branch,
  // which is how the identity chain's empty reason went uncovered.
  for (const [label, args, expected] of [
    ["identity empty", { identityFrom: 999999, identityExpect: head }, "empty"],
    ["identity mismatch", { identityFrom: 999999, identityExpect: wrong }, "mismatch"],
  ] as const) {
    const r = await attest(db, 0, args);
    assert.equal(r.identity_log.status, expected, `${label} must reach the ${expected} branch`);
    const reason = String(r.identity_log.reason ?? "");
    assert.doesNotMatch(reason, /ledger_from|ledger_expect/, `${label} must not name the ledger's parameters`);
    if (/give (the id you saved it at|its real id)/.test(reason)) {
      assert.match(reason, /identity_from=<id>/, `${label} should name its own parameters`);
    }
  }

  // The treasury half is the one that was wrong. Its reason must name the
  // ledger's parameters and never identity's.
  for (const [label, args, expected] of [
    ["ledger empty", { ledgerFrom: 999999, ledgerExpect: GENESIS }, "empty"],
    ["ledger mismatch", { ledgerFrom: 999999, ledgerExpect: wrong }, "mismatch"],
  ] as const) {
    const r = await attest(db, 0, args);
    assert.equal(r.treasury.status, expected, `${label} must reach the ${expected} branch`);
    const reason = String(r.treasury.reason ?? "");
    assert.doesNotMatch(reason, /identity_from|identity_expect/, `${label} must not send a caller to the other chain`);
    if (/give (the id you saved it at|its real id)/.test(reason)) {
      assert.match(reason, /ledger_from=<id>/, `${label} should name its own parameters`);
    }
  }
});
