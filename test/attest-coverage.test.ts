// Coverage honesty in /api/attest: the three ways it could report `verified`
// for work it did not do (Sirpixelalittle, #31).
//
// The witness suite's stub deliberately ignores LIMIT, which is right for the
// questions it asks and wrong for these — two of the three findings live
// exactly at the page boundary. This stub honours the bound limit and can hold
// a tip that is ahead of the page, which is what a concurrent append looks like
// from inside one request.

import test from "node:test";
import assert from "node:assert/strict";
import { attest, entryHash, GENESIS, VERIFY_PAGE, type ChainRow } from "../src/chain.ts";

/** Seal `n` rows into a chain that genuinely verifies. */
async function sealedChain(n: number): Promise<ChainRow[]> {
  const out: ChainRow[] = [];
  let prev = GENESIS;
  for (let i = 1; i <= n; i++) {
    const row: ChainRow = { id: i, citizen_id: 1, kind: "joined", detail: `citizen ${i} joined`, created_at: i * 1000 };
    const hash = await entryHash("identity_events", prev, row);
    out.push({ ...row, prev_hash: prev, hash });
    prev = hash;
  }
  return out;
}

/**
 * D1 stand-in that honours LIMIT. `tipOverride` stands in for a row appended
 * between the tip read and the page read — the two are separate statements, so
 * a live chain can and does move between them.
 */
function stubDb(identityRows: ChainRow[], tipOverride?: { id: number; hash: string }) {
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
          if (tipOverride && sql.includes("identity_events")) return tipOverride as T;
          const tip = rows.filter((r) => r.hash).pop();
          return (tip ? { id: tip.id, hash: tip.hash } : null) as T;
        },
        async all<T>() {
          const after = Number(bound[0] ?? 0);
          const limit = Number(bound[1] ?? Number.MAX_SAFE_INTEGER);
          return { results: rowsFor(sql).filter((r) => Number(r.id) > after).slice(0, limit) as T[] };
        },
      };
      return api;
    },
  } as never;
}

// Finding 2. A verdict about one saved hash is not coverage of a chain, and
// letting the first stand in for the second is how "verified" gets printed over
// zero rows — with a verified_through_id naming an id that does not exist.
test("a page past the end is 'empty' even when expect matches", async () => {
  const rows = await sealedChain(3);
  const head = String(rows[2].hash);
  const result = await attest(stubDb(rows), 0, { identityFrom: 9999, identityExpect: head });
  const r = result.identity_log;

  assert.equal(r.status, "empty", "this call hashed nothing; a matching expect must not launder that into 'verified'");
  assert.equal(r.ok, false);
  assert.equal(r.sealed_entries, 0);
});

test("an empty page never reports a verified_through_id it did not reach", async () => {
  const rows = await sealedChain(3);
  const result = await attest(stubDb(rows), 0, { identityFrom: 9999 });
  const r = result.identity_log;

  assert.equal(r.verified_through_id, null, "no row was hashed, so no row can be named as verified-through");
  assert.notEqual(r.verified_through_id, 9999, "the caller's cursor is not evidence of a verified position");
});

test("the witness verdict is still reported when the cursor is past the end", async () => {
  // Suppressing `empty` was the bug; suppressing the witness answer would be a
  // different one. Both questions get answered, and witnessed_against discloses
  // what the comparison actually used, since it is not the id the caller named.
  const rows = await sealedChain(3);
  const head = String(rows[2].hash);
  const result = await attest(stubDb(rows), 0, { identityFrom: 9999, identityExpect: head });
  const r = result.identity_log;

  assert.equal(r.status, "empty");
  assert.equal(r.expect_matches, true, "the hash does match where the anchor landed, and hiding that helps nobody");
  assert.equal(r.witnessed_against, head, "the response must disclose what it compared against");
  assert.match(String(r.reason), /not at 9999/, "and must say plainly that the comparison was not at the named id");
});

// A witness who saved the head at the tip and hands it back is the documented
// form. Nothing follows the tip, and that is being caught up rather than a
// defect — the distinction the first version of this fix got wrong.
test("a cursor at the real tip is caught up, not empty", async () => {
  const rows = await sealedChain(3);
  const result = await attest(stubDb(rows), 0, { identityFrom: 3, identityExpect: String(rows[2].hash) });
  const r = result.identity_log;

  assert.equal(r.status, "verified", "id 3 names a real row and the caller is current");
  assert.equal(r.expect_matches, true);
});

// Finding 1. tip and page are separate reads. If an entry lands between them,
// the page can reach its end while the head being reported was never hashed.
test("a tip that moved mid-request is reported as behind, not verified", async () => {
  const rows = await sealedChain(3);
  const future = await sealedChain(4); // as if row 4 landed during the read
  const result = await attest(stubDb(rows, { id: 4, hash: String(future[3].hash) }));
  const r = result.identity_log;

  assert.equal(r.status, "incomplete", "the reported head was never hashed by this call");
  assert.equal(r.ok, false);
  assert.notEqual(r.head, r.verified_head, "head is the true tip; verified_head is where hashing stopped");
  assert.equal(r.next_from, 3, "the caller resumes from the last row actually hashed");
  assert.match(String(r.reason), /behind the chain, not broken/);
});

// Finding 3. With exactly VERIFY_PAGE rows left, inferring the end from
// `rows.length < VERIFY_PAGE` marks a complete page incomplete; the follow-up
// then finds nothing and reports empty. No sequence of calls could reach
// verified — the chain became permanently unverifiable at an exact multiple of
// the page size.
test("a chain of exactly VERIFY_PAGE rows verifies in one call", async () => {
  const rows = await sealedChain(VERIFY_PAGE);
  const result = await attest(stubDb(rows));
  const r = result.identity_log;

  assert.equal(r.status, "verified", "the page held every row there is; that is the end");
  assert.equal(r.sealed_entries, VERIFY_PAGE);
  assert.equal(r.verified_through_id, VERIFY_PAGE);
  assert.equal(r.head, r.verified_head);
});

test("VERIFY_PAGE + 1 rows page cleanly to verified", async () => {
  const rows = await sealedChain(VERIFY_PAGE + 1);
  const first = (await attest(stubDb(rows))).identity_log;

  assert.equal(first.status, "incomplete", "one row remains, so this genuinely is a partial read");
  assert.equal(first.next_from, VERIFY_PAGE);

  const second = (await attest(stubDb(rows), first.next_from!)).identity_log;
  assert.equal(second.status, "verified", "the continuation must be able to finish");
  assert.equal(second.verified_head, rows[VERIFY_PAGE].hash);
});

test("query_dependence names exactly the fields that move with the anchor", async () => {
  // scrollback's acceptance (c7008): a boolean can only say SOMETHING depends
  // on the query; a list says WHICH, and makes omission visible. The empirical
  // half runs here: diff the block across two anchors, and every numeric field
  // whose value moved must appear in query_dependence — so a future field that
  // starts windowing without joining the list turns this red instead of
  // installing a fresh silent window beside an explicitly-scoped neighbour.
  const rows = await sealedChain(10);
  const un = (await attest(stubDb(rows))).identity_log as unknown as Record<string, unknown>;
  const an = (await attest(stubDb(rows), 0, { identityFrom: 5 })).identity_log as unknown as Record<string, unknown>;

  const declared = un.query_dependence as readonly string[];
  assert.ok(Array.isArray(declared) && declared.length >= 3, "a non-empty list, truthy like the boolean it replaces");
  assert.deepEqual(un.query_dependence, an.query_dependence, "the declaration itself must not move with the anchor");

  const exempt = new Set(["anchored_at", "verified_through_id", "next_from"]); // declare the window, not measurements of the chain
  const moved = Object.keys(un).filter(
    (k) => !exempt.has(k) && typeof un[k] === "number" && typeof an[k] === "number" && un[k] !== an[k],
  );
  assert.ok(moved.includes("sealed_entries"), "the fixture must actually exercise a windowed count");
  for (const k of moved) {
    assert.ok(declared.includes(k), `${k} moved with the anchor and is missing from query_dependence`);
  }
  for (const k of declared) {
    assert.ok(k in un, `query_dependence names ${k}, which is not a field in the block`);
  }
});

test("the response names the revision of its own prose (unspent, #876)", async () => {
  // Their falsifier: name any field from which a reader can determine the
  // revision of the prose they were served. The prose is source-embedded, so
  // the deployed commit determines it exactly; the field passes the commit
  // through, and null stays null rather than becoming a guess.
  const { attestation } = await import("../src/society.ts");
  const rows = await sealedChain(3);
  const env = { DB: stubDb(rows), BUILD_COMMIT: "abc123" } as never;
  const out = (await attestation(env)) as { prose_revision: string | null };
  assert.equal(out.prose_revision, "abc123");
  const bare = (await attestation({ DB: stubDb(rows) } as never)) as { prose_revision: string | null };
  assert.equal(bare.prose_revision, null, "an untold deployment says null, not a guess");
});
