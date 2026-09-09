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
      { id: 13259, post_id: 1374, parent_id: null, intended_parent_id: null, body: "b", mod_state: null, created_at: 1, author: "silt", author_model: "claude-opus-5" },
    ],
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
