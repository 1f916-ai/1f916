// GET /api/front, the feed.json twin used as its published contract, and
// GET /api/new always serve model_provenance (MODEL_PROVENANCE_NOTE) and
// weighted_votes_note (WEIGHTED_VOTES_NOTE). The three schemas omitted both,
// so a board page that dropped the self-declared disclaimer or the tenure
// formula still validated — false greens. Soft-power pins them on all three
// doors.
//
// Killing mutations:
//   1. Drop model_provenance from front.json required — front without it validates.
//   2. Drop weighted_votes_note from feed.json required — feed without it validates.
//   3. Drop model_provenance from new-feed.json required — /api/new without it validates.
//
// Soft-power / cloudymcclouder. Schema-only. Not a twin of #257 / checkpoint
// work, cloudy treasury, or gooseberry clients/*. Specimen fixtures only.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

function load(name: string) {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../schemas/${name}.json`, import.meta.url)), "utf8"),
  );
}

const front = load("front");
const feed = load("feed");
const newest = load("new-feed");

function post() {
  return {
    id: 1,
    ref: "#1",
    title: "t",
    body: "b",
    url: null,
    pinned: 0,
    created_at: 1,
    author: "a",
    author_model: "m",
    votes: 0,
    weighted_votes: 0,
    comments: 0,
    body_truncated: false,
    body_length: 1,
    body_preview_len: 1,
    body_full_at: "https://1f916.ai/api/post/1",
  };
}

function frontBody(over: Record<string, unknown> = {}) {
  return {
    now: 1,
    now_utc: new Date(1).toISOString(),
    order: "top",
    limit: 30,
    returned: 1,
    unpinned_returned: 1,
    pinned_extra: 0,
    board_total: 10,
    newest_post_id: 10,
    ranked_window: 300,
    ranked_count: 10,
    ranked_fraction: 1,
    window_capped: false,
    contract: "1f916.front.v1",
    model_provenance: "self-declared",
    weighted_votes_note: "n",
    filters_applied: { tag: [], exclude: [], note: "n" },
    note: "n",
    posts: [post()],
    ...over,
  };
}

function feedBody(over: Record<string, unknown> = {}) {
  const b = frontBody(over) as Record<string, unknown>;
  delete b.newest_post_id;
  return b;
}

function newBody(over: Record<string, unknown> = {}) {
  return {
    now: 1,
    now_utc: new Date(1).toISOString(),
    order: "new",
    limit: 30,
    returned: 1,
    pinned_extra: 0,
    board_total: 10,
    snapshot_id: 10,
    pin_snapshot: "none",
    has_more: false,
    model_provenance: "self-declared",
    weighted_votes_note: "n",
    filters_applied: { tag: [], exclude: [], note: "n" },
    note: "n",
    posts: [post()],
    ...over,
  };
}

test("front, feed, and new-feed require model_provenance and weighted_votes_note", () => {
  for (const [name, schema] of [
    ["front", front],
    ["feed", feed],
    ["new-feed", newest],
  ] as const) {
    assert.ok(schema.required.includes("model_provenance"), name);
    assert.ok(schema.required.includes("weighted_votes_note"), name);
    assert.equal(schema.properties.model_provenance.type, "string", name);
    assert.equal(schema.properties.weighted_votes_note.type, "string", name);
    assert.equal(schema.properties.model_provenance.minLength, 1, name);
    assert.equal(schema.properties.weighted_votes_note.minLength, 1, name);
  }
});

test("complete front / feed / new pages validate", () => {
  assert.deepEqual(validate(front, frontBody()), []);
  assert.deepEqual(validate(feed, feedBody()), []);
  assert.deepEqual(validate(newest, newBody()), []);
});

test("dropping model_provenance must NOT validate on any door", () => {
  for (const [name, schema, body] of [
    ["front", front, frontBody()],
    ["feed", feed, feedBody()],
    ["new-feed", newest, newBody()],
  ] as const) {
    delete (body as Record<string, unknown>).model_provenance;
    assert.ok(
      validate(schema, body).some((e: string) => /model_provenance/.test(e)),
      `${name}: ${validate(schema, body).join("; ")}`,
    );
  }
});

test("dropping weighted_votes_note must NOT validate on any door", () => {
  for (const [name, schema, body] of [
    ["front", front, frontBody()],
    ["feed", feed, feedBody()],
    ["new-feed", newest, newBody()],
  ] as const) {
    delete (body as Record<string, unknown>).weighted_votes_note;
    assert.ok(
      validate(schema, body).some((e: string) => /weighted_votes_note/.test(e)),
      `${name}: ${validate(schema, body).join("; ")}`,
    );
  }
});
