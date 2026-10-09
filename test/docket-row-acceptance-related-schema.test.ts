// GET /api/docket always serves on every item: content_hash (SHA-256),
// acceptance (string|null — explicit key, never omitted), and
// related_by_source (array of {id,status,has_acceptance,via}, possibly empty).
// schemas/docket.json $defs.item required the identity/status fields and listed
// content_hash optional; acceptance and related_by_source were absent from the
// published item shape entirely — so a docket page that dropped the acceptance
// key or the neighbour graph still validated. Soft-power requires all three.
// Wire already asserts the acceptance key (docket.test.ts); this pins the
// schema. related_by_source is derived/additive and outside row hashes
// (docket.ts) — still always served.
//
// Live evidence 2026-09-27: 102/102 rows carry content_hash, acceptance key,
// related_by_source array.
//
// Killing mutations:
//   1. Drop content_hash from item.required — hashless row validates.
//   2. Drop acceptance from item.required / properties — omitted key validates.
//   3. Drop related_by_source from item.required — neighbour-blind row validates.
//   4. Allow related item without via — incomplete edge validates.
//
// Soft-power / cloudymcclouder. Schema-only. No clients/*. Complements #508
// (envelope coverage blocks); this is the per-row always-served set. Not
// cloudy/gooseberry.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/docket.json", import.meta.url)), "utf8"),
);
const item = schema.$defs.item;

const HASH = "a".repeat(64);

function row(over: Record<string, unknown> = {}) {
  return {
    id: "example-row",
    lane: "fix",
    title: "a title",
    updated: "2026-09-27",
    status: "open",
    size: "small",
    source_posts: [1],
    content_hash: HASH,
    acceptance: null,
    related_by_source: [],
    ...over,
  };
}

test("docket item requires content_hash, acceptance, related_by_source", () => {
  for (const k of ["content_hash", "acceptance", "related_by_source"] as const) {
    assert.ok(item.required.includes(k), k);
    assert.ok(item.properties[k], k);
  }
  assert.deepEqual(item.properties.acceptance.type, ["string", "null"]);
  assert.equal(item.properties.related_by_source.type, "array");
  const edge = item.properties.related_by_source.items;
  for (const k of ["id", "status", "has_acceptance", "via"] as const) {
    assert.ok(edge.required.includes(k), k);
  }
});

test("complete item validates; dropping always-served fields does not", () => {
  assert.deepEqual(validate(item, row(), "$", schema), []);
  assert.deepEqual(
    validate(
      item,
      row({
        acceptance: "A".repeat(40) + " checkable sentence for the row.",
        related_by_source: [
          { id: "neighbour", status: "shipped", has_acceptance: true, via: [1] },
        ],
      }),
      "$",
      schema,
    ),
    [],
  );
  for (const k of ["content_hash", "acceptance", "related_by_source"] as const) {
    const bad = row();
    delete (bad as Record<string, unknown>)[k];
    assert.ok(
      validate(item, bad, "$", schema).some((e: string) => e.includes(k)),
      `drop ${k} must fail`,
    );
  }
  const badEdge = row({
    related_by_source: [{ id: "n", status: "open", has_acceptance: false }],
  });
  assert.ok(
    validate(item, badEdge, "$", schema).some((e: string) => /via/.test(e)),
    "related edge without via must fail",
  );
});
