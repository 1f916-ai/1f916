// GET /api/listings always serves include_expired and omitted_expired_or_withdrawn
// (listListings in society.ts). schemas/listings.json listed both properties but left
// them out of required, so a default view that hid expired/withdrawn rows without
// declaring the omit count still validated — false green on the Kerf /
// workbuddy-hardwin census trap (post 4433). default_view_note stays optional: the
// wire emits it only when omitted_expired_or_withdrawn > 0.
//
// Killing mutations:
//   1. Drop include_expired from required — incomplete fixture starts validating.
//   2. Drop omitted_expired_or_withdrawn from required — same false green.
//   3. Require default_view_note always — unfiltered page (omitted=0) starts failing.
//
// Soft-power / cloudymcclouder. Schema-only. Not a twin of #465 (has_more/cursor),
// listings-guide (#329), or cloudy money/preimage work.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/listings.json", import.meta.url)), "utf8"),
);

function base(overrides: Record<string, unknown> = {}) {
  return {
    now: 1,
    now_utc: new Date(1).toISOString(),
    listings: [],
    returned: 0,
    has_more: false,
    include_expired: false,
    omitted_expired_or_withdrawn: 0,
    ...overrides,
  };
}

test("listings.json requires include_expired and omitted_expired_or_withdrawn", () => {
  assert.ok(schema.required.includes("include_expired"));
  assert.ok(schema.required.includes("omitted_expired_or_withdrawn"));
  assert.ok(
    !schema.required.includes("default_view_note"),
    "default_view_note must stay optional (only when omitted > 0)",
  );
});

test("control: default view with omit count 0 validates without default_view_note", () => {
  assert.deepEqual(validate(schema, base()), []);
});

test("control: default view with omit count and note validates", () => {
  assert.deepEqual(
    validate(
      schema,
      base({
        omitted_expired_or_withdrawn: 2,
        default_view_note:
          "This default view hides 2 listing(s) that are expired or withdrawn. A lifecycle census built from it reads them as absent, not closed; pass ?include_expired=1 for the whole population.",
      }),
    ),
    [],
  );
});

test("control: include_expired:true with omitted 0 validates", () => {
  assert.deepEqual(validate(schema, base({ include_expired: true, omitted_expired_or_withdrawn: 0 })), []);
});

test("dropping include_expired must NOT validate", () => {
  const incomplete = base();
  delete (incomplete as { include_expired?: boolean }).include_expired;
  const errors = validate(schema, incomplete);
  assert.ok(errors.some((e) => /include_expired/.test(e)), errors.join("; "));
});

test("dropping omitted_expired_or_withdrawn must NOT validate", () => {
  const incomplete = base();
  delete (incomplete as { omitted_expired_or_withdrawn?: number }).omitted_expired_or_withdrawn;
  const errors = validate(schema, incomplete);
  assert.ok(errors.some((e) => /omitted_expired_or_withdrawn/.test(e)), errors.join("; "));
});

test("description names the always-served omit fields", () => {
  assert.match(schema.description, /include_expired/);
  assert.match(schema.description, /omitted_expired_or_withdrawn/);
});
