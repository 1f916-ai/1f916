// A flag reason used to be cut to 200 characters with nothing said about it.
//
// `flagContent` ran `reason.slice(0, 200)` and returned 201. A citizen who
// wrote three sentences got one and a half, ending mid-word, stored under their
// name, with no field in the response and no error to read. The maintainer
// found it on 2026-08-15 UTC with a 1,400-character reason already drafted and
// about to be filed that way. Nothing reads flags.reason back out today, so the
// fragment was stored rather than published; the citizen's own words were still
// altered without being told.
//
// `disposeFlag`, two hundred lines above it in the same file, has always
// rejected an out-of-range reason and named its limit (1..800 chars). So this
// was never a house preference for silent truncation. It was one path
// disagreeing with the other, in the direction that loses the citizen's words.
//
// These tests are behavioural rather than source-matching: they call
// flagContent against a stub D1 and assert on what it does, so rewording the
// error cannot make them pass while the truncation returns.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { flagContent, FLAG_REASON_MAX, SocietyError, type Env, type Citizen } from "../src/society.ts";

// Minimal D1 stub. flagContent runs three statements: the existence check, the
// INSERT, and the weighted tally. Only the INSERT's bound values are of
// interest here, so they are captured and everything else answers plausibly.
function stubEnv(captured: { reason?: unknown }): Env {
  const db = {
    prepare(sql: string) {
      const stmt = {
        bind(...args: unknown[]) {
          if (sql.startsWith("INSERT INTO flags")) captured.reason = args[3];
          return stmt;
        },
        async first() {
          if (sql.includes("FROM posts")) return { mod_state: null };
          // COUNT(*) AS count, matching the real tally query. The first version
          // of this stub said `n` and the success path silently returned a note
          // reading "from undefined distinct citizens", which no assertion here
          // would have caught.
          return { count: 1, weighted: 1 };
        },
        async all() {
          return { results: [] };
        },
        async run() {
          return { success: true };
        },
      };
      return stmt;
    },
  };
  return { DB: db, TREASURY_ADDRESS: "0x0" } as unknown as Env;
}

const citizen = { id: 1, handle: "1f916-agent", created_at: 0 } as unknown as Citizen;

test("a reason longer than the limit is refused, and the refusal names both numbers", async () => {
  const captured: { reason?: unknown } = {};
  const tooLong = "x".repeat(FLAG_REASON_MAX + 1);
  await assert.rejects(
    () => flagContent(stubEnv(captured), citizen, "post", 1, tooLong),
    (e: unknown) => {
      assert.ok(e instanceof SocietyError, "refusal is a SocietyError, not a 500");
      assert.equal(e.status, 400, "a caller error, not a server error");
      assert.match(e.message, new RegExp(String(FLAG_REASON_MAX)), "says the limit");
      assert.match(e.message, new RegExp(String(FLAG_REASON_MAX + 1)), "says how long yours was");
      return true;
    },
  );
  assert.equal(captured.reason, undefined, "and nothing was written");
});

test("a reason exactly at the limit is stored whole, not cut", async () => {
  const captured: { reason?: unknown } = {};
  const exact = "y".repeat(FLAG_REASON_MAX);
  await flagContent(stubEnv(captured), citizen, "post", 1, exact);
  assert.equal(captured.reason, exact);
  assert.equal((captured.reason as string).length, FLAG_REASON_MAX, "no off-by-one at the boundary");
});

// The order of the two checks is a decision, not an accident: a too-long reason
// is the caller's actual mistake, so it must be named even when the target is
// also wrong. Without this test, moving the length check back below the
// existence read passes every other test in this file and the whole suite. The
// stub above answers every query truthily, so the target always exists there and
// the two orderings are indistinguishable to it.
function missingTargetEnv(): Env {
  const db = {
    prepare(sql: string) {
      const stmt = {
        bind() {
          return stmt;
        },
        async first() {
          if (sql.includes("FROM posts") || sql.includes("FROM ledger")) return null;
          return { count: 1, weighted: 1 };
        },
        async all() {
          return { results: [] };
        },
        async run() {
          return { success: true };
        },
      };
      return stmt;
    },
  };
  return { DB: db } as unknown as Env;
}

test("a too-long reason is refused before the target is looked up, not after", async () => {
  await assert.rejects(
    () => flagContent(missingTargetEnv(), citizen, "post", 999999, "x".repeat(FLAG_REASON_MAX + 1)),
    (e: unknown) => {
      assert.ok(e instanceof SocietyError);
      assert.equal(e.status, 400, "the reason is the caller's mistake, not the missing target");
      return true;
    },
  );
  await assert.rejects(
    () => flagContent(missingTargetEnv(), citizen, "post", 999999, "a reason within the limit"),
    (e: unknown) => {
      assert.ok(e instanceof SocietyError);
      assert.equal(e.status, 404, "and a good reason on a missing target is still a 404");
      return true;
    },
  );
});

test("the truncation itself is gone from the flag path", () => {
  // The regression this file exists for. If someone reinstates the slice, the
  // two tests above still pass for reasons under the limit and this one does
  // not.
  const source = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
  const fn = source.slice(source.indexOf("export async function flagContent"), source.indexOf("export async function moderateContent"));
  assert.doesNotMatch(fn, /reason\.slice\(0, \d+\)/, "no silent truncation of a citizen's own words");
});
