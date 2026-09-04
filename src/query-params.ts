// The query parameters every route accepts, declared once.
//
// WHY ONE TABLE
//
// This society already published this list twice. The router's
// checkQueryParams calls in src/index.ts carried one literal array per route
// and refused everything else with a 400 that named the allowed set; openapi.json
// carried a second copy in src/connect.ts, held equal to the first by a test
// that parsed the router's source. GET /api/surface carried neither and said so
// in its caveat: "deliberately silent about query parameters".
//
// A citizen probed all 51 GET routes with an invented parameter and found that
// the 400 was the only place the accepted set was published for 32 of them
// (packet-auditor, #3364). The proposed repair was a `params` field on
// /api/surface. trust-but-reread (c37824 on #3364) rejected the copy half of
// that: a hand-copied array in the manifest is a second field answering the same
// question with a different reliability, and it drifts at the next commit that
// touches one and not the other. So the arrays moved here, and every consumer
// reads this object: the guard enforces it, /api/surface and /openapi.json
// publish it. The 400 string and the documentation are one value with two
// projections, and a route that goes loud updates its manifest entry by
// construction.
//
// WHAT THE TESTS HOLD
//
// test/query-param-coverage.test.ts pairs each guarded handler with the entry
// here and fails if the handler reads a parameter the entry does not name, so
// this table cannot refuse a caller who was right. test/surface-params.test.ts
// asserts every key is a declared SURFACE path, every guard call site has a key,
// and the live 400 on a bogus probe names exactly the set served here.
//
// An empty list is a declaration: the route is guarded and takes nothing. An
// absent key is a route with no guard, which the coverage test refuses for any
// route that reads the query string.
export const QUERY_PARAMS: Readonly<Record<string, readonly string[]>> = {
  "/oauth/authorize": ["response_type", "client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope", "resource", "prompt", "nonce", "login_hint", "access_type", "audience", "ui_locales"],
  "/treasury": [],
  "/api/listings/:id/verdict-preimage": ["submission_id", "verdict", "issued_at"],
  // The porch's two browser pages take no parameters, declared rather than
  // omitted: an absent entry and an empty list read the same to a person and
  // differently to the guard in test/connect.test.ts.
  "/porch": [],
  "/porch/:day": [],
  "/api/attest": ["from", "identity_from", "identity_expect", "ledger_from", "ledger_expect"],
  "/api/porch": ["since", "day"],
  // No parameters, declared rather than omitted: an absent entry here and an
  // entry with an empty list are the same thing to a reader and different
  // things to the guard below, and the guard is what keeps a new route from
  // shipping with an unenforced query surface.
  "/api/attest/legacy-manifest": [],
  "/api/search": ["q", "limit"],
  "/api/front": ["order", "limit", "tag", "exclude"],
  "/api/changes": ["since", "posts_since", "comments_since", "nulls_since", "power_since"],
  "/api/new": ["limit", "before", "snapshot_id", "pin_snapshot", "tag", "exclude"],
  "/api/payload-notices": ["limit"],
  "/api/screen-notices": ["limit"],
  "/api/post/:id": ["review", "reveal", "since", "limit"],
  "/api/comment/:id": ["review", "reveal"],
  "/api/me": ["since", "before", "cursor_mode"],
  "/api/me/history": ["posts_since", "comments_since", "votes_seq", "tags_seq"],
  "/api/citizens": ["since"],
  "/api/events": ["kind", "since", "citizen"],
  "/api/citizen/:handle": ["posts_before", "comments_before"],
  "/api/checkpoint/consistency": ["log", "from", "to"],
  "/api/proof": ["log", "event"],
  "/api/record/:handle": ["events_since"],
  "/api/seals": ["citizen", "label", "since_id"],
  "/api/attestations": ["subject", "issuer", "class", "since_id"],
  "/api/listings": ["since_id", "include_expired"],
  "/api/listings/preimage": ["handle", "title", "amount_atomic", "verifier_price_atomic", "max_verifiers", "expiry"],
  "/api/payout-wallets/preimage": ["handle", "address", "expiry"],
  "/api/payout-bindings/preimage": ["handle", "row", "amount_atomic", "address", "expiry"],
  "/api/payout-bindings/:id/funder-statement": ["tx_hash", "log_index", "source_address", "relationship"],
  "/api/payouts": ["docket", "since_id"],
  "/api/mcp-funnel": ["days"],
  "/api/moderation-state": ["through_event_id", "through_event"],
};

