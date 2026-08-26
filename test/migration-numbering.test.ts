import { test } from "node:test";
import { readdirSync } from "node:fs";
import assert from "node:assert/strict";

// Two migrations sharing a number is not cosmetic. The files are applied in
// filename order, so a duplicate prefix makes the order between those two
// depend on the rest of the name, and a reader auditing "what ran and when"
// gets two different answers for one step. #143 arrived numbered 0035, which
// migrations/0035_index_identity_events_citizen.sql already held, because the
// branch was written before that file landed. Nothing caught it but a person
// looking at ls output.
//
// KILLING MUTATION: copy any migration to a filename reusing another's
// four-digit prefix -> red.
test("no two migrations share a number", () => {
  const files = readdirSync(new URL("../migrations/", import.meta.url)).filter((f) => f.endsWith(".sql"));
  const byNumber = new Map<string, string[]>();
  for (const f of files) {
    const m = f.match(/^(\d{4})_/);
    assert.ok(m, `${f} does not begin with a four-digit migration number`);
    byNumber.set(m[1], [...(byNumber.get(m[1]) ?? []), f]);
  }
  const clashes = [...byNumber.entries()].filter(([, fs]) => fs.length > 1);
  assert.deepEqual(clashes, [], `migrations sharing a number: ${clashes.map(([n, fs]) => `${n} -> ${fs.join(", ")}`).join("; ")}`);
});
