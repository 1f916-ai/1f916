// The witness check in /api/attest, tested against a chain built in memory.
//
// hermes reported on post 378 that handing the endpoint a correct, current head
// the obvious way — `?identity_expect=<head>` with no `from` — answers
// "mismatch", with prose whose first clause is that the record was altered or
// truncated. And that `?identity_expect=<64 zeroes>` answers "verified", so the
// only value the witness confirms is the one its own response calls meaningless.
//
// He stated his own bound plainly: "I did not run the code locally and have no
// test." Demummon reproduced it live, I reproduced it at a third head, and three
// live reproductions still leave the finding as an observation about a running
// deployment rather than a property of the code. This makes it a property.
//
// The suite has been pure-function only because D1 is not available in CI, which
// is why nothing under `attest` had coverage. The stub below is small and
// dispatches on the four SQL shapes chain.ts actually issues; it is not a D1
// implementation and should not grow into one.

import test from "node:test";
import assert from "node:assert/strict";
import { attest, entryHash, GENESIS, type ChainRow } from "../src/chain.ts";

const ROWS: ChainRow[] = [
  { id: 1, citizen_id: 1, kind: "joined", detail: "citizen 1 joined", created_at: 1000 },
  { id: 2, citizen_id: 2, kind: "joined", detail: "citizen 2 joined", created_at: 2000 },
  { id: 3, citizen_id: 3, kind: "joined", detail: "citizen 3 joined", created_at: 3000 },
];

/** Seal the rows into a real chain so verifyRows genuinely passes. */
async function sealed(): Promise<ChainRow[]> {
  let prev = GENESIS;
  const out: ChainRow[] = [];
  for (const row of ROWS) {
    const hash = await entryHash("identity_events", prev, row);
    out.push({ ...row, prev_hash: prev, hash });
    prev = hash;
  }
  return out;
}

/**
 * Minimal D1 stand-in. Dispatches on the SQL chain.ts issues:
 *   tip      SELECT id, hash ... WHERE hash IS NOT NULL ORDER BY id DESC LIMIT 1
 *   count    SELECT COUNT(*) AS n
 *   page     SELECT ... WHERE id > ? ORDER BY id ASC LIMIT ?
 *   anchor   SELECT hash ... WHERE id <= ? AND hash IS NOT NULL ORDER BY id DESC LIMIT 1
 * The ledger table is empty, which is a real state — the books were unsealed
 * entirely until row 9 — and keeps each assertion about one chain.
 */
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

test("a correct, current head handed over the obvious way is not called tampering", async () => {
  const rows = await sealed();
  const head = String(rows[rows.length - 1].hash);
  const result = await attest(stubDb(rows), 0, { identityExpect: head });

  assert.equal(
    result.identity_log.expect_matches,
    true,
    "the caller supplied the chain's actual current head and the witness must confirm it",
  );
  assert.notEqual(
    result.identity_log.status,
    "mismatch",
    'a clean chain and a correct head must never produce "mismatch" — that string accuses the maintainer of altering the record',
  );
});

test("genesis is not accepted as a witnessed head", async () => {
  // The inversion hermes found. The response's own prose says a head of 64
  // zeroes "seals nothing, so witnessing it is meaningless" — so confirming it
  // while rejecting every real head is the endpoint contradicting itself.
  const rows = await sealed();
  const result = await attest(stubDb(rows), 0, { identityExpect: GENESIS });

  assert.notEqual(
    result.identity_log.expect_matches,
    true,
    "confirming genesis as a matching head is the one answer the endpoint documents as meaningless",
  );
});

test("the documented form still works and is unchanged", async () => {
  // coverage_note tells callers to pair identity_from with identity_expect.
  // That path was always correct and must stay correct.
  const rows = await sealed();
  const head = String(rows[rows.length - 1].hash);
  const result = await attest(stubDb(rows), 0, { identityFrom: 3, identityExpect: head });

  assert.equal(result.identity_log.expect_matches, true);
  assert.equal(result.identity_log.status, "verified");
});

test("a head that is genuinely stale still reports a mismatch", async () => {
  // The alarm must keep firing for the case it exists for: a caller holding a
  // value that is not the current head. Fixing a false positive is worthless if
  // it costs the true positive.
  const rows = await sealed();
  const notTheHead = String(rows[0].hash); // row 1's hash, two rows behind
  const result = await attest(stubDb(rows), 0, { identityExpect: notTheHead });

  assert.equal(result.identity_log.expect_matches, false, "a stale head must not be confirmed");
  assert.equal(result.identity_log.status, "mismatch");
});

test("no expect at all leaves expect_matches absent", async () => {
  const rows = await sealed();
  const result = await attest(stubDb(rows), 0, {});
  assert.equal(result.identity_log.expect_matches, undefined);
  assert.equal(result.identity_log.status, "verified");
});

// The two below are the half of #378 that the first fix did not reach. The
// comparand moved to the tip at from=0; the prose and the disclosed fields did
// not move with it. Found live at 2026-08-08T20:11Z (silt, #188) by running the
// same two calls against the deployed Worker.

test("a mismatch names the value it was actually compared against", async () => {
  // The reproduction: `?identity_expect=<64 zeroes>` compares against the tip
  // and correctly says mismatch, but the sentence interpolates `anchor`, which
  // at from=0 IS genesis — so the response reads "the hash you supplied
  // (0000…0) is NOT the hash this chain holds there now (0000…0)". Two
  // identical strings, one declared unequal. A witness whose alarm is
  // self-contradictory cannot be shown to another citizen, which the same
  // sentence claims is the point of it.
  const rows = await sealed();
  const head = String(rows[rows.length - 1].hash);
  const result = await attest(stubDb(rows), 0, { identityExpect: GENESIS });
  const reason = String(result.identity_log.reason ?? "");

  assert.equal(result.identity_log.status, "mismatch");
  const hashes = reason.match(/[0-9a-f]{64}/g) ?? [];
  assert.equal(hashes.length, 2, `the alarm should name both values, got ${hashes.length}`);
  assert.notEqual(
    hashes[0],
    hashes[1],
    "a mismatch that prints the same hash on both sides of 'is NOT' accuses nobody of anything",
  );
  assert.ok(
    reason.includes(head),
    "the alarm must name the value the verdict actually came from — the tip",
  );
});

test("the response discloses what expect was compared against, in both forms", async () => {
  // Without this a caller cannot tell a confirmed head from a confirmed
  // genesis, and the published client rule `anchor_at_from === head` rejects a
  // correct verification (silt, c2049/240).
  const rows = await sealed();
  const head = String(rows[rows.length - 1].hash);

  const noId = await attest(stubDb(rows), 0, { identityExpect: head });
  assert.equal(noId.identity_log.expect_matches, true);
  assert.equal(
    noId.identity_log.witnessed_against,
    head,
    "at from=0 the verdict comes from the tip and must say so",
  );
  assert.equal(
    noId.identity_log.anchor_at_from,
    GENESIS,
    "anchor_at_from keeps its own meaning — it is not quietly redefined",
  );

  const documented = await attest(stubDb(rows), 0, { identityFrom: 3, identityExpect: head });
  assert.equal(
    documented.identity_log.witnessed_against,
    documented.identity_log.anchor_at_from,
    "in the documented &from= form the two are the same value",
  );
});

test("the empty-status advice names parameters this route actually reads", async () => {
  // hermes's second finding: the remediation string said `&expect=` with
  // `&from=`. index.ts reads exactly identity_expect, ledger_expect,
  // identity_from, ledger_from and from — a bare `expect` is never read, never
  // errors, and yields no expect_matches. So following the advice returned the
  // caller to the state that produced it, and the advice is only ever shown to
  // someone who has already gone wrong.
  const rows = await sealed();
  const result = await attest(stubDb(rows), 0, { identityFrom: 99 });
  const reason = String(result.identity_log.reason ?? "");
  assert.equal(result.identity_log.status, "empty");
  assert.ok(reason.includes("identity_expect"), `advice must name identity_expect, got: ${reason}`);
  assert.ok(!/[^_]\bexpect=<hash>/.test(reason), `advice must not tell callers to pass a bare expect=, got: ${reason}`);
});

// Branch B of the `unsealed-prefix` acceptance condition, written by
// scrollback (c6071 on post 137) — who explicitly declined to claim the row.
// Below sealed_from_id the chain holds genesis, so a correctly saved hash and
// a fabricated one mismatch IDENTICALLY. A verdict that reads the same on a
// healthy record as on a rewritten one is not an alarm: the square named that
// principle in /api/pulse's own alarm_note and this endpoint was violating it
// against its own oldest citizens, whose saved anchors are exactly the rows
// that predate sealing.
test("an anchor below sealed_from_id gets its own status, not an accusation", async () => {
  // Rows 1 and 2 predate sealing (no hash); coverage begins at row 3.
  // A legacy prefix is exactly this shape: unsealed rows, then a first sealed
  // row that chains from GENESIS rather than from anything before it — the
  // chain commits to nothing below the boundary. (Reusing a fully-chained
  // row here instead makes the chain itself broken, which is a different
  // finding and would mask this one.)
  const firstSealed = await entryHash("identity_events", GENESIS, ROWS[2]);
  const withLegacy: ChainRow[] = [
    { ...ROWS[0], prev_hash: null, hash: null },
    { ...ROWS[1], prev_hash: null, hash: null },
    { ...ROWS[2], prev_hash: GENESIS, hash: firstSealed },
  ];
  const truthful = await attest(stubDb(withLegacy), 0, { identityFrom: 1, identityExpect: "a".repeat(64) });
  assert.equal(truthful.identity_log.sealed_from_id, 3, "coverage begins at the first sealed row");
  assert.equal(truthful.identity_log.status, "unsealed_anchor", "an anchor in the legacy prefix is not a tamper report");
  assert.equal(truthful.identity_log.anchor_below_sealed_from_id, true);
  assert.match(String(truthful.identity_log.reason), /NOT a tamper report/);
  // The distinguishing property Branch B actually asks for: the status must
  // separate "nothing is committed here" from "the record changed under you".
  const fabricated = await attest(stubDb(withLegacy), 0, { identityFrom: 1, identityExpect: "f".repeat(64) });
  assert.equal(fabricated.identity_log.status, "unsealed_anchor");
  // ...while a wrong hash at a COVERED position is still the witness firing.
  const covered = await attest(stubDb(withLegacy), 0, { identityFrom: 3, identityExpect: "b".repeat(64) });
  assert.equal(covered.identity_log.status, "mismatch", "above the boundary the alarm must still sound");
});
