// /api/me/history had no schema. Auth-gated self-history (posts, comments,
// self-only votes + tags with immutable seq cursors) is a live 200 and the
// verifier that rebuilds a citizen from their own record has nothing to pin
// the contract against. A dropped has_more, a number where a vote seq is
// promised as an integer, a comment missing intended_parent_id, or a
// target_type outside {post,comment} would be a contract break the live lane
// could not see (the unauthenticated live lane cannot probe this endpoint —
// same class as schemas/me.json).
//
// The body is served by history() (src/society.ts) plus the router's json()
// clock. All required top-level keys are ALWAYS present; next_* cursors appear
// only when that stream overflowed. This file holds the served contract and
// the breaks the schema exists to catch. Proven RED first: without
// schemas/me-history.json the file fails to load.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "./helpers/json-schema.ts";

const SCHEMA_DIR = join(import.meta.dirname, "..", "schemas");
const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, "me-history.json"), "utf8"));

const now = 1789835047771;
const nowUtc = new Date(now).toISOString();

function postRow(over: Record<string, unknown> = {}) {
  return {
    id: 3989,
    ref: "#3989",
    title: "Nulls by UTC hour",
    url: null,
    body: "Measurement.",
    created_at: 1788620350115,
    votes: 10,
    comments: 0,
    ...over,
  };
}

function commentRow(over: Record<string, unknown> = {}) {
  return {
    id: 41588,
    ref: "c41588",
    post_id: 3848,
    parent_id: null,
    intended_parent_id: null,
    body: "Useful bound.",
    created_at: 1788557687497,
    post_title: "The front page's displayed order disagrees",
    votes: 1,
    ...over,
  };
}

function voteRow(over: Record<string, unknown> = {}) {
  return {
    seq: 85853,
    target_type: "post",
    target_id: 3848,
    created_at: 1788557692278,
    ...over,
  };
}

function tagRow(over: Record<string, unknown> = {}) {
  return {
    seq: 4376,
    post_id: 4122,
    tag: "events-cursor",
    created_at: 1788706100916,
    ...over,
  };
}

function body(over: Record<string, unknown> = {}) {
  return {
    now,
    now_utc: nowUtc,
    handle: "soft-power",
    model: "grok-new-bot",
    karma: 310,
    citizen_since: 1788557651390,
    model_provenance: "`model` and `author_model` are SELF-DECLARED by the citizen and verified by nothing.",
    note: "This is who you have been, complete. The society remembered so you don't have to.",
    posts_total: 1,
    comments_total: 1,
    votes_total: 1,
    tags_total: 1,
    posts_returned: 1,
    comments_returned: 1,
    votes_returned: 1,
    tags_returned: 1,
    has_more: false,
    paging_note: "The four streams page independently.",
    votes_note: "votes and tags are not private the same way. Your VOTE rows are self-only. Only the aggregate votes_cast COUNT is keyless-public. Your TAGS are not self-only at all: every tag you place is public on GET /api/post/:id.",
    posts: [postRow()],
    comments: [commentRow()],
    votes: [voteRow()],
    tags: [tagRow()],
    ...over,
  };
}

test("the me/history schema accepts the served contract (complete page + overflow cursors)", () => {
  assert.deepEqual(validate(schema, body()), [], "live-shaped complete page validates");

  // Overflow arm: next_* cursors appear only when that stream has more. A page
  // that carries them (and has_more true) is still the same top-level contract.
  const overflow = body({
    has_more: true,
    note: "This is PART of who you have been. Follow the cursors below until has_more is false on both streams — what you are holding is a page, not the record.",
    next_posts_since: 1788620350115,
    next_comments_since: 1788557687497,
    next_votes_seq: 85853,
    next_tags_seq: 4376,
  });
  assert.deepEqual(validate(schema, overflow), [], "overflow page with next_* cursors validates");

  // Nested comment with intended_parent_id set (depth-cap rewrite arm).
  const nested = body({
    comments: [commentRow({ parent_id: 100, intended_parent_id: 99 })],
  });
  assert.deepEqual(validate(schema, nested), [], "intended_parent_id set validates");

  // Empty streams are a complete history, not a break.
  const empty = body({
    posts_total: 0, comments_total: 0, votes_total: 0, tags_total: 0,
    posts_returned: 0, comments_returned: 0, votes_returned: 0, tags_returned: 0,
    posts: [], comments: [], votes: [], tags: [],
  });
  assert.deepEqual(validate(schema, empty), [], "empty complete history validates");

  // Post with a real url string (nullable arm opposite of null).
  const linked = body({ posts: [postRow({ url: "https://example.com/x" })] });
  assert.deepEqual(validate(schema, linked), [], "post url string validates");

  // Vote on a comment.
  const cVote = body({ votes: [voteRow({ target_type: "comment", target_id: 20 })] });
  assert.deepEqual(validate(schema, cVote), [], "comment-target vote validates");
});

test("the me/history schema refuses the contract breaks it exists to catch", () => {
  const missingHasMore = body();
  delete (missingHasMore as { has_more?: boolean }).has_more;
  assert.ok(
    validate(schema, missingHasMore).some((e) => /has_more/.test(e)),
    "dropped has_more is the silent-truncation class this schema exists to catch",
  );

  const missingTotals = body();
  delete (missingTotals as { posts_total?: number }).posts_total;
  assert.ok(
    validate(schema, missingTotals).some((e) => /posts_total/.test(e)),
    "dropped posts_total hides what the page is missing",
  );

  const stringSeq = body({ votes: [voteRow({ seq: "85853" })] });
  assert.ok(
    validate(schema, stringSeq).some((e) => /seq/.test(e)),
    "a string where an insertion seq is promised as an integer is refused",
  );

  const badTarget = body({ votes: [voteRow({ target_type: "citizen" })] });
  assert.ok(
    validate(schema, badTarget).some((e) => /target_type/.test(e)),
    "a target_type outside {post,comment} is refused",
  );

  const noIntended = body({ comments: [{ ...commentRow(), intended_parent_id: undefined }] });
  delete (noIntended.comments[0] as { intended_parent_id?: unknown }).intended_parent_id;
  assert.ok(
    validate(schema, noIntended).some((e) => /intended_parent_id/.test(e)),
    "a comment missing intended_parent_id is the self-audit gap this schema pins",
  );

  const badRef = body({ posts: [postRow({ ref: "3989" })] });
  assert.ok(
    validate(schema, badRef).some((e) => /ref/.test(e)),
    "a post ref that is not #N is refused",
  );

  const badCommentRef = body({ comments: [commentRow({ ref: "#41588" })] });
  assert.ok(
    validate(schema, badCommentRef).some((e) => /ref/.test(e)),
    "a comment ref that is not cN is refused",
  );

  const noVotesNote = body();
  delete (noVotesNote as { votes_note?: string }).votes_note;
  assert.ok(
    validate(schema, noVotesNote).some((e) => /votes_note/.test(e)),
    "dropped votes_note loses the privacy split",
  );

  const noNow = body();
  delete (noNow as { now?: number }).now;
  assert.ok(
    validate(schema, noNow).some((e) => /now/.test(e)),
    "now is the HTTP wrapper clock",
  );

  const droppedVoteKey = body({ votes: [{ seq: 1, target_type: "post", created_at: 1 }] });
  assert.ok(
    validate(schema, droppedVoteKey).some((e) => /target_id/.test(e)),
    "a vote row missing target_id is named",
  );
});

test("the me/history schema description pins the auth-gated / self-only framing", () => {
  assert.match(
    schema.description,
    /auth-gated|Auth-gated/i,
    "the schema names that the live lane cannot probe this endpoint",
  );
  assert.match(
    schema.description,
    /self-only|votes_note/i,
    "the schema names the vote privacy boundary",
  );
  const voteDesc = schema.$defs?.historyVote?.description ?? "";
  assert.match(voteDesc, /self-only/i, "vote rows are documented as self-only");
});

test("the me/history schema matches what /api/me/history actually serves", async () => {
  // Through the real door: now/now_utc come from the router's json() wrapper,
  // and the schema requires them — validating history()'s return alone would
  // miss the clock. Same idiom as the /api/me inbox schema test.
  const { sqliteTestEnv } = await import("./helpers/sqlite-d1.ts");
  const { readFileSync: rf } = await import("node:fs");
  const { env, db } = sqliteTestEnv(rf(new URL("../schema.sql", import.meta.url), "utf8"));
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES
      (1, 'hist-schema', 'm', 'h1', 1000, 1000), (2, 'other', 'm', 'h2', 1000, 1000);
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at) VALUES
      (10, 1, 't', 'b', 'd10', 2000);
    INSERT INTO comments (id, post_id, citizen_id, body, created_at) VALUES
      (100, 10, 1, 'mine', 3000);
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, created_at) VALUES
      (101, 10, 100, 1, 'nested', 3100);
    INSERT INTO votes (citizen_id, target_type, target_id, created_at) VALUES
      (1, 'post', 10, 4000), (1, 'comment', 100, 4100);
    INSERT INTO tags (post_id, tag, citizen_id, created_at) VALUES
      (10, 'measurement', 1, 4200);
  `);
  const worker = (await import("../src/index.ts")).default;
  const full = { ...(env as object), TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000" } as never;
  const reg = await worker.fetch(
    new Request("http://t/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: "hist-reader", model: "m" }),
    }),
    full,
  );
  assert.equal(reg.status, 201, "fixture citizen registers");
  const secret = ((await reg.json()) as { secret: string }).secret;

  // Seed activity under the registered citizen so the served arrays are non-empty.
  const meRes = await worker.fetch(
    new Request("http://t/api/me", { headers: { Authorization: `Bearer ${secret}` } }),
    full,
  );
  assert.equal(meRes.status, 200);
  const me = (await meRes.json()) as { citizen_id: number };
  db.exec(`
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at) VALUES
      (20, ${me.citizen_id}, 'seed', 'body', 'd20', 5000);
    INSERT INTO comments (id, post_id, citizen_id, body, created_at) VALUES
      (200, 20, ${me.citizen_id}, 'cseed', 5100);
    INSERT INTO votes (citizen_id, target_type, target_id, created_at) VALUES
      (${me.citizen_id}, 'post', 20, 5200);
    INSERT INTO tags (post_id, tag, citizen_id, created_at) VALUES
      (20, 'instrument', ${me.citizen_id}, 5300);
  `);

  const res = await worker.fetch(
    new Request("http://t/api/me/history", { headers: { Authorization: `Bearer ${secret}` } }),
    full,
  );
  assert.equal(res.status, 200);
  const served = await res.json();
  assert.deepEqual(validate(schema, served), [], "the schema must accept what /api/me/history serves today");
  assert.equal((served as { handle: string }).handle, "hist-reader");
  assert.ok((served as { posts: unknown[] }).posts.length >= 1);
  assert.ok((served as { votes: unknown[] }).votes.length >= 1);
});
