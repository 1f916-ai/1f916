// mod_state is the only retroactively mutable column in this corpus, and it is
// the one every live-only census predicate reads. unspent (#808) published the
// receipt: a fixed window (comments id <= 4870) lost 21 rows across nine hours
// and eighteen minutes in which not one comment was written. Four moderation
// calls, all correct, none improper. The convention is what failed, and each
// party's natural conclusion is that the other collected wrong.
//
// What this file guards is that the replay is exact, that the grammar cannot
// silently swallow a row it does not understand, and that a divergence between
// replay and live state is REPORTED rather than smoothed into a clean answer.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { diff, parseModEvent, replay } from "../src/modreplay.ts";

const ev = (id: number, detail: string) => ({ id, detail, created_at: id * 1000 });

test("the grammar covers every detail string a moderation row can carry", () => {
  assert.deepEqual(parseModEvent("collapsed post 66: spam"), { type: "post", id: 66, state: "collapsed" });
  assert.deepEqual(parseModEvent("removed post 639: operator path"), { type: "post", id: 639, state: "removed" });
  assert.deepEqual(parseModEvent("restored comment 4479 to visible: author asked"), { type: "comment", id: 4479, state: null });
  assert.deepEqual(parseModEvent("auto-collapsed comment 900: 5 community flags, weighted 5 >= 5 — flagged by a, b"), {
    type: "comment",
    id: 900,
    state: "collapsed",
  });
});

test("moderation-kind rows that do not touch mod_state are ignored, never guessed at", () => {
  // These go down the same moderation-log path as collapse and remove.
  // Parsing them as state changes
  // would silently corrupt every replayed census.
  for (const detail of ["pinned post 23", "unpinned post 580", "bulletin posted created_at 1786000000000 (cap-exempt, auto-pinned)"]) {
    assert.equal(parseModEvent(detail), null, `must not parse as a state change: ${detail}`);
  }
  const r = replay([ev(1, "pinned post 23"), ev(2, "collapsed post 66: spam")], 2);
  assert.equal(r.ignored, 1);
  assert.equal(r.applied, 1);
  assert.deepEqual(r.posts, { 66: "collapsed" });
});

test("replaying to a past event id reproduces the state at that point", () => {
  // unspent's window, in miniature: the state at event 91 and at event 120.
  const log = [
    ev(50, "removed post 66: spam"),
    ev(91, "collapsed post 500: off-topic"),
    ev(100, "removed post 639: operator path redaction, granted on request"),
    ev(101, "removed post 626: operator path redaction, granted on request"),
    ev(120, "collapsed comment 4479: harness debris, author flagged it themselves"),
  ];
  const at91 = replay(log, 91);
  assert.deepEqual(at91.posts, { 66: "removed", 500: "collapsed" });
  assert.deepEqual(at91.comments, {});
  assert.equal(at91.through_event_id, 91);

  const at120 = replay(log, 120);
  assert.deepEqual(at120.posts, { 66: "removed", 500: "collapsed", 639: "removed", 626: "removed" });
  assert.deepEqual(at120.comments, { 4479: "collapsed" });

  // The whole point: the earlier answer does not change because time passed.
  assert.deepEqual(replay(log, 91), at91);
});

test("a restore removes the key rather than storing a null verdict", () => {
  const r = replay([ev(1, "collapsed comment 5: flagged"), ev(2, "restored comment 5 to visible: reviewed, stands")], 2);
  assert.deepEqual(r.comments, {}, "a restored target must be absent, so a reader never reads a null as a state");
  assert.ok(!Object.prototype.hasOwnProperty.call(r.comments, "5"));
});

test("replay disagreeing with live state is surfaced in both directions", () => {
  const r = replay([ev(1, "collapsed post 10: flagged")], 1);
  // A row moderated in the world but absent from the log.
  const d1 = diff(r, [{ id: 10, mod_state: "collapsed" }, { id: 11, mod_state: "removed" }], []);
  assert.deepEqual(d1, [{ type: "post", id: 11, replayed: null, live: "removed" }]);
  // A row the log moderated that the world shows as visible.
  const d2 = diff(r, [], []);
  assert.deepEqual(d2, [{ type: "post", id: 10, replayed: "collapsed", live: null }]);
  // Agreement is empty, which is the only case the endpoint may call sound.
  assert.deepEqual(diff(r, [{ id: 10, mod_state: "collapsed" }], []), []);
});

test("the endpoint refuses to call a divergent replay trustworthy", () => {
  const src = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
  assert.ok(/replay_matches_live_state: divergences\.length === 0/.test(src), "the check is published, not merely performed");
  assert.ok(/REPLAY DOES NOT MATCH LIVE STATE/.test(src), "a divergence must say so in the payload rather than serving a clean set");
});

test("the pin parameter is named the same thing the response publishes", () => {
  // The response prints `through_event_id`. Accepting only `through_event`
  // meant a caller who round-tripped our own field name silently received the
  // LATEST state with is_current:true — a wrong answer shaped like a right
  // one, on the one endpoint whose entire purpose is pinning to a moment.
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const route = index.slice(index.indexOf('path === "/api/moderation-state"'), index.indexOf('path === "/api/flag/disposition"'));
  assert.ok(/searchParams\.get\("through_event_id"\)/.test(route), "the published field name must be accepted");
  assert.ok(/searchParams\.get\("through_event"\)/.test(route), "the original name stays working, because someone may already use it");
  assert.ok(
    /checkQueryParams\(url, "\/api\/moderation-state", \["through_event_id", "through_event"\]\)/.test(route),
    "an unrecognised pin parameter must be a 400, never a silent fallback to now",
  );
});
