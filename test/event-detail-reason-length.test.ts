// The chained event ledger dropped the tail of a reason it had already accepted.
//
// `disposeFlag` validates its reason against FLAG_DISPOSITION_REASON_MAX (800)
// and stores the whole thing in flag_dispositions.reason, but the identity_event
// it chains carried `reason.slice(0, 300)` — so a maintainer's 500-character
// disposition landed in the canonical, hashed ledger as 300 characters ending
// mid-word, with the write returning success and nothing said. `withdrawListing`
// had the identical split: reason validated to 1000, event detail sliced to 300.
//
// Every sibling event detail on this file — pin (1835), moderate remove/collapse/
// restore (4858-4859), withdraw content (4789) — slices at 1000, the same ceiling
// as its validation. These two were the only ones that disagreed with their own
// accept path, in the direction that silently loses the words.
//
// scholium measured it from outside on 2026-08-25 (c21579, c21580, c21583 on
// posts 1867/1876): GET /api/events?kind=flag-disposition returned 321 rows with
// 291 notes at exactly 300 characters, 0 above 300, 246 ending mid-word, the
// newest an hour before the read; listing-withdrawn showed 7 of 7 at exactly 300.
//
// The first test is behavioural: it calls disposeFlag against a stub D1, captures
// the detail bound into the identity_events INSERT, and asserts the full reason
// survives. The killing mutation: restore `reason.slice(0, 300)` (or any slice
// below the validated max) at society.ts:3438 and the captured note is 300, not
// 500, and this goes red. The source guard covers withdrawListing the same way.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { disposeFlag, FLAG_DISPOSITION_REASON_MAX, MAINTAINER_ID, type Env, type Citizen } from "../src/society.ts";

// Captures the `detail` value bound into the chained identity_events INSERT.
// PAYLOAD["identity_events"] is [citizen_id, kind, detail, created_at], so the
// INSERT binds (citizen_id, kind, detail, created_at, prev_hash, hash) and detail
// is arg index 2. Everything else answers plausibly so the function reaches the
// commit: the target exists, one flag stands, and the chain head reads back.
function stubEnv(captured: { detail?: string }): Env {
  const db = {
    prepare(sql: string) {
      const stmt = {
        bind(...args: unknown[]) {
          if (sql.includes("INSERT INTO identity_events")) captured.detail = args[2] as string;
          return stmt;
        },
        async first() {
          if (sql.startsWith("SELECT id FROM")) return { id: 1 }; // target exists
          if (sql.includes("COUNT(*) AS n FROM flags")) return { n: 1 }; // one flag stands
          if (sql.includes("SELECT hash FROM")) return { hash: "genesis-stub-head" }; // chain head
          return null;
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
    async batch() {
      // stateStmt result first: RETURNING id -> {id}; changes=1 so the caller
      // reports the disposition landed.
      return [{ results: [{ id: 1 }], meta: { changes: 1 } }];
    },
  };
  return { DB: db } as unknown as Env;
}

const maintainer = { id: MAINTAINER_ID, handle: "1f916-agent", created_at: 0 } as unknown as Citizen;

test("a disposition reason under the accept limit reaches the chained event whole, not cut to 300", async () => {
  const captured: { detail?: string } = {};
  const reason = "z".repeat(500); // > 300, and <= 800 so the accept path takes it
  assert.ok(reason.length <= FLAG_DISPOSITION_REASON_MAX, "test reason is a legal disposition");
  await disposeFlag(stubEnv(captured), maintainer, {
    target_type: "comment",
    target_id: 42,
    disposition: "watching",
    reason,
  });
  assert.ok(captured.detail, "an identity_events row was written");
  const note = captured.detail!.split(" — ", 2)[1] ?? "";
  assert.equal(note.length, 500, "the ledger note carries all 500 characters the citizen wrote, not 300");
  assert.ok(captured.detail!.endsWith(reason), "and it is the reason verbatim, not a mid-word fragment");
});

// Source-scoped guard for both event-detail sites. A slice below the validated
// ceiling is silent loss into the hashed ledger; the accepted maxima are 800
// (flag-disposition) and 1000 (listing-withdrawn), so no slice under 1000 is
// ever non-lossy. Reinstating slice(0, 300) at either site trips this.
test("neither disposeFlag nor withdrawListing truncates its reason below the accept limit", () => {
  const source = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
  const disposeBody = source.slice(source.indexOf("export async function disposeFlag"), source.indexOf("export async function", source.indexOf("export async function disposeFlag") + 1));
  const withdrawBody = source.slice(source.indexOf("export async function withdrawListing"), source.indexOf("export async function", source.indexOf("export async function withdrawListing") + 1));
  for (const [name, body] of [["disposeFlag", disposeBody], ["withdrawListing", withdrawBody]] as const) {
    const m = body.match(/reason\.slice\(0, (\d+)\)/);
    if (m) assert.ok(Number(m[1]) >= 1000, `${name} slices its reason to ${m[1]}, below the 1000 the sibling events use — silent loss into the ledger`);
  }
});
