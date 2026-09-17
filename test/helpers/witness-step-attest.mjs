// The /api/attest the witness step talks to during test/witness-step-page-bound.test.ts.
//
// One process per curl call, no socket anywhere: the step's `curl` is a shim that
// runs this file with the URL it was given, and this file answers from a SQLite
// chain the test seeded, through the SAME attest() the Worker serves (src/chain.ts
// against schema.sql via node:sqlite, the seat attest-anchor-resolved.test.ts uses).
// Nothing is mocked but the transport, so what the step sees is the served payload
// at a chain size the deployment has not reached yet — which is the whole point:
// no live response has ever carried next_from, and a loop written against an
// unobserved shape is a guess. This is where the shape is observed.
//
//   node --experimental-strip-types --experimental-sqlite witness-step-attest.mjs <db> <url>
//
// Query mapping copied from the /api/attest route in src/index.ts: from,
// identity_from, ledger_from (whole numbers), identity_expect, ledger_expect
// (64 hex or a 400, which the shim turns into curl's exit 22).
import { DatabaseSync } from "node:sqlite";
import { attest } from "../../src/chain.ts";
import { SqliteD1 } from "./sqlite-d1.ts";

const [dbPath, rawUrl] = process.argv.slice(2);
const q = new URL(rawUrl).searchParams;
const num = (k) => (q.get(k) === null ? undefined : Number(q.get(k)));
const str = (k) => {
  const v = q.get(k);
  if (v === null) return undefined;
  if (!/^[0-9a-f]{64}$/i.test(v)) {
    console.error(`400 ${k} must be a 64-char hex hash`);
    process.exit(22);
  }
  return v;
};
const d1 = new SqliteD1(new DatabaseSync(dbPath, { readOnly: true }));
const res = await attest(d1, q.get("from") === null ? 0 : Number(q.get("from")), {
  identityFrom: num("identity_from"),
  ledgerFrom: num("ledger_from"),
  identityExpect: str("identity_expect"),
  ledgerExpect: str("ledger_expect"),
});
process.stdout.write(JSON.stringify(res));
