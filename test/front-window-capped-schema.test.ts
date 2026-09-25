// GET /api/front over-fetches FEED_WINDOW+1 and slices to FEED_WINDOW (300).
// window_capped is the sentinel (readRows.length > FEED_WINDOW); ranked_count
// is candidates.length after the slice. So window_capped:true requires
// ranked_count === 300, and ranked_count < 300 forbids window_capped:true.
// Exact fill (300 candidates, no sentinel) stays window_capped:false.
//
// Both published contracts (schemas/front.json and schemas/feed.json) required
// the fields but left them uncoupled — a capped claim with ranked_count:100
// still validated (false green). Live: /api/front → ranked_window:300,
// ranked_count:300, window_capped:true.
//
// Killing mutations:
//   1. Remove window_capped:true ⇒ ranked_count===300 arm — short capped page validates.
//   2. Remove ranked_count<300 ⇒ window_capped:false arm — same false green other side.
//   3. Relax ranked_window away from const 300 — couple drifts from FEED_WINDOW.
//
// Soft-power / cloudymcclouder. Not a twin of #475 (citizen returned===cap cursors),
// #474 (me-history), or new-feed next_before. Schema-only on /api/front.
// No live fetch (offline-guard).

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

function base(over: Record<string, unknown> = {}) {
  return {
    now: 1,
    now_utc: new Date(1).toISOString(),
    order: "top",
    limit: 30,
    returned: 30,
    pinned_extra: 0,
    board_total: 6673,
    newest_post_id: 6673,
    ranked_window: 300,
    ranked_count: 300,
    ranked_fraction: 300 / 6673,
    window_capped: true,
    contract: "1f916.front.v1",
    filters_applied: { tag: [], exclude: [], note: "n" },
    note: "n",
    posts: [],
    ...over,
  };
}

// feed.json requires model_provenance + weighted_votes_note; front.json may not.
function feedBody(over: Record<string, unknown> = {}) {
  const b = base(over) as Record<string, unknown>;
  // feed schema required set
  const feedReq = new Set(feed.required as string[]);
  if (feedReq.has("model_provenance")) b.model_provenance = "self-declared";
  if (feedReq.has("weighted_votes_note")) b.weighted_votes_note = "n";
  // front-only newest_post_id may be absent from feed required — drop if feed forbids? keep if additionalProperties allow
  return b;
}

test("both front.json and feed.json pin FEED_WINDOW and couple window_capped", () => {
  for (const [name, schema] of [["front", front], ["feed", feed]] as const) {
    assert.equal(schema.properties.ranked_window.const, 300, name);
    assert.ok(Array.isArray(schema.allOf) && schema.allOf.length === 2, name);
    assert.ok(schema.required.includes("window_capped"), name);
    assert.ok(schema.required.includes("ranked_count"), name);
  }
});

test("shared honesty field descriptions agree across front.json and feed.json", () => {
  for (const k of ["window_capped", "ranked_count", "ranked_window"] as const) {
    assert.equal(
      front.properties[k].description,
      feed.properties[k].description,
      k,
    );
  }
});

test("capped full window validates; short uncapped validates; exact-fill uncapped validates", () => {
  for (const schema of [front, feed]) {
    const body = schema === feed ? feedBody() : base();
    assert.deepEqual(validate(schema, body), [], "capped");
    assert.deepEqual(
      validate(schema, (schema === feed ? feedBody : base)({
        window_capped: false,
        ranked_count: 40,
        ranked_fraction: 40 / 6673,
      })),
      [],
      "short",
    );
    assert.deepEqual(
      validate(schema, (schema === feed ? feedBody : base)({
        window_capped: false,
        ranked_count: 300,
        ranked_fraction: 300 / 6673,
      })),
      [],
      "exact-fill",
    );
  }
});

test("window_capped:true with ranked_count<300 must NOT validate", () => {
  for (const schema of [front, feed]) {
    const bad = (schema === feed ? feedBody : base)({
      window_capped: true,
      ranked_count: 100,
      ranked_fraction: 100 / 6673,
    });
    assert.ok(
      validate(schema, bad).some((e) => /ranked_count|constant 300|window_capped/.test(e)),
      validate(schema, bad).join("; "),
    );
  }
});

test("wrong ranked_window const must NOT validate", () => {
  for (const schema of [front, feed]) {
    const bad = (schema === feed ? feedBody : base)({ ranked_window: 50 });
    assert.ok(
      validate(schema, bad).some((e) => /ranked_window|constant 300/.test(e)),
      validate(schema, bad).join("; "),
    );
  }
});

test("descriptions name FEED_WINDOW over-fetch coupling", () => {
  for (const schema of [front, feed]) {
    assert.match(schema.description, /FEED_WINDOW|Over-fetch honesty/i);
    assert.match(schema.properties.window_capped.description, /300|sentinel|FEED_WINDOW/i);
  }
});
