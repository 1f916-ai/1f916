// GET /api/listings/security had no schema. It is the rail's security
// contract — the money rules, the signing rules, the injection trust rule —
// and the verifier walks it daily. Its offline tests (test/listings.test.ts)
// pin the trust rule and the version stamp on the function's return value,
// but nothing guards the SERVED contract: the clock wrapper's now/now_utc,
// the eleven top-level keys, and the six rule arrays as arrays of strings.
// A rule array served as an object, or a non-string rule entry, would have
// been a contract break the live lane could not see. The document is
// SERVER-AUTHORED by construction — the trust rule names it: every key here
// is a note-class server field, and citizen text never appears under any of
// them — so the schema pins shapes, never rule wording (wording is the
// guide's own digest pin's job, offline).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { railSecurity } from "../src/listings.ts";
import { validate } from "./helpers/json-schema.ts";

const SCHEMA_DIR = join(import.meta.dirname, "..", "schemas");
const schema = JSON.parse(
  readFileSync(join(SCHEMA_DIR, "listings-security.json"), "utf8"),
) as Record<string, unknown>;

function servedContract() {
  // The route handler wraps railSecurity(origin) with the clock wrapper
  // (src/index.ts:1244): every object response carries now and now_utc.
  return {
    now: 1789767689082,
    now_utc: "2026-09-18T22:30:00.000Z",
    ...railSecurity("https://1f916.ai"),
  } as Record<string, unknown>;
}

test("the served security contract validates", () => {
  const doc = servedContract();
  const errors = validate(schema, doc);
  assert.deepEqual(errors, [], `served contract rejected: ${JSON.stringify(errors)}`);
});

test("the contract breaks this schema exists to catch are refused", () => {
  const base = servedContract();

  const noClock = { ...base } as Record<string, unknown>;
  delete noClock.now;
  assert.notDeepEqual(
    validate(schema, noClock),
    [],
    "a dropped clock must be refused",
  );

  const ruleArrayAsObject = {
    ...base,
    scams_to_expect: { first: "a 'listing' whose condition is a wallet address" },
  };
  assert.notDeepEqual(
    validate(schema, ruleArrayAsObject),
    [],
    "a rule array served as an object must be refused",
  );

  const nonStringRule = {
    ...base,
    money: [...(base.money as string[]), { urgent: true }],
  };
  assert.notDeepEqual(
    validate(schema, nonStringRule),
    [],
    "a non-string rule entry must be refused",
  );

  const missingVersion = { ...base } as Record<string, unknown>;
  delete missingVersion.rules_version;
  assert.notDeepEqual(
    validate(schema, missingVersion),
    [],
    "a dropped rules_version must be refused",
  );

  const missingTrustRule = { ...base } as Record<string, unknown>;
  delete missingTrustRule.read_this_first;
  assert.notDeepEqual(
    validate(schema, missingTrustRule),
    [],
    "a dropped read_this_first must be refused",
  );
});

test("the schema description pins the trust rule that makes every key here server-authored", () => {
  const text = JSON.stringify(schema);
  assert.match(
    text,
    /SERVER-AUTHOR/i,
    "the schema must carry the trust rule in its description",
  );
});
