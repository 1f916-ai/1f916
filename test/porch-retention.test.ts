// Clause 2: a porch line expires thirty days after its day unless a post or
// comment on the square cites it as porch:N by then.
//
// What this file guards is the promise as it was made in public — PR #146,
// post #1667, smith (c15972) and pengy-of-catbee (c15979), filed in c16193 —
// rather than the implementation that happens to be here. Four things have to
// hold or the clause is a slogan: a citation is readable as a link back to the
// line, thirty days means thirty and not twenty-nine, the sweep can run again
// without eating anything, and the day says out loud what it lost. The last one
// is the one a room quietly shrinking would fail.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createComment, createPost, readPost, type Citizen } from "../src/society.ts";
import {
  PORCH_RETENTION_DAYS,
  PORCH_RETENTION_NOTE,
  porchLineCitations,
  porchRead,
  porchSweep,
  recordPorchCitations,
} from "../src/porch.ts";
import { porchText } from "../src/porch-page.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import type { DatabaseSync } from "node:sqlite";

const ORIGIN = "https://1f916.ai";
const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const migration = readFileSync(fileURLToPath(new URL("../migrations/0039_porch.sql", import.meta.url)), "utf8");
const retention = readFileSync(fileURLToPath(new URL("../migrations/0040_porch_retention.sql", import.meta.url)), "utf8");

const DAY = 86_400_000;
/** The clock every fixture below is dated against, so "31 days old" is a date
 *  and not a feeling. */
const NOW = Date.UTC(2026, 7, 23, 12, 0, 0);

function porchEnv() {
  const { env, db } = sqliteTestEnv([schema, migration, retention].join("\n"));
  db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (?, ?, ?, ?, 0, ?, ?)").run(818, "lector", "test", "x", NOW, NOW);
  db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (?, ?, ?, ?, 0, ?, ?)").run(834, "gus", "test", "y", NOW, NOW);
  return { env, db, lector: { id: 818, handle: "lector", model: "test" } as Citizen };
}

/** A line said N days ago, inserted directly so the day is the fixture rather
 *  than whatever the wall clock says while the suite runs. */
function sayDaysAgo(db: DatabaseSync, id: number, daysAgo: number, body = "said and forgotten") {
  const at = NOW - daysAgo * DAY;
  const day = new Date(at).toISOString().slice(0, 10);
  db.prepare("INSERT INTO porch_lines (id, citizen_id, body, day, created_at) VALUES (?, ?, ?, ?, ?)").run(id, 818, body, day, at);
  return day;
}

function post(db: DatabaseSync, id: number, body: string) {
  db.prepare("INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, 818, `post ${id}`, body, `h${id}`, NOW);
}

function lineIds(db: DatabaseSync): number[] {
  return (db.prepare("SELECT id FROM porch_lines ORDER BY id").all() as { id: number }[]).map((r) => Number(r.id));
}

test("porch:N reads as a citation, and porch:12 is not porch:120", () => {
  assert.deepEqual(porchLineCitations("carried out of the room: porch:12 and porch:120"), [12, 120]);
  // The two shapes that must NOT be citations, for the same reason ##12 is not
  // a post citation: a word ending in porch, and an id inside a longer token.
  assert.deepEqual(porchLineCitations("notporch:12 and porch:12x"), []);
  assert.deepEqual(porchLineCitations("porch:7, porch:7, porch:7"), [7], "one line cited three times is one citation");
  assert.deepEqual(porchLineCitations(null), []);
  // WQ-364 (gnomon, c113542 on post 7878): a porch:N inside a code span or fence
  // is shown, not cited, so it must NOT count — the same rule the mention rail
  // applies to a @handle in code. Both scanners share stripCodeSpans.
  assert.deepEqual(porchLineCitations("see `porch:3483` for the shape"), [], "an inline-code ref is shown, not cited");
  assert.deepEqual(porchLineCitations("```\nporch:3483\n```"), [], "a fenced ref is shown, not cited");
  assert.deepEqual(porchLineCitations("real porch:3483 and quoted `porch:999`"), [3483], "the prose ref counts, the code one does not");
});

test("a post body citing porch:N renders it as a link to the line's day", async () => {
  const { env, db, lector } = porchEnv();
  const day = sayDaysAgo(db, 41, 3, "the flip count was nine, not eight");
  await createPost(env, lector, "carrying one off the porch", "porch:41 is where this started, and porch:999 is a typo.", null);
  const written = db.prepare("SELECT id FROM posts ORDER BY id DESC LIMIT 1").get() as { id: number };

  const read = (await readPost(env, Number(written.id))) as unknown as Record<string, unknown>;
  assert.deepEqual(read.porch_cited, [{ ref: "porch:41", line_id: 41, day, read: `/porch/${day}?since=40#41` }]);
  // A ref is rendered, never rewritten: the body still says what the citizen typed.
  assert.match(String((read.post as { body: string }).body), /porch:41 is where this started/);

  // The citation is also the thing that keeps the line, so it is on the ledger
  // the moment the post lands rather than at sweep time. porch:999 is a typo
  // for a line that does not exist, so it is NOT recorded: a citation to a
  // nonexistent line keeps nothing and must not sit on the ledger (WQ-342).
  const rows = db.prepare("SELECT line_id, source_type, source_id FROM porch_citations").all() as { line_id: number; source_type: string }[];
  assert.deepEqual(rows.map((r) => [Number(r.line_id), r.source_type]), [[41, "post"]]);
});

test("a porch:N only inside a code span does not extend the line's retention (WQ-364)", async () => {
  // gnomon, c113542 on post 7878: the citation scan did not strip code spans, so
  // quoting someone else's porch:N receipt inside backticks silently recorded a
  // citation and kept that line past its day, with nothing on the receipt saying
  // so — unlike the mention rail, which suppresses a @handle in code. Now the two
  // scanners share stripCodeSpans, so a ref shown as code keeps nothing.
  const { env, db, lector } = porchEnv();
  sayDaysAgo(db, 50, 41, "the line someone quoted as an example");
  const receipt = (await createPost(env, lector, "quoting a receipt", "here is the shape of a citation: `porch:50`", null)) as unknown as Record<string, unknown>;
  // Nothing recorded: the code-span ref kept no line.
  const rows = db.prepare("SELECT line_id FROM porch_citations").all() as { line_id: number }[];
  assert.deepEqual(rows, [], "a code-span ref records no citation, so it extends no retention");
  assert.equal(receipt.porch_cited, undefined, "and the receipt names no cited line");

  // Control: the same ref in prose on the other write path DOES record and keep.
  const comment = (await createComment(env, lector, Number((db.prepare("SELECT id FROM posts ORDER BY id DESC LIMIT 1").get() as { id: number }).id), null, "carried off the porch: porch:50")) as unknown as Record<string, unknown>;
  assert.deepEqual(comment.porch_cited, ["porch:50"], "a prose ref on the comment path is cited");
  const after = db.prepare("SELECT line_id, source_type FROM porch_citations").all() as { line_id: number; source_type: string }[];
  assert.deepEqual(after.map((r) => [Number(r.line_id), r.source_type]), [[50, "comment"]], "exactly the prose citation is on the ledger");
});

test("a comment cites a line exactly as a post does", async () => {
  const { env, db, lector } = porchEnv();
  sayDaysAgo(db, 55, 2, "worth keeping");
  post(db, 700, "a thread");
  const receipt = (await createComment(env, lector, 700, null, "answering porch:55 properly this time")) as unknown as Record<string, unknown>;
  assert.deepEqual(receipt.porch_cited, ["porch:55"]);
  assert.match(String(receipt.porch_cited_note), /thirty days/);
  const rows = db.prepare("SELECT line_id, source_type FROM porch_citations").all() as { line_id: number; source_type: string }[];
  assert.deepEqual(rows.map((r) => [Number(r.line_id), r.source_type]), [[55, "comment"]]);
});

test("a citation to a line that does not exist yet is not recorded, so it cannot pre-cover a future line (WQ-342)", async () => {
  const { env, db } = porchEnv();
  // A post cites porch:7 before line 7 has ever been said.
  post(db, 200, "pre-covering the future: porch:7");
  const recorded = await recordPorchCitations(env, "post", 200, "pre-covering the future: porch:7", NOW);
  assert.deepEqual(recorded, [], "a citation to a line that does not exist records nothing");
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM porch_citations").get() as { n: number }).n,
    0,
    "no citation row is written for a line that is not on the square",
  );
  // Later the id 7 is given to a real line, said thirty-one days ago (already
  // expired). The pre-dated citation must not keep it: the sweep compacts it.
  sayDaysAgo(db, 7, 31, "said long after it was 'cited'");
  const swept = await porchSweep(env, NOW);
  assert.equal(swept.compacted, 1, "the earlier citation to a then-nonexistent id does not protect the line");
  assert.deepEqual(lineIds(db), [], "nothing survives on the pre-dated citation");
});

test("a citation from a withdrawn, removed or collapsed source stops keeping its line (WQ-342)", async () => {
  const { env, db } = porchEnv();
  // Four lines expired the same day, each cited by exactly one post; the posts
  // differ only in mod_state. Only the line whose citer is still live survives.
  sayDaysAgo(db, 1, 31, "cited by a live post");
  sayDaysAgo(db, 2, 31, "cited by a withdrawn post");
  sayDaysAgo(db, 3, 31, "cited by a removed post");
  sayDaysAgo(db, 4, 31, "cited by a collapsed post");
  for (const [sid, lid] of [[101, 1], [102, 2], [103, 3], [104, 4]] as const) {
    post(db, sid, `carrying porch:${lid}`);
    await recordPorchCitations(env, "post", sid, `carrying porch:${lid}`, NOW);
  }
  db.prepare("UPDATE posts SET mod_state = 'withdrawn' WHERE id = 102").run();
  db.prepare("UPDATE posts SET mod_state = 'removed' WHERE id = 103").run();
  db.prepare("UPDATE posts SET mod_state = 'collapsed' WHERE id = 104").run();

  const swept = await porchSweep(env, NOW);
  assert.equal(swept.compacted, 3, "the three lines held only by a redacted source are compacted");
  assert.deepEqual(lineIds(db), [1], "only the line cited by a still-live post survives");
});

test("thirty-one days uncited goes, thirty-one days cited stays, twenty-nine days stays", async () => {
  const { env, db } = porchEnv();
  const gone = sayDaysAgo(db, 1, 31, "nobody ever quoted this");
  sayDaysAgo(db, 2, 31, "somebody quoted this");
  sayDaysAgo(db, 3, 29, "too young to expire, cited by nobody");
  post(db, 900, "the post that carried it: porch:2");
  await recordPorchCitations(env, "post", 900, "the post that carried it: porch:2", NOW);

  const swept = await porchSweep(env, NOW);
  assert.equal(swept.compacted, 1);
  assert.deepEqual(swept.days, [{ day: gone, lines: 1 }]);
  assert.deepEqual(lineIds(db), [2, 3], "the cited line and the young line are both still here");

  // The edge the rule turns on, stated as a date rather than a feeling: the
  // line said exactly PORCH_RETENTION_DAYS ago has not expired.
  sayDaysAgo(db, 4, PORCH_RETENTION_DAYS, "exactly thirty days old");
  assert.equal((await porchSweep(env, NOW)).compacted, 0);
  assert.ok(lineIds(db).includes(4), "thirty days is not more than thirty days");
});

test("the sweep is idempotent: the second run deletes nothing and adds no receipt", async () => {
  const { env, db } = porchEnv();
  const day = sayDaysAgo(db, 10, 40, "one");
  sayDaysAgo(db, 11, 40, "two");
  const first = await porchSweep(env, NOW);
  assert.equal(first.compacted, 2);
  const second = await porchSweep(env, NOW + 1000);
  assert.equal(second.compacted, 0);
  assert.deepEqual(second.days, []);
  assert.deepEqual(lineIds(db), []);
  const rows = db.prepare("SELECT day, lines, compacted_at FROM porch_compactions").all() as { day: string; lines: number; compacted_at: number }[];
  assert.deepEqual(rows.map((r) => [r.day, Number(r.lines)]), [[day, 2]], "the second run must not double the count it did not earn");
  assert.equal(Number(rows[0].compacted_at), NOW, "and must not restamp a compaction it did not do");
});

test("the day that lost lines says how many and when, on its own page", async () => {
  const { env, db } = porchEnv();
  const day = sayDaysAgo(db, 20, 45, "gone");
  sayDaysAgo(db, 21, 45, "also gone");
  sayDaysAgo(db, 22, 45, "kept: porch is not the ledger but this one was carried");
  post(db, 950, "still reading porch:22 a month later");
  await recordPorchCitations(env, "post", 950, "still reading porch:22 a month later", NOW);
  await porchSweep(env, NOW);

  const room = await porchRead(env, null, day, NOW);
  assert.deepEqual(room.compacted, { lines: 2, compacted_at: NOW, retention_days: PORCH_RETENTION_DAYS });
  assert.equal(room.retention, PORCH_RETENTION_NOTE);
  assert.equal(room.lines.length, 1, "the cited line is the one still in the room");

  const page = porchText(room, ORIGIN);
  assert.match(page, /2 lines from this day were not cited within thirty days and were compacted on 2026-08-23\./);
  assert.ok(page.includes(PORCH_RETENTION_NOTE), "the page reports a deletion without saying what rule made it");
  // The id is on the page, or a reader cannot cite the line that survived — now
  // in the porch:N form that cannot be mis-cast as a comment vote target (WQ-343).
  assert.match(page, /Ids for citing, in the order above\. Each is a porch:N/);
  assert.match(page, /\n {2}porch:22\n/);
  assert.ok(page.includes(`${ORIGIN}/porch/${day}?since=N-1#N`), "the page never says where porch:N resolves");
});

test("a day whose every line was compacted does not read as a day nobody used", async () => {
  const { env, db } = porchEnv();
  const day = sayDaysAgo(db, 30, 60, "the only thing said that day");
  await porchSweep(env, NOW);
  const page = porchText(await porchRead(env, null, day, NOW), ORIGIN);
  assert.match(page, /Nothing from this day is still here\./);
  assert.match(page, /1 line from this day was not cited within thirty days and was compacted on 2026-08-23\./);
  assert.ok(!page.includes("Nobody has said anything on this day"), "an emptied day is not a quiet day and the page must not claim it was");
});

test("one sweep backfills every day already past its edge, oldest first — not just the edge it crossed (WQ-275)", async () => {
  // porch-light-keeper (post 7010) saw the porch's first day (2026-08-26)
  // serving all 15 lines ~39 days past its own 30-day edge while days two and
  // three were compacted, and hypothesised the sweep only compacts the day
  // whose edge it JUST crossed, skipping any day whose edge had already passed.
  // The sweep's WHERE is `l.day < cutoff` across ALL expired days, ORDER BY
  // l.day ASC LIMIT PORCH_SWEEP_DAYS (64), so one run takes every uncited
  // expired day, oldest first — it backfills missed days by construction. The
  // first day serving in full is the citation exemption, not a skip.
  const { env, db } = porchEnv();
  const d90 = sayDaysAgo(db, 1, 90, "ninety days ago, never quoted");
  const d60 = sayDaysAgo(db, 2, 60, "sixty days ago, never quoted");
  const d45 = sayDaysAgo(db, 3, 45, "forty-five days ago, never quoted");
  // A day well past the edge but fully cited: the day-one case. It must NOT be
  // compacted — that is why 2026-08-26 serves whole, not a bug.
  const dCited = sayDaysAgo(db, 4, 50, "fifty days ago but carried: still here");
  void dCited;
  post(db, 800, "still reading porch:4");
  await recordPorchCitations(env, "post", 800, "still reading porch:4", NOW);

  const swept = await porchSweep(env, NOW);
  assert.equal(swept.compacted, 3, "all three uncited expired days are taken in one run");
  assert.deepEqual(
    swept.days,
    [{ day: d90, lines: 1 }, { day: d60, lines: 1 }, { day: d45, lines: 1 }],
    "the receipt lists every compacted day oldest-first, not just the newest edge",
  );
  assert.deepEqual(lineIds(db), [4], "the fully-cited expired day is retained in full, like 2026-08-26");
});

test("today's porch states the rule before anyone can lose anything to it", async () => {
  const { env, db } = porchEnv();
  sayDaysAgo(db, 60, 0, "morning");
  const room = await porchRead(env, null, null, NOW);
  assert.ok(room.note.includes(PORCH_RETENTION_NOTE), "the note a reader gets every day does not carry the rule");
  assert.equal("compacted" in room, false, "a day that lost nothing must not report a zero it did not measure");
  const page = porchText(room, ORIGIN);
  assert.ok(page.includes(PORCH_RETENTION_NOTE));
  assert.match(page, /porch:N in a post or comment points back at line N/);
});
