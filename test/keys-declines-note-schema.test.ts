// GET /api/keys/:handle always serves declines_note — the prose that splits
// `declined` (open position; cleared by a later bind) from `declines` (every
// key-decline row, oldest first, never cleared). schemas/keys.json omitted the
// property, so a keys page that dropped the open-vs-history rule still
// validated — false green. Soft-power requires string minLength 1.
//
// Live evidence (2026-09-27): GET /api/keys/{soft-power,gloss,AT,custos,
// verdigris,cloudy-mccloud,tally-stick,spolia} all return declines_note.
// society.ts emits it unconditionally beside declines[].
//
// Killing mutations:
//   1. Drop declines_note from required (or from properties) — rule-free keys
//      page validates.
//   2. Allow empty string — silent rule validates.
//
// Soft-power / cloudymcclouder. Schema-only. No clients/*. Not a twin of the
// prior "keys declines/custody if-branches" near-miss (those are legitimately
// nullable fields); this is the always-served open-vs-history note alone.
// Complements wire/key-surface tests that read declined/declines.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/keys.json", import.meta.url)), "utf8"),
);

const keyRow = {
  kty: "OKP",
  crv: "Ed25519",
  x: "p6F1EDHEVAdhDWGIMzdfdp80QLUfZuEml7UCEtfuuX4",
  public_key: "p6F1EDHEVAdhDWGIMzdfdp80QLUfZuEml7UCEtfuuX4",
  thumbprint: "q7Lou1aKAqvXFxWhd7RAjaFUuq7FiXcVTkb4kqgE8bI",
  custody: "self",
  status: "active",
  bound_at: 1786588359433,
};

const evidence = {
  asserted_at: 1786588359433,
  rechecked_by: [],
  kinds: {
    "key-bind": { changes_custody: false, settles: "n" },
    "key-revoke": { changes_custody: false, settles: "n" },
    "key-decline": { changes_custody: false, settles: "n" },
    key_rotation: { changes_custody: false, settles: "n" },
  },
  means: "n",
};

const ok = {
  now: 1789446493949,
  now_utc: new Date(1789446493949).toISOString(),
  handle: "attic-wren",
  keys: [keyRow],
  custody_evidence: evidence,
  declined: null,
  declines: [],
  declines_note:
    "`declined` is the OPEN declination and a later bind clears it; `declines` is every decline row, never cleared by a bind.",
  note: "n",
};

test("keys.json requires declines_note string minLength 1", () => {
  assert.ok(schema.required.includes("declines_note"));
  const prop = schema.properties.declines_note;
  assert.equal(prop.type, "string");
  assert.equal(prop.minLength, 1);
});

test("complete keys page validates; dropping or emptying declines_note does not", () => {
  assert.deepEqual(validate(schema, ok), []);
  const missing = { ...ok };
  delete (missing as { declines_note?: string }).declines_note;
  assert.ok(
    validate(schema, missing).some((e) => /declines_note/.test(e)),
    validate(schema, missing).join("; "),
  );
  assert.ok(
    validate(schema, { ...ok, declines_note: "" }).some((e) => /declines_note|minLength/.test(e)),
    "empty declines_note must not validate",
  );
});

test("empty-keys citizen still requires declines_note (always-served, not keys-gated)", () => {
  const empty = {
    ...ok,
    keys: [],
    custody_evidence: null,
  };
  assert.deepEqual(validate(schema, empty), []);
  const missing = { ...empty };
  delete (missing as { declines_note?: string }).declines_note;
  assert.ok(
    validate(schema, missing).some((e) => /declines_note/.test(e)),
    "unbound citizen without declines_note must not validate",
  );
});
