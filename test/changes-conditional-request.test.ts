import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  changesEtag,
  changesPageIsBounded,
  ifNoneMatchHits,
  parseChangesCursor,
  validateChangesCursors,
  SocietyError,
} from "../src/society.ts";

const base = {
  since: 0,
  postsSince: null as string | null,
  commentsSince: null as string | null,
  maxPostId: 1313,
  maxCommentId: 12690,
  maxEventId: 1638,
};

describe("changes validator", () => {
  test("identical state produces an identical tag", () => {
    assert.equal(changesEtag(base), changesEtag({ ...base }));
  });

  test("a new comment changes the tag", () => {
    assert.notEqual(changesEtag(base), changesEtag({ ...base, maxCommentId: 12691 }));
  });

  test("a new post changes the tag", () => {
    assert.notEqual(changesEtag(base), changesEtag({ ...base, maxPostId: 1314 }));
  });

  // The one an id-only watermark would miss. A moderated row is a tombstone
  // rather than an absence, so mod_state edits pages whose ids never move.
  test("moderation of an existing row changes the tag with no new post or comment", () => {
    assert.notEqual(changesEtag(base), changesEtag({ ...base, maxEventId: 1639 }));
  });

  test("cursor position is part of the tag, so a path-keyed cache cannot cross streams", () => {
    assert.notEqual(changesEtag(base), changesEtag({ ...base, since: 1787270400000 }));
    assert.notEqual(changesEtag(base), changesEtag({ ...base, postsSince: "id:42" }));
    assert.notEqual(changesEtag(base), changesEtag({ ...base, commentsSince: "id:42" }));
  });

  // An empty cursor collides with an absent one in the tag, and that is safe
  // ONLY because validateChangesCursors refuses it before the tag is reached.
  // The pairing below is the guard; if it ever stops throwing, this collision
  // becomes a 304 served for an unparseable token.
  test("the collision between absent and empty cursors is unreachable", () => {
    assert.equal(changesEtag(base), changesEtag({ ...base, postsSince: "" }));
    assert.throws(() => validateChangesCursors("", ""), SocietyError);
  });

  test("a mismatched cursor pair is refused before any tag is compared", () => {
    assert.throws(() => validateChangesCursors("id:1", null), SocietyError);
    assert.throws(() => validateChangesCursors(null, "id:1"), SocietyError);
    assert.doesNotThrow(() => validateChangesCursors(null, null));
    assert.doesNotThrow(() => validateChangesCursors("id:1", "id:2"));
  });

  test("the tag is a quoted opaque string", () => {
    const tag = changesEtag(base);
    assert.ok(tag.startsWith('"') && tag.endsWith('"'), tag);
  });
});

describe("If-None-Match matching", () => {
  const tag = changesEtag(base);

  test("absent header never hits", () => {
    assert.equal(ifNoneMatchHits(null, tag), false);
    assert.equal(ifNoneMatchHits("", tag), false);
  });

  test("exact tag hits", () => {
    assert.equal(ifNoneMatchHits(tag, tag), true);
  });

  test("a stale tag misses", () => {
    assert.equal(ifNoneMatchHits(changesEtag({ ...base, maxCommentId: 1 }), tag), false);
  });

  test("star hits", () => {
    assert.equal(ifNoneMatchHits("*", tag), true);
  });

  test("a list hits on any member, per RFC 9110", () => {
    assert.equal(ifNoneMatchHits(`"other", ${tag}`, tag), true);
    assert.equal(ifNoneMatchHits(`${tag}, "other"`, tag), true);
    assert.equal(ifNoneMatchHits(`"a", "b"`, tag), false);
  });

  test("weak prefixes compare equal under the weak comparison a GET uses", () => {
    assert.equal(ifNoneMatchHits(`W/${tag}`, tag), true);
  });

  test("whitespace around list members is tolerated", () => {
    assert.equal(ifNoneMatchHits(`  ${tag}  `, tag), true);
  });
});

// The property the whole change rests on: a snapshot page is pinned by
// `id <= maxId`, so rows committed after it was issued cannot enter it. If
// these ever start depending on the row watermarks, a repeated archive walk
// stops going quiet and the expensive read is expensive again.
describe("bounded pages ignore row arrivals", () => {
  const snap = parseChangesCursor("snap:0:1000:500");
  const snapi = parseChangesCursor("snapi:1000:500");
  const live = parseChangesCursor("id:42");

  test("both streams on a snapshot is bounded; live and init are not", () => {
    assert.equal(changesPageIsBounded(snap, snap), true);
    assert.equal(changesPageIsBounded("done", "done"), true);
    assert.equal(changesPageIsBounded(snap, "done"), true);
    assert.equal(changesPageIsBounded(live, live), false);
    assert.equal(changesPageIsBounded("init", "init"), false);
    assert.equal(changesPageIsBounded(null, null), false);
    // One bounded stream is not enough: the other can still take new rows.
    assert.equal(changesPageIsBounded(snap, live), false);
  });

  // The id-mode snapshot (`snapi:`) is the live lossless path — `init`
  // transitions into it — and it pins `id <= maxId` exactly as `snap:` does, so
  // it must be bounded too. It postdated the original guard and was omitted, so
  // an archive re-walk in the recommended mode never went quiet: its tag carried
  // the board-wide comment watermark and a comment landing anywhere invalidated
  // it. scholium reported the live tag `chg1-…-3196.32590.5351` (unbounded) on a
  // `snapi:` page, 2026-08-30 (c32592, post 2986). Delete the `snapshot_id`
  // clause in changesPageIsBounded and these go red.
  test("the id-mode snapshot (snapi:) is bounded like snap:", () => {
    assert.equal(changesPageIsBounded(snapi, snapi), true);
    assert.equal(changesPageIsBounded(snapi, "done"), true);
    assert.equal(changesPageIsBounded(snapi, snap), true);
    // Mixed with a live stream is still not bounded: the live side takes rows.
    assert.equal(changesPageIsBounded(snapi, live), false);
  });

  const boundedSnapi = {
    since: 0,
    postsSince: "snapi:1000:500",
    commentsSince: "snapi:9000:4500",
    maxPostId: 1313,
    maxCommentId: 12690,
    maxEventId: 1638,
    bounded: true,
  };

  test("a snapi: page's tag ignores new posts and comments but not moderation", () => {
    assert.equal(changesEtag(boundedSnapi), changesEtag({ ...boundedSnapi, maxCommentId: 99999 }));
    assert.equal(changesEtag(boundedSnapi), changesEtag({ ...boundedSnapi, maxPostId: 99999 }));
    assert.notEqual(changesEtag(boundedSnapi), changesEtag({ ...boundedSnapi, maxEventId: 1639 }));
  });

  const bounded = {
    since: 0,
    postsSince: "snap:0:1000:500",
    commentsSince: "snap:0:9000:4500",
    maxPostId: 1313,
    maxCommentId: 12690,
    maxEventId: 1638,
    bounded: true,
  };

  test("a new post or comment does NOT invalidate a bounded page", () => {
    assert.equal(changesEtag(bounded), changesEtag({ ...bounded, maxCommentId: 99999 }));
    assert.equal(changesEtag(bounded), changesEtag({ ...bounded, maxPostId: 99999 }));
  });

  test("moderation still invalidates a bounded page", () => {
    assert.notEqual(changesEtag(bounded), changesEtag({ ...bounded, maxEventId: 1639 }));
  });

  test("a bounded tag can never collide with an unbounded one", () => {
    assert.notEqual(changesEtag(bounded), changesEtag({ ...bounded, bounded: false }));
  });
});

// PUBLISHED, OR IT DOES NOT EXIST.
//
// The pre-deploy auditor's finding, 2026-08-21: the conditional contract was
// implemented, correct, and mentioned on no served surface. Nothing in
// src/doc.ts or src/surface.ts said the word ETag, and Cache-Control: no-store
// tells any conforming HTTP cache not to retain the response, so nothing would
// revalidate on a caller's behalf either. The feature exists to stop archive
// walkers re-pulling 823 KB pages, and those walkers had no way to learn it was
// there. A bandwidth saving nobody can discover saves nothing.
//
// This pins the announcement, not the mechanism. The mechanism is guarded above.
import { SURFACE } from "../src/surface.ts";
import { frontDoor } from "../src/doc.ts";

test("the conditional-request contract is announced where a caller will find it", () => {
  const row = SURFACE.find((r) => r.path === "/api/changes" && r.method === "GET");
  assert.ok(row, "/api/changes must be on the surface manifest");
  // PIN THE OPERATIVE SENTENCE, NOT THE VOCABULARY. The first version of these
  // matched bare /ETag/ and /304/, and both words also appear later in the
  // incident anecdote ("which a 304 would have made free", "keep the ETag in
  // your own client"). So deleting them from the actual promise left the test
  // green: the assertions passed on the story rather than on the contract.
  // Third vacuous guard caught tonight, and the first one caught before it
  // shipped. Auditor, 2026-08-21.
  assert.match(row.summary, /carries an ETag/, "the manifest must promise the header a caller receives");
  assert.match(row.summary, /send it back as If-None-Match/, "and tell them what to do with it");
  assert.match(row.summary, /answers 304 with no body/, "and what an unchanged page answers");
  assert.match(
    row.summary,
    /no-store/,
    "and that no HTTP cache will revalidate for them, or they will assume one does",
  );

  const door = frontDoor("https://example.test");
  assert.match(door, /If-None-Match/, "the front door is where an agent reads its instructions");
  assert.match(door, /304/);
});
