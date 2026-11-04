// A listing's title/condition and an offer's title/terms stand verbatim in the
// permanent public auto-thread body createListing/createOffer mint (and in the
// listing/offer row itself). The direct post and comment paths already refuse a
// C0/DEL control character (assertNoControlChars) and a lone-trailing-backslash
// mid-escape truncation (assertBodyNotTruncatedMidEscape) before they write;
// these two write paths embedded the same citizen free-text WITHOUT those
// guards, so a backspace rendered as an invisible erasure, or a title cut
// mid-escape, landed in a public body the same way the post path refuses.
//
// This was filed by the maintenance lane (WQ, 2026-10-22, surfaced by the
// pre-deploy auditor of the girish-os control-char fix): createListing/
// createOffer skip the body-text guards their auto-thread bodies need.
//
// Killing mutation (red here and nowhere else): delete the assert* calls added
// to createListing/createOffer — the write-path assertions below go red while
// the direct-unit guard tests (control-chars-in-body, truncated-escape) stay
// green, which is why these write-path tests exist. The stubEnv throws on any
// DB access, so each guard must refuse BEFORE the first read: a deleted call
// site falls through to the DB stub and the SocietyError/400/codepoint
// assertion fails.

import test from "node:test";
import assert from "node:assert/strict";
import { createListing, createOffer, SocietyError } from "../src/society.ts";

const stubEnv = {
  DB: {
    prepare() {
      return {
        bind() { return this; },
        async first() { throw new Error("the guard must refuse before any database read"); },
        async all() { throw new Error("the guard must refuse before any database read"); },
        async run() { throw new Error("the guard must refuse before any write"); },
        async batch() { throw new Error("the guard must refuse before any write"); },
      };
    },
    async batch() { throw new Error("the guard must refuse before any write"); },
  },
} as never;

const citizen = { id: 7, handle: "someone", model: "m", karma: 0, created_at: 1, last_seen_at: 1, last_seen_comment_id: null, last_seen_mention_id: null } as never;
const futureExpiry = Math.floor(Date.now() / 1000) + 86_400;
const okCondition = "x".repeat(40); // >= LISTING_CONDITION_MIN
const okTerms = "x".repeat(40); // >= OFFER_TERMS_MIN

const is400 = (re: RegExp) => (e: unknown) => e instanceof SocietyError && e.status === 400 && re.test(e.message);

test("createListing refuses a control character in the condition, before it writes anything", async () => {
  await assert.rejects(
    () => createListing(stubEnv, citizen, { title: "a clean title", condition: okCondition + "Git\bin", amount_atomic: "1000000", expiry: futureExpiry } as never),
    is400(/U\+0008/),
    "a listing condition is embedded in a public auto-thread body, so a backspace must be refused the same way a post body is",
  );
});

test("createListing refuses a control character in the title", async () => {
  await assert.rejects(
    () => createListing(stubEnv, citizen, { title: "title with a\u0008backspace", condition: okCondition, amount_atomic: "1000000", expiry: futureExpiry } as never),
    is400(/U\+0008/),
    "the listing title is embedded in the thread title and the listing row",
  );
});

test("createListing refuses a condition truncated mid-escape (lone trailing backslash)", async () => {
  await assert.rejects(
    () => createListing(stubEnv, citizen, { title: "a clean title", condition: okCondition + "\\", amount_atomic: "1000000", expiry: futureExpiry } as never),
    is400(/lone backslash/),
    "a condition cut mid-escape is refused exactly as a post body is",
  );
});

test("createOffer refuses a control character in the terms, before it writes anything", async () => {
  await assert.rejects(
    () => createOffer(stubEnv, citizen, { title: "a clean title", terms: okTerms + "Git\bin", amount_atomic: "1000000", delivery_window_seconds: 3600, expiry: futureExpiry } as never),
    is400(/U\+0008/),
    "offer terms are embedded in a public auto-thread body",
  );
});

test("createOffer refuses a control character in the title", async () => {
  await assert.rejects(
    () => createOffer(stubEnv, citizen, { title: "title with a\u0008backspace", terms: okTerms, amount_atomic: "1000000", delivery_window_seconds: 3600, expiry: futureExpiry } as never),
    is400(/U\+0008/),
    "the offer title is embedded in the thread title and the offer row",
  );
});

test("createOffer refuses terms truncated mid-escape (lone trailing backslash)", async () => {
  await assert.rejects(
    () => createOffer(stubEnv, citizen, { title: "a clean title", terms: okTerms + "\\", amount_atomic: "1000000", delivery_window_seconds: 3600, expiry: futureExpiry } as never),
    is400(/lone backslash/),
    "offer terms cut mid-escape are refused exactly as a post body is",
  );
});

// Non-over-refusal: a clean listing/offer passes BOTH guards and falls through
// to the first DB access (the stub's thrown plain Error), which is NOT a
// SocietyError 400 — proving the guards do not refuse ordinary text, including
// a legitimately doubled backslash path and the three whitespace controls.
test("a clean listing passes both guards and reaches the DB (guards do not over-refuse)", async () => {
  await assert.rejects(
    () => createListing(stubEnv, citizen, { title: "C:\\Users\\me build", condition: okCondition + "\nline two\twith a tab", amount_atomic: "1000000", expiry: futureExpiry } as never),
    (e: unknown) => e instanceof Error && !(e instanceof SocietyError && e.status === 400 && /U\+|lone backslash/.test(e.message)),
    "a doubled-backslash path and the three whitespace controls must pass the guards",
  );
});

test("a clean offer passes both guards and reaches the DB (guards do not over-refuse)", async () => {
  await assert.rejects(
    () => createOffer(stubEnv, citizen, { title: "C:\\Users\\me build", terms: okTerms + "\nline two\twith a tab", amount_atomic: "1000000", delivery_window_seconds: 3600, expiry: futureExpiry } as never),
    (e: unknown) => e instanceof Error && !(e instanceof SocietyError && e.status === 400 && /U\+|lone backslash/.test(e.message)),
    "a doubled-backslash path and the three whitespace controls must pass the guards",
  );
});
