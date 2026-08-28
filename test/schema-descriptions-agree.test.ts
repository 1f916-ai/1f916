// Two published schemas describing the same field must describe it the same way.
//
// schemas/events.json and schemas/events-paged.json both document the /api/events
// response. They carried DIFFERENT prose for the same field names, and one of
// those divergences was not a paraphrase but a contradiction: events.json said
// filter_is_a_declared_kind is false "when one was supplied and discarded by the
// accepted class", enumerating one of the two causes of false. Measured against
// the live service, ?kind=witness_rotate is HONOURED, the filter is applied, and
// the field is false because the name is not in the vocabulary. A reader applying
// the published description literally concludes the opposite of what happened —
// that the filter was discarded and the body is the whole log.
//
// events-paged.json described the same field with only the short, true half. So
// the two contracts disagreed about one field's semantics, and nothing noticed,
// because nothing had ever compared them.
//
// Found by the pre-deploy auditor on PR #173, not by a test.
//
// Killing mutation: change any shared field's description in one file only.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

type Json = Record<string, unknown>;

function describedFields(doc: Json): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) { for (const v of o) walk(v); return; }
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o as Json)) {
      if (k === "properties" && v && typeof v === "object" && !Array.isArray(v)) {
        for (const [name, spec] of Object.entries(v as Json)) {
          if (spec && typeof spec === "object" && typeof (spec as Json).description === "string") {
            if (!out.has(name)) out.set(name, (spec as Json).description as string);
          }
        }
      }
      walk(v);
    }
  };
  walk(doc);
  return out;
}

const load = (f: string) => JSON.parse(readFileSync(new URL(`../schemas/${f}`, import.meta.url), "utf8")) as Json;

test("the two /api/events schemas describe every shared field identically", () => {
  const a = describedFields(load("events.json"));
  const b = describedFields(load("events-paged.json"));
  const shared = [...a.keys()].filter((k) => b.has(k));

  // Guard the guard: if the walker stops finding fields, this must fail rather
  // than pass over an empty set.
  assert.ok(shared.length >= 8, `expected the two schemas to share described fields, found ${shared.length}`);

  const disagree = shared.filter((k) => a.get(k) !== b.get(k));
  assert.deepEqual(
    disagree,
    [],
    `these fields are described differently in the two published schemas, which is how one of them came to contradict the other: ${disagree.join(", ")}`,
  );
});

// The specific sentence that was wrong, pinned so it cannot regress to naming
// only one cause of false.
test("filter_is_a_declared_kind names BOTH causes of false", () => {
  for (const f of ["events.json", "events-paged.json"]) {
    const d = describedFields(load(f)).get("filter_is_a_declared_kind");
    assert.ok(d, `${f} must describe filter_is_a_declared_kind`);
    assert.match(d, /two causes/i, `${f}: false has two causes and the description must say so`);
    assert.match(d, /honoured/i, `${f}: the honoured-but-undeclared cause is the one that was missing`);
  }
});
