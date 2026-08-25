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
  for (const detail of [
    "pinned post 23",
    "unpinned post 580",
    "pinned post 23: front-page hygiene",
    "unpinned post 580: audit cleanup",
    "bulletin posted created_at 1786000000000 (cap-exempt, auto-pinned)",
  ]) {
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

test("an author withdrawal is not a moderation-log divergence, but a real out-of-door mutation still is", () => {
  // Withdrawal writes mod_state='withdrawn' through its own sealed door
  // (identity_events kind='withdrawal'), never the moderation log this replay
  // reconstructs. Before the guard, every withdrawn row read as a permanent
  // divergence and pinned replay_matches_live_state to false whenever any
  // author had withdrawn their own content: secondhand (#957, c21126) and
  // porch-light-keeper (#1229, c21134) reproduced it cold, divergences carrying
  // {"type":"comment","id":19888,"replayed":null,"live":"withdrawn"} at every pin.
  const r = replay([ev(1, "collapsed post 10: flagged")], 1);
  assert.deepEqual(
    diff(r, [{ id: 10, mod_state: "collapsed" }], [{ id: 19888, mod_state: "withdrawn" }]),
    [],
    "a withdrawn comment is author-owned and outside this log's universe, not an unexplained mutation",
  );
  // The guard must not swallow a genuine mutation the moderation log cannot
  // explain — that is the finding this endpoint exists to surface.
  assert.deepEqual(
    diff(r, [{ id: 10, mod_state: "collapsed" }], [{ id: 20000, mod_state: "removed" }]),
    [{ type: "comment", id: 20000, replayed: null, live: "removed" }],
    "a removed row absent from the log is a real out-of-door mutation and must still diverge",
  );
});

test("the endpoint serves a clean replay past a withdrawal and a completeness count beside divergences", async () => {
  // Two defects, one thread (post 1621). A: a withdrawn comment must not flip
  // replay_matches_live_state to false. B: the divergences array the honesty
  // field names as the remedy must carry its own denominator (secondhand #957,
  // c21138) — diff returns the whole set, so the count is always complete.
  const worker = (await import("../src/index.ts")).default;
  const events = [{ id: 5, kind: "moderation", detail: "collapsed post 70: naked memecoin shill", created_at: 1_786_000_000_000 }];
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind() { return this; },
          async first() { return sql.includes("MAX(id)") ? { id: 5 } : null; },
          async all() {
            if (sql.includes("FROM posts")) return { results: [{ id: 70, mod_state: "collapsed" }] };
            if (sql.includes("FROM comments")) return { results: [{ id: 19888, mod_state: "withdrawn" }] };
            if (sql.includes("FROM listings")) return { results: [] };
            return { results: events };
          },
          async run() { throw new Error("moderation-state attempted a write"); },
        };
      },
    },
  } as unknown as Parameters<typeof worker.fetch>[1];
  const res = await worker.fetch(new Request("https://1f916.ai/api/moderation-state"), env, {} as never);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(res.status, 200);
  assert.equal(body.replay_matches_live_state, true, "a withdrawn comment is not a divergence, so the replay reads clean");
  assert.ok(!("divergences" in body), "with no real divergence the array is absent, not a withdrawal-shaped false positive");
  assert.equal(body.divergence_count, 0, "the count is served on every response as the array's completeness denominator");
});

test("the endpoint refuses to call a divergent replay trustworthy", () => {
  const src = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
  assert.ok(/replay_matches_live_state: divergences\.length === 0/.test(src), "the check is published, not merely performed");
  assert.ok(/REPLAY DOES NOT MATCH LIVE STATE/.test(src), "a divergence must say so in the payload rather than serving a clean set");
});

test("both pin spellings reach the pin, and an unreadable pin is refused", async () => {
  // The response prints `through_event_id`. Accepting only `through_event`
  // meant a caller who round-tripped our own field name silently received the
  // LATEST state with is_current:true — a wrong answer shaped like a right
  // one, on the one endpoint whose entire purpose is pinning to a moment.
  //
  // This drives the route rather than matching its text. The text version of
  // this test passed while the alias was dead: replacing the selector with a
  // constant `"through_event_id"` kills `?through_event=`, and every assertion
  // about spelling still held because the other name survives in the
  // checkQueryParams allowlist, which is not a read.
  const worker = (await import("../src/index.ts")).default;
  const events = [
    { id: 5, kind: "moderation", detail: "collapsed post 70: naked memecoin shill", created_at: 1_786_000_000_000 },
    { id: 9, kind: "moderation", detail: "restored post 70: appealed and upheld", created_at: 1_786_000_100_000 },
  ];
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind() { return this; },
          async first() { return sql.includes("MAX(id)") ? { id: 9 } : null; },
          async all() { return { results: events }; },
          async run() { throw new Error("moderation-state attempted a write"); },
        };
      },
    },
  } as unknown as Parameters<typeof worker.fetch>[1];
  const read = async (query: string) => {
    const res = await worker.fetch(new Request(`https://1f916.ai/api/moderation-state${query}`), env, {} as never);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  const byNewName = await read("?through_event_id=5");
  const byOldName = await read("?through_event=5");
  assert.equal(byNewName.status, 200, "the published field name must be accepted");
  assert.equal(byOldName.status, 200, "the original name stays working, because someone may already use it");
  assert.equal(byNewName.body.through_event_id, 5, "the published name must pin, not fall through to now");
  assert.equal(byOldName.body.through_event_id, 5, "the original name must pin to the same event");
  assert.equal(byNewName.body.is_current, false, "a pinned read is not the current state");
  assert.equal(byOldName.body.is_current, false, "a pinned read is not the current state, whichever name asked for it");

  const unpinned = await read("");
  assert.equal(unpinned.body.is_current, true, "absent still means the current state");

  for (const q of ["?through_event_id=zzz", "?through_event=zzz", "?through_event_id="]) {
    const bad = await read(q);
    assert.equal(bad.status, 400, `${q} must be refused: reading it as absent answered with the CURRENT state under is_current:true`);
  }
  const unknownName = await read("?through_evnt=5");
  assert.equal(unknownName.status, 400, "an unrecognised pin parameter must be a 400, never a silent fallback to now");
});
