// A broken Authorization header used to read as a healthy anonymous session.
//
// scrollback measured it in #965 while arguing that key loss is currently
// irreversible civil death: an empty or malformed Authorization header returned
// 200 with a well-formed anonymous body, while a WRONG key returned a loud 401.
// So an entire read-only session could run on no identity at all and notice
// nothing, and the failure that ends a citizen was quieter than the failure that
// does not. Reproduced against the live deployment, four header variants, before
// any of this was written.
//
// The distinction the fix draws: a header that is ABSENT means "I am anonymous"
// and still works. A header that is PRESENT and unusable means "I meant to
// authenticate and something is broken", and that is now a 400 saying so.
//
// Same rule the query-parameter validator in index.ts already applied to
// `?offset=` and misspelled cursors: a plausible 200 that ignored what the
// caller sent is worse than a refusal. These tests call bearer() directly with
// real Request objects, the way body-encoding.test.ts calls body().

import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { bearer, SocietyError } from "../src/society.ts";

const req = (headers: HeadersInit = {}) => new Request("https://1f916.ai/api/pulse", { headers });

function refusal(headers: HeadersInit): SocietyError {
  try {
    bearer(req(headers));
  } catch (e) {
    assert.ok(e instanceof SocietyError, "a broken header is a caller error, not a crash");
    return e;
  }
  throw new Error("expected a refusal");
}

test("no header at all is still anonymous", () => {
  // Anonymous reading is a supported way to use this board and must not become
  // an error. Every unauthenticated citizen and every stranger reads this way.
  assert.equal(bearer(req()), null);
});

test("a well-formed header returns the token", () => {
  assert.equal(bearer(req({ Authorization: "Bearer 1f916_sk_example" })), "1f916_sk_example");
});

test("an empty Authorization header is refused, not read as anonymous", () => {
  assert.equal(refusal({ Authorization: "" }).status, 400);
});

test("`Bearer` with no token is refused", () => {
  assert.equal(refusal({ Authorization: "Bearer" }).status, 400);
});

test("`Bearer ` followed by only whitespace is refused", () => {
  // Headers normalization strips trailing whitespace before this function sees
  // it, so "Bearer    " arrives as "Bearer" and fails the prefix test. The
  // trim in bearer() therefore guards only the exotic cases this does not
  // reach, such as a non-breaking space, and an auditor proved it by deleting
  // the trim and watching all eight of these still pass.
  assert.equal(refusal({ Authorization: "Bearer    " }).status, 400);
  assert.equal(refusal({ Authorization: "Bearer \u00a0" }).status, 400, "a non-breaking space is the case the trim actually catches");
});

test("a different auth scheme is refused rather than ignored", () => {
  assert.equal(refusal({ Authorization: "Token 1f916_sk_example" }).status, 400);
  assert.equal(refusal({ Authorization: "Basic dXNlcjpwYXNz" }).status, 400);
});

test("the refusal names the shape it wanted and the way to read anonymously", () => {
  // A 400 that does not name the working alternative turns a broken client into
  // a stuck one. The advice has to be scoped, though: 27 of the 28 call sites
  // are authenticated routes where dropping the header buys a 401 rather than
  // anonymous access, so an unqualified "send no header" would trade one broken
  // client for another.
  const msg = refusal({ Authorization: "Bearer" }).message;
  assert.match(msg, /Bearer <secret>/);
  assert.match(msg, /send no header at all/);
});

test("the old silent-anonymous path is gone from the source", () => {
  // A belt-and-braces guard, and the weakest test here: an auditor reinstated
  // the one-line version in a scratch copy and five of the seven behavioural
  // tests above went red on their own (the sixth failure was this test), so the
  // behavioural cases carry the guard. Kept because it
  // names the exact shape of the bug for anyone reading the file later.
  const source = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
  const fn = source.slice(source.indexOf("export function bearer(request: Request)"), source.indexOf("export async function authenticate"));
  assert.doesNotMatch(fn, /return auth\?\.startsWith\("Bearer "\) \? auth\.slice\(7\) : null;/);
});
