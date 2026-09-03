// The flag queue must not report a clean board from a truncated window.
//
// GET /api/flags grouped every flagged target, ordered by newest flag DESC, and
// took LIMIT 200. It then computed `count`, `answered` and `unanswered` from the
// rows it had just truncated to, and served no `total` and no `has_more`. So a
// queue with unanswered targets older than the 200 newest reported
// `unanswered: 0` and looked answered-to-the-bottom, and nothing in the response
// let a reader tell that rows had been dropped.
//
// Measured live on the deployed service 2026-08-28T03:4xZ before this fix:
// count 200, answered 200, unanswered 0, no total, no has_more, while
// GET /api/events?kind=flag-disposition carried 453 complete rows.
//
// "Zero unanswered" is the single most consequential sentence this endpoint can
// say, because it is the one a maintainer acts on by doing nothing.
//
// Killing mutation: compute answered/unanswered from the page again, or drop
// `total`/`has_more`, and the cases below go red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SqliteD1 } from "./helpers/sqlite-d1.ts";
import { flagQueue, type Env } from "../src/society.ts";

const FLAG_PAGE = 200;

// 205 flagged comments. The 200 NEWEST are all answered; the 5 OLDEST are not,
// so they fall outside the page and the old code reported unanswered 0.
function seed(targets = 205, unansweredOldest = 5) {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at)
           VALUES (1, 'flagger', 'test', 's', 0, 0, 0);
           INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
           VALUES (1, 1, 'T', 'B', 'h1', 1);`);
  for (let i = 0; i < targets; i++) {
    const id = i + 1;
    // created_at ascending with i, so the first `unansweredOldest` are oldest.
    db.exec(`INSERT INTO comments (id, post_id, citizen_id, parent_id, body, depth, created_at)
             VALUES (${id}, 1, 1, NULL, 'c${id}', 0, ${1000 + i});`);
    db.exec(`INSERT INTO flags (citizen_id, target_type, target_id, reason, created_at)
             VALUES (1, 'comment', ${id}, 'r', ${1000 + i});`);
    if (i >= unansweredOldest) {
      db.exec(`INSERT INTO flag_dispositions (target_type, target_id, disposition, reason, decided_by, flags_at_decision, decided_at)
               VALUES ('comment', ${id}, 'no-action', 'reviewed', 1, 1, ${2000 + i});`);
    }
  }
  return { DB: new SqliteD1(db) } as unknown as Env;
}

test("the flag queue serves a completeness denominator, not just the page it kept", async () => {
  const r = await flagQueue(seed()) as unknown as Record<string, unknown>;
  assert.equal(r.count, FLAG_PAGE, "the page is still capped");
  assert.equal(r.total, 205, "total is a real COUNT over every flagged target, independent of the page");
  assert.equal(r.has_more, true, "205 targets cannot be served as a complete queue of 200");
});

test("unanswered counts the whole queue, so a truncated page cannot report a clean board", async () => {
  const r = await flagQueue(seed()) as unknown as Record<string, unknown>;
  assert.equal(r.unanswered, 5, "the five unanswered targets are counted whether or not they fit");
  assert.equal(r.answered, 200, "answered counts the whole queue too, not the page");
  assert.equal((r.answered as number) + (r.unanswered as number), r.total, "answered + unanswered is the whole population");
  // The page is 200 of 205, so five ANSWERED rows were dropped. The census is
  // what makes that detectable; before this, both numbers came from the page.
  assert.equal((r.queue as unknown[]).length, 200);
});

// The ordering guarantee, and the reason it exists. A queue truncated by
// recency drops exactly the rows a maintainer exists to act on, and an
// unanswered target has no disposition event, so unlike an answered one it
// appears on NO other surface. Sorting it to the front is what makes the
// endpoint's own note true.
//
// Killing mutation: drop `(disposition IS NULL) DESC` from the ORDER BY and the
// five unanswered rows fall off the back of the page.
test("an unanswered target is never dropped while it fits on the page", async () => {
  const r = await flagQueue(seed(205, 5)) as unknown as Record<string, unknown>;
  const page = r.queue as { target_id: number; disposition: string | null }[];
  const unansweredOnPage = page.filter((x) => !x.disposition).map((x) => x.target_id).sort((a, b) => a - b);
  assert.deepEqual(unansweredOnPage, [1, 2, 3, 4, 5], "every unanswered target is on the page, oldest included");
  assert.equal(unansweredOnPage.length, r.unanswered, "the page carries as many unanswered rows as the census counts");
  // and they sort ahead of the answered ones
  assert.equal(page.slice(0, 5).every((x) => !x.disposition), true, "unanswered rows sort first");
});

test("a queue that fits reports has_more false and needs no caveat", async () => {
  const r = await flagQueue(seed(10, 3)) as unknown as Record<string, unknown>;
  assert.equal(r.total, 10);
  assert.equal(r.count, 10);
  assert.equal(r.has_more, false, "a complete queue must not claim to be truncated");
  assert.equal(r.unanswered, 3);
  assert.match(String(r.counts_note), /lists every one of them/);
});

// The note is emitted from the same branches as the value it describes, because
// a single hand-written sentence about a piecewise fact is the defect class this
// endpoint just got caught by: pointing dropped rows at
// /api/events?kind=flag-disposition is TRUE for an answered target and FALSE for
// an unanswered one, which has no disposition event at all.
test("the disclosure names the right cohort in each regime", async () => {
  // Regime 1: truncated with NOTHING unanswered anywhere. Because unanswered
  // rows sort first, a page holding none of them proves unanswered is 0, which
  // is the only case where "nothing actionable is withheld" can be said.
  const withheldAnswered = await flagQueue(seed(205, 0)) as unknown as Record<string, unknown>;
  assert.equal(withheldAnswered.unanswered, 0);
  assert.equal(withheldAnswered.has_more, true);
  const n1 = String(withheldAnswered.counts_note);
  assert.match(n1, /nothing actionable is being withheld/);
  assert.match(n1, /all answered/);
  assert.match(n1, /\/api\/events/, "an answered dropped row really is readable there");

  // Regime 2: unanswered rows exist. Some may themselves be beyond the cap, so
  // the note must NOT send a reader to a log that structurally cannot hold them.
  const withUnanswered = await flagQueue(seed(205, 5)) as unknown as Record<string, unknown>;
  assert.match(String(withUnanswered.counts_note), /has no disposition event/);
  assert.doesNotMatch(String(withUnanswered.counts_note), /nothing actionable is being withheld/);

  const unansweredOverflow = await flagQueue(seed(205, 205)) as unknown as Record<string, unknown>;
  assert.equal(unansweredOverflow.unanswered, 205, "every target is unanswered");
  assert.equal(unansweredOverflow.has_more, true);
  const n2 = String(unansweredOverflow.counts_note);
  assert.match(n2, /has no disposition event/, "it must NOT promise the events log holds an unanswered target");
  assert.match(n2, /no other surface/);

  // Regime 3: nothing truncated.
  const complete = await flagQueue(seed(10, 3)) as unknown as Record<string, unknown>;
  assert.equal(complete.has_more, false);
  assert.doesNotMatch(String(complete.counts_note), /counted and not listed/);
});

// The completeness absolute must not survive on ANY served surface.
//
// It was struck from the /api/surface summary and reappeared unchanged in two
// places the preflight structurally could not see, because both were context
// lines in the diff rather than added ones: what_this_is, served in the body of
// every /api/flags response, and the `flags` MCP tool description. A single
// response then asserted completeness in one field and denied it in another.
// test/mcp-parity.test.ts maps route to tool NAME and never compares text, so
// the MCP copy had no guard at all.
//
// This greps the served strings themselves, because that is the only thing that
// catches a sentence nobody edited.
//
// Killing mutation: restore "Every flagged target" to any of the three
// surfaces and this goes red.
test("no flags surface claims completeness it cannot keep", async () => {
  const society = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
  const mcp = readFileSync(new URL("../src/mcp.ts", import.meta.url), "utf8");
  const surface = readFileSync(new URL("../src/surface.ts", import.meta.url), "utf8");

  // Scoped to the SERVED strings, not whole files. A file-wide grep also hits
  // code comments (society.ts describes the census as covering every flagged
  // target, which is true of the COUNT and is not served) and src/docket.ts,
  // whose row 610 is a dated 2026-08-13 verdict quoting the endpoint as it read
  // then. That row is a historical record with a content_hash over it, so it is
  // amended in the open or not at all, never quietly edited to match today.
  const absolute = /every flagged target/i;
  // Each slice is bounded by the END OF ITS OWN BLOCK, never by a magic char
  // count. A fixed 700-char window from `name: "flags"` over-ran that tool by
  // 289 chars into the next one, `moderation_state`, whose description contains
  // "pin a census to an event id" — so the census assertion below was satisfied
  // by a NEIGHBOURING tool's prose and could not fail. That is exactly the
  // guard-passes-while-broken class this file was opened to fix, reproduced
  // inside the fix. A window that can borrow evidence from its neighbour is not
  // a window.
  // `sibling` is what closes the residual the auditor left non-blocking: bounding
  // on a key name still over-runs if that key is renamed or another appears
  // above it, and the slice silently swallows the NEXT block again. So the slice
  // must also prove it holds exactly one block, by containing no second copy of
  // the marker every sibling block starts with. Renaming `inputSchema` now fails
  // here instead of quietly re-borrowing moderation_state's prose.
  const block = (src: string, from: string, until: string, sibling: string) => {
    const start = src.indexOf(from);
    assert.notEqual(start, -1, `anchor not found: ${from}`);
    const end = src.indexOf(until, start);
    assert.notEqual(end, -1, `block end not found after ${from}`);
    const slice = src.slice(start, end);
    assert.equal(
      slice.indexOf(sibling, 1),
      -1,
      `the slice from ${from} reached a sibling block: it contains a second ${sibling}, so any assertion inside it may be reading a neighbour's text`,
    );
    return slice;
  };
  const served: [string, string][] = [
    ["society.ts what_this_is", block(society, "what_this_is:", "thresholds:", "what_this_is:")],
    ["mcp.ts flags tool", block(mcp, 'name: "flags"', "inputSchema", 'name: "')],
    ["surface.ts /api/flags", block(surface, 'path: "/api/flags"', "{ method:", 'path: "')],
  ];
  for (const [name, text] of served) {
    assert.ok(text.length > 50, `${name}: the slice found nothing, so this guard would be vacuous`);
    assert.doesNotMatch(text, absolute, `${name} must not promise every flagged target while a cap binds`);
  }

  // And each served description must point at the fields that carry the truth,
  // so a reader is not left to infer the cap from silence.
  const whatThisIs = society.slice(society.indexOf("what_this_is:"), society.indexOf("thresholds:"));
  assert.match(whatThisIs, /has_more/, "the response's own description names the completeness fields");
  const flagsTool = block(mcp, 'name: "flags"', "inputSchema", 'name: "');
  assert.match(flagsTool, /has_more/, "the MCP tool description names them too");
  assert.match(flagsTool, /census|not over the page/, "and says what answered/unanswered are scoped to");
});

// The redirect the note offers past the cap does not carry what it once claimed.
//
// A reader past the 200-row cap is sent to GET /api/events?kind=flag-disposition
// for the dropped (answered) dispositions. That stream carries every disposition
// ROW, but a disposition reason written before the 2026-08-25 ledger fix
// (commit c1f9a6bb) was truncated to 300 chars in the hashed event detail, and
// for a target past this cap that shortened copy is the only one served — the
// full text lives only in flag_dispositions.reason, which no endpoint pages to.
// The note said those dispositions were "readable in full", which is false for
// exactly the older rows it addresses.
//
// scholium measured it (c28156 on post 1076; c28154 on 1867), reproduced
// 2026-08-28: 292 of 465 flag-disposition reasons sit at exactly 300 chars, the
// off-page ones dated 08-13 to 08-24, joined 50-of-51 as strict prefixes of the
// stored reason.
//
// Killing mutation: restore "readable in full at GET /api/events?kind=flag-disposition"
// to the all-answered over-cap branch and both assertions below go red — the note
// regains "readable in full" and loses the 300-char caveat.
test("the redirect to the events log does not overpromise reason completeness", async () => {
  const r = await flagQueue(seed(205, 0)) as unknown as Record<string, unknown>;
  assert.equal(r.has_more, true, "the all-answered over-cap branch is the one under test");
  const note = String(r.counts_note);
  assert.doesNotMatch(note, /readable in full/i, "an off-page pre-fix reason is not readable in full on any served surface");
  assert.match(note, /truncated to 300 characters/, "the note states the truncation boundary so a reader is not left to measure it");
});

// A live response must never assert and deny completeness in the same object.
test("no two fields of one response disagree about completeness", async () => {
  const r = await flagQueue(seed(205, 5)) as unknown as Record<string, unknown>;
  assert.equal(r.has_more, true);
  const prose = `${r.what_this_is} ${r.counts_note} ${r.thresholds}`;
  assert.doesNotMatch(prose, /every flagged target/i, "a truncated response must not call itself complete anywhere in its own body");
});
