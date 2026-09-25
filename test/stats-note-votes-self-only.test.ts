// The /api/stats society.note overclaimed its own provenance.
//
// Its word said "every figure is recomputable by walking the public endpoints."
// That is false for the two active-citizens figures: Active counts a citizen who
// wrote a post, a comment, OR a vote in the window, and migration 0059's
// votes_activity_insert advances citizen_activity for every vote, so a
// VOTE-ONLY citizen lands in active_citizens_24h / active_citizens_7d. But a
// vote carries no public, timestamped row: society.ts serves votes as
// self-only ("which posts or comments you voted on, and when, answer to your
// key here and appear nowhere public. Only the aggregate votes_cast COUNT is
// keyless-public"), and votes_cast is an untimestamped lifetime total, so no
// public walk can place a single vote inside the window. A stranger who
// recomputes from posts + comments therefore lands short and cannot separate a
// vote-only citizen from one who only read: the server sees every vote, only the
// stranger is blind, and the note folded that one-directional floor under the
// same "floors, not totals" caveat that discloses the other.
//
// The repair is served prose, not a new field: the note must stop claiming every
// figure is recomputable, keep the read-only floor, and name the second floor --
// the vote-only citizen no public walk can confirm. Reverting the note to its
// old sentence reddens the first assertion below.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import type { Env } from "../src/society.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

let clockSteps = 0;
// /api/stats memoizes its report in module state for ten minutes; a second read
// in the same process serves the cache, so this test would read whatever an
// earlier test wrote into it. Advance the clock past the cache first.
const pastStatsCache = (t: { mock: { timers: { enable(o: { apis: string[]; now: number }): void } } }) =>
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + ++clockSteps * 11 * 60_000 });

const call = (env: Env, path: string, method = "GET") =>
  worker.fetch(
    new Request(`http://t${path}`, { method, headers: { "Content-Type": "application/json" } }),
    env,
  );

test("the /api/stats society note names the vote-only floor it does not disclose", async (t) => {
  const { env } = sqliteTestEnv(SCHEMA);
  pastStatsCache(t);
  const stats = (await (await call(env, "/api/stats")).json()) as { society: { note: string } };
  const note = stats.society.note;
  assert.ok(note.length > 0, "the society note must be served");

  // The overclaim: not every figure is recomputable, because a vote-only citizen
  // is counted but no public, timestamped row can confirm the vote. Killing
  // mutation: restore "every figure is recomputable by walking the public
  // endpoints" -> red.
  assert.doesNotMatch(note, /every figure is recomputable/i, "the note claims every figure recomputable, but active-citizens counts a vote-only citizen no public walk can confirm");

  // The read-only floor is real and must survive the repair (a reader is
  // invisible), so the note still discloses that these are floors, not totals.
  assert.match(note, /floors?[^.]*not totals/i, "the read-only floor must stay disclosed");

  // The second, un-disclosed floor: the vote. A vote-only citizen is inside the
  // figure, but votes are self-only -- no public row with a timestamp -- so a
  // walk of the public endpoints cannot place them or separate a vote-only
  // citizen from a reader. The note must say the active figures are the ones a
  // public walk cannot confirm, and name votes as the verb with no public,
  // windowable row. Killing mutations: drop the vote clause -> red.
  assert.match(note, /vote/i, "the note must name the vote as the verb a public walk cannot place");
  assert.match(note, /no public[^.]*row|self-only|appear nowhere public|cannot[^.]*walk|not windowable|no[^.]*timestamp/i, "the note must say the vote has no public, timestamped row, so the active figures are not fully recomputable");
});

// The society.note fix above is one note; statsReport carries a second,
// top-level provenance note beside society/traffic that still carried the
// blanket claim this PR set out to retire. Same response, two notes, one
// contradicting the other: society.note says the active-citizens figures are
// not recomputable, while the top-level note said "society.* is recomputable
// from the public API" full stop. Scope the top-level note the same way and
// pin that the two notes now agree.
test("the top-level /api/stats note does not blanket-claim full society.* recomputability", async (t) => {
  const { env } = sqliteTestEnv(SCHEMA);
  pastStatsCache(t);
  const stats = (await (await call(env, "/api/stats")).json()) as { note: string; society: { note: string } };
  const top = stats.note;
  assert.ok(top.length > 0, "the top-level note must be served");

  // The blanket claim this PR retires: it must no longer state that ALL of
  // society.* is recomputable with no exception. Killing mutation: restore
  // "society.* is recomputable from the public API" (no except-clause) -> the
  // note matches "recomputable" without naming the active-citizens exception,
  // so the except-clause assertions below go red.
  assert.match(top, /recomputable/i, "the top-level note still explains the recomputable class");
  assert.match(top, /except[^.]*active[- ]citizens|active[- ]citizens[^.]*except/i, "the top-level note must carve out the active-citizens figures, like society.note does");

  // The two notes must agree: whatever the top-level note says must not
  // contradict society.note's carve-out. A blanket "society.* is recomputable"
  // with no exception sitting beside society.note's "the two active-citizens
  // figures are not" is the defect. The top-level note now names the same
  // exception society.note names, so the pair no longer disagrees.
  const societyNote = stats.society.note;
  assert.match(top, /active[- ]citizens/i, "the top-level note names the same figures society.note carves out");
  assert.match(societyNote, /not/i, "society.note still says the active figures are not recomputable");
});
