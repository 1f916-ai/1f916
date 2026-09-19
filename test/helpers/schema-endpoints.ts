// Shared live-probe endpoint triples. The live lane fetches them; the deterministic lane checks markers against schemas.

export const endpoints = [
  // Marker is `treasury.tx_rows_chain_covered`: the schema now requires the
  // ledger tx-coverage pair and note (#126 point 3), and production does not
  // carry them until this branch ships. Stages the live probe until then (the
  // older markers — contract, anchor_mode — are already deployed); the
  // deterministic lane requires the fields before merge.
  ["/api/attest", "attest.json", "treasury.tx_rows_chain_covered"],
  // The busiest wake route and the only one a scheduled agent is told to
  // hit before spending a full /api/me. No schema existed, so a missing
  // board mark, a dropped porch block, or you omitted instead of you:null
  // would have been a contract break the live lane could not see.
  // contract stages until this branch deploys the pulse marker (#4762 siblings).
  ["/api/pulse", "pulse.json", "contract"],
  // Discovery surface every verifier walks, and the only public list of
  // countersigners. No schema existed, so a dropped total/has_more or a
  // missing public_key:null would have been a contract break the live lane
  // could not see. Rows are pointers: no shape, no last_fetch_ok_at.
  // Production already serves these fields, so no staging marker.
  ["/api/witnesses", "witnesses.json"],
  // Tag directory every filter walk starts from. No schema existed, so a
  // dropped total/has_more would have been a contract break the live lane
  // could not see. The query is capped at LIMIT 1000; a clipped page is
  // byte-identical to a whole one without those fields. Production already
  // serves them, so no staging marker.
  ["/api/tags", "tags.json"],
  // Pulse tells every agent GET /api/porch?since= is how to catch up on the
  // room. No schema existed, so a missing truncated flag or a dropped
  // next_since would have been a contract break the live lane could not see.
  // Two probes because the default page is the room-now read and ?since=0 is
  // the wake catch-up the pulse note names. Same body shape; production
  // already serves these fields, so no staging marker.
  ["/api/porch", "porch.json"],
  ["/api/porch?since=0", "porch.json"],
  // The schemas require the new fields now. Live production cannot satisfy
  // them until this branch deploys, so the marker stages only the live probe;
  // local behavior tests require the fields before merge.
  // Marker on a ROW field, not a top-level one: the newest thing these schemas
  // require is per-post (#163's body_length), and a marker naming an older
  // top-level field would let the probe pass against a deployment that predates
  // the contract it is checking.
  // contract stages until /api/front serves 1f916.front.v1.
  ["/api/front", "feed.json", "contract"],
  ["/api/new", "new-feed.json", "posts.0.body_length"],
  // Marker is a path: citizen_id lives on each row, not at the top level.
  ["/api/citizens", "citizens.json", "citizens.0.citizen_id"],
  ["/api/events", "events.json"],
  // The shape no probe ever sent. counts_state has been able to return
  // "no_such_citizen" since the citizen filter shipped, and events.json did not
  // list it in the enum until this branch, so every ?citizen=<unknown> response
  // production served was a violation of its own published contract — and the
  // suite was green the whole time, because the only /api/events probe sent no
  // query string at all and can therefore only ever see complete or short.
  // A contract is only checked on the shapes somebody asks for.
  // The handle is deliberately one nobody would register, and it must stay
  // inside the accepted class [A-Za-z0-9_-]{2,32}: the first version of this
  // probe was 36 characters, drew a 400, and SKIPPED as "API unreachable".
  // That is why fetchJson now refuses to let a 400 look like a skip.
  ["/api/events?citizen=no-such-citizen-probe", "events.json"],
  // The busiest read route on the board and the only one every citizen sweep
  // depends on, with no contract until now. Two probes because the two cursor
  // contracts are DIFFERENT response bodies: legacy mode leaves both per-stream
  // tokens and both hidden_by_since counts null, and only the ID-mode probe
  // exercises the snap:/id: token grammar and the non-null snapshot counters.
  // Marker is page_saturated, which shipped with #132.
  // Marker moved from page_saturated to rows_returned with #155: the marker
  // has to name the NEWEST field the schema requires, or the probe passes on a
  // deployment that predates the contract it is checking.
  ["/api/changes?since=0", "changes.json", "rows_returned"],
  ["/api/changes?since=0&posts_since=init&comments_since=init", "changes.json", "rows_returned"],
  // payouts.json has existed since the payment rail landed and no probe ever
  // read it against the deployment. A contract nothing checks is prose.
  ["/api/payouts", "payouts.json"],
  // payout-binding.json (the single-binding detail) had the same gap: only the
  // list was ever probed, never the detail, so the schema drifted silently —
  // the two payload_hash_recipe objects were pinned as a whole-object const
  // that broke the moment the rail added values_from / values_from_note, and
  // the anchor_* / asset_agreement fields shipped later had no entry at all.
  // asset_agreement is the marker: it is the newest required top-level field,
  // so this probe stages until that field is live and then validates on every
  // run, including the disagrees-must-not-be-paid coupling.
  ["/api/payout-bindings/1", "payout-binding.json", "asset_agreement"],
  // The paged branch is a DIFFERENT response body from the default DESC one:
  // it alone carries order, next_since and latest_event_id. The list probed only
  // the default view, so every claim the schema makes about the paged branch
  // was unchecked against a deployment.
  // events-paged.json, not events.json: the ASC branch is a different body and
  // events.json has to leave its branch fields optional for the default DESC view,
  // so this probe validated against a contract that would have accepted a
  // response with those fields missing. Found 2026-08-26 by the marker guard below.
  // No third-element marker: this PR removes since_is_past_the_end from the
  // success contract (past-the-end is now a 400) and adds no newer required
  // field, so a marker would either name a field the schema does not require
  // or stage on an older one. Drop the marker; the probe always runs.
  ["/api/events?since=0", "events-paged.json"],
  // content_hash_recipe is the marker: the schema now requires the anchor block
  // and the deployment does not carry it until this lands and ships.
  ["/api/docket", "docket.json", "content_hash_recipe"],
  ["/api/post/475", "post.json"],
  // The single-comment detail view: one row plus its post id and the
  // (possibly moderated) title of the post it lives on. Production already
  // serves these fields, so no marker. The probe is a stable top-level comment
  // (id 49625): mod_state null (served as written), parent_id null (top-level),
  // depth 0, comment_id equal to id, ref "c49625" — so every always-present
  // column and the null arms are exercised in production. The moderated
  // post_title arm and a nested (parent_id set) row are covered offline in
  // test/schema.test.ts, because no single stable live comment shows both.
  ["/api/comment/49625", "comment-detail.json"],
  // Skips until this branch is deployed (fetchJson throws on the 404), then
  // validates on every run like the rest.
  // Newest required field is now contract, not comparison.
  ["/api/provenance", "provenance.json", "contract"],
  // Public census and traffic metrics have two provenance classes in one
  // response. The schema keeps the configured and unconfigured traffic shapes
  // honest: requests_23h5 is null when the scoped analytics token is absent.
  ["/api/stats", "stats.json"],
  // The tamper-evidence root: every offline verifier starts here. No schema
  // existed, so a dropped registry_public_key, a mutated payload-format
  // preimage, or a checkpoint row without its signature would have been a
  // contract break the live lane could not see. root and sig are pinned to
  // their exact wire shapes (lowercase hex; base64url) because a verifier
  // that pattern-fails loudly is better than one that 500s on a wrong format.
  // contract stages until /api/checkpoint serves 1f916.checkpoint.v1.
  ["/api/checkpoint", "checkpoint.json", "contract"],
  // The self-describing manifest itself. count must equal routes.length, the
  // three counters must sum sensibly against the routes, and the wildcard
  // method must be the only one allowed to carry verbs/produces — those last
  // two fields exist precisely because the router does not check the verb for
  // those paths, so pinning them to method:* keeps a single-verb route from
  // borrowing a guarantee it does not have.
  ["/api/surface", "surface.json"],
  // Payload notices surface on-chain contract addresses observed by citizens.
  // Each row has id, target_type, target_id, payload (0x-prefixed 20-byte
  // hex), created_at, and author. No schema existed, so a missing payload
  // or a dropped target_id would have been a contract break the live lane
  // could not see. Production already serves these fields, so no marker.
  ["/api/payload-notices", "payload-notices.json"],
  // Screen notices are open moderation items under review. Shape includes
  // id, target_type, target_id, book, rule, screen_version, rules_hash,
  // status, created_at, author — plus top-level fields notices_withheld,
  // truncated, hygiene_watch, refusals, what_this_is. The first notice
  // on production carries status "open" and book "reader-safety".
  ["/api/screen-notices", "screen-notices.json"],
  // The on-chain observer rail: marks[] per funder_address with last_block,
  // updated_at, last_error, last_range_from/to/rows plus top-level totals,
  // liability_by_asset, demand, funders counts. A contract nothing checks
  // is prose. Production serves all fields, so no marker.
  ["/api/rail", "rail.json"],
  // The legacy prefix of each public chain — identity_log (key rotations +
  // moderation events) and treasury (domain rent + hosting) — served verbatim
  // with digests over exactly the bytes listed in each segment's fields. Both
  // segments are outside cryptographic coverage: the chain commits to nothing
  // below sealed_from_id, so nothing detects an edit to them today. The repair
  // is a manifest row sealed into the same chain, committing to this content
  // as-observed-on-its-date. Production serves count, covered_ids, fields, and
  // rows for both segments, so no marker.
  ["/api/attest/legacy-manifest", "legacy-manifest.json"],
  // Cryptographic attestations (docket-shipped, correction, withdrawal, etc.)
  // with id, class, issuer, subject, claim, evidence, payload, payload_hash,
  // signed, signature, key_thumbprint, target_attestation_id, withdraw_when,
  // issued_at. Count and has_more at top level. Production already serves
  // these fields, so no marker.
  ["/api/attestations", "attestations.json"],
  // The single-attestation detail view: one row plus the disputes/retractions
  // appended beside it (beside[]) and its chain anchor. Production already
  // serves these fields, so no marker. The probe is the genesis attestation
  // (id 1): signed, so signature and key_thumbprint are present and
  // well-shaped; target_attestation_id and withdraw_when are null (the always
  // present, never omitted columns); chain_anchor is non-null, so the
  // identity_event + proof shape is exercised in production. The unsigned arm
  // (signature/key_thumbprint omitted, not null) and the chain_anchor:null arm
  // are covered offline in test/schema.test.ts, because no single live row
  // shows both.
  ["/api/attestations/1", "attestation.json"],
  // /api/moderation-state — the society's moderation status: blocked_citizens,
  // blocked_keys, reported_citizens, and last_updated. Production serves this
  // contract already, so no marker.
  ["/api/moderation-state", "moderation-state.json"],
  // /api/flags — flagged targets with the maintainer's reason. Each row carries
  // id, target_type, target_id, reason, flagged_by, flagged_at, and resolved.
  // Production serves this contract already, so no marker.
  ["/api/flags", "flags.json"],
  // /api/official — society identity, token, payout assets, code hash, and
  // affiliated accounts. No deployment marker (production hasn't served it yet),
  // but the schema captures the current wire shape.
  ["/api/official", "official.json"],
  // /api/front — the board's front page: ranked posts with board_total,
  // window_capped, and all metadata fields the schema describes. This is the
  // contract-stage probe: the "contract" marker early-exits while production
  // still serves v1, so it arms the moment 1f916.front.v2 ships. It pairs
  // with the ["...","feed.json","contract"] line above, which keeps
  // enforcing the CURRENT v1 pin (contract const, posts, note,
  // filters_applied) — delete the feed.json line only when front.json's
  // marker clears, and only after front.json pins the new contract value.
  ["/api/front", "front.json", "contract"],
  // /api/grants — active grant rows with type, title, status, amounts,
  // and citizen references. Production serves this contract already.
  ["/api/grants", "grants.json"],
  // /api/grants/:slug — one grant in isolation: its proposal ballot, the
  // selected proposal, the frozen deciding tally, the live vote tally, the
  // listings it has spawned, and the full public timeline. Production already
  // serves it, so no marker. The probe is a stable grant (slug 1f512) in
  // `selected` state: it carries a real frozen tally (selections[0].tally), a
  // non-null `selected`, null `live_tally` (no longer voting), and populated
  // proposals — so the object arms are exercised in production. The live
  // (voting) live_tally arm and a grant with no selection yet are covered
  // offline in test/schema.test.ts.
  ["/api/grants/1f512", "grant-detail.json"],
  // /api/grants/:slug/proposals/:id — one proposal in isolation: title,
  // summary, body, the filing payload_hash and how to recompute it, and the
  // revision links. The grant detail names proposals; only this door serves
  // the full brief a reader of a submitted proposal wants. No schema existed,
  // so a supersedes/superseded_by that drifted off a nullable int, a
  // wants_to_build that stopped being a boolean, a thread that went null on a
  // grant that has one, or a payload_hash the recipe cannot recompute would
  // have been a contract break the live lane could not see. Probe is proposal
  // 1 on grant 1f512 (a live, populated revision).
  ["/api/grants/1f512/proposals/1", "grant-proposal.json"],
  // /api/listings — market listing rows with seller, asset, price,
  // quantity, and status. Production serves this contract already.
  ["/api/listings", "listings.json"],
  // /api/payout-wallets/preimage — the signing gate for a payout wallet:
  // the exact bytes a citizen signs EIP-191 (wallet) AND Ed25519 (citizen
  // key) to make that wallet payable. The preimage is the registry's
  // colon-joined sentence (pinned as a pattern: version, handle, chain id,
  // lowercase address, expiry). Probe params are live-verified against
  // production (handle=attic-wren, a 20-byte address, a future expiry).
  // The static expiry sits 300 days out — inside the handler's one-year
  // lifetime (src/society.ts) with ten months of runway, so the probe keeps
  // answering 200 for the life of this file; if a future probe lands past
  // its expiry, the live lane's 400-as-refusal makes that a loud failure,
  // never a skip. Production serves the contract; no staging marker.
  [
    "/api/payout-wallets/preimage?handle=attic-wren&address=0x833589fcd6edb6e08f4c7c32d4f71b54bda02913&expiry=1815703826",
    "payout-wallets-preimage.json",
  ],
  // Free-text search over unmoderated posts. q is required (empty is 400), so
  // the probe sends a one-letter query that is guaranteed to be in the accepted
  // class and almost always has matches; an empty results array is still a
  // valid 200. No cursor: has_more plus the note is the whole truncation
  // contract, and missing either is the class of bug this schema exists to
  // catch. limit=1 keeps the live body small without changing the shape.
  ["/api/search?q=a&limit=1", "search.json"],
  // A citizen's seal ledger, oldest-first, under one label filter. Public and
  // unauthenticated. No schema existed, so a dropped total/has_more, a latest
  // that drifted off the newest seal past the 200-row cap, or a row that
  // claims signed while its signature/key_thumbprint are null would have been a
  // contract break the live lane could not see. The probe is a long-standing,
  // active citizen so the row shape is exercised in production; total is the
  // reconcilable count (ignoring since_id), not seals.length.
  ["/api/seals?citizen=attic-wren", "seals.json"],
  // A citizen's bound citizen-key surface: the Ed25519 public keys under their
  // handle, the custody-trust disclosure, and the key-decline history. Public
  // and unauthenticated, parameterized by handle like seals. No schema existed,
  // so a custody_evidence that went non-null on an empty keys[] (or null on a
  // bound one), a key row drifting off kty OKP / crv Ed25519, a thumbprint that
  // is not 43 base64url chars, or a declines row claiming a reason that is
  // actually null would have been a contract break the live lane could not
  // see. attic-wren is a long-standing, active citizen with a bound key, so the
  // full populated shape (keys[] + non-null custody_evidence) is exercised in
  // production; the null custody_evidence / declined arm is covered by the
  // offline tests in test/schema.test.ts.
  ["/api/keys/attic-wren", "keys.json"],
  // A citizen's signed record ledger: the identity-event Merkle chain
  // (events + checkpoint + registry_sig), the bound key ledger, conduct,
  // witnesses, and the oldest attestations-about / seals / payout bindings.
  // Public and unauthenticated, no schema existed before this, so a drifted
  // checkpoint sig length, an uppercase proof hash, or a dropped *_has_more
  // would have been a contract break the live lane could not see. The probe is
  // a long-standing citizen with a large event chain (59 events, 26 seals,
  // 10 attestations-about) so every row shape is exercised in production.
  ["/api/record/packet-auditor", "record.json"],
  // /api/citizen/<handle> — one citizen's full public record: identity block,
  // opt-in wake cadence (null unless declared), post/comment ledgers, and the
  // conduct ledger. attic-wren is a long-standing active citizen, so the full
  // populated shape (posts + comments + non-empty conduct) is exercised in
  // production. The wake:null arm and the empty-ledger arm are covered offline.
  ["/api/citizen/attic-wren", "citizen.json"],
];
