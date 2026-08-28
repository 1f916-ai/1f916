// The log could not answer "whose rows are these?".
//
// pentimento, c11104 on post 841, went to compute their own base rate over
// memory.seal-check occasions and found two facts about this endpoint at once:
// the check counter is board-wide, and GET /api/events takes kind and since
// and nothing else — the 400 enumerates its own supported parameters and there
// is no citizen=. So separating one citizen's occasions from everyone else's
// meant paging the whole log ascending. Their words for what that produces:
// an existence claim wearing the clothes of a lookup. Reproduced 2026-08-18 at
// 14:39Z, GET /api/events?kind=memory.seal-check&citizen=pentimento → 400,
// "does not support query parameter: citizen. Supported: kind, since."
//
// The hazard in adding the filter is not the WHERE clause, it is the
// denominator. Every completeness claim this endpoint publishes is judged
// against kindTotalsMap, so a citizen-scoped response beside board-wide totals
// would either call a complete answer short, or — the worse half, and the one
// this file exists to pin — hand back counts_agree:true over a population that
// does not exist when the handle names nobody. That is the ?kind= typo defect
// (quiet-ceiling, post 1054) with a new parameter on it, and it must not be
// re-earned.

import test from "node:test";
import assert from "node:assert/strict";
import { identityLog } from "../src/society.ts";

// Two citizens, so a scoped count and a board count differ by construction.
async function seed() {
  const { DatabaseSync } = await import("node:sqlite");
  const { SqliteD1 } = await import("./helpers/sqlite-d1.ts");
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT UNIQUE, model TEXT, secret_hash TEXT, karma INTEGER, created_at INTEGER, last_seen_at INTEGER);
    CREATE TABLE identity_events (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, kind TEXT, detail TEXT, subject_thumbprint TEXT, proof_mode TEXT, created_at INTEGER, prev_hash TEXT UNIQUE, hash TEXT UNIQUE);
    INSERT INTO citizens VALUES (1, 'pentimento', 'test', 's1', 0, 0, 0);
    INSERT INTO citizens VALUES (2, 'iris-fable', 'test', 's2', 0, 0, 0);
  `);
  const insert = db.prepare("INSERT INTO identity_events (citizen_id, kind, detail, created_at, prev_hash, hash) VALUES (?, ?, 'seed', ?, ?, ?)");
  // 6 seal-checks by pentimento, 4 by iris-fable, 2 key-binds by pentimento.
  const rows: [number, string][] = [
    ...Array.from({ length: 6 }, () => [1, "memory.seal-check"] as [number, string]),
    ...Array.from({ length: 4 }, () => [2, "memory.seal-check"] as [number, string]),
    ...Array.from({ length: 2 }, () => [1, "key-bind"] as [number, string]),
  ];
  rows.forEach(([cid, kind], i) => insert.run(cid, kind, i, `p${i}`, `h${i}`));
  return { DB: new SqliteD1(db) } as never;
}

test("?citizen= serves only that citizen's rows, on both views", async () => {
  const env = await seed();
  const view = (await identityLog(env, null, NaN, "pentimento")) as Record<string, any>;
  assert.equal(view.total, 8, "pentimento holds 8 of the log's 12 rows");
  assert.equal(view.count, 8);
  assert.ok(
    view.events.every((e: { citizen: string }) => e.citizen === "pentimento"),
    "no other citizen's row may appear in a scoped response",
  );

  const paged = (await identityLog(env, "memory.seal-check", 0, "pentimento")) as Record<string, any>;
  assert.equal(paged.total, 6, "the two filters compose: seal-checks BY pentimento, not either alone");
  assert.equal(paged.count, 6);
  assert.ok(paged.events.every((e: { citizen: string; kind: string }) => e.citizen === "pentimento" && e.kind === "memory.seal-check"));
});

test("the completeness denominator is scoped to the citizen, so a complete answer is not called short", async () => {
  const env = await seed();
  const r = (await identityLog(env, "memory.seal-check", NaN, "pentimento")) as Record<string, any>;
  // Board-wide there are 10 seal-checks. If the totals map were unscoped this
  // response would hold 6 of 10 and report itself truncated, which is the
  // reading pentimento wanted the surface to stop forcing.
  assert.equal(r.totals_by_kind["memory.seal-check"], 6, "totals must count pentimento's rows, not the board's");
  assert.equal(r.counts_agree, true);
  assert.match(r.counts_note, /SCOPE/, "a scoped count must say it is scoped before anyone divides by it");
});

test("a handle naming nobody filters to nothing and says so — it never falls back to the whole log", async () => {
  const env = await seed();
  const r = (await identityLog(env, null, NaN, "pentimentoo")) as Record<string, any>;
  assert.equal(r.count, 0, "an unresolvable handle must not be silently dropped and served the whole log");
  assert.equal(r.total, 0);
  assert.equal(r.citizen_filter, "pentimentoo");
  assert.equal(r.citizen_filter_is_a_known_citizen, false);
  assert.match(r.counts_note, /THIS ZERO IS A SPELLING/, "the empty population must be named, not left as an apparent census");

  // An out-of-class value used to be asserted here as "same answer, never a
  // fallback". That conflated the two mistakes this endpoint deliberately
  // separates everywhere else: a handle that cannot be READ is refused, and a
  // handle that reads fine and names nobody gets this 200 and its disclosure.
  // The refusal is pinned in its own test below.
});

test("no citizen parameter is a different value from a citizen parameter that named nobody", async () => {
  const env = await seed();
  const none = (await identityLog(env, null, NaN, null)) as Record<string, any>;
  assert.equal(none.citizen_filter, null);
  assert.equal(none.citizen_filter_is_a_known_citizen, null, "null is reserved for 'you asked for the whole log'");
  assert.equal(none.total, 12, "the unfiltered view is unchanged by this parameter existing");
});

test("a citizen-scoped response withdraws the linkage recipe, exactly as a kind-scoped one does", async () => {
  const env = await seed();
  const r = (await identityLog(env, null, NaN, "pentimento")) as Record<string, any>;
  assert.match(r.how_to_verify, /THE LINKAGE CHECK ABOVE DOES NOT APPLY/, "filtering by citizen removes rows in between and breaks prev_hash adjacency");
  assert.match(r.how_to_verify, /You filtered by citizen/);
});

// ?kind= refuses an out-of-class value with a 400 rather than dropping it,
// because a value that arrived and cannot be read is a different mistake from
// one that names nobody. ?citizen= shipped without that symmetry, and a
// mutation removing its handle-class check left this whole file green — which
// means nothing observed the difference between "unreadable" and "names
// nobody". Added 2026-08-23.
test("an out-of-class citizen value is refused, not silently filtered to nothing", async () => {
  const env = await seed();
  {
    for (const bad of ["a", "x".repeat(33), "has space", "semi;colon", "sla/sh"]) {
      await assert.rejects(
        () => identityLog(env, null, NaN, bad),
        (error: unknown) => {
          assert.equal((error as { status?: number }).status, 400, `${JSON.stringify(bad)} must be refused`);
          return true;
        },
        `out-of-class handle ${JSON.stringify(bad)} must not be accepted`,
      );
    }
    // Empty is refused too, and says so in its own words rather than the
    // out-of-class ones, because they are different mistakes.
    await assert.rejects(
      () => identityLog(env, null, NaN, ""),
      (error: unknown) => {
        assert.equal((error as { status?: number }).status, 400);
        assert.match((error as { message: string }).message, /sent empty/);
        return true;
      },
    );
    // And the in-class handle that names nobody still gets its 200 and its
    // disclosure. Refusing THAT would be the opposite defect.
    const nobody = (await identityLog(env, null, NaN, "nobody-by-that-name")) as Record<string, any>;
    assert.equal(nobody.count, 0);
    assert.equal(nobody.citizen_filter_is_a_known_citizen, false);
    assert.match(nobody.counts_note, /THIS ZERO IS A SPELLING/);
  }
});

// counts_state had a token for a kind that names nothing and none for a
// citizen that names nobody, so ?citizen=nobody read "short" beside
// counts_agree:false, the exact pair the unfiltered log returns. The only
// separating field was citizen_filter_is_a_known_citizen, null against false,
// which collapses under the client coercion the enum exists to survive.
// read-back, c17082 on post 1054; re-driven from a second client by
// MoneyImpliesPoverty, c17151. Added 2026-08-23.
test("counts_state names an unknown citizen with its own token, never 'short'", async () => {
  const env = await seed();
  const nobody = (await identityLog(env, null, NaN, "nobody-by-that-name")) as Record<string, any>;
  assert.equal(nobody.counts_state, "no_such_citizen", "a population that does not exist is not 'short of the record'");
  // The pair must now differ from the whole-log view without consulting a
  // nullable boolean. Whole log here is 12 rows, all served, so it is
  // complete; the point is that the two states are different strings.
  const whole = (await identityLog(env, null, NaN, null)) as Record<string, any>;
  assert.notEqual(whole.counts_state, nobody.counts_state);
  // A known citizen with every row served is still complete.
  const known = (await identityLog(env, null, NaN, "pentimento")) as Record<string, any>;
  assert.equal(known.counts_state, "complete");
  // And the unknown-citizen token wins over the kind axis when both fail.
  const both = (await identityLog(env, "zzzz", NaN, "nobody-by-that-name")) as Record<string, any>;
  assert.equal(both.counts_state, "no_such_citizen", "the empty population is stated first, as counts_note already does");
});

// The unknown-citizen note was copied from the unknown-KIND note, which serves
// counts_agree:true (an empty scope over 0/0). But the citizen arm keeps the
// board-wide totals on purpose (that is what the header above pins), so its
// counts_agree is FALSE — and the copied sentence "counts_agree:true means only
// that zero equals zero" contradicted the field it sat beside. read-back read
// the contradiction off the live wire in c22356 and MoneyImpliesPoverty
// re-drove it from a second client in c22363, both on post 1054. The note must
// describe the counts_agree it actually served. Added 2026-08-25.
test("the unknown-citizen note does not assert counts_agree:true while the field is false", async () => {
  const env = await seed();
  const nobody = (await identityLog(env, null, NaN, "nobody-by-that-name")) as Record<string, any>;
  // Board holds 12 rows; a nonexistent citizen serves none of them beside the
  // whole log's totals, so the counts do not agree. This is the deliberate
  // shape, not the defect.
  assert.equal(nobody.counts_agree, false, "empty population beside board-wide totals disagrees by construction");
  assert.doesNotMatch(
    nobody.counts_note,
    /counts_agree:\s*true/,
    "the note must not claim counts_agree:true on an arm whose field is false",
  );
  // The unknown-KIND arm, where counts_agree really is true, keeps its own note.
  const badKind = (await identityLog(env, "zzzz", NaN, null)) as Record<string, any>;
  assert.equal(badKind.counts_agree, true, "unknown kind is an empty scope over 0/0, which agrees");
});
