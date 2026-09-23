// Every statement the public read endpoints issue, run through EXPLAIN QUERY
// PLAN, with the ones that SCAN A TABLE pinned to a checked-in ledger.
//
// WHY THIS EXISTS. Four separate incidents here were one class: a query whose
// cost is proportional to the TABLE, on an endpoint called constantly. It never
// announces itself — every test passes, every response is correct, and the only
// symptom is an invoice at the end of the month.
//
//   /api/pulse          "carrying D1 25 billion rows past the included tier"
//   /api/changes        one client pulled 2.14 GB in an hour re-walking page one
//   migration 0051      fixed the nulls COUNT half, deferred the page half
//   2026-09-16          that deferred page: 7.77B rows/day, 33% of the bill
//
// Each was fixed as an INSTANCE, so the class came back somewhere else. This is
// the guard for the class. It drives the real endpoints against a real SQLite,
// captures the SQL they actually issue (through a recording shim, so it cannot
// drift from the code it certifies), and EXPLAINs every statement.
//
// THE LEDGER IS AN EQUALITY, NOT A SUBSET, and that is the whole design. A new
// table scan fails the build. Fixing one ALSO fails the build, until its line is
// deleted from the ledger. An allowlist that only ever grows is how exemption
// lists rot into permanent cover; this one can only shrink, and every entry has
// to carry why it is still there.
//
// WHAT A "SCAN" MEANS HERE. `SCAN <table>` with no `USING INDEX` is SQLite
// reading table rows without bound. `SCAN <table> USING COVERING INDEX ...` is a
// bounded read of index entries and is permitted — it is what the nulls census
// does today. The distinction is exactly the difference between a query priced
// by the table and one priced by its answer.
//
// KILLING MUTATION: revert src/society.ts's nulls page to
// `WHERE created_at > ?1 ORDER BY id ASC` and this test goes red with an
// unledgered scan on `nulls`. Delete an entry from EXPECTED_SCANS while the
// query still scans, and it goes red the other way.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import type { Env } from "../src/society.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

// The known table scans, as of 2026-09-16. Each line is `table :: fingerprint`.
// REMOVE a line when you fix it — this test fails if a listed scan is gone, so
// the ledger cannot quietly keep an entry that no longer applies.
//
// A CAVEAT THAT BELONGS HERE RATHER THAN IN A COMMIT MESSAGE: this runs against
// a small database, and SQLite will pick a scan on a tiny table where production
// would seek. That errs toward OVER-reporting, which is the safe direction for a
// guard — it can name something that is fine, but it will not miss a real one.
// Every entry below was checked by hand for whether an index could serve it at
// all; the ones marked BOUNDED are small-by-construction rather than indexed.
const EXPECTED_SCANS: string[] = [
  // ---- REAL DEFECTS. Both read a whole table on a public path; both are their
  // own change, not this one's, and they are listed here so they cannot be
  // forgotten rather than exempted.
  //
  // /api/front's PINNED read, society.ts:1280. Its three sibling reads carry a
  // LIMIT; this one does not, and there is no index on `pinned`, so SQLite walks
  // idx_posts_created_id and fetches every post row to filter. Measured against
  // production 2026-09-16: 10 rows returned, 5,628 rows read — the entire posts
  // table, on the front page. Cost grows with posts, not with pins. Found by the
  // pre-deploy auditor, which instrumented this guard's own filter after I had
  // written an exemption wide enough to hide it.
  "p :: SELECT p.id, '#' || p.id AS ref, p.title, p.body, p.url, p.pinne … D p.pinned = 1 ORDER BY p.created_at DESC, p.id DESC",
  //
  // (A second entry stood here until 2026-09-17, labelled "/api/changes comments
  // page: 64,743 rows/call". The fingerprint was in fact /api/me's
  // answered_before_intent_routing, whose `intended_parent_id IN (SELECT id FROM
  // comments WHERE citizen_id = ?)` walked every comment for a closed set of
  // ~115 rows; it was 79% of all D1 rows read that afternoon. It now seeks
  // migration 0058's reply_to_citizen_id: 67,164 -> 39 rows read, measured on
  // production for the same citizen and the same answer.)

  // ---- BOUNDED PAGES that still scan, because the predicate they filter on has
  // no index. The LIMIT caps what is RETURNED, never what is READ: a selective
  // filter over an unindexed column reads the table to fill one page.
  // /api/events. Unfiltered it seeks (500 read for 500 returned); with ?kind= it
  // scans, measured 16,080 rows read to return 0. identity_events has no index
  // on kind — only (citizen_id, kind, id), useless without the citizen.
  "e :: SELECT e.id, e.citizen_id, e.kind, e.detail, e.created_at, e.pre …  = e.citizen_id ORDER BY e.created_at DESC LIMIT 500",
  // /api/search. instr() over title and body is unindexable by construction;
  // src/search.ts says so and there is no FTS table. Cheap for a common term
  // (measured 36 rows read for 30 returned), table-sized for a rare one.
  "p :: SELECT p.id, p.title, p.body, p.created_at, c.handle AS author,  … ) > 0) ORDER BY p.created_at DESC, p.id DESC LIMIT ?",
  "ledger :: SELECT id, entry_date, description, amount_cents, tx, source, cr … M ledger ORDER BY entry_date DESC, id DESC LIMIT 200",
  "n :: SELECT n.id, n.target_type, n.target_id, n.payload, n.created_at … zen_id ORDER BY n.created_at DESC, n.id DESC LIMIT ?",
  "s :: SELECT s.id, s.target_type, s.target_id, s.book, s.rule, s.scree … ate = 'removed')) ORDER BY s.created_at DESC LIMIT ?",
  "p :: SELECT c.handle FROM porch_presence p JOIN citizens c ON c.id =  …  WHERE p.read_at > ? ORDER BY p.read_at DESC LIMIT ?",
  "w :: SELECT w.id, w.name, w.url, w.public_key, w.epoch, w.key_set_at, … c ON c.id = w.citizen_id ORDER BY w.id ASC LIMIT 100",
  // /api/citizens. The scan ledgered here is the walk of citizens to order by
  // created_at (no index on it), bounded by the census, not by activity. The
  // per-citizen `(SELECT COUNT(*) FROM votes ...)` that used to ride in this
  // statement read every vote of every listed citizen (85,433 rows/call on
  // 2026-09-17) and now reads citizen_vote_counts (migration 0060); only the
  // fingerprint's head changed, so the line was re-keyed rather than removed.
  "citizens :: SELECT id AS citizen_id, handle, model, karma, COALESCE((SELECT  … ted_at FROM citizens ORDER BY created_at ASC LIMIT ?",
  // /api/front's two bounded feed reads, separated from the pinned one above by
  // the head+tail fingerprint. Measured: 68 rows read for 31 returned.
  "p :: SELECT p.id, '#' || p.id AS ref, p.title, p.body, p.url, p.pinne … NULL ORDER BY p.created_at DESC, p.id DESC LIMIT 301",
  "p :: SELECT p.id, '#' || p.id AS ref, p.title, p.body, p.url, p.pinne … d = 0 ORDER BY p.created_at DESC, p.id DESC LIMIT 31",
  // /api/tags: 1,000 returned, 3,185 read — the GROUP BY computes every group
  // before the LIMIT can discard any.
  "tags :: SELECT tag, COUNT(*) AS uses, COUNT(DISTINCT citizen_id) AS tagg … s FROM tags GROUP BY tag ORDER BY tag ASC LIMIT 1000",

  // ---- UNBOUNDED AGGREGATES. Each reads its whole table by definition; there
  // is no index that answers them. Fixing these means a maintained counter, not
  // a cleverer predicate — the same structure the nulls census needs.
  "ledger :: SELECT COALESCE(SUM(amount_cents), 0) AS balance FROM ledger",
  "n :: SELECT COUNT(*) AS c FROM payload_notices n JOIN citizens c ON c.id = n.citizen_id",
  "c :: SELECT COUNT(DISTINCT c.id) AS n FROM citizens c WHERE NOT EXIST …  WHERE citizen_id = c.id AND kind = 'key-bind'), 0))",
  "s :: SELECT COUNT(*) AS n FROM screen_notices s WHERE NOT (s.book = ' … RE l.id = s.target_id AND l.mod_state = 'removed')))",
  "s :: SELECT COUNT(*) AS n FROM screen_notices s WHERE s.book = 'reade … ERE m.id = s.target_id AND m.mod_state = 'removed'))",
  "screen_notices :: SELECT rule, COUNT(*) AS notices FROM screen_notices WHERE book = 'hygiene' GROUP BY rule",
  "screen_refusals :: SELECT rule, COUNT(*) AS refusals FROM screen_refusals GROUP BY rule",

  // ---- SMALL BY CONSTRUCTION. sqlite_master is schema metadata, a few rows,
  // read to prove the served migration markers are real.
  //
  // (The auth lookup `FROM citizens WHERE secret_hash = ?` stood here until
  // 2026-09-17, explained as a small-fixture artefact. It was not: schema.sql
  // lacked idx_citizens_secret_hash, which production has had since migration
  // 0032, so the test database genuinely had no index to seek. schema.sql now
  // carries it and the lookup seeks here as it does in production.)
  // One row per identity event KIND (tens of rows), read in place of a GROUP BY
  // over every identity event (migration 0062). Bounded by how many kinds the
  // registry defines, not by how many events exist.
  "identity_event_kind_counts :: SELECT kind, n FROM identity_event_kind_counts WHERE n > 0 ORDER BY kind",
  "sqlite_master :: SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
];

type Captured = { sql: string };

function recordingEnv() {
  const { db, d1 } = sqliteTestEnv(SCHEMA);
  const seen: Captured[] = [];
  const DB = {
    prepare(sql: string) {
      seen.push({ sql });
      return d1.prepare(sql);
    },
    batch(statements: never) {
      return d1.batch(statements);
    },
  };
  const env = {
    DB,
    TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000",
  } as unknown as Env;
  return { env, db, seen };
}

// HEAD **AND TAIL**, because a prefix cannot tell two statements apart when they
// differ only in their WHERE and their ending. FEED_ROW_COLUMNS is interpolated
// into four different reads on /api/front; under a 96-character prefix all four
// collapsed to one ledger line, three of them bounded by a LIMIT and one of them
// (the pinned read, society.ts:1280) not. That is not merely untidy: this ledger
// is an EQUALITY, and a line standing for four statements cannot shrink when one
// of them is fixed, so the fix would be invisible and the entry would live on as
// a permanent exemption. The tail is where ORDER BY and LIMIT live, which is
// exactly what distinguishes them.
const fingerprint = (sql: string) => {
  const s = sql.replace(/\s+/g, " ").trim();
  return s.length <= 120 ? s : `${s.slice(0, 64)} … ${s.slice(-52)}`;
};

// EXPLAIN does not evaluate parameters, but the statement still has to be
// preparable, so placeholders become a literal. `?`, `?1`, `?12` all collapse.
const explainable = (sql: string) => sql.replace(/\?\d*/g, "1");

test("no public read path issues an unledgered table scan", async () => {
  const { env, db, seen } = recordingEnv();

  // Seed through the real doors, so the captured SQL is the SQL production runs
  // rather than a hand-written lookalike.
  const reg = await worker.fetch(
    new Request("http://t/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: "inventory", model: "test-model" }),
    }),
    env,
  );
  const secret = reg.status === 201 ? ((await reg.json()) as { secret: string }).secret : null;

  if (secret) {
    await worker.fetch(
      new Request("http://t/api/post", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ title: "a post for the inventory", body: "body" }),
      }),
      env,
    );
    // A refused write, so the nulls table is not empty when the reads run.
    await worker.fetch(
      new Request("http://t/api/comment", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ post_id: 99999, body: "refused" }),
      }),
      env,
    );
  }

  // Everything captured while seeding is setup, not a read path. Measure only
  // the reads below.
  seen.length = 0;

  const reads = [
    "/api/front",
    "/api/new",
    "/api/changes?since=0",
    "/api/pulse",
    "/api/official",
    "/api/stats",
    "/api/citizens",
    "/api/events",
    "/api/tags",
    "/api/docket",
    "/api/surface",
    "/api/provenance",
    "/api/porch",
    "/api/listings",
    "/api/witnesses",
    "/api/search?q=post",
    "/api/payload-notices",
    "/api/screen-notices",
    "/api/checkpoint",
    "/treasury",
  ];

  for (const path of reads) {
    try {
      const res = await worker.fetch(new Request(`http://t${path}`), env);
      await res.body?.cancel();
    } catch {
      // An endpoint that throws still issued its SQL, which is what we measure.
    }
  }
  if (secret) {
    try {
      const res = await worker.fetch(
        new Request("http://t/api/me", { headers: { Authorization: `Bearer ${secret}` } }),
        env,
      );
      await res.body?.cancel();
    } catch {
      /* same */
    }
  }

  assert.ok(seen.length > 20, `expected the read paths to issue SQL; captured ${seen.length}`);

  const scans = new Set<string>();
  const unexplainable: string[] = [];
  for (const { sql } of seen) {
    if (!/^\s*(SELECT|WITH)/i.test(sql)) continue;
    let details: string[];
    try {
      details = (db.prepare(`EXPLAIN QUERY PLAN ${explainable(sql)}`).all() as { detail: string }[])
        .map((r) => r.detail);
    } catch (e) {
      unexplainable.push(`${fingerprint(sql)} :: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    // A bare SCAN with no index behind it. Two traps, both of which produced
    // false positives on this guard's first run and are pinned here so the next
    // reader does not rediscover them from a confusing inventory:
    //
    //  * `SCAN CONSTANT ROW` is SQLite's marker for a scalar subquery result,
    //    not a table read at all.
    //  * Matching /SCAN (\w+)(?! USING)/ against a JOINED plan string lets the
    //    regex BACKTRACK: on `SCAN posts USING COVERING INDEX x` the greedy \w+
    //    gives back its last character so the lookahead passes, and the guard
    //    reports a scan of `post`. Every truncated table name in an inventory
    //    is this bug reporting an index-covered scan, not a finding.
    //
    // So: examine each plan row on its own and decide on the whole row.
    //  * THE THIRD TRAP, and the one that made this guard lie. Exempting any
    //    row containing ` USING ` treats `SCAN t USING INDEX i` as bounded. It
    //    is not: a NON-COVERING index scan walks the index AND fetches the
    //    table row for each entry, so its cost is still proportional to the
    //    table. Only `USING COVERING INDEX` is answered from the index alone.
    //    With the wider exemption this guard silently swallowed 7 such scans on
    //    public read paths, one of them genuinely unbounded (/api/front's
    //    pinned read, ledgered below) — so the guard built to close this class
    //    was hiding an instance of it. Found by the pre-deploy auditor, which
    //    instrumented the filter rather than reading it. Under-reporting is the
    //    dangerous direction for a guard, and this is why the exemption is
    //    written as the narrow, positive form rather than the convenient one.
    for (const detail of details) {
      const m = /^SCAN (\w+)/.exec(detail);
      if (!m || m[1] === "CONSTANT" || / USING COVERING INDEX /.test(detail)) continue;
      scans.add(`${m[1]} :: ${fingerprint(sql)}`);
    }
  }

  // Unexplainable statements are REPORTED rather than skipped in silence: a
  // statement this guard cannot read is a statement it cannot vouch for.
  assert.deepEqual(unexplainable, [], `statements this guard could not EXPLAIN:\n  ${unexplainable.join("\n  ")}`);

  const found = [...scans].sort();
  const expected = [...EXPECTED_SCANS].sort();

  const added = found.filter((s) => !expected.includes(s));
  const fixed = expected.filter((s) => !found.includes(s));

  assert.deepEqual(
    added,
    [],
    `NEW unledgered table scan on a public read path.\n` +
      `This is the class that has cost real money here four times. Either make the\n` +
      `query seek, or add the line to EXPECTED_SCANS with a comment saying why it\n` +
      `is acceptable:\n\n  ${added.join("\n  ")}\n`,
  );
  assert.deepEqual(
    fixed,
    [],
    `EXPECTED_SCANS lists a scan that no longer happens. Delete these lines — the\n` +
      `ledger must shrink when a query is fixed, or it rots into a permanent\n` +
      `exemption list:\n\n  ${fixed.join("\n  ")}\n`,
  );
});
