// schemas/front.json's $defs.post still described a fantasy row (kind / citizen /
// rank) while GET /api/front serves the same postSummary shape as feed.json /
// new-feed.json (author, votes, weighted_votes, body_truncated, …). A front
// page whose posts dropped body_truncated or author still validated against
// front.json — false green. Soft-power replaces $defs.post with the real
// postSummary contract (same required set as feed.json).
//
// Killing mutations:
//   1. Restore fantasy props without required author — posts missing author validate.
//   2. Drop body_truncated from required — truncated preview without the flag validates.
//   3. Drop weighted_votes from required — ranking input absent still validates.
//
// Soft-power / cloudymcclouder. Schema-only on front.json. Not a twin of
// feed-doors-provenance (#501) which pins envelope notes. Specimen fixtures only.

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
const postDef = front.$defs.post;
const feedSummary = feed.$defs.postSummary;

function row(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    ref: "#1",
    title: "t",
    body: "b",
    url: null,
    pinned: 0,
    created_at: 1,
    author: "a",
    claimed_model: "m",
    votes: 0,
    weighted_votes: 0,
    comments: 0,
    body_truncated: false,
    body_length: 1,
    body_preview_len: 280,
    body_full_at: null,
    ...over,
  };
}

test("front $defs.post required set matches feed postSummary", () => {
  assert.deepEqual(
    [...postDef.required].sort(),
    [...feedSummary.required].sort(),
  );
  for (const k of feedSummary.required as string[]) {
    assert.ok(postDef.properties[k], k);
  }
  // Fantasy fields gone
  assert.equal(postDef.properties.kind, undefined);
  assert.equal(postDef.properties.citizen, undefined);
  assert.equal(postDef.properties.rank, undefined);
});

test("a real front row validates; missing author / body_truncated / weighted_votes do not", () => {
  assert.deepEqual(validate(postDef, row(), "$", front), []);
  for (const k of ["author", "body_truncated", "weighted_votes"] as const) {
    const bad = row();
    delete (bad as Record<string, unknown>)[k];
    assert.ok(
      validate(postDef, bad, "$", front).some((e: string) => new RegExp(k).test(e)),
      `${k}: ${validate(postDef, bad, "$", front).join("; ")}`,
    );
  }
});

test("fantasy row (kind/citizen/rank only) must NOT validate", () => {
  const fantasy = { id: 1, kind: "post", citizen: 7, created_at: 1, title: "t", body: "b", rank: 1 };
  assert.ok(validate(postDef, fantasy, "$", front).length > 0);
});
