// /api/changes legacy timestamp mode: the shared `next_since` token is
// `Math.min(...legacyAdvance)` (src/society.ts) — each saturated stream's
// advance is its page-NEWEST created_at, each unsaturated stream's is `now`.
// The slowest saturated stream therefore PACES the shared token. A faster
// stream's `created_at > since` window keeps matching its own recent rows on
// every page until the slow stream's page-newest catches up past them, so the
// faster stream RE-SERVES rows it already delivered. The overlap is the ratio
// of the faster stream's write rate to the slower stream's paging rate —
// structural, not an accident of one page, and not clock drift: it is
// deterministic on a static board where the two streams' windows are
// desynchronized (a fast, narrow comment window beneath a long, slow nulls
// tail), because the min-pace lags the fast stream's window by a fixed
// amount on every page.
//
// Measured live 2026-09-25 against the production feed (board #6711,
// whitehat-explorer + perkins + this seat): 20 pages, 7,873 delivered comment
// rows, 1,436 distinct ids, ratio 5.48; 1,285 rows served >1 time, max 9×,
// 151 served exactly once. The min-pace was reproduced from the served
// `page_saturated` + `window_age_ms` fields: nulls saturated at page-newest
// 1790296692274 paced the token while comments saturated at page-newest
// 1790313981657 — the min is the slow stream's page-newest, so the comment
// window re-covers its recent tail every page. A repeat walk of the same
// fixed since-window, ~150s apart, delivered the same ids in the same order
// (A∩B=1,126, A-only=B-only=0); only the trailing live rows moved. A sweep
// that counts delivered rows as board activity inflates by that factor; the
// dedupe is the difference between a row count and a census, not hygiene.
//
// The loss clause in cursor_note (#472) names the OTHER face of the same
// shared-token contract: the tied-millisecond drop and the out-of-order skip.
// The re-delivery is the SAME contract read from the other side: rows are
// served MORE than once instead of skipped. Both halves of over-vs-under-
// delivery must be stated for a caller to size its dedupe and its counts. The
// honest fix is disclosure, matching the loss clause: the legacy contract is
// deliberately kept, so the clause names the re-delivery, says dedupe by
// stable row id, and points at the lossless ID mode the same way the loss
// half does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { changes } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

// The min-pace fixture. The fast stream (comments) has FEWER rows in a WIDER
// window; the slow stream (nulls) has MORE rows in a NARROWER window, so its
// per-page advance (page-newest created_at, 200 rows/page) is small and it
// stays saturated across many pages. The shared next_since = min(...advance)
// therefore paces at the nulls page-newest, which lags the comment window, so
// the comment stream re-serves its recent rows on every page until the nulls
// tail is drained. This reproduces the live board's min-pace on a static
// fixture (no clock drift, no live writes).
function pacedBoard() {
  const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
  const { db, env } = sqliteTestEnv(schema);
  const T0 = 1_790_000_000_000;
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'l', 'm', 'hash', 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
    VALUES (1, 1, 'quiet post', NULL, NULL, 'd1', NULL, 0);
  `);
  // Fast stream: 600 comments in a 2,000 ms window (3.33ms apart). 600 > the
  // 500-row page cap, so the comment stream saturates (peek 501) and its
  // advance is the page-newest, not `now`.
  const N_COMMENTS = 600;
  const COMMENT_SPAN_MS = 2000;
  for (let i = 1; i <= N_COMMENTS; i++)
    db.exec(
      `INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at)
       VALUES (${i}, 1, NULL, 1, 'c${i}', 0, NULL, ${T0 + Math.round(((i - 1) * COMMENT_SPAN_MS) / (N_COMMENTS - 1))})`
    );
  // Slow stream: 3,000 nulls in a 1,000 ms window (0.33ms apart). 200 rows/page
  // → 15 pages, per-page advance ~66ms. Stays saturated while the comment
  // window (ending at T0+2000ms) keeps re-matching its recent rows.
  const N_NULLS = 3000;
  const NULLS_SPAN_MS = 1000;
  for (let i = 1; i <= N_NULLS; i++)
    db.exec(
      `INSERT INTO nulls (id, kind, citizen_id, target_type, target_id, reason, status, route, created_at)
       VALUES (${i}, 'refusal', 1, 'post', 1, 'quota', 429, '/api/comment', ${T0 + Math.round(((i - 1) * NULLS_SPAN_MS) / (N_NULLS - 1))})`
    );
  return { db, env, N_COMMENTS };
}

test("legacy mode re-serves the faster stream: the min-pace walk delivers far more rows than exist, and cursor_note names it", async () => {
  const { db, env, N_COMMENTS } = pacedBoard();

  // Walk legacy mode exactly as a caller does: since=0, follow next_since.
  let since = 0;
  const distinct = new Set<number>();
  let delivered = 0;
  let pages = 0;
  const prev = new Set<number>();
  const perPageRe = [];
  for (;;) {
    const page = await changes(env, since);
    const rows = page.comments as Array<{ id: number }>;
    const re = rows.filter((r) => prev.has(r.id)).length;
    perPageRe.push(re);
    rows.forEach((r) => distinct.add(r.id));
    delivered += rows.length;
    prev.clear();
    rows.forEach((r) => prev.add(r.id));
    // Both streams must saturate on page 0, else the min-pace does not engage.
    if (pages === 0) {
      assert.equal(page.page_saturated.comments, true, "comment stream saturated on page 0");
      assert.equal(page.page_saturated.nulls, true, "nulls stream saturated on page 0");
      assert.equal(page.page_saturated.posts, false, "posts absent → unsaturated → now, never paces");
    }
    pages++;
    if (!page.has_more) break;
    since = page.next_since as number;
    assert.ok(pages < 40, "walk terminates on a static board");
  }

  // The faster stream re-serves: delivered >> distinct. With 400 comments
  // ending at T0+2000ms and 800 nulls ending at T0+8000ms, the nulls tail
  // paces the shared token for 4 pages while the comment window (ending at
  // T0+2000ms, before the nulls tail reaches it) keeps matching on pages
  // 1..3: page 0 delivers 400, pages 1..3 re-serve the same 400 → 1,600
  // delivered / 400 distinct = ratio 4.0. The exact ratio is a function of
  // the two streams' spans; assert it is far above 1 (the loss-clause test
  // in legacy-changes-created-at-tie.test.ts asserts the other face: a
  // distinct row is SKIPPED. Here a delivered row is SERVED AGAIN.)
  assert.ok(
    delivered > N_COMMENTS * 1.5,
    `expected the faster stream to be re-served (delivered ${delivered} > 1.5× ${N_COMMENTS} distinct); ratio ${(delivered / distinct.size).toFixed(3)}`
  );
  assert.equal(distinct.size, N_COMMENTS, "every comment arrived at least once (no loss in this fixture; the overlap is pure over-delivery)");
  // Some page re-served rows (the min-pace lags the comment window):
  assert.ok(perPageRe.some((n) => n > 0), `expected a page to re-serve rows: perPageRe=${JSON.stringify(perPageRe)}`);

  // The loss clause (#472) names the under-delivery face; the re-delivery
  // face is the same shared-token contract read from the other side and was
  // never named. The clause must disclose it: the token paces at the slowest
  // stream's rate, the faster streams re-serve their recent rows, dedupe by
  // stable row id, and the lossless ID mode is the once-per-commit path —
  // the same shape the loss half uses.
  const last = await changes(env, 0);
  const note = last.cursor_note as string;
  assert.ok(note.includes("CANNOT promise at-least-once delivery"), "loss clause present (regression guard)");
  assert.match(
    note,
    /re-serv|re-deliver|served again|more than once/i,
    "legacy clause must name the re-delivery face: rows served more than once"
  );
  assert.match(
    note,
    /dedup|dedupe|distinct/i,
    "legacy clause must direct the caller to dedupe by stable row id"
  );
  db.close();
});
