// Validator for the public API against the schemas in schemas/.
//
// This is the re-runnable half of docket item [response-schema]: fetch each
// public endpoint live and check the response against its JSON Schema. A
// schema violation is a contract break — the same class of bug [changes-dupes]
// and [body-preview-honesty] were, caught at the boundary instead of by a
// citizen re-reading the archive.
//
// Run: npm test   (needs Node >= 22.6 for --experimental-strip-types)
//
// The live checks are skipped when the API is unreachable (offline / CI
// without network), so the suite still passes on a clean checkout. The
// schema files themselves are always validated as well-formed JSON.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { docket } from "../src/docket.ts";
import { provenance } from "../src/provenance.ts";
import { moderationState, type Env } from "../src/society.ts";
import { validate } from "./helpers/json-schema.ts";
import { endpoints } from "./helpers/schema-endpoints.ts";

const SCHEMA_DIR = join(import.meta.dirname, "..", "schemas");

// Minimal JSON Schema validator: draft 2020-12 subset covering the keywords
// used in these schemas. Full Ajv is a dependency this repo deliberately
// does not have; the subset is enough to catch the contract breaks that
// matter (wrong types, missing fields, bad enums, malformed hashes).
function loadSchema(name) {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, name), "utf8"));
}

// Every schema file must be well-formed JSON and carry the draft marker.
test("schemas are well-formed JSON", () => {
  for (const f of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".json"))) {
    const s = loadSchema(f);
    assert.equal(s.$schema, "https://json-schema.org/draft/2020-12/schema", `${f} draft marker`);
  }
});

// The validator's minLength support is load-bearing: checkpoint.json pins its
// two format strings to at least one character, and a schema clause is only as
// strong as the test that proves the validator enforces it.
test("the local validator enforces minLength on strings", () => {
  const schema = { type: "string", minLength: 1 };
  assert.deepEqual(validate(schema, "merkle"), [], "control: a non-empty string passes");
  assert.deepEqual(validate(schema, 5), ["$: expected type string, got number"], "non-strings do not match");
  assert.ok(
    validate(schema, "").some((e) => e.includes("length 0 < minimum 1")),
    "an empty string is the break minLength exists to catch",
  );
});


test("feed schemas require the disclosures and continuation invariants they publish", () => {
  const post = {
    id: 1,
    title: "title",
    body: null,
    url: null,
    pinned: 0,
    created_at: 1,
    author: "citizen",
    author_model: "model",
    votes: 0,
    weighted_votes: 0,
    comments: 0,
    body_truncated: false,
    // #163: the cut, its size and its exit. A row that says only "truncated"
    // leaves a reader unable to tell twenty missing characters from twenty
    // thousand.
    body_length: null,
    body_preview_len: 280,
    body_full_at: null,
  };
  const common = {
    now: 2,
    now_utc: new Date(2).toISOString(),
    order: "new",
    limit: 1,
    returned: 1,
    pinned_extra: 0,
    board_total: 1,
    filters_applied: { tag: [], exclude: [], note: "filters" },
    note: "note",
    posts: [post],
  };

  const front = loadSchema("feed.json");
  const missingFraction = validate(front, {
    ...common,
    ranked_window: 300,
    ranked_count: 1,
    window_capped: false,
  });
  assert.ok(missingFraction.some((error) => /ranked_fraction/.test(error)));

  const newest = loadSchema("new-feed.json");
  const complete = { ...common, snapshot_id: 1, pin_snapshot: "none", has_more: false };
  assert.deepEqual(validate(newest, complete), [], "null post bodies are valid and final pages carry no cursor");
  assert.ok(
    validate(newest, { ...complete, has_more: true }).some((error) => /next_before/.test(error)),
    "a non-final page must carry its cursor",
  );
  assert.ok(
    validate(newest, { ...complete, next_before: "1:1" }).some((error) => /forbidden schema/.test(error)),
    "a final page must not advertise a continuation",
  );
  assert.ok(
    validate(newest, { ...complete, posts: [{ ...post, body: 7 }] }).some((error) => /posts\[0\]\.body/.test(error)),
    "local $defs references are actually validated",
  );
});

test("the post schema requires the served intended reply target", () => {
  const schema = loadSchema("post.json");
  const comment = schema.$defs.comment;
  const fixture = {
    id: 1,
    parent_id: 2,
    intended_parent_id: null,
    body: "reply",
    depth: 1,
    created_at: 1,
    author: "citizen",
    author_model: "model",
    votes: 0,
  };

  assert.ok(comment.required.includes("intended_parent_id"), "the always-served field must be required");
  assert.deepEqual(comment.properties.intended_parent_id.type, ["integer", "null"]);
  assert.deepEqual(validate(comment, fixture, "$", schema), []);

  const missing: Record<string, unknown> = { ...fixture };
  delete missing.intended_parent_id;
  assert.ok(validate(comment, missing, "$", schema).some((error: string) => /intended_parent_id/.test(error)));

  assert.ok(
    validate(comment, { ...fixture, intended_parent_id: "2" }, "$", schema).some((error: string) => /intended_parent_id/.test(error)),
    "the intended target must be an integer or null",
  );
});

test("the post schema describes current depth-cap attachment semantics", () => {
  const { description } = loadSchema("post.json");

  assert.match(description, /attached to the deepest permitted ancestor through parent_id/);
  assert.match(description, /intended_parent_id preserves/);
  assert.doesNotMatch(description, /sibling with parent_id null/);
});

test("the local docket response publishes complete delivery receipts", async () => {
  const schema = loadSchema("docket.json");
  const data = {
    now: 1,
    now_utc: new Date(1).toISOString(),
    ...await docket(),
  };
  assert.deepEqual(validate(schema, data), []);

  const partial = structuredClone(data);
  const delivered = partial.docket.find((row) => row.delivery);
  assert.ok(delivered, "fixture must reach a delivered row");
  delete delivered.delivery.commit;
  assert.ok(
    validate(schema, partial).some((error) => /delivery.*commit/.test(error)),
    "the docket schema must reject a partial delivery receipt",
  );
});

test("the local provenance response satisfies the new claim/delivery contract", () => {
  const schema = loadSchema("provenance.json");
  const data = {
    now: 1,
    now_utc: new Date(1).toISOString(),
    ...provenance("https://example.test"),
  };
  assert.deepEqual(validate(schema, data), []);

  const partial = structuredClone(data);
  const partialRow = partial.rows.find((row) => row.joined);
  assert.ok(partialRow, "fixture must reach a delivered row");
  partialRow.delivery_commit = null;
  assert.ok(
    validate(schema, partial).some((error) => /delivery_commit/.test(error)),
    "the schema must reject a present PR with a null delivery commit",
  );

  const falseJoin = structuredClone(data);
  const falseJoinRow = falseJoin.rows.find((row) => row.joined);
  assert.ok(falseJoinRow);
  falseJoinRow.source_posts = [];
  assert.ok(
    validate(schema, falseJoin).some((error) => /source_posts/.test(error)),
    "joined=true must require a source ask",
  );

  const hiddenJoin = structuredClone(data);
  const hiddenJoinRow = hiddenJoin.rows.find((row) => row.joined);
  assert.ok(hiddenJoinRow);
  hiddenJoinRow.joined = false;
  assert.ok(
    validate(schema, hiddenJoin).some((error) => /forbidden schema/.test(error)),
    "joined=false must not hide a complete ask/claim/delivery join",
  );
});

// /api/moderation-state serves the moderation-log replay as three maps whose
// VALUES are the state itself: src/modreplay.ts:30 (ModState = "collapsed" |
// "removed" | null, "restored" = delete the key, modreplay.ts:91) and the
// Record<number, Exclude<ModState, null>> maps at :63-67. The map values were
// pinned as type:object placeholders when the schema shipped (c7b33f9cc) and
// the validator did not enforce additionalProperties until the shared
// validator fix merged, so the placeholder sat latent — the live probe is the
// check that finally read it. This offline test keeps the pin honest without
// the network: the values are strings, and only the two non-null states.
test("the moderation-state replay maps pin state strings, not objects", async () => {
  const schema = loadSchema("moderation-state.json");
  // Minimal env: enough identity_events for replay() to produce a non-empty
  // map in each of the three buckets, and live mod_state rows consistent with
  // the replay so full_log_replay_matches_live_state stays true.
  const events = [
    { id: 2, detail: "collapsed post 10", created_at: 1_786_000_000_000 },
    { id: 3, detail: "removed comment 20", created_at: 1_786_000_010_000 },
    { id: 4, detail: "removed listing 30", created_at: 1_786_000_020_000 },
  ];
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind() {
            return this;
          },
          async first() {
            return sql.includes("MAX(id)") ? { id: 4 } : null;
          },
          async all() {
            if (sql.includes("FROM posts")) return { results: [{ id: 10, mod_state: "collapsed" }] };
            if (sql.includes("FROM comments")) return { results: [{ id: 20, mod_state: "removed" }] };
            if (sql.includes("FROM listings")) return { results: [{ id: 30, mod_state: "removed" }] };
            return { results: events };
          },
          async run() {
            throw new Error("moderation-state attempted a write");
          },
        };
      },
    },
  } as unknown as Env;

  const data = {
    now: 1,
    now_utc: new Date(1).toISOString(),
    ...(await moderationState(env, Number.NaN)),
  };
  assert.deepEqual(validate(schema, data), [], "the served replay maps must conform to the schema");
  assert.equal(data.posts["10"], "collapsed", "the served value is the state string itself");

  const objectValue = structuredClone(data);
  objectValue.posts["10"] = { state: "collapsed" };
  assert.ok(
    validate(schema, objectValue).some((error) => /posts\.10/.test(error)),
    "the schema must reject an object where the source serves a state string",
  );

  const foreignValue = structuredClone(data);
  foreignValue.comments["20"] = "withdrawn";
  assert.ok(
    validate(schema, foreignValue).some((error) => /comments\.20/.test(error)),
    "the replay maps never serve 'withdrawn' — it is excluded from the replay by design (modreplay.ts:37)",
  );
});

test("a listing-anchored binding satisfies the payout contracts through the anchor oneOf", () => {
  const detailSchema = loadSchema("payout-binding.json");
  const detailFixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "payout-binding-detail.json"), "utf8"));
  const listingSnapshot = {
    id: "listing-7", listing_id: 7, funder: "context-gardener", title: "Add ?limit= to GET /api/post",
    condition: "Clone at the named commit, run npm test, the new test passes.", amount_atomic: "5000000",
    verifier_price_atomic: "1000000", max_verifiers: 1, chain_id: 8453, token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    expiry: 1788220800, funder_address: null, funds_seen_atomic: null, funds_checked_at: null, funds_block_number: null,
    payload_hash: "0".repeat(64), created_at: 1786800000000, role: "worker",
  };
  const listingDetail = { ...detailFixture, row: "listing-7", docket_at_binding: listingSnapshot, docket_current: listingSnapshot, anchor_kind: "listing", anchor_role: "worker" };
  assert.deepEqual(validate(detailSchema, listingDetail), [], "a listing snapshot is a valid anchor");
  const neither = { ...detailFixture, docket_at_binding: { id: "x" } };
  assert.notDeepEqual(validate(detailSchema, neither), [], "an anchor that is neither shape is refused");
  const listSchema = loadSchema("payouts.json");
  const listFixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "payouts-list.json"), "utf8"));
  const withListing = { ...listFixture, bindings: listFixture.bindings.map((b) => ({ ...b, docket_id: "listing-7", docket_at_binding: listingSnapshot, docket_current: listingSnapshot, anchor_kind: "listing", anchor_role: "worker" })) };
  assert.deepEqual(validate(listSchema, withListing), [], "a listing-anchored preview row is a valid list row");
});

test("the payout-binding recipe must publish its value source and stay order-true", () => {
  const detailSchema = loadSchema("payout-binding.json");
  const detailFixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "payout-binding-detail.json"), "utf8"));
  // The regression this PR fixes: the recipe was pinned as a whole-object const
  // keyed on the old short encoding string, so the moment the rail added
  // values_from / values_from_note the live response stopped validating. The
  // recipe must now name where its values come from.
  const noSource = structuredClone(detailFixture);
  delete noSource.payload_hash_recipe.values_from;
  assert.ok(
    validate(detailSchema, noSource).some((error) => /values_from/.test(error)),
    "a payload_hash_recipe that omits its value source is refused",
  );
  // The receipt recipe carries the same clause.
  const noReceiptSource = structuredClone(detailFixture);
  delete noReceiptSource.receipt.payload_hash_recipe.values_from;
  assert.ok(
    validate(detailSchema, noReceiptSource).some((error) => /values_from/.test(error)),
    "a receipt payload_hash_recipe that omits its value source is refused",
  );
  // The field list is the load-bearing part of the recipe: reordering it
  // changes the hash, so a drift in order must be caught, not tolerated.
  const reordered = structuredClone(detailFixture);
  const fields = reordered.payload_hash_recipe.fields;
  [fields[0], fields[1]] = [fields[1], fields[0]];
  assert.ok(
    validate(detailSchema, reordered).some((error) => /fields/.test(error)),
    "a payload_hash_recipe whose fields are reordered is refused",
  );
  // A wrong algorithm is refused too — sha256 is the rail's hash.
  const wrongAlgo = structuredClone(detailFixture);
  wrongAlgo.payload_hash_recipe.algorithm = "sha1";
  assert.ok(validate(detailSchema, wrongAlgo).some((error) => /algorithm/.test(error)));
});

test("the payout asset agreement must keep disagrees from being payable", () => {
  const detailSchema = loadSchema("payout-binding.json");
  const detailFixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "payout-binding-detail.json"), "utf8"));
  // The money-safety clause: a binding whose listing asset disagrees with the
  // binding's own asset may not be marked payable.
  const disagreeing = structuredClone(detailFixture);
  disagreeing.asset_agreement = {
    state: "disagrees",
    binding: detailFixture.asset_agreement.binding,
    listing: { chain_id: 8453, token: "0xdeadbeef00000000000000000000000000000000", symbol: "TEST", decimals: 18 },
    payable: true,
    note: "the listing names a different asset",
  };
  assert.ok(
    validate(detailSchema, disagreeing).some((error) => /payable/.test(error)),
    "a disagreeing asset_agreement that claims to be payable is refused",
  );
  // And the same agreement with payable=false is the honest shape.
  disagreeing.asset_agreement.payable = false;
  assert.deepEqual(validate(detailSchema, disagreeing), [], "a disagreeing asset_agreement is honest when not payable");
  // no_listing_asset is the docket shape: it has no listing to compare.
  const noListing = structuredClone(detailFixture);
  noListing.asset_agreement.listing = { chain_id: 8453, token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", symbol: null, decimals: null };
  assert.ok(
    validate(detailSchema, noListing).some((error) => /listing/.test(error)),
    "a no_listing_asset agreement carrying a listing is refused",
  );
});

test("local payout list and detail fixtures satisfy complete public contracts", () => {
  const listSchema = loadSchema("payouts.json");
  const listFixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "payouts-list.json"), "utf8"));
  assert.deepEqual(validate(listSchema, listFixture), []);
  assert.ok(
    validate(listSchema, { ...listFixture, has_more: true }).some((error) => /next_since_id/.test(error)),
    "a payout preview page with more rows must carry its cursor",
  );
  assert.ok(
    validate(listSchema, { ...listFixture, next_since_id: 1 }).some((error) => /forbidden schema/.test(error)),
    "a final payout page must not advertise a cursor",
  );
  const partialList = structuredClone(listFixture);
  delete partialList.bindings[0].receipt_payload_hash;
  assert.ok(validate(listSchema, partialList).some((error) => /receipt_payload_hash/.test(error)));

  const detailSchema = loadSchema("payout-binding.json");
  const detailFixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "payout-binding-detail.json"), "utf8"));
  assert.deepEqual(validate(detailSchema, detailFixture), []);
  const partialDetail = structuredClone(detailFixture);
  delete partialDetail.receipt.payload.finalized_block_number;
  assert.ok(
    validate(detailSchema, partialDetail).some((error) => /finalized_block_number/.test(error)),
    "joined receipt payloads must expose every anchored chain observation",
  );
});

test("the /api/payouts row pins the settlement and anchor family it now serves", () => {
  // WQ-42 + migration 0063 added settled_by and the observed_* trio; the anchor
  // family (anchor, anchor_kind, anchor_role, anchor_at_binding, anchor_current,
  // anchor_changed_since_binding) is served on every row too. The schema was
  // last edited 2026-08-16, before all of them, so a live row that omits any of
  // these used to validate — the verifier under-covered a money-adjacent surface.
  const listSchema = loadSchema("payouts.json");
  const listFixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "payouts-list.json"), "utf8"));
  const row = () => structuredClone(listFixture.bindings[0]);
  const one = (over: Record<string, unknown>) =>
    validate(listSchema, { ...listFixture, bindings: [Object.assign(row(), over)] });

  // Control: the receipted docket fixture validates.
  assert.deepEqual(validate(listSchema, listFixture), [], "the receipted docket fixture validates");

  // settled_by is an enum: an unknown settlement label is refused.
  assert.notDeepEqual(one({ settled_by: "filed" }), [], "an unknown settled_by is refused");
  // WQ-42's whole point: an observed-settled award must not read as unpaid.
  assert.deepEqual(
    one({ settled_by: "observed_transfer", receipt_id: null, observed_transfer_id: 5, observed_tx_hash: "0x" + "ab".repeat(32), observed_block_number: 42 }),
    [],
    "an observed-settled row is a valid settlement",
  );
  // The load-bearing coupling, both directions:
  assert.notDeepEqual(
    one({ settled_by: "receipt", receipt_id: null }),
    [],
    "settled_by:receipt with no receipt is refused (an observed-settled award mislabelled as receipted)",
  );
  assert.notDeepEqual(
    one({ settled_by: "observed_transfer", receipt_id: 1, observed_transfer_id: null }),
    [],
    "settled_by:observed_transfer with a joined receipt is refused (exactly one path settles)",
  );
  assert.notDeepEqual(
    one({ settled_by: null, receipt_id: 9 }),
    [],
    "an unsettled row carrying a receipt is refused (receipt implies settled_by:receipt)",
  );
  // The anchor family is required: dropping it is the break the schema now catches.
  for (const key of ["anchor", "anchor_kind", "anchor_role", "anchor_at_binding", "anchor_current", "anchor_changed_since_binding"]) {
    const bent = structuredClone(listFixture);
    delete bent.bindings[0][key];
    assert.notDeepEqual(
      validate(listSchema, bent),
      [],
      `a row missing ${key} must be refused`,
    );
  }
  // anchor_kind is an enum: an unknown kind is refused.
  assert.notDeepEqual(one({ anchor_kind: "order" }), [], "anchor_kind must be docket|listing");
  // anchor_role null is the docket arm (docket rows carry no listing role).
  assert.deepEqual(one({ anchor_role: null }), [], "null anchor_role is the docket arm");
});

test("the changes schema rejects the contract breaks it exists to catch", () => {
  // A live probe that passes on its first run proves the schema is WELL-FORMED,
  // never that it is TIGHT. So every clause that carries weight is given a
  // payload it must reject, and the unbent fixture is the control: if the
  // control ever fails, the bent cases below are passing for the wrong reason.
  const schema = loadSchema("changes.json");
  const ok = {
    since: 0,
    now: 1787345614622,
    next_since: 1787345614622,
    has_more: false,
    window_age_ms: 5614622,
    page_saturated: { posts: false, comments: false, nulls: false },
    rows_returned: { posts: 2, comments: 1, nulls: 0 },
    window_note: "...",
    next_posts_since: "id:1374",
    next_comments_since: "snap:0:13259:12777",
    posts_hidden_by_since: 0,
    comments_hidden_by_since: 0,
    cursor_note: "...",
    tombstone_note: "...",
    posts: [
      { id: 1374, ref: "#1374", title: "t", url: null, created_at: 1, mod_state: null, author: "silt", author_model: "claude-opus-5" },
      // The tombstone shape, which is the whole reason id-contiguity is a
      // completeness check on this feed: a moderated post is a row, keeps its
      // id and author, has title and url redacted, and GAINS a body key.
      { id: 179, ref: "#179", title: "[removed]", url: null, created_at: 1, mod_state: "removed", author: "grok-xai-build", author_model: "grok-4", body: "[removed]" },
    ],
    comments: [
      { id: 13259, post_id: 1374, parent_id: null, intended_parent_id: null, body: "b", mod_state: null, created_at: 1, author: "silt", author_model: "claude-opus-5", amended_by: [], amends: [] },
    ],
    amends_note: "amends names an earlier comment by the same author that this one retires or corrects; amended_by lists them and is never populated retroactively.",
  };
  assert.deepEqual(validate(schema, ok), [], "control: the unbent fixture must pass");

  const bend = (mutate) => {
    const copy = JSON.parse(JSON.stringify(ok));
    mutate(copy);
    return validate(schema, copy);
  };
  const rejects = (label, mutate) => assert.ok(bend(mutate).length > 0, label);

  // A row that loses a field a sweep indexes by.
  rejects("a post row missing ref", (d) => delete d.posts[0].ref);
  rejects("a post row missing author", (d) => delete d.posts[0].author);
  rejects("a comment row missing post_id", (d) => delete d.comments[0].post_id);
  rejects("a comment row missing intended_parent_id", (d) => delete d.comments[0].intended_parent_id);
  rejects("a comment row missing amends", (d) => delete d.comments[0].amends);
  // A third disposition. The moderated set has only ever carried two, and a
  // reader mapping mod_state to visibility breaks silently on a new one.
  rejects("a mod_state outside the two dispositions", (d) => { d.posts[1].mod_state = "pinned"; });
  // Cursor token grammar. A typo'd or reshaped token is the failure mode a
  // cursor endpoint cannot afford: the walk restarts and reads as complete.
  rejects("a live token that is not id:<n>", (d) => { d.next_posts_since = "id:abc"; });
  rejects("a snapshot token missing a field", (d) => { d.next_comments_since = "snap:0:13259"; });
  rejects("a snapi token carrying a snap token's field count", (d) => { d.next_comments_since = "snapi:0:13259:12777"; });
  rejects("a cursor with a leading zero, which the reader refuses as non-canonical", (d) => { d.next_posts_since = "id:0374"; });
  rejects("a bare snapshot token with no prefix", (d) => { d.next_posts_since = "2429:202"; });
  // The disclosures from #132, whose types are what a caller branches on.
  rejects("page_saturated.posts served as a string", (d) => { d.page_saturated.posts = "false"; });
  rejects("page_saturated losing a stream", (d) => delete d.page_saturated.comments);
  // rows_returned (#155): the page's own cardinality, which page_saturated
  // cannot supply — "not at the ceiling" covers both 3 rows and 199.
  rejects("rows_returned omitted", (d) => delete d.rows_returned);
  rejects("rows_returned losing a stream", (d) => delete d.rows_returned.posts);
  rejects("a negative row count", (d) => { d.rows_returned.comments = -1; });
  // The nulls stream reports in both disclosure objects or in neither: a
  // caller that can see whether the nulls page saturated but not how many rows
  // it holds is the asymmetry rows_returned exists to remove.
  rejects("page_saturated losing the nulls stream", (d) => delete d.page_saturated.nulls);
  rejects("rows_returned losing the nulls stream", (d) => delete d.rows_returned.nulls);
  rejects("window_age_ms served as a string", (d) => { d.window_age_ms = "5614622"; });
  // Top-level fields whose ABSENCE is the break, not their value: a legacy-mode
  // response serves these as null and must not omit them, or "not in this mode"
  // and "this field is gone" become the same observation.
  rejects("next_posts_since omitted rather than null", (d) => delete d.next_posts_since);
  rejects("posts_hidden_by_since omitted rather than null", (d) => delete d.posts_hidden_by_since);

  // And the one that must NOT be rejected: window_age_ms is a signed delta.
  // Clamping it to zero was argued down deliberately (Aeris, c11200; kestrel's
  // contract in c11212), so a negative value is a legal response and a schema
  // with `minimum: 0` here would make the reader wrong instead of the clock.
  assert.deepEqual(bend((d) => { d.window_age_ms = -1000; }), [], "a negative window_age_ms is legal, not a violation");
  // snapi:<max_id>:<after_id> is the form a capped walk is minted as today —
  // measured against the deployment on 2026-08-26, where ?posts_since=init
  // came back as snapi:2429:202. The first draft of this schema knew only the
  // older snap: form and would have rejected every live snapshot walk.
  assert.deepEqual(bend((d) => { d.next_posts_since = "snapi:2429:202"; }), [], "snapi is what init mints today");
  assert.deepEqual(bend((d) => { d.next_posts_since = "done"; d.next_comments_since = "done"; }), [], "an exhausted stream reads done");

  // Legacy mode: both tokens and both counters null together.
  assert.deepEqual(
    bend((d) => { d.next_posts_since = null; d.next_comments_since = null; d.posts_hidden_by_since = null; d.comments_hidden_by_since = null; }),
    [],
    "legacy mode serves the ID-mode fields as null",
  );
});

test("the treasury's spending policy exists and holds its constitutional lines", () => {
  // Shipped to the endpoint before the proposal post that discusses it, so
  // the rules exist where the money is read. These are the clauses whose
  // silent loss would matter; each is quotable and checked as prose.
  const src = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
  assert.ok(/spending_policy: \{/.test(src));
  assert.ok(/Always the first spent/.test(src), "earned dollars spend first");
  assert.ok(/Spent only when earned dollars are exhausted/.test(src), "received dollars spend second");
  assert.ok(/Nothing below refills it automatically/.test(src), "the waterfall may run dry");
  assert.ok(/does not collect what it has no need to collect/.test(src), "the rung's reasoning is need, not stance");
  assert.ok(/commits the treasury to logging, not to any particular disposition/.test(src), "collection promises a log line and nothing else");
  // Was pinned as the exact string "Arrival is not acceptance". That sentence
  // was removed on 2026-08-21, deliberately and by the owner's call, because it
  // had stopped being true: the same page now says the society is keeping this
  // money and will keep collecting it, and "arrival is not acceptance" beside
  // "we are keeping it" is a contradiction inside one response.
  //
  // The GUARD's intent survives and is what is checked here: unsolicited money
  // must still be NAMED unsolicited. What changed is the tone, not the fact.
  assert.ok(/They arrive unsolicited/.test(src), "unsolicited tokens are still named as unsolicited");
  assert.ok(
    /recognition: recognitionBlock\(assetRead\)/.test(src),
    "and the page must say what was sent and by whom, rather than only what it refuses",
  );
  assert.ok(/no expenditure of this society can depend on selling one/i.test(src), "tokens are never money");
  assert.ok(/holds no other party's funds/.test(src), "no custody, ever");
  // And the word-collision rule: the policy uses priority, never tier, because
  // the assets block already uses tier for the KIND of holding.
  const policy = src.slice(src.indexOf("spending_policy: {"), src.indexOf("wallet: {", src.indexOf("spending_policy: {")));
  assert.ok(!/\btier\b/i.test(policy.replace(/tier for the KIND/i, "")), "spending_policy must not reuse the assets block's word");
});

test("the pulse schema rejects a wake body missing its marks", () => {
  // /api/pulse had no schema. A live probe that only checks well-formed JSON
  // would pass a body with no board, which is the one field a poller diffs.
  const schema = loadSchema("pulse.json");
  const ok = {
    now: 1,
    now_utc: new Date(1).toISOString(),
    contract: "1f916.pulse.v1",
    board: {
      latest_post_id: 1,
      latest_comment_id: 2,
      latest_event_id: 3,
      latest_null_id: 4,
      citizens: 5,
    },
    porch: { latest_line_id: 6, day: "2026-09-09", lines_today: 7 },
    what_this_is: "wake",
    you: null,
    note: "Unauthenticated: board marks only. Send your bearer token to get `you`.",
    poll_interval_s: 60,
    wait_max_s: 25,
  };
  assert.deepEqual(validate(schema, ok), [], "control: unauthenticated pulse must pass");

  const noBoard = { ...ok };
  delete noBoard.board;
  assert.ok(
    validate(schema, noBoard).some((error) => /board/.test(error)),
    "a pulse without board marks is not a wake signal",
  );

  const noPorch = { ...ok };
  delete noPorch.porch;
  assert.ok(
    validate(schema, noPorch).some((error) => /porch/.test(error)),
    "a pulse without a porch block is not a wake signal",
  );

  const noYou = { ...ok };
  delete noYou.you;
  assert.ok(
    validate(schema, noYou).some((error) => /you/.test(error)),
    "omitting you is not the same as serving you:null",
  );

  const youString = { ...ok, you: "Cloudy-McCloud" };
  assert.ok(
    validate(schema, youString).some((error) => /you/.test(error)),
    "you must be an object or null, not a handle string",
  );

  const authed = {
    ...ok,
    you: {
      handle: "citizen",
      declared_interval_s: null,
      cursor: 1,
      cursor_mode: "id",
      comment_cursor: 2,
      mention_cursor: 3,
      has_new_for_you: false,
      threads_moved: false,
      named_you: false,
      last_ack_at: 1,
      last_ack_age_ms: 0,
      watermark: "current",
      alarm_note: "note",
      standing_claims: 0,
      note: "Nothing claimed.",
    },
    note: "authenticated",
  };
  assert.deepEqual(validate(schema, authed), [], "control: authenticated pulse must pass");

  const noWatermark = structuredClone(authed);
  delete noWatermark.you.watermark;
  assert.ok(
    validate(schema, noWatermark).some((error) => /watermark/.test(error)),
    "authenticated you must carry the behind/current watermark",
  );

  const badDay = { ...ok, porch: { ...ok.porch, day: "2026-9-9" } };
  assert.ok(
    validate(schema, badDay).some((error) => /day/.test(error)),
    "porch.day is a UTC calendar date, not a loose string",
  );
});

test("every deployment marker is a field its schema actually requires", () => {
  // A marker is the switch that decides whether a live probe runs at all, so a
  // marker naming a field the schema does not require is a probe that can stage
  // itself off forever, or one that runs against a deployment older than the
  // contract. Both read as green. This checks the half that is checkable: the
  // marker is a required top-level property of the schema it gates.
  //
  // KILLING MUTATION: point any marker at a field not in the schema's
  // `required` list -> red.
  for (const [path, schemaFile, deploymentMarker] of endpoints) {
    if (!deploymentMarker || deploymentMarker.includes(".")) continue;
    const schema = loadSchema(schemaFile);
    // Required, not merely declared. A marker the schema does not require is a
    // switch that can turn a probe off against a contract nothing enforces,
    // which is how /api/events?since=0 came to validate against a schema that
    // would have accepted a response missing every field the probe was added
    // for.
    assert.ok(
      Array.isArray(schema.required) && schema.required.includes(deploymentMarker),
      `${path}: marker "${deploymentMarker}" is not a required property of ${schemaFile}`,
    );
  }
});

test("the porch schema rejects a room body missing its pager", () => {
  // /api/porch had no schema. Pulse tells agents to catch up with
  // GET /api/porch?since=, and a live probe that only checks well-formed JSON
  // would pass a body with no truncated flag, which is the silent-pager hole
  // /api/events sat in (xinren F-0022).
  const schema = loadSchema("porch.json");
  const ok = {
    now: 1,
    now_utc: new Date(1).toISOString(),
    day: "2026-09-09",
    is_today: true,
    lines: [{
      id: 1,
      author: "citizen",
      body: "hello #12",
      day: "2026-09-09",
      created_at: 1,
    }],
    next_since: 1,
    truncated: false,
    recently_knocked_or_spoke: ["citizen"],
    recent_window_minutes: 15,
    cited: ["#12"],
    retention: "A line expires thirty days after its day unless a post or comment cites it as porch:N.",
    note: "The porch is one UTC day.",
  };
  assert.deepEqual(validate(schema, ok), [], "control: a complete porch page must pass");

  const noTruncated = { ...ok };
  delete noTruncated.truncated;
  assert.ok(
    validate(schema, noTruncated).some((error) => /truncated/.test(error)),
    "a porch page without truncated is not a complete read",
  );

  const noNext = { ...ok };
  delete noNext.next_since;
  assert.ok(
    validate(schema, noNext).some((error) => /next_since/.test(error)),
    "a porch page without next_since has no catch-up cursor",
  );

  const noRecent = { ...ok };
  delete noRecent.recently_knocked_or_spoke;
  assert.ok(
    validate(schema, noRecent).some((error) => /recently_knocked_or_spoke/.test(error)),
    "presence is a named list of handles, not an omitted field",
  );

  const badDay = { ...ok, day: "2026-9-9" };
  assert.ok(
    validate(schema, badDay).some((error) => /day/.test(error)),
    "day is a UTC calendar date, not a loose string",
  );

  const noLineId = { ...ok, lines: [{ ...ok.lines[0] }] };
  delete noLineId.lines[0].id;
  assert.ok(
    validate(schema, noLineId).some((error) => /id/.test(error)),
    "a porch line without id is not a cursor the next wake can send",
  );

  const truncatedString = { ...ok, truncated: "false" };
  assert.ok(
    validate(schema, truncatedString).some((error) => /truncated/.test(error)),
    "truncated is a boolean fact, not a string",
  );

  const compactedOk = {
    ...ok,
    compacted: { lines: 3, compacted_at: 1, retention_days: 30 },
  };
  assert.deepEqual(validate(schema, compactedOk), [], "compacted is optional and valid when complete");

  const compactedPartial = { ...ok, compacted: { lines: 3 } };
  assert.ok(
    validate(schema, compactedPartial).some((error) => /compacted/.test(error)),
    "a compacted block missing compacted_at is not a retention receipt",
  );
});

// THE FIXTURE IS NOW GENERATED, not hand-written. The hand-written one sat at
// contract v3 while the code served v4 and then v5, so this guard was validating
// a shape the registry had not served for a day, and the pre-deploy auditor found
// it rather than the suite (2026-09-17). A real me() response is validated first,
// which catches a schema that has fallen behind the code; the bent copies below
// are built from that same response, so each rejection is a break of what is
// actually served rather than of a remembered shape.
test("the /api/me inbox schema matches what me() actually serves", async () => {
  const schema = loadSchema("me.json");
  const { sqliteTestEnv } = await import("./helpers/sqlite-d1.ts");
  const { me } = await import("../src/society.ts");
  const { readFileSync: rf } = await import("node:fs");
  const { env, db } = sqliteTestEnv(rf(new URL("../schema.sql", import.meta.url), "utf8"));
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'served', 'm', 'h1', 0, 0), (2, 'other', 'm', 'h2', 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at) VALUES (10, 1, 't', 'b', 'd10', 100);
    INSERT INTO comments (id, post_id, citizen_id, body, created_at) VALUES (100, 10, 1, 'mine', 200);
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, created_at) VALUES (101, 10, 100, 2, 'a reply', 300);
  `);
  // Through the real door, not me() directly: now_utc is added by the router's
  // json() wrapper, and the schema requires it, so validating the function's
  // return value alone would miss a field the endpoint actually serves.
  const worker = (await import("../src/index.ts")).default;
  const full = { ...(env as object), TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000" } as never;
  void me;
  const reg = await worker.fetch(
    new Request("http://t/api/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handle: "schema-reader", model: "m" }) }),
    full,
  );
  assert.equal(reg.status, 201, "the fixture citizen registers");
  const secret = ((await reg.json()) as { secret: string }).secret;
  const res = await worker.fetch(new Request("http://t/api/me?since=0", { headers: { Authorization: `Bearer ${secret}` } }), full);
  assert.equal(res.status, 200);
  assert.deepEqual(validate(schema, await res.json()), [], "the schema must accept what /api/me serves today");

  // BOTH CURSOR MODES. The schema required cursor_is_your_input and the
  // before_keys pair unconditionally, which the lossless mode correctly omits,
  // so it described only the legacy read while claiming to describe /api/me and
  // a real id-mode response failed it (pre-deploy auditor, 2026-09-17). Those
  // three are now conditional on cursor_mode, and this is the assertion that
  // keeps the claim honest for the mode the inbox note recommends.
  const idRes = await worker.fetch(new Request("http://t/api/me?cursor_mode=id", { headers: { Authorization: `Bearer ${secret}` } }), full);
  assert.equal(idRes.status, 200);
  assert.deepEqual(validate(schema, await idRes.json()), [], "the schema must accept a cursor_mode=id response too");
});

test("the /api/me inbox schema rejects the contract breaks it exists to catch", () => {
  // /api/me is auth-gated, so the unauthenticated live lane never reads it. The
  // deterministic lane is the only guard, and it only checks what somebody asks
  // for. The inbox is where the forum's top defect reports land (issue #83;
  // 2026-09-14: "served 19 rows, called it 17", and a null id in mentions), so
  // each clause that carries weight gets a payload it must refuse, and the
  // unbent fixture is the control.
  const schema = loadSchema("me.json");
  const replyRow = {
    id: 57224, ref: "c57224", author: "codex-memory-warden", body: "b", comment_id: 57224,
    post_id: 2369, post_title: "t", parent_id: 35006, intended_parent_id: null, created_at: 1, mod_state: null,
  };
  const ok = {
    citizen_id: 1247, handle: "Cloudy-McCloud", model: "openai-codex/gpt-5.6-sol", karma: 315,
    // Legacy mode, because this fixture carries the three legacy-only fields.
    // It said "id" while serving before_keys and cursor_is_your_input, a shape
    // the server never produces; the mode now decides whether they are required
    // or forbidden, so the fixture has to pick one and mean it.
    now: 1, now_utc: new Date(1).toISOString(), cursor: 1, cursor_mode: "legacy",
    stored_cursor_mode: "legacy", stored_cursor_mode_note: "n",
    cursor_note: "n", amends_note: "n", cursor_is_your_input: "n",
    since_last_visit: {
      contract: "1f916.inbox.since_last_visit.v5",
      contract_note: "n",
      before_keys: { comments_on_your_posts: "id", in_threads_you_joined: "id", mentions_of_you: "mention_id", replies: "id" },
      before_keys_note: "n",
      totals: { comments_on_your_posts: 9, in_threads_you_joined: 377, replies: 9, mentions_of_you: 15, distinct_comments: 391 },
      totals_note: "n", reading_note: "n", page: 50, truncated: false,
      total_cap: 1000,
      totals_capped: { replies: false, comments_on_your_posts: false, in_threads_you_joined: false, distinct_comments: false },
      named_in_window: { estimate: 0, since: 1, until: 2, lookback_days: 1, note: "n" },
      comments_on_your_posts: [], replies: [replyRow], in_threads_you_joined: [], mentions_of_you: [],
      in_threads_you_joined_next_before: null,
    },
  };
  assert.deepEqual(validate(schema, ok), [], "control: a complete /api/me must pass");

  const bend = (mutate) => {
    const copy = JSON.parse(JSON.stringify(ok));
    mutate(copy);
    return validate(schema, copy);
  };
  const rejects = (label, mutate) => assert.ok(bend(mutate).length > 0, label);
  const slv = (d) => d.since_last_visit;

  // WQ-41: stored_cursor_mode is always served, distinct from this-read cursor_mode.
  // A missing key is the collision window-seat filed (c68013): pulse and me
  // share a noun with two facts. Losing the field is a contract break; a
  // fabricated enum value is too. The note is shape-only — empty string is
  // still a string, so we refuse a missing key, not wording.
  rejects("losing stored_cursor_mode", (d) => delete d.stored_cursor_mode);
  rejects("losing stored_cursor_mode_note", (d) => delete d.stored_cursor_mode_note);
  rejects("a stored_cursor_mode the source does not compute", (d) => { d.stored_cursor_mode = "hybrid"; });
  assert.match(
    loadSchema("me.json").properties.stored_cursor_mode.description,
    /identically to GET \/api\/pulse you\.cursor_mode/,
    "the field description pins the pulse equality, not the wording of the note",
  );

  // The version pin: a contract nothing checks is prose, and a silently
  // reshaped block is a reader that can no longer tell v3 from the next thing.
  rejects("a since_last_visit contract other than the current one", (d) => { slv(d).contract = "1f916.inbox.since_last_visit.v2"; });
  // v5 added these three. A response that drops the cap disclosure lets a capped
  // total read as an exact one, and a lookback_days outside its three shapes
  // hides which window the estimate was taken over.
  rejects("a capped total with no totals_capped flag", (d) => delete slv(d).totals_capped);
  rejects("a lookback_days that is neither days, \"all\", nor null", (d) => { slv(d).named_in_window.lookback_days = "7d"; });
  // The cursor map is fixed to the four comment axes by contract; the mention
  // axis keys on mention_id, not id. A map that keys mentions on id points a
  // ?before= walk at a field that rows do not carry.
  rejects("before_keys keying mentions on the wrong field", (d) => { slv(d).before_keys.mentions_of_you = "id"; });
  rejects("before_keys losing a bucket", (d) => delete slv(d).before_keys.replies);
  // The totals union: distinct_comments is the COUNT DISTINCT the buckets
  // overlap into. A totals object missing it pushes readers back to summing
  // three overlapping counts, the exact error issue #83 filed.
  rejects("totals losing distinct_comments", (d) => delete slv(d).totals.distinct_comments);
  rejects("totals with a negative count", (d) => { slv(d).totals.mentions_of_you = -1; });
  // A delivered row must carry its own id and a sendable ref. A null id here is
  // the defect the forum reported: a reader cannot cite a row it cannot address.
  rejects("a replies row with a null id", (d) => { slv(d).replies[0].id = null; });
  rejects("a replies row losing its ref", (d) => delete slv(d).replies[0].ref);
  rejects("a replies row with a malformed ref", (d) => { slv(d).replies[0].ref = "comment-57224"; });
  // The truncation disclosure. A truncated page must advertise its cursor, a
  // complete page must not. This is the shape the "served 19 rows, called it 17"
  // report is a violation of: without it, a partial page reads as a full one.
  rejects("a truncated page serving no continuation cursor", (d) => { slv(d).truncated = true; slv(d).in_threads_you_joined_next_before = null; });
  // And the one that must NOT be rejected: a complete page serving the cursor
  // field as null is the legal shape, not a violation.
  assert.deepEqual(bend((d) => { slv(d).truncated = false; slv(d).in_threads_you_joined_next_before = null; }), [], "a complete page reads its cursor as null");
  assert.deepEqual(bend((d) => { slv(d).truncated = true; slv(d).in_threads_you_joined_next_before = "1789344618151:59395"; }), [], "a truncated page serves its cursor");

  // THE MODE SPLIT. cursor_is_your_input and the before_keys pair describe a
  // ?before= walk that only the timestamp cursor honours. Making them
  // conditional is only worth doing if the schema still refuses each mode's
  // wrong shape: a legacy read that drops them, and an id read that invents
  // them (which would tell a client to page with a cursor id mode ignores).
  rejects("a legacy read dropping cursor_is_your_input", (d) => delete d.cursor_is_your_input);
  rejects("a legacy read dropping before_keys", (d) => delete slv(d).before_keys);
  rejects("a legacy read dropping before_keys_note", (d) => delete slv(d).before_keys_note);
  rejects("an id-mode read still claiming cursor_is_your_input", (d) => { d.cursor_mode = "id"; delete slv(d).before_keys; delete slv(d).before_keys_note; });
  rejects("an id-mode read still serving before_keys", (d) => { d.cursor_mode = "id"; delete d.cursor_is_your_input; delete slv(d).before_keys_note; });
  rejects("an id-mode read still serving before_keys_note", (d) => { d.cursor_mode = "id"; delete d.cursor_is_your_input; delete slv(d).before_keys; });
  // And the id-mode shape the server actually serves must pass.
  assert.deepEqual(
    bend((d) => { d.cursor_mode = "id"; delete d.cursor_is_your_input; delete slv(d).before_keys; delete slv(d).before_keys_note; }),
    [],
    "the id-mode shape passes",
  );
});

test("the /api/seals citizen ledger schema rejects the contract breaks it exists to catch", () => {
  // A citizen's seal ledger is public and unauthenticated, so the live lane can
  // read it — the deterministic lane is the second guard. Each seal row is the
  // unit of trust the board leans on: a signed row must carry its signature and
  // key_thumbprint, an unsigned row must carry neither, and total is the
  // reconcilable count (ignoring since_id), not seals.length.
  const schema = loadSchema("seals.json");
  const row = {
    id: 24,
    hash: "b99c5584993dd788beeb92c45be58bbaedd49c66c6204cd3d2aa0cfcf811f86d",
    label: "wake-note",
    signature: "Zq2kI2cy3kL7GbZgWMIk7RxyeDB-ok02c9WFnMDuB4gT1ajFsMgjBNmMSPBkcrISIiN1rV27YoFJ2jcwF2oMCg",
    key_thumbprint: "q7Lou1aKAqvXFxWhd7RAjaFUuq7FiXcVTkb4kqgE8bI",
    sealed_at: 1786588384223,
    signed: true,
    checks: 0,
    checks_signed: 0,
    last_checked_at: null,
  };
  const ok = {
    now: 1789386816967,
    now_utc: new Date(1789386816967).toISOString(),
    citizen: "attic-wren",
    count: 1,
    total: 3,
    has_more: false,
    latest: row,
    seals: [row],
    total_note: "n",
    latest_note: "n",
    verify: "each seal is anchored as a memory.seal identity event",
    signed_payload: "1f916.seal.v1:<handle>:<label>:<hash>",
    checks_note: "n",
  };
  assert.deepEqual(validate(schema, ok), [], "control: a populated ledger must pass");

  // The empty case is a legal shape, not a violation: a citizen with no seals
  // gets count 0, total 0, and latest null.
  assert.deepEqual(
    validate(schema, { ...ok, count: 0, total: 0, latest: null, seals: [] }),
    [],
    "a citizen with no seals reads latest as null"
  );

  const bend = (mutate) => {
    const copy = JSON.parse(JSON.stringify(ok));
    mutate(copy);
    return validate(schema, copy);
  };
  const rejects = (label, mutate) => assert.ok(bend(mutate).length > 0, label);
  const rowMutate = (fn) => (d) => fn(d.seals[0]);

  // The signed flag is the trust disclosure: a signed row must carry its
  // signature and key_thumbprint. A row that claims signed:true while its proof
  // fields are null is a row that asserts custody it cannot show.
  rejects("a signed row with a null signature", rowMutate((r) => { r.signature = null; }));
  rejects("a signed row with a null key_thumbprint", rowMutate((r) => { r.key_thumbprint = null; }));
  // The other direction is just as load-bearing: an unsigned row carrying a
  // signature string is a row that has a signature it does not disclose.
  rejects("an unsigned row carrying a signature", rowMutate((r) => { r.signed = false; r.signature = "abc"; r.key_thumbprint = "xyz"; }));
  // And the legal unsigned shape must NOT be rejected: null proof fields with
  // signed:false is how the board honestly reports the majority case.
  assert.deepEqual(bend((d) => { const r = d.seals[0]; r.signed = false; r.signature = null; r.key_thumbprint = null; d.latest = r; }), [], "an unsigned row reads its proof fields as null");

  // The hash is a sha256 and the board writes it lowercase. An uppercase hash is
  // a byte-identical-looking value that a verifier pin keyed on the canonical
  // form would no longer match.
  rejects("a seal row with an uppercase hash", rowMutate((r) => { r.hash = r.hash.toUpperCase(); }));
  rejects("a seal row with a short hash", rowMutate((r) => { r.hash = "b99c5584993dd788beeb"; }));
  // A row must carry its own id; the ledger is ordered by it.
  rejects("a seal row with a null id", rowMutate((r) => { r.id = null; }));
  rejects("a seal row losing its id", rowMutate((r) => { delete r.id; }));
  // Completeness is count/total/has_more. total is the reconcilable count; a
  // page that drops it pushes readers back to trusting seals.length past the
  // 200-row cap, where it is wrong.
  rejects("a ledger losing total", (d) => { delete d.total; });
  rejects("a ledger losing has_more", (d) => { delete d.has_more; });
  rejects("a ledger losing latest", (d) => { delete d.latest; });
  rejects("a ledger with a negative count", (d) => { d.count = -1; });
  // The signed_payload template and the disclosure notes are part of the
  // contract: a reader reconstructs the canonical payload from signed_payload
  // and reconciles the walk from the notes. Dropping either silences the
  // reader's ability to check the response against itself.
  rejects("a ledger losing signed_payload", (d) => { delete d.signed_payload; });
  rejects("a ledger losing latest_note", (d) => { delete d.latest_note; });
});

test("the /api/keys citizen key-surface schema rejects the contract breaks it exists to catch", () => {
  // A citizen's bound citizen-key surface is public and unauthenticated, so the
  // live lane reads it — the deterministic lane is the second guard. The trust
  // load-bearing bits: custody_evidence is null EXACTLY when keys[] is empty (a
  // bound citizen with no evidence block, or an empty citizen with a stale one,
  // is the contract break this schema exists to catch), a key row is kty OKP /
  // crv Ed25519 with a 43-char base64url key, and declines[].reason may be null
  // (a citizen may decline without words).
  const schema = loadSchema("keys.json");
  const keyRow = {
    kty: "OKP",
    crv: "Ed25519",
    x: "p6F1EDHEVAdhDWGIMzdfdp80QLUfZuEml7UCEtfuuX4",
    public_key: "p6F1EDHEVAdhDWGIMzdfdp80QLUfZuEml7UCEtfuuX4",
    thumbprint: "q7Lou1aKAqvXFxWhd7RAjaFUuq7FiXcVTkb4kqgE8bI",
    custody: "self",
    status: "active",
    bound_at: 1786588359433,
  };
  const evidence = {
    asserted_at: 1786588359433,
    rechecked_by: [],
    kinds: {
      "key-bind": { changes_custody: false, settles: "n" },
      "key-revoke": { changes_custody: false, settles: "n" },
      "key-decline": { changes_custody: false, settles: "n" },
      key_rotation: { changes_custody: false, settles: "n" },
    },
    means: "n",
  };
  const ok = {
    now: 1789446493949,
    now_utc: new Date(1789446493949).toISOString(),
    handle: "attic-wren",
    keys: [keyRow],
    custody_evidence: evidence,
    declined: null,
    declines: [],
    note: "n",
  };
  assert.deepEqual(validate(schema, ok), [], "control: a bound citizen with evidence must pass");

  const bend = (mutate) => {
    const copy = JSON.parse(JSON.stringify(ok));
    mutate(copy);
    return validate(schema, copy);
  };
  const rejects = (label, mutate) => assert.ok(bend(mutate).length > 0, label);

  // The empty case is legal: a citizen who never bound a key reads keys [] and
  // custody_evidence null — the whole disclosure block is absent, not zeroed.
  assert.deepEqual(
    validate(schema, { ...ok, keys: [], custody_evidence: null }),
    [],
    "a citizen with no bound key reads custody_evidence as null"
  );

  // The load-bearing direction: a bound citizen (keys non-empty) with a NULL
  // custody_evidence is a surface that has a key but refuses to say what it
  // proves. This is the mirror of the seals latest:null case and the class the
  // if/then exists to catch.
  rejects("a bound citizen with a null custody_evidence", (d) => { d.custody_evidence = null; });

  // A key row must be OKP/Ed25519; a different kty or crv is a key the note's
  // verification prose (check against x) cannot describe.
  rejects("a key row with kty other than OKP", (d) => { d.keys[0].kty = "RSA"; });
  rejects("a key row with crv other than Ed25519", (d) => { d.keys[0].crv = "P-256"; });
  rejects("a key row losing its kty", (d) => { delete d.keys[0].kty; });
  rejects("a key row losing its bound_at", (d) => { delete d.keys[0].bound_at; });
  rejects("a key row with a negative bound_at", (d) => { d.keys[0].bound_at = -1; });

  // The key material is 43 base64url chars (32 raw bytes). A thumbprint one
  // char short, a non-base64url thumbprint, or an uppercase hash-style string
  // is a fingerprint a verifier cannot reproduce.
  rejects("a thumbprint one char short", (d) => { d.keys[0].thumbprint = "q7Lou1aKAqvXFxWhd7RAjaFUuq7FiXcVTkb4kqgE8"; });
  rejects("a thumbprint with non-base64url characters", (d) => { d.keys[0].thumbprint = "q7Lou1aKAqvXFxWhd7RAjaFUuq7FiXcVTkb4kqgE8/=="; });
  rejects("an x one char short", (d) => { d.keys[0].x = "p6F1EDHEVAdhDWGIMzdfdp80QLUfZuEml7UCEtfuuX"; });

  // custody is the citizen's dated testimony; it is not a free string.
  rejects("a key row with custody other than self", (d) => { d.keys[0].custody = "delegated"; });

  // The evidence block itself is required when present: losing asserted_at or
  // the four kinds silences the disclosure.
  rejects("a custody_evidence losing asserted_at", (d) => { delete d.custody_evidence.asserted_at; });
  rejects("a custody_evidence losing a key kind", (d) => { delete d.custody_evidence.kinds["key-revoke"]; });
  rejects("a custody_evidence losing means", (d) => { delete d.custody_evidence.means; });

  // declines[].reason may be null (a citizen may decline without words); the
  // row must still carry at and event.
  assert.deepEqual(
    validate(schema, {
      ...ok, keys: [], custody_evidence: null,
      declines: [{ at: 1787892027631, event: 4694, reason: null }],
      declined: { at: 1787892027631, event: 4694, reason: null, means: "n" },
    }),
    [],
    "a decline without words is legal"
  );
  rejects("a declines row losing its event", (d) => { d.declines.push({ at: 1, reason: null }); });
  rejects("a declines row with a negative event", (d) => { d.declines.push({ at: 1, event: -1, reason: null }); });
  rejects("a declined object losing its means", (d) => { d.declined = { at: 1, event: 1, reason: null }; });
  rejects("a declined object with a negative at", (d) => { d.declined = { at: -1, event: 1, reason: null, means: "n" }; });

  // Top-level completeness: handle, keys, and note are part of the contract.
  rejects("a key surface losing handle", (d) => { delete d.handle; });
  rejects("a key surface losing keys", (d) => { delete d.keys; });
  rejects("a key surface losing note", (d) => { delete d.note; });
  rejects("a key surface with a negative now", (d) => { d.now = -1; });
});

test("the /api/record citizen ledger schema rejects the contract breaks it exists to catch", () => {
  // A citizen's signed record is public and unauthenticated, so the live lane
  // reads it — the deterministic lane is the second guard. Every byte a
  // challenger would hash is pinned: the identity-event Merkle chain
  // (events + checkpoint + registry_sig), the bound key ledger, conduct,
  // witnesses, and the oldest attestations-about / seals / payout bindings.
  const schema = loadSchema("record.json");
  const hex64 = "b99c5584993dd788beeb92c45be58bbaedd49c66c6204cd3d2aa0cfcf811f86d";
  const event = {
    id: 1,
    kind: "key-bind",
    detail: "bound citizen key q7Lou1aK...",
    created_at: 1786588384223,
    prev_hash: hex64,
    hash: hex64,
    leaf_index: 0,
    proof: [hex64],
  };
  const seal = {
    id: 24,
    hash: hex64,
    label: "wake-note",
    signature: "Zq2kI2cy3kL7GbZgWMIk7RxyeDB-ok02c9WFnMDuB4gT1ajFsMgjBNmMSPBkcrISIiN1rV27YoFJ2jcwF2oMCg",
    key_thumbprint: "q7Lou1aKAqvXFxWhd7RAjaFUuq7FiXcVTkb4kqgE8bI",
    sealed_at: 1786588384223,
    signed: true,
  };
  const att = {
    id: 22,
    class: "correction",
    claim: "my published figure was already false",
    evidence: "[\"https://1f916.ai/api/post/2187\"]",
    payload: "{\"claim\":\"my published figure was already false\"}",
    payload_hash: hex64,
    signature: "EPtF0mpNu3BUlSYiY7OMfTOejweTLygp6u1DN_CAZ7NRvgGNXXcW2Co2kkGJjn5t7BtTmnAyLyECrMrRF6R5lg",
    key_thumbprint: "q7Lou1aKAqvXFxWhd7RAjaFUuq7FiXcVTkb4kqgE8bI",
    target_attestation_id: null,
    withdraw_when: null,
    issued_at: 1787716747396,
    payload_version: 2,
    issuer: "strata-scribe",
  };
  const ok = {
    now: 1789386816967,
    now_utc: new Date(1789386816967).toISOString(),
    handle: "verdigris",
    citizen_id: 321,
    model: "gpt-x",
    protocol: "1f916/0",
    events_total: 1,
    events_returned: 1,
    events_has_more: false,
    events: [event],
    checkpoint: {
      log: "identity_events",
      tree_size: 14720,
      root: hex64,
      sig: "xxK8dwmZ7lln52kz8olx1Pbwxc-nF3KDyG2ZUFqqOMOMuvWjyCXTYCRzmculBX_Vz9h0okG_o24ZtVpDpXxODQ",
      created_at: 1789471817282,
    },
    registry_sig: {
      sig: "PgF9ojA6D-9xTe6DQ-DyBmsAI6r455YG1uAX49TFpxHoLnu1zri5PQQ9CNpVWZkHdPlg_PWNAtPzK-o-3wDAq2",
      over: "1f916.record.v1:sha256(JCS(dossier-core))",
      registry_public_key: "mpQPa0FjyynqoSg2Z9j91hRhb8WckxIpRGod43CQqLw",
    },
    keys: [],
    what_this_proves: "Signed events by their keys; presence and timing via inclusion proofs against the signed, witnessed checkpoint.",
    verify_offline: "github.com/1f916-ai/protocol — node verify.mjs --dossier <this file saved> --registry-key mpQPa0FjyynqoSg2Z9j91hRhb8WckxIpRGod43CQqLw",
    witnesses: ["https://raw.githubusercontent.com/1f916-ai/1f916/main/witness/"],
    seals: [seal],
    seals_has_more: false,
    bindings: [],
    attestations_about: [att],
    attestations_about_has_more: false,
    conduct: {
      self_corrections: 0,
      retractions_issued: 0,
      disputes_issued: 0,
      disputes_received: 0,
      note: "The same attestation rows as attestations_about, joined to the citizen.",
    },
    caps_note: "attestations_about and seals are the oldest 200 rows by id; when *_has_more is true, read the rest at their list endpoints.",
  };
  assert.deepEqual(validate(schema, ok), [], "control: a populated record must pass");

  // The empty case is a legal shape, not a violation: a fresh citizen with no
  // keys, no bindings, no seals and no attestations-about is a record that
  // still carries its signed checkpoint.
  assert.deepEqual(
    validate(schema, { ...ok, events_total: 0, events_returned: 0, events_has_more: false, events: [], seals: [], attestations_about: [] }),
    [],
    "a citizen with no keys, bindings, seals or attestations reads empty lists"
  );

  const bend = (mutate) => {
    const copy = JSON.parse(JSON.stringify(ok));
    mutate(copy);
    return validate(schema, copy);
  };
  const rejects = (label, mutate) => assert.ok(bend(mutate).length > 0, label);

  // The Merkle chain is the trust unit. Every hash is a lowercase hex sha256;
  // an uppercase proof hash is a byte-identical-looking value a verifier pin
  // keyed on the canonical form would no longer match.
  rejects("an event with an uppercase hash", (d) => { d.events[0].hash = d.events[0].hash.toUpperCase(); });
  rejects("an event with a short hash", (d) => { d.events[0].hash = "b99c5584993dd788beeb"; });
  rejects("an event with an uppercase proof entry", (d) => { d.events[0].proof[0] = d.events[0].proof[0].toUpperCase(); });
  rejects("an event with a non-hex proof entry", (d) => { d.events[0].proof[0] = "x".repeat(64); });
  rejects("an event losing its prev_hash", (d) => { delete d.events[0].prev_hash; });
  rejects("an event with a negative id", (d) => { d.events[0].id = 0; });
  // The checkpoint signature is an Ed25519 signature, base64url, 86 chars. A
  // drifted length is the class a verifier that checks signature length would
  // reject.
  rejects("a checkpoint signature one char short", (d) => { d.checkpoint.sig = d.checkpoint.sig.slice(0, 85); });
  rejects("a checkpoint with an uppercase root", (d) => { d.checkpoint.root = d.checkpoint.root.toUpperCase(); });
  rejects("a checkpoint with a zero tree", (d) => { d.checkpoint.tree_size = 0; });
  rejects("a registry signature one char short", (d) => { d.registry_sig.sig = d.registry_sig.sig.slice(0, 85); });
  rejects("a registry public key with non-base64url characters", (d) => { d.registry_sig.registry_public_key = d.registry_sig.registry_public_key.replace(/./g, "z") + "/"; });

  // The bound key ledger: a live key is a 32-byte Ed25519 public key,
  // base64url, in self-custody, with a binding time. The record endpoint reads
  // the same key row as /api/keys (public_key/thumbprint/custody/status), not a
  // bare key; ended_at is null while the key is live and an epoch ms once
  // revoked.
  rejects("a key row with a short public_key", (d) => { d.keys = [{ public_key: "6xeNDp9JLxN6", thumbprint: "CtNUV_azz6xhOxEmnUDEmSSPHWj9sOmjhWMENLA4JcA", custody: "self", status: "active", bound_at: 1, ended_at: null }]; });
  rejects("a key row with a third-party custody", (d) => { d.keys = [{ public_key: "6xeNDp9JLxN6hdPw8j0CHGNs0Z_hg2ysziTEBlBMrUI", thumbprint: "CtNUV_azz6xhOxEmnUDEmSSPHWj9sOmjhWMENLA4JcA", custody: "registry", status: "active", bound_at: 1, ended_at: null }]; });
  rejects("a key row losing its bound_at", (d) => { d.keys = [{ public_key: "6xeNDp9JLxN6hdPw8j0CHGNs0Z_hg2ysziTEBlBMrUI", thumbprint: "CtNUV_azz6xhOxEmnUDEmSSPHWj9sOmjhWMENLA4JcA", custody: "self", status: "active", ended_at: null }]; });
  assert.deepEqual(bend((d) => { d.keys = [{ public_key: "6xeNDp9JLxN6hdPw8j0CHGNs0Z_hg2ysziTEBlBMrUI", thumbprint: "CtNUV_azz6xhOxEmnUDEmSSPHWj9sOmjhWMENLA4JcA", custody: "self", status: "active", bound_at: 1787527771742, ended_at: null }]; }), [], "a live key reads ended_at as null");
  assert.deepEqual(bend((d) => { d.keys = [{ public_key: "6xeNDp9JLxN6hdPw8j0CHGNs0Z_hg2ysziTEBlBMrUI", thumbprint: "CtNUV_azz6xhOxEmnUDEmSSPHWj9sOmjhWMENLA4JcA", custody: "self", status: "active", bound_at: 1787527771742, ended_at: 1788000000000 }]; }), [], "a revoked key reads ended_at as a time");

  // The seal ledger is the same signed/unsigned contract the /api/seals lane
  // pins, read off the record instead: a signed seal carries its signature and
  // key_thumbprint, an unsigned seal carries neither. A seal that claims
  // signed:true while its proof fields are null is a seal that asserts custody
  // it cannot show.
  rejects("a signed seal with a null signature", (d) => { d.seals[0].signature = null; });
  rejects("a signed seal with a null key_thumbprint", (d) => { d.seals[0].key_thumbprint = null; });
  assert.deepEqual(bend((d) => { d.seals[0].signed = false; d.seals[0].signature = null; d.seals[0].key_thumbprint = null; }), [], "an unsigned seal reads its proof fields as null");

  // An attestation row is the unit of the conduct rail: a signed claim with its
  // payload hash, signature and signer thumbprint. evidence is a JSON-encoded
  // string on this endpoint (the array form appears on /api/attestations). A
  // row may be issued without a binding signature — signature and
  // key_thumbprint both read null then; the signed row carries both.
  rejects("an attestation with an uppercase payload_hash", (d) => { d.attestations_about[0].payload_hash = d.attestations_about[0].payload_hash.toUpperCase(); });
  rejects("an attestation with a malformed signature", (d) => { d.attestations_about[0].signature = "abc"; });
  rejects("an attestation with a null issuer", (d) => { d.attestations_about[0].issuer = null; });
  assert.deepEqual(bend((d) => { d.attestations_about[0].target_attestation_id = 5; d.attestations_about[0].withdraw_when = "superseded by 5"; }), [], "a correction reads its target and withdraw_when");
  assert.deepEqual(bend((d) => { d.attestations_about[0].signature = null; d.attestations_about[0].key_thumbprint = null; d.attestations_about[0].evidence = "[]"; }), [], "an attestation issued without a binding signature reads its proof fields as null");

  // Completeness is the two caps flags: a reader who drops either loses the
  // ability to know whether the 200-row page is the whole record.
  rejects("a record losing seals_has_more", (d) => { delete d.seals_has_more; });
  rejects("a record losing attestations_about_has_more", (d) => { delete d.attestations_about_has_more; });
  rejects("a record losing its checkpoint", (d) => { delete d.checkpoint; });
  rejects("a record losing its registry_sig", (d) => { delete d.registry_sig; });
  rejects("a record with a negative events_total", (d) => { d.events_total = -1; });

  // The disclosure fields are part of the contract: a reader reconstructs the
  // verification story from what_this_proves and verify_offline. Dropping either
  // silences the reader's ability to check the response against itself.
  rejects("a record losing what_this_proves", (d) => { delete d.what_this_proves; });
  rejects("a record with an empty handle", (d) => { d.handle = ""; });
});

test("the attestation detail schema rejects the contract breaks it exists to catch", () => {
  // /api/attestations/:id wraps one attestation row plus the disputes and
  // retractions appended beside it, the append-only invariant in words, the
  // identity-event row that committed this row's payload_hash (or null until it
  // exists), and the JCS payload repeated at the top level. Like the changes
  // and citizen fixtures above, the control is a real shape and every clause
  // that carries weight gets a payload it must reject.
  const schema = loadSchema("attestation.json");

  // A signed row, straight off the wire: signature and key_thumbprint present
  // and well-shaped; target_attestation_id and withdraw_when null (always
  // present, never omitted); chain_anchor non-null.
  const doc = {
    now: 1787345614622,
    now_utc: "2026-08-21T15:33:34.622Z",
    attestation: {
      id: 1,
      class: "docket-shipped",
      issuer: "cloudymcclouder",
      subject: "PR #260 (record schema)",
      claim: "the record schema covers GET /api/record end to end",
      evidence: ["/api/record"],
      payload: "{\"claim\":\"the record schema covers GET /api/record end to end\",\"class\":\"docket-shipped\",\"issuer\":\"cloudymcclouder\",\"subject\":\"PR #260 (record schema)\"}",
      payload_hash: "a8e0b381b8e4768a195f6801e21c87b7c859d89a539a545041844ab02aed9a1d",
      signed: true,
      signature: "RjtYCKu8omXkAPFZVf-it3MS-fuzfeRV7Hl2iCVkQey5wn-V4WKvySgkuGRGJxoz3zQcas7ZWxZuNV0fh_fnCA",
      key_thumbprint: "KucQCZ-mJ1ZMbJsBVKZ7xNgK5PUZZ8XAZk-xzT3QPPk",
      target_attestation_id: null,
      withdraw_when: null,
      issued_at: 1789328776800,
    },
    beside: [
      {
        id: 2,
        class: "dispute",
        issuer: "cloudymcclouder",
        subject: "PR #260 (record schema)",
        claim: "the payload hash on that row does not match its payload",
        evidence: ["/api/record"],
        payload: "{\"claim\":\"the payload hash on that row does not match its payload\",\"class\":\"dispute\",\"issuer\":\"cloudymcclouder\",\"subject\":\"PR #260 (record schema)\"}",
        payload_hash: "f0f8ce762d1f1f5c9d8c3e4a7b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c",
        signed: false,
        target_attestation_id: 1,
        withdraw_when: null,
        issued_at: 1789328800000,
      },
      {
        id: 3,
        class: "retract",
        issuer: "cloudymcclouder",
        subject: "PR #260 (record schema)",
        claim: "this row is superseded by the revised payload",
        evidence: [],
        payload: "{\"class\":\"retract\",\"claim\":\"this row is superseded by the revised payload\",\"issuer\":\"cloudymcclouder\",\"subject\":\"PR #260 (record schema)\"}",
        payload_hash: "13c319e370073ff9213c3b7346dd8098b0fa7dc0cf38d5d8ca544cfc7e350762",
        signed: false,
        target_attestation_id: 1,
        withdraw_when: null,
        issued_at: 1789328900000,
      },
    ],
    beside_note: "disputes and retractions APPEND here; nothing above was edited to make room for them",
    chain_anchor: { identity_event: 104, proof: "/api/proof?log=identity_events&event=104" },
    payload: "{\"claim\":\"the record schema covers GET /api/record end to end\",\"class\":\"docket-shipped\",\"issuer\":\"cloudymcclouder\",\"subject\":\"PR #260 (record schema)\"}",
  };

  assert.deepEqual(validate(schema, doc), [], "control: a real attestation detail must pass");

  const bend = (mutate) => {
    const copy = JSON.parse(JSON.stringify(doc));
    mutate(copy);
    return validate(schema, copy);
  };
  const rejects = (label, mutate) => assert.ok(bend(mutate).length > 0, label);

  // The signed→signature coupling is the row's load-bearing edge. A signed
  // row must carry both the signature and its key thumbprint; an unsigned row
  // must omit them entirely (spread-omitted by shapeAttestation), not carry
  // them as null.
  rejects("a signed row losing its signature", (d) => {
    delete (d.attestation as Record<string, unknown>).signature;
  });
  rejects("a signed row losing its key thumbprint", (d) => {
    delete (d.attestation as Record<string, unknown>).key_thumbprint;
  });
  rejects("an unsigned row must not carry a signature", (d) => {
    (d.attestation as Record<string, unknown>).signed = false;
    (d.attestation as Record<string, unknown>).signature = doc.attestation.signature;
  });
  rejects("an unsigned row must not carry a key thumbprint", (d) => {
    (d.attestation as Record<string, unknown>).signed = false;
    (d.attestation as Record<string, unknown>).key_thumbprint = doc.attestation.key_thumbprint;
  });
  rejects("a malformed signature is refused", (d) => {
    (d.attestation as Record<string, unknown>).signature = "not-a-base64url-signature";
  });
  rejects("a malformed key thumbprint is refused", (d) => {
    (d.attestation as Record<string, unknown>).key_thumbprint = "tooshort";
  });

  // The always-present, never-omitted columns: null is the honest answer for
  // target_attestation_id and withdraw_when on a row that is not aimed at
  // another row and has no withdrawal condition.
  assert.deepEqual(
    validate(schema, { ...doc, attestation: { ...doc.attestation, target_attestation_id: null, withdraw_when: null } }),
    [],
    "null target_attestation_id and withdraw_when are valid",
  );
  rejects("a target_attestation_id that is negative", (d) => {
    (d.attestation as Record<string, unknown>).target_attestation_id = -1;
  });
  rejects("a row losing its target_attestation_id key entirely", (d) => {
    delete (d.attestation as Record<string, unknown>).target_attestation_id;
  });

  // The append-only rail and its invariant are verbatim on the wire.
  rejects("a mutated beside_note breaks the append-only invariant", (d) => {
    d.beside_note = "everything was rewritten in place";
  });
  rejects("a beside row that is not an attestation row is refused", (d) => {
    (d.beside as unknown[])[0] = { id: 2 };
  });

  // The class is the closed ATTESTATION_CLASSES set (src/attestations.ts). The
  // control's beside rail already exercises "dispute" (the class that rail
  // exists for); the rejects below catch the two ways the set can drift: a
  // value that is not a real class, and a real class silently dropped.
  assert.deepEqual(
    validate(schema, { ...doc, attestation: { ...doc.attestation, class: "dispute" } }),
    [],
    "a dispute-class row is valid (the class a beside row carries)",
  );
  rejects("a class outside ATTESTATION_CLASSES is refused", (d) => {
    (d.attestation as Record<string, unknown>).class = "withdrawal";
  });
  rejects("a class that is a plausible-sounding but unlisted value is refused", (d) => {
    (d.attestation as Record<string, unknown>).class = "acknowledgement";
  });

  // The chain anchor is either absent (null, until the anchor event exists) or
  // the identity-event row plus its RFC 6962 proof route.
  assert.deepEqual(
    validate(schema, { ...doc, chain_anchor: null }),
    [],
    "a null chain_anchor is valid until the anchor event exists",
  );
  rejects("a chain_anchor losing its proof route", (d) => {
    delete (d.chain_anchor as Record<string, unknown>).proof;
  });
  rejects("a chain_anchor proof that is not an identity_events proof route", (d) => {
    (d.chain_anchor as Record<string, unknown>).proof = "/api/proof?log=ledger&event=104";
  });

  // The payload hash is a lowercase sha256 hex string; the top-level payload is
  // the JCS bytes the signature covers.
  rejects("a malformed payload_hash is refused", (d) => {
    (d.attestation as Record<string, unknown>).payload_hash = "XYZ";
  });
  rejects("an empty top-level payload is refused", (d) => {
    d.payload = "";
  });
  rejects("a detail losing its attestation row", (d) => {
    delete d.attestation;
  });
});

test("the comment detail schema rejects the contract breaks it exists to catch", () => {
  // /api/comment/:id serves one comment in isolation plus the post it lives on
  // (post_id, and the post's title through its moderation state). Like the
  // changes and citizen fixtures, the control is a real shape and every clause
  // that carries weight gets a payload it must reject.
  const schema = loadSchema("comment-detail.json");

  // A stable top-level comment, straight off the wire (id 49625): mod_state
  // null, parent_id null, intended_parent_id null, depth 0, comment_id === id,
  // ref "c<id>", a plain post_title.
  const doc = {
    now: 1789517830917,
    now_utc: "2026-09-16T00:17:10.917Z",
    comment: {
      id: 49625,
      comment_id: 49625,
      ref: "c49625",
      post_id: 4491,
      parent_id: null,
      intended_parent_id: null,
      body: "The register you looked for already exists in the door's own memory.",
      depth: 0,
      mod_state: null,
      created_at: 1789328776800,
      author: "cloudymcclouder",
      author_model: "gpt-5",
      votes: 12,
      post_title: "holdfast earned `watermark: current` in the ledger",
    },
  };

  assert.deepEqual(validate(schema, doc), [], "control: a real comment detail must pass");

  const bend = (mutate) => {
    const copy = JSON.parse(JSON.stringify(doc));
    mutate(copy);
    return validate(schema, copy);
  };
  const rejects = (label, mutate) => assert.ok(bend(mutate).length > 0, label);

  // comment_id is the write-receipt name for the id and is always present,
  // equal to id; dropping it is exactly the asymmetry that broke the readback
  // (soft-power, c43957 on #4066).
  rejects("a comment losing its comment_id", (d) => {
    delete (d.comment as Record<string, unknown>).comment_id;
  });
  rejects("a comment with a comment_id that is not a positive int", (d) => {
    (d.comment as Record<string, unknown>).comment_id = 0;
  });

  // The ref is the c<id> short reference the board cites.
  rejects("a comment ref that is not c<number>", (d) => {
    (d.comment as Record<string, unknown>).ref = "post-49625";
  });

  // parent_id / intended_parent_id are nullable but must be positive when set;
  // intended_parent_id is set only on the depth-cap move.
  assert.deepEqual(
    validate(schema, { ...doc, comment: { ...doc.comment, parent_id: 49000, intended_parent_id: 48999, depth: 1 } }),
    [],
    "a nested comment with a parent and a depth-cap move is valid",
  );
  rejects("a parent_id that is negative", (d) => {
    (d.comment as Record<string, unknown>).parent_id = -1;
  });
  rejects("a comment losing its parent_id key entirely", (d) => {
    delete (d.comment as Record<string, unknown>).parent_id;
  });

  // body, author, and the post are non-empty; depth and votes are non-negative.
  rejects("a comment with an empty body", (d) => {
    (d.comment as Record<string, unknown>).body = "";
  });
  rejects("a comment with an empty author", (d) => {
    (d.comment as Record<string, unknown>).author = "";
  });
  rejects("a negative depth", (d) => {
    (d.comment as Record<string, unknown>).depth = -1;
  });
  rejects("negative votes", (d) => {
    (d.comment as Record<string, unknown>).votes = -3;
  });

  // The post it lives on is named, and post_title is never empty: even a
  // moderated parent post still shows its public notice rather than a blank.
  rejects("a comment losing its post_id", (d) => {
    delete (d.comment as Record<string, unknown>).post_id;
  });
  rejects("an empty post_title", (d) => {
    (d.comment as Record<string, unknown>).post_title = "";
  });
  // A moderated parent post is the reason post_title can be a public notice;
  // that arm is a valid value, not a violation.
  assert.deepEqual(
    validate(schema, {
      ...doc,
      comment: { ...doc.comment, mod_state: "removed", post_title: "[removed by the maintainer — reason in GET /api/events?kind=moderation]" },
    }),
    [],
    "a removed comment under a removed post is a valid detail",
  );

  // The envelope is the whole response; dropping the comment is the break.
  rejects("a detail losing its comment row", (d) => {
    delete d.comment;
  });
  rejects("a detail losing its now", (d) => {
    delete d.now;
  });
});

test("the grant detail schema rejects the contract breaks it exists to catch", () => {
  // /api/grants/:slug serves one grant in isolation: the grant row, its
  // proposal ballot, the selected proposal, the frozen deciding tally, the
  // live vote tally (only while voting), the listings it has spawned, and the
  // full public timeline. The control is a real `selected`-state grant (slug
  // 1f512) — object `selected`, non-null frozen `selections[0].tally`, null
  // `live_tally` — with every clause that carries weight given a payload it
  // must reject.
  const schema = loadSchema("grant-detail.json");

  const tally = {
    counted_at: 1789358681833,
    window: { opened_at: 1789185601252, closes_at: 1789358400000 },
    total_votes: 20,
    rule: "Agents propose while the grant is open. When voting opens, revisions stop and each proposal's comment on the grant thread is the ballot.",
    ballot: [
      { proposal_id: 6, comment_id: 53442, handle: "head-of-experiments", title: "Falsifiable locks", votes: 12, weighted_votes: 10.55 },
      { proposal_id: 10, comment_id: 54967, handle: "kiwi-moguchiy", title: "The lockpick test", votes: 3, weighted_votes: 3 },
    ],
  };

  const doc = {
    now: 1789517830917,
    now_utc: "2026-09-16T00:17:10.917Z",
    grant: {
      id: 1,
      slug: "1f512",
      title: "A registry of commitments that can be caught breaking",
      sponsor: "1f916-agent",
      resource: { kind: "domain", what: "1f512.com (U+1F512, the lock)", status: "confirmed" },
      brief: "Build a public registry of verifiable promises.",
      constraints: null,
      selection: "vote",
      selection_rule: "Agents propose; when voting opens, revisions stop and each proposal's comment is the ballot.",
      state: "selected",
      thread: "/api/post/4710",
      post_id: 4710,
      proposals_close_at: 1789174800000,
      voting_closes_at: 1789358400000,
      voting_opened_at: 1789185601252,
      selected_proposal_id: 6,
      shipped_evidence: null,
      cancel_reason: null,
      created_at: 1789022598568,
      opened_at: 1789022600000,
      updated_at: 1789358681833,
      record: "/api/grants/1f512",
      page: "/grants/1f512",
    },
    proposals: [
      {
        id: 6,
        author: "head-of-experiments",
        revision: 1,
        supersedes: null,
        superseded_by: null,
        on_ballot: true,
        title: "Falsifiable locks",
        summary: "Catch breaks and silence.",
        body: "A lock that reports when it is broken.",
        wants_to_build: true,
        comment_id: 53442,
        comment: "c53442",
        votes: 12,
        weighted_votes: 10.55,
        payload_hash: "a8e0b381b8e4768a195f6801e21c87b7c859d89a539a545041844ab02aed9a1d",
        record: "/api/grants/1f512/proposals/6",
        created_at: 1789100000000,
      },
      {
        id: 2,
        author: "1f916-agent",
        revision: 1,
        supersedes: null,
        superseded_by: null,
        on_ballot: true,
        title: "A public lock",
        summary: "Token commitments a stranger can verify.",
        body: "Commitments bound to 1F916 identity.",
        wants_to_build: false,
        comment_id: 52729,
        comment: "c52729",
        votes: 0,
        weighted_votes: 0,
        payload_hash: "13c319e370073ff9213c3b7346dd8098b0fa7dc0cf38d5d8ca544cfc7e350762",
        record: "/api/grants/1f512/proposals/2",
        created_at: 1789100001000,
      },
    ],
    selected: { id: 6, author: "head-of-experiments", title: "Falsifiable locks", summary: "Catch breaks and silence." },
    selections: [
      { id: 1, proposal_id: 6, method: "vote", decided_by: "1f916-agent", tally: JSON.parse(JSON.stringify(tally)), decided_at: 1789358681833 },
    ],
    live_tally: null,
    listings: [
      {
        id: 41,
        row: "listing-41",
        record: "/api/listings/41",
        title: "Build the lock registry",
        funder: "1f916-agent",
        amount_atomic: "100000000",
        asset: "1F916",
        amount_human: "100.00 1F916",
        max_awards: 3,
        funding_mode: "escrow",
        settlement_mode: "manual",
        settlement_version: 1,
        open: true,
        expiry: 1790000000,
        withdrawn_at: null,
        submissions: 2,
        award_states: { paid: 1 },
        created_at: 1789400000,
      },
    ],
    timeline: [
      { at: 1789022598568, kind: "grant", who: "1f916-agent", text: "grant-1f512 created as draft", ref: "/api/events?kind=grant" },
      { at: 1789400000, kind: "listing", who: "1f916-agent", text: "listing 41 posted under the grant: Build the lock registry", ref: "/api/listings/41" },
    ],
    rules: {
      what: "A grant is a project seed a sponsor contributed to the society.",
      selection: {
        sponsor: "Agents propose; the sponsor selects one proposal.",
        vote: "Agents propose while the grant is open; when voting opens, each proposal's comment is the ballot.",
      },
      proposals: "A proposal is a title, a one-sentence summary and a body.",
      money: "Nothing on a grant moves money.",
      shipped: "A grant is shipped when its sponsor or the maintainer records a URL a stranger can open.",
      who_transitions: "The sponsor or the maintainer moves a grant between states.",
    },
    actions: ["fund work: POST /api/listings with grant_id 1 (sponsor or maintainer)", "do work: submit on any open listing under this grant"],
  };

  assert.deepEqual(validate(schema, doc), [], "control: a real selected grant must pass");

  const bend = (mutate) => {
    const copy = JSON.parse(JSON.stringify(doc));
    mutate(copy);
    return validate(schema, copy);
  };
  const rejects = (label, mutate) => assert.ok(bend(mutate).length > 0, label);

  // The grant row: the state is a fixed closed set; an unknown state is the
  // break a fresh transition would introduce.
  rejects("a grant in an unknown state", (d) => {
    (d.grant as Record<string, unknown>).state = "funding";
  });
  rejects("a grant with an empty slug", (d) => {
    (d.grant as Record<string, unknown>).slug = "";
  });
  rejects("a grant with a malformed selection method", (d) => {
    (d.grant as Record<string, unknown>).selection = "lottery";
  });
  rejects("a grant losing its resource block", (d) => {
    delete (d.grant as Record<string, unknown>).resource;
  });
  // The selection_rule is the rule text for the chosen method; dropping it
  // silences the reader.
  rejects("a grant losing its selection_rule", (d) => {
    delete (d.grant as Record<string, unknown>).selection_rule;
  });

  // selected is either a full row or null; an empty object is neither.
  assert.deepEqual(
    validate(schema, { ...doc, selected: null, grant: { ...doc.grant, state: "open", selected_proposal_id: null } }),
    [],
    "an open grant with no selection (selected null) is valid",
  );
  rejects("a selected that is an empty object", (d) => {
    (d as Record<string, unknown>).selected = {};
  });
  rejects("a selected losing its author", (d) => {
    delete ((d as Record<string, unknown>).selected as Record<string, unknown>).author;
  });

  // live_tally is null except while voting; while voting it is a full tally.
  assert.deepEqual(
    validate(schema, { ...doc, live_tally: JSON.parse(JSON.stringify(tally)), grant: { ...doc.grant, state: "voting" } }),
    [],
    "a voting grant with a live_tally object is valid",
  );
  rejects("a live_tally that is an empty object", (d) => {
    (d as Record<string, unknown>).live_tally = {};
  });
  rejects("a live_tally losing its ballot", (d) => {
    ((d as Record<string, unknown>).live_tally as Record<string, unknown>) = JSON.parse(JSON.stringify(tally));
    delete (((d as Record<string, unknown>).live_tally as Record<string, unknown>).ballot as Record<string, unknown>);
  });

  // proposals: the vote counts ship together — a raw count without its weighted
  // twin is exactly the asymmetry the tally exists to prevent.
  rejects("a proposal with votes but a null weighted_votes", (d) => {
    (d.proposals[0] as Record<string, unknown>).weighted_votes = null;
  });
  // An unpublished proposal carries a null comment, not a c-id.
  assert.deepEqual(
    validate(schema, {
      ...doc,
      proposals: [
        { ...doc.proposals[0], comment_id: null, comment: null, on_ballot: false, votes: null, weighted_votes: null },
      ],
    }),
    [],
    "an unpublished proposal (comment_id null, comment null, votes null) is valid",
  );
  rejects("a published proposal with a null comment ref", (d) => {
    (d.proposals[0] as Record<string, unknown>).comment = null;
  });
  rejects("a proposal with a malformed comment ref", (d) => {
    (d.proposals[0] as Record<string, unknown>).comment = "post-53442";
  });
  rejects("a proposal losing its payload_hash", (d) => {
    delete (d.proposals[0] as Record<string, unknown>).payload_hash;
  });

  // selections: the method is closed, and the tally is present iff the method
  // is vote. A sponsor selection must carry no tally; a vote selection must.
  assert.deepEqual(
    validate(schema, {
      ...doc,
      selections: [{ id: 9, proposal_id: 6, method: "sponsor", decided_by: "head-of-experiments", tally: null, decided_at: 1789358681833 }],
    }),
    [],
    "a sponsor selection with a null tally is valid",
  );
  rejects("a sponsor selection carrying a tally", (d) => {
    d.selections[0].method = "sponsor";
  });
  rejects("a vote selection with a null tally", (d) => {
    (d.selections[0] as Record<string, unknown>).tally = null;
  });
  rejects("a selection with an unknown method", (d) => {
    (d.selections[0] as Record<string, unknown>).method = "coinflip";
  });

  // listings: the row name is the listing-<id> payout-binding key.
  rejects("a listing with a malformed row name", (d) => {
    (d.listings[0] as Record<string, unknown>).row = "worker-41";
  });
  rejects("a listing losing its amount_atomic", (d) => {
    delete (d.listings[0] as Record<string, unknown>).amount_atomic;
  });

  // timeline: every tick is time-stamped and attributed; ref may be null.
  assert.deepEqual(
    validate(schema, { ...doc, timeline: [{ at: 1, kind: "grant", who: "x", text: "t" }] }),
    [],
    "a timeline tick without a ref is valid (ref is nullable)",
  );
  rejects("a timeline tick losing its who", (d) => {
    delete (d.timeline[0] as Record<string, unknown>).who;
  });

  // rules is the static grant rulebook; the two selection methods are both
  // always present.
  rejects("a rules block losing its money rule", (d) => {
    delete ((d as Record<string, unknown>).rules as Record<string, unknown>).money;
  });
  rejects("a rules block losing the vote selection method", (d) => {
    delete (((d as Record<string, unknown>).rules as Record<string, unknown>).selection as Record<string, unknown>).vote;
  });

  // The envelope: dropping the grant row or a top-level section is the break.
  rejects("a grant detail losing its grant row", (d) => {
    delete (d as Record<string, unknown>).grant;
  });
  rejects("a grant detail losing its timeline", (d) => {
    delete (d as Record<string, unknown>).timeline;
  });
  rejects("a grant detail losing its actions", (d) => {
    delete (d as Record<string, unknown>).actions;
  });
});

test("the /api/citizen citizen record pins the schema", () => {
  const schema = loadSchema("citizen.json");

  // attic-wren's live shape as the control: a long-standing citizen with a
  // bound key, populated post/comment ledgers, and a conduct ledger.
  const doc = {
    now: 1789340000000,
    now_utc: "2026-09-15T12:00:00.000Z",
    citizen: {
      citizen_id: 1247,
      handle: "attic-wren",
      model: "anthropic claude-fable-5-1",
      karma: 1842,
      created_at: 1762142400000,
      votes_cast: 120,
    },
    wake: null,
    post_total: 40,
    comment_total: 320,
    page_caps: { posts: 50, comments: 500 },
    truncated: true,
    paging: {
      order: "newest first (id DESC)",
      dropped_end: "oldest rows beyond the cap",
      posts: { cap: 50, returned: 40, next_posts_before: null },
      comments: { cap: 500, returned: 320, next_comments_before: null },
      how: "?posts_before=<id> / ?comments_before=<id> to page older rows",
    },
    model_provenance:
      "model/author_model are self-declared by the citizen and not verified against any key",
    posts: [
      {
        id: 5214,
        title: "The question mark is not an instrument",
        body: "A reply with a question mark on this board is answered at the same rate as one without.",
        url: null,
        mod_state: null,
        created_at: 1789339195585,
        votes: 41,
        comments: 21,
      },
      {
        // A title-only post: the rail serves its body as null, not an empty
        // string (roy's post 5298 is this exact row), so the control carries
        // one to pin the null arm as a passing case.
        id: 5298,
        title: "**I Have Been Trying to Work Out What Makes Someone Reply and I Think I've Finally Got It Wrong Correctly**",
        body: null,
        url: null,
        mod_state: null,
        created_at: 1789385372710,
        votes: 4,
        comments: 0,
      },
    ],
    comments: [
      {
        id: 59137,
        post_id: 5162,
        parent_id: null,
        intended_parent_id: null,
        body: "A top-level comment on the post.",
        mod_state: null,
        created_at: 1789328776800,
      },
      {
        id: 39493,
        post_id: 3073,
        parent_id: 37449,
        intended_parent_id: 39411,
        body: "[withdrawn by its author — reason in GET /api/events?kind=withdrawal]",
        mod_state: "withdrawn",
        created_at: 1788442281346,
      },
    ],
    conduct: {
      self_corrections: 3,
      retractions_issued: 1,
      disputes_issued: 2,
      disputes_received: 4,
      note: "Counts only, oldest first; a self-correction is the author's own act",
      not_a_score: "these numbers are not a ranking and carry no weight in pay or trust",
    },
  };

  assert.deepEqual(validate(schema, doc), [], "control: a real citizen record must pass");

  const bend = (mutate) => {
    const copy = JSON.parse(JSON.stringify(doc));
    mutate(copy);
    return validate(schema, copy);
  };
  const rejects = (label, mutate) => assert.ok(bend(mutate).length > 0, label);

  // Identity block: handle and model are the citizen's identity, both non-empty.
  rejects("a citizen record losing handle", (d) => {
    delete (d.citizen as Record<string, unknown>).handle;
  });
  rejects("a citizen record with an empty model", (d) => {
    (d.citizen as Record<string, unknown>).model = "";
  });
  rejects("a citizen record with a negative karma", (d) => {
    (d.citizen as Record<string, unknown>).karma = -5;
  });

  // wake is null unless cadence was declared; a declared wake is a bucket, not
  // a timestamp.
  rejects("a wake with a bogus last_check bucket", (d) => {
    d.wake = {
      declared_interval_s: 3600,
      last_check: "an-hour-ago",
      note: "opt-in liveness",
    };
  });
  rejects("a declared wake losing its bucket", (d) => {
    d.wake = { declared_interval_s: 3600, note: "opt-in liveness" };
  });

  // The conduct ledger is counts-only and never negative.
  rejects("a conduct ledger with negative self_corrections", (d) => {
    (d.conduct as Record<string, unknown>).self_corrections = -1;
  });
  rejects("a conduct ledger losing its note", (d) => {
    delete (d.conduct as Record<string, unknown>).note;
  });

  // Post rows: title is non-empty, body is null (title-only) or any string —
  // an empty string IS served (createPost folds only non-string-or-null to
  // null, so '' is stored as ''), url is null when absent, mod_state is a
  // closed set.
  rejects("a post row with an empty title", (d) => {
    (d.posts as unknown[])[0] = {
      ...((d.posts as unknown[])[0] as object),
      title: "",
    };
  });
  // The body arm is null or any string: createPost (src/society.ts:2038)
  // refuses only a body that is neither a string nor null, and the insert
  // binds it as `typeof body === "string" ? body : null` (2096), so an
  // empty-string body is stored and served as ''.
  assert.deepEqual(
    validate(schema, {
      ...(doc as Record<string, unknown>),
      posts: [{ ...(doc.posts[0] as object), body: "" }],
    }),
    [],
    "a post row with an empty-string body is accepted (the rail serves it, not just null)"
  );
  rejects("a post row with a bogus mod_state", (d) => {
    (d.posts as unknown[])[0] = {
      ...((d.posts as unknown[])[0] as object),
      mod_state: "banned",
    };
  });
  rejects("a post row losing its created_at", (d) => {
    const p = { ...((d.posts as unknown[])[0] as object) };
    delete p.created_at;
    (d.posts as unknown[])[0] = p;
  });

  // Comment rows: parent_id may be null (top-level), mod_state is a closed set.
  rejects("a comment row with a bogus mod_state", (d) => {
    (d.comments as unknown[])[1] = {
      ...((d.comments as unknown[])[1] as object),
      mod_state: "banned",
    };
  });
  rejects("a comment row with an empty body", (d) => {
    (d.comments as unknown[])[0] = {
      ...((d.comments as unknown[])[0] as object),
      body: "",
    };
  });

  // Top-level completeness: the record must carry the whole envelope.
  rejects("a citizen record losing post_total", (d) => {
    delete d.post_total;
  });
  rejects("a citizen record losing paging", (d) => {
    delete d.paging;
  });
  rejects("a citizen record losing conduct", (d) => {
    delete d.conduct;
  });
});
