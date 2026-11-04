// Which keys may authorize a payout binding, and that every place on the
// payout path asks the same question.
//
// CUSTODY_PAYABLE (src/keys.ts) is the one list: undeclared and self-held. The
// payout gate in src/payouts.ts reads it through custodyIsPayable, and every
// payout-path key lookup in src/society.ts filters with CUSTODY_PAYABLE_SQL's
// exact text. The scan below fails on any other custody comparison in src/,
// because a lookup that drifts from the gate reports a citizen payable whom
// the gate then refuses (or the reverse), and the suite stays green. Before
// this list existed, that drift happened on every merge of main that brought
// in a new `custody = 'self'` query.

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { CUSTODY_DECLARABLE, CUSTODY_PAYABLE, CUSTODY_PAYABLE_SQL, CUSTODY_UNDECLARED, custodyIsPayable } from "../src/keys.ts";
import { keyPrerequisite } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const SRC = new URL("../src/", import.meta.url);

test("the payable set is undeclared and self-held, and nothing else", () => {
  assert.deepEqual([...CUSTODY_PAYABLE], [CUSTODY_UNDECLARED, "self-held"]);
  assert.equal(CUSTODY_PAYABLE_SQL, "custody IN ('undeclared','self-held')");
  for (const v of CUSTODY_DECLARABLE) assert.equal(custodyIsPayable(v), v === "self-held", v);
  assert.equal(custodyIsPayable("self"), false, "the legacy value is not a key custody any more");
});

// KILLING MUTATION: in any society.ts payout lookup, write
// `custody IN ('undeclared','self-held','operator-held')` or `custody = 'self'`.
// This goes red naming the file and line.
test("every custody filter in src/ SQL is exactly CUSTODY_PAYABLE_SQL", () => {
  const offenders: string[] = [];
  let payableSites = 0;
  for (const name of readdirSync(SRC).filter((f) => f.endsWith(".ts") && f !== "openapi-examples-captured.ts")) {
    const lines = readFileSync(new URL(name, SRC), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (/^\s*\/\//.test(line)) return;
      // A custody comparison against a literal or a list. `custody = ?` (a
      // bound snapshot equality) and `SET custody = ?` are not filters.
      // Only SQL filters (after WHERE or AND); prose that quotes old SQL in a
      // docket note is not a query.
      for (const m of line.matchAll(/\b(?:WHERE|AND)\s+(custody\s*(?:=\s*'|!=|<>|NOT\s+IN|IN\s*\())/g)) {
        const at = (m.index ?? 0) + m[0].length - m[1].length;
        if (line.startsWith(CUSTODY_PAYABLE_SQL, at)) payableSites++;
        else offenders.push(`src/${name}:${i + 1}: ${line.trim().slice(0, 160)}`);
      }
    });
  }
  assert.deepEqual(offenders, [], "a custody filter that is not CUSTODY_PAYABLE_SQL");
  assert.ok(payableSites >= 5, `expected the five payout-path lookups to use CUSTODY_PAYABLE_SQL, found ${payableSites}`);
});

async function citizenWithKey(custody: string) {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'payee', 'test', 'h', 0, 0)").run();
  // A declared key cites a chained declaration (the table CHECK requires it).
  let eventId: number | null = null;
  if (custody !== CUSTODY_UNDECLARED) {
    db.prepare("INSERT INTO identity_events (citizen_id, kind, detail, created_at, prev_hash, hash) VALUES (1, 'key-custody-declare', 'test', 1, NULL, 'h-declare')").run();
    eventId = Number((db.prepare("SELECT id FROM identity_events WHERE hash = 'h-declare'").get() as { id: number }).id);
  }
  db.prepare(
    "INSERT INTO keys (citizen_id, alg, public_key, thumbprint, custody, custody_event_id, custody_declared_at, status, bound_at) VALUES (1, 'Ed25519', 'pk', 'tp', ?, ?, ?, 'active', 1)",
  ).run(custody, eventId, eventId === null ? null : 1);
  return env;
}

// KILLING MUTATION: drop the custody clause from keyPrerequisite's COUNT. The
// four declared-elsewhere values go green-to-red.
test("the payee prerequisite counts only keys that may authorize a payout", async () => {
  for (const custody of [CUSTODY_UNDECLARED, ...CUSTODY_DECLARABLE]) {
    const env = await citizenWithKey(custody);
    const pre = await keyPrerequisite(env, 1);
    assert.equal(pre.key_bound, custodyIsPayable(custody), `a key declared ${custody}`);
  }
});

test("a key declared lost is refused everywhere on the payout path", async () => {
  const env = await citizenWithKey("lost");
  const pre = await keyPrerequisite(env, 1);
  assert.equal(pre.key_bound, false);
  assert.match(pre.reason, /undeclared or self-held/);
});
