// commitWithIdentityEvent retries only a chain prev_hash/hash collision; any
// other error is terminal after ONE attempt. Its callers' refusal strings all say
// "<log> chain head moved four times running", which was true only of the
// loop's own exit, so a missing column (2026-10-09: 0076/0077 deployed ahead of
// their migrations) answered every seal with a head race that never happened.
// The terminal path now says what kind of failure it was; the loop's exit keeps
// the caller's sentence as written.
//
// KILLING MUTATION: throw `refusal` instead of `terminalRefusal(refusal)` in the
// terminal catch -> the first test goes red; change the phrase in any caller's
// refusal so the replace no longer matches -> the third test goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import * as society from "../src/society.ts";

const { SocietyError, commitWithIdentityEvent } = society;
const terminalRefusal = (s: string): string => (society as unknown as { terminalRefusal: (s: string) => string }).terminalRefusal(s);

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const SRC = fileURLToPath(new URL("../src", import.meta.url));
const REFUSAL = "seal chain head moved four times running; refusing to record a fingerprint without its anchor";

test("a non-race error is refused once, without claiming the head moved, and commits nothing", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  const before = Number((db.prepare("SELECT COUNT(*) AS n FROM identity_events").get() as { n: number }).n);
  // A runtime error that is neither a chain collision nor UNIQUE, as a missing column is.
  const failing = env.DB.prepare("SELECT abs(-9223372036854775808)");
  await assert.rejects(
    commitWithIdentityEvent(env, failing, { citizen_id: 1, kind: "seal", detail: "x" }, REFUSAL),
    (e: unknown) => {
      assert.ok(e instanceof SocietyError);
      assert.equal(e.status, 500);
      assert.doesNotMatch(e.message, /four times running/);
      assert.match(e.message, /not a head race/);
      assert.match(e.message, /refusing to record a fingerprint without its anchor/);
      return true;
    },
  );
  const after = Number((db.prepare("SELECT COUNT(*) AS n FROM identity_events").get() as { n: number }).n);
  assert.equal(after, before, "the batch is atomic: no identity event lands");
});

test("terminalRefusal rewrites only the race clause, both refusal shapes", () => {
  assert.equal(terminalRefusal(REFUSAL), "seal chain write failed on a database error (not a head race); refusing to record a fingerprint without its anchor");
  assert.equal(
    terminalRefusal("The identity chain head moved four times running, so nothing was committed: your key was NOT rotated and the secret you are holding still works. Retry."),
    "The identity chain write failed on a database error (not a head race), so nothing was committed: your key was NOT rotated and the secret you are holding still works. Retry.",
  );
  assert.equal(terminalRefusal("something else entirely"), "something else entirely");
});

test("every 'four times running' refusal in src/ carries the exact phrase terminalRefusal replaces", () => {
  const misses: string[] = [];
  // The refusals are passed as string-literal arguments on their own line, in
  // the modules that call commitWithIdentityEvent (chain.ts's own throw and
  // journal.ts's 503 are other loops and say what they mean).
  for (const name of readdirSync(SRC).filter((f) => f.endsWith(".ts"))) {
    const text = readFileSync(join(SRC, name), "utf8");
    if (!text.includes("commitWithIdentityEvent(")) continue;
    text.split("\n").forEach((line, i) => {
      const t = line.trim();
      if (/four times running/.test(t) && /^["`]/.test(t) && !/chain head moved four times running/.test(t)) {
        misses.push(`${name}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(misses, []);
});
