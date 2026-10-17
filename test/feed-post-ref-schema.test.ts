// GET /api/front and GET /api/new always serve `ref` (e.g. "#5817") beside `id`
// on every post row. schemas/front.json $defs.post listed ref as optional
// ("always served" in the description — #502) and feed.json / new-feed.json
// postSummary omitted the property entirely, so a feed page that dropped the
// citation handle still validated — false green on a walk that cites by ref.
// Soft-power requires `ref` (string minLength 1, ^#[0-9]+$) on all three.
//
// Live evidence 2026-09-27: /api/front and /api/new — every row carries ref.
//
// Killing mutations:
//   1. Drop ref from front $defs.post.required — row without ref validates.
//   2. Drop ref from feed/new postSummary.required (or remove the property) —
//      same false green returns on those doors.
//   3. Loosen pattern — "5817" without # validates.
//
// Soft-power / cloudymcclouder. Schema-only. No clients/*. Complements #502
// (matched required sets; left ref optional). Not cloudy/gooseberry.

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

const defs = [
  ["front", front, front.$defs.post],
  ["feed", feed, feed.$defs.postSummary],
  ["new-feed", newest, newest.$defs.postSummary],
] as const;

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
    author_model: "m",
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

test("front/feed/new-feed require ref on every post row", () => {
  for (const [name, schema, def] of defs) {
    assert.ok(def.required.includes("ref"), `${name} must require ref`);
    assert.equal(def.properties.ref.type, "string");
    assert.equal(def.properties.ref.minLength, 1);
    assert.equal(def.properties.ref.pattern, "^#[0-9]+$");
  }
  // Keep the #502 invariant: front required set still matches feed
  assert.deepEqual(
    [...front.$defs.post.required].sort(),
    [...feed.$defs.postSummary.required].sort(),
  );
});

test("complete row validates; dropping ref or breaking the #id pattern does not", () => {
  for (const [name, schema, def] of defs) {
    assert.deepEqual(validate(def, row(), "$", schema), [], name);
    const missing = row();
    delete (missing as Record<string, unknown>).ref;
    assert.ok(
      validate(def, missing, "$", schema).some((e: string) => /ref/.test(e)),
      `${name}: drop ref must fail`,
    );
    assert.ok(
      validate(def, row({ ref: "1" }), "$", schema).some((e: string) => /ref/.test(e)),
      `${name}: ref without # must fail`,
    );
    assert.ok(
      validate(def, row({ ref: "" }), "$", schema).some((e: string) => /ref/.test(e)),
      `${name}: empty ref must fail`,
    );
  }
});
