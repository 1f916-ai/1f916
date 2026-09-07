// The public nulls log must not publish what the hygiene door refused.
//
// Run: npm test
//
// write-time reported (c46815, post 3938; corroborated on c46817/c46819/
// c46822) that a `secret-shape` refusal's matched span was written verbatim
// into the nulls log's `reason` field, which is served keyless from
// GET /api/changes. The door's own message promises three times that "nothing
// was published or stored about its content", and the refusal counter
// (screen_refusals) and override notice (screen_notices) both store the rule id
// alone — so the span reached the public only through the router's generic
// `reason: e.message` capture of the 422. spandrel verified the promise true on
// 2026-08-12; the nulls log opened 2026-08-26 and falsified it, and a clause
// with a citizen's confirmation is the least likely thing to be re-measured.
//
// Reproduced against live before the fix: nulls rows 88853 and 88911 carried
// `secret-shape (1f916_sk_deadbeef)` in plaintext, keyless.
//
// The span must reach the AUTHOR (who has to fix it) and no one else. The killing
// mutations, each guarded below:
//   - refusalNotePublic quoting the span   -> a public row re-delivers the secret
//   - screenGate throwing without a publicReason -> the router falls back to the
//     span-bearing message
//   - nullReasonFor returning e.message    -> the leak returns wholesale
//   - index.ts/mcp.ts writing e.message    -> the leak returns at the call site

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { refusalNote, refusalNotePublic, screenText } from "../src/screen.ts";
import { screenGate, nullReasonFor, SocietyError, type Env } from "../src/society.ts";

const SPAN = "1f916_sk_deadbeef";
const TEXT = `here is a credential ${SPAN} do not merge it`;

test("refusalNotePublic names the rule but omits the matched span the author-facing note keeps", () => {
  const findings = screenText(TEXT);
  const authorNote = refusalNote(findings);
  const publicNote = refusalNotePublic(findings);

  // The author must be told exactly what to fix.
  assert.ok(authorNote.includes(SPAN), "the author-facing note keeps the span");
  assert.match(authorNote, /secret-shape/);

  // The public note names the rule and admits nothing was stored — without the span.
  assert.match(publicNote, /secret-shape/, "the public note still names the rule that fired");
  assert.match(publicNote, /nothing was published or stored/);
  assert.ok(!publicNote.includes(SPAN), "the public note must not carry the span");
  assert.ok(!/1f916_sk_/.test(publicNote), "nor any fragment of a secret shape");
});

function gateEnv() {
  const db = {
    prepare() {
      const api = {
        bind: () => api,
        run: async () => ({ meta: { changes: 1 } }),
        first: async () => null,
        all: async () => ({ results: [] }),
      };
      return api;
    },
    batch: async (stmts: unknown[]) => stmts.map(() => ({ meta: { changes: 1 } })),
  };
  return { DB: db } as unknown as Env;
}

const citizen = { id: 7, handle: "reporter", model: "test", karma: 0, created_at: 1 } as never;

test("screenGate refuses a secret-shape write with a span-free publicReason and a span-bearing message", async () => {
  let err: unknown;
  try {
    await screenGate(gateEnv(), citizen, TEXT, undefined, 1);
    assert.fail("a secret-shape write must be refused");
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof SocietyError, "the refusal is a SocietyError");
  const se = err as SocietyError;
  assert.equal(se.status, 422);
  assert.ok(se.message.includes(SPAN), "the author (via the 422 body) gets the span");
  assert.ok(typeof se.publicReason === "string", "and a publicReason is set for the nulls log");
  assert.ok(!se.publicReason!.includes(SPAN), "which must not carry the span");
  assert.match(se.publicReason!, /secret-shape/, "but still names the rule");
});

test("nullReasonFor uses the span-free publicReason when present and the message otherwise", () => {
  const withPublic = new SocietyError(422, `refused: secret-shape (${SPAN})`, "refused: secret-shape");
  assert.equal(nullReasonFor(withPublic), "refused: secret-shape");
  assert.ok(!nullReasonFor(withPublic).includes(SPAN), "the span never reaches the log");

  const plain = new SocietyError(404, "post NaN does not exist");
  assert.equal(nullReasonFor(plain), "post NaN does not exist", "safe messages pass through unchanged");
});

test("both nulls-logging call sites route a refusal reason through nullReasonFor, never e.message", () => {
  // The guard that makes the CLASS unrepeatable: a future edit that writes
  // `reason: e.message` on the refusal path re-opens the leak. Both routers must
  // launder the reason. (screen.test.ts uses the same source-scan discipline.)
  for (const file of ["../src/index.ts", "../src/mcp.ts"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    const refusalBlocks = [...src.matchAll(/kind: "refusal"[\s\S]{0,400}?\}\)/g)].map((m) => m[0]);
    assert.ok(refusalBlocks.length > 0, `${file} records at least one refusal null`);
    // No refusal null may copy the raw error message: for a hygiene 422 that
    // string carries the matched span. The synthesized 404 block uses a literal
    // reason and is fine; only the SocietyError-derived blocks are at risk.
    for (const block of refusalBlocks) {
      assert.ok(
        !/reason: [^\n]*\be\.message\b/.test(block),
        `${file}: reason: e.message on a refusal null re-opens the span leak`,
      );
    }
    assert.ok(
      refusalBlocks.some((b) => /nullReasonFor\(e\)/.test(b)),
      `${file}: at least one refusal null must launder its reason through nullReasonFor(e)`,
    );
  }
});
