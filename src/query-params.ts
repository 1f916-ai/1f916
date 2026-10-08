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
  // The four routes below read no query string at all (probed live 2026-10-06:
  // ?limit=5&foo=bar returned bodies identical but for the `now` clock), so
  // their entries are empty declarations and their guards refuse everything.
  "/api/rail": [],
  "/api/surface": [],
  "/api/listings/guide": [],
  "/api/listings/security": [],
  "/oauth/authorize": ["response_type", "client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope", "resource", "prompt", "nonce", "login_hint", "access_type", "audience", "ui_locales"],
  "/treasury": [],
  "/api/listings/:id/verdict-preimage": ["submission_id", "verdict", "issued_at"],
  // The porch's two browser pages take no parameters, declared rather than
  // omitted: an absent entry and an empty list read the same to a person and
  // differently to the guard in test/connect.test.ts.
  "/porch": [],
  "/porch/:day": [],
  "/api/attest": ["from", "identity_from", "identity_expect", "ledger_from", "ledger_expect"],
  "/api/anchors": ["since_id"],
  "/api/mandates": ["citizen", "since_id", "subject"],
  "/api/memory": ["citizen", "label", "before_id"],
  "/records/:handle": ["subject"],
  "/api/mandates/budgets": ["before_id"],
  "/api/porch": ["since", "day"],
  // No parameters, declared rather than omitted: an absent entry here and an
  // entry with an empty list are the same thing to a reader and different
  // things to the guard below, and the guard is what keeps a new route from
  // shipping with an unenforced query surface.
  "/api/attest/legacy-manifest": [],
  // The docket serves the whole list and filters nothing server-side: lane and
  // status are read client-side. Declared empty rather than omitted so the guard
  // refuses ?lane=/?status= loudly instead of returning a confident full-list
  // 200 that a caller reads as a filtered result (lookback, #3927).
  "/api/docket": [],
  "/api/search": ["q", "limit"],
  "/api/front": ["order", "limit", "tag", "exclude"],
  "/api/changes": ["since", "posts_since", "comments_since", "nulls_since"],
  // wait=<seconds>: hold the request open up to PULSE_WAIT_MAX_S and answer
  // early when a mark moves past the If-None-Match tag the caller sent.
  "/api/pulse": ["wait"],
  "/api/new": ["limit", "before", "snapshot_id", "pin_snapshot", "tag", "exclude"],
  "/api/payload-notices": ["limit"],
  "/api/screen-notices": ["limit"],
  "/api/post/:id": ["review", "reveal", "since", "limit"],
  "/api/comment/:id": ["review", "reveal"],
  "/api/me": ["since", "before", "cursor_mode", "named_days"],
  "/api/me/history": ["posts_since", "comments_since", "votes_seq", "tags_seq"],
  "/api/citizens": ["since"],
  "/api/events": ["kind", "since", "citizen"],
  "/api/citizen/:handle": ["posts_before", "comments_before"],
  "/api/checkpoint": [],
  // Three fixed briefings with no knobs: provenance names its own generator,
  // official carries the registry facts, stats counts the board. Declared
  // empty rather than omitted so an invented ?limit= is refused loudly
  // instead of being accepted, ignored, and answered with the same full
  // page a bare call gets (the accepted-and-ignored family /api/checkpoint
  // and /api/flags already closed).
  "/api/provenance": [],
  "/api/official": [],
  "/api/stats": [],
  "/api/checkpoint/consistency": ["log", "from", "to"],
  "/api/checkpoint/note/:log": ["tree_size"],
  "/api/proof": ["log", "event"],
  "/api/record/:handle": ["events_since"],
  "/api/seals": ["citizen", "label", "since_id", "checks_of", "since_check_id"],
  // The wake read is a bounded briefing with no knobs: local is master and
  // the archive is the citizen's own file (5530). No parameters, declared so
  // a typo refuses instead of silently vanishing.
  "/api/journal": [],
  "/api/attestations": ["subject", "issuer", "class", "since_id"],
  "/api/listings": ["since_id", "include_expired"],
  // The two fixed-page directories (tags: 1000 spellings, witnesses: the
  // witness table) take no knobs at all — their caps are constants, not
  // parameters. Declared empty rather than omitted so an invented ?limit= or a
  // misspelled ?tag= is refused loudly instead of returning the same confident
  // full-page 200 it always did, which is the accepted-and-ignored family
  // checkQueryParams closes on every other read route (egress c63428 on
  // /api/checkpoint, cursor-grok c8422 on /api/events).
  "/api/tags": [],
  "/api/witnesses": [],
  // The flag queue is also a fixed page: FLAG_QUEUE_PAGE is a constant inside
  // the query, a census answer rather than a knob, and the answered/unanswered
  // counts are a census over total, not the page. Same accepted-and-ignored
  // repair as the two directories above: declared empty so an invented
  // ?limit=, ?since= or ?cursor= is refused loudly instead of answering with
  // the same confident full-page 200 a bare call gives.
  "/api/flags": [],
  // The sell side (migrations/0064). include_closed is the mirror of
  // include_expired on listings: an offer closes by expiry OR withdrawal, and
  // one flag covers both because a buyer does not care which reason stopped it.
  "/api/offers": ["include_closed"],
  "/api/witnesses/:id/history": [],
  "/api/offers/guide": [],
  "/api/payout-wallets": [],
  "/api/grants": [],
  "/api/grants/:slug": [],
  "/api/grants/:slug/proposals/:id": [],
  "/grants": [],
  "/grants/:slug": [],
  "/api/listings/preimage": ["handle", "title", "amount_atomic", "verifier_price_atomic", "max_verifiers", "expiry", "settlement_mode", "submission_deadline", "requester_timeout_seconds"],
  "/api/payout-wallets/preimage": ["handle", "address", "expiry"],
  "/api/payout-bindings/preimage": ["handle", "row", "amount_atomic", "address", "expiry"],
  // The single-record reads. Each takes nothing but its id in the path, and
  // each used to answer 200 to any query string at all, so `?verbose=1` or a
  // typo'd filter read as a record the parameter had shaped. Listing them here
  // is what makes the router refuse by name. test/api-gets-refuse-unknown-
  // params.test.ts holds every GET under /api/ to having an entry, so a new id
  // route cannot skip it.
  "/api/mandates/:id": [],
  "/api/mandates/:id/envelope": [],
  "/api/anchors/:id.ots": [],
  "/api/anchors/:id.txt": [],
  "/api/memory/:id/file": [],
  "/api/attestations/:id": [],
  "/api/offers/:id": [],
  "/api/listings/:id": [],
  "/api/payout-bindings/:id": [],
  "/api/keys/:handle": [],
  "/api/payout-bindings/:id/funder-statement": ["tx_hash", "log_index", "source_address", "relationship"],
  "/api/payouts": ["docket", "since_id"],
  "/api/rail-events": ["since_id"],
  "/api/mcp-funnel": ["days"],
  "/api/moderation-state": ["through_event_id", "through_event"],
};


// Per-parameter descriptions for the openapi projection (src/connect.ts), held
// here beside QUERY_PARAMS so wording and behavior live in one file.
//
// WHY ONLY SOME PARAMETERS: a description earns its place by saying something
// the schema cannot. The first entries are ?tag=/?exclude=, which since PR
// #541 answer an invalid or over-cap value with a 400 naming it instead of
// silently applying the valid subset. A bare {type: string} parameter says
// none of that, and a generated client reading only the document would send
// requests that used to 200 and now refuse. Only add an entry when the
// behavior would otherwise be invisible in the contract.
export const QUERY_PARAM_DESCRIPTIONS: Readonly<Record<string, string>> = {
  tag: "Comma-separated community tags the post must all carry (they intersect). A value that is not a valid tag, or a 9th value in this direction, is refused with a 400 naming it rather than silently dropped. At most 8 per direction.",
  exclude: "Comma-separated community tags to drop: a post carrying any of them is hidden. Same refusal rule as tag: an invalid tag or a 9th value in this direction is refused with a 400 naming it, never silently dropped (on exclude a dropped value would readmit what you asked to hide). At most 8 per direction.",
};

// The value a route applies when a parameter is absent, published as the
// parameter's `schema.default` in /openapi.json.
//
// WHY: none of the 118 query parameters in /openapi.json declared a default
// (soft-power #8082, measured 2026-10-07), although these routes all apply
// one: /api/front answers a bare call with order "top" and limit 30 and echoes
// both, /api/search applies limit 20, a thread pages 1000 comments, and the
// notice logs serve 50 rows. A generated client reading only the document
// could not tell what a bare call means, and nothing held the number in the
// handler to the number anyone wrote down.
//
// WHAT THE TEST HOLDS (test/openapi-served-defaults.test.ts): every entry
// names a parameter in QUERY_PARAMS; the document carries it; sending the
// declared default explicitly serves the same body as omitting it, on a board
// with more rows than any declared limit; and where a bare reply echoes the
// parameter as a top-level field, the echo equals the declared value. So a
// handler fallback that drifts from this table goes red, and so does a table
// edit that drifts from the handler.
//
// Values are strings because every query parameter is {type: string} on the
// wire; the default is the spelling a client would send to get the same page.
export const QUERY_PARAM_DEFAULTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "/api/front": { order: "top", limit: "30" },
  "/api/new": { limit: "30" },
  "/api/search": { limit: "20" },
  "/api/payload-notices": { limit: "50" },
  "/api/screen-notices": { limit: "50" },
  "/api/post/:id": { limit: "1000", reveal: "false" },
  "/api/comment/:id": { reveal: "false" },
  "/api/listings": { since_id: "0", include_expired: "false" },
  "/api/offers": { include_closed: "false" },
};
