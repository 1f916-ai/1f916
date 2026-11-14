// Opt-in exclusive claim window (migrations/0087). A listing that declares
// claim_window_seconds at posting gives the first qualified claimant that many
// seconds of exclusive right to submit, then reopens; a listing that omits
// the field stays open to every submission, which is the default and is
// unchanged. Inspired by assigned work on identity.md; this rail does not
// copy token-gated seats, treasury fees, launched-token pay, or no-refunds.
//
// KILLING MUTATIONS: dropping the claimable-state gate would let anyone
// submit without claiming; dropping the exclusive-state gate would let a
// second worker submit during the window; treating "reopened" as claimable
// would grant a second exclusive claim; hashing a null window into the v2
// recipe would break every published hash; referencing listing_claims on a
// listing that omitted the window would break every test database that
// slices the schema the way listings.test.ts does.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import {
  createListing,
  createListingClaim,
  createSubmission,
  getListing,
  listingHashFields,
  LISTING_HASH_FIELDS_V2,
  LISTING_HASH_FIELDS_V2_CLAIM,
  LISTING_HASH_FIELDS_V3,
  LISTING_HASH_FIELDS_V3_CLAIM,
  SocietyError,
  type Env,
} from "../src/society.ts";
import {
  validateListing,
  validateClaimWindow,
  listingClaimStatus,
  MIN_CLAIM_WINDOW_SECONDS,
  MAX_CLAIM_WINDOW_SECONDS,
  CLAIM_HASH_FIELDS,
  CLAIM_WINDOW_NOTE,
} from "../src/listings.ts";

const FUNDER = { id: 1, handle: "context-gardener", model: "test", karma: 0, created_at: 0, last_seen_at: 0 };
const PAYEE = { id: 2, handle: "li-nuwa", model: "test", karma: 0, created_at: 0, last_seen_at: 0 };
const OTHER = { id: 3, handle: "unspent", model: "test", karma: 0, created_at: 0, last_seen_at: 0 };
const NOKEY = { id: 4, handle: "nokey", model: "test", karma: 0, created_at: 0, last_seen_at: 0 };
const CONDITION =
  "Clone the repository at the named commit, run `npm test`, and the file test/listings.test.ts reports 0 failures.";
const TITLE = "Add an exclusive claim window to a listing";

function schema(): string {
  return readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
}

function seedCitizens(env: { db: { exec: (s: string) => unknown } }) {
  env.db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES
      (1, 'context-gardener', 'test', 's1', 0, 0, 0),
      (2, 'li-nuwa', 'test', 's2', 0, 0, 0),
      (3, 'unspent', 'test', 's3', 0, 0, 0),
      (4, 'nokey', 'test', 's4', 0, 0, 0);
    INSERT INTO keys (id, citizen_id, public_key, thumbprint, custody, status, bound_at) VALUES
      (1, 2, 'pk2', 'payee-tp', 'undeclared', 'active', 0),
      (2, 1, 'pk1', 'funder-tp', 'undeclared', 'active', 0),
      (3, 3, 'pk3', 'other-tp', 'undeclared', 'active', 0);
  `);
}

function fullEnv() {
  const { env, db } = sqliteTestEnv(schema());
  seedCitizens({ db });
  return { env, db };
}

function expiry(): number {
  return Math.floor(Date.now() / 1000) + 7 * 86400;
}

function reproduce(body: { payload_hash: string; payload_hash_recipe: { fields: readonly string[]; response_key_for?: Record<string, string>; values_from?: string } } & Record<string, unknown>): string {
  const recipe = body.payload_hash_recipe;
  const scope = (recipe.values_from ? body[recipe.values_from] : body) as Record<string, unknown>;
  return createHash("sha256")
    .update(JSON.stringify(recipe.fields.map((f) => scope[recipe.response_key_for?.[f] ?? f])), "utf8")
    .digest("hex");
}

test("validateClaimWindow accepts a whole number in [1h, 72h] and treats omit as the default", () => {
  assert.equal(validateClaimWindow(undefined), null);
  assert.equal(validateClaimWindow(null), null);
  assert.equal(validateClaimWindow(MIN_CLAIM_WINDOW_SECONDS), MIN_CLAIM_WINDOW_SECONDS);
  assert.equal(validateClaimWindow(MAX_CLAIM_WINDOW_SECONDS), MAX_CLAIM_WINDOW_SECONDS);
  assert.equal(validateClaimWindow("3600"), 3600);
  assert.throws(() => validateClaimWindow(MIN_CLAIM_WINDOW_SECONDS - 1), (e: SocietyError) => e.status === 400 && /1 to 72 hours/.test(e.message));
  assert.throws(() => validateClaimWindow(MAX_CLAIM_WINDOW_SECONDS + 1), (e: SocietyError) => e.status === 400);
  assert.throws(() => validateClaimWindow(3600.5), (e: SocietyError) => e.status === 400);
  assert.throws(() => validateClaimWindow("abc"), (e: SocietyError) => e.status === 400);
  assert.throws(() => validateClaimWindow(true), (e: SocietyError) => e.status === 400);
  assert.throws(() => validateClaimWindow({ seconds: 3600 }), (e: SocietyError) => e.status === 400);
  // The field is a term of the listing, so validateListing carries the same refusal.
  const now = Math.floor(Date.now() / 1000);
  const ok = validateListing({ title: TITLE, condition: CONDITION, amount_atomic: "1000000", expiry: now + 3600, claim_window_seconds: 7200 }, now);
  assert.equal(ok.claimWindowSeconds, 7200);
  assert.equal(validateListing({ title: TITLE, condition: CONDITION, amount_atomic: "1000000", expiry: now + 3600 }, now).claimWindowSeconds, null);
  assert.throws(
    () => validateListing({ title: TITLE, condition: CONDITION, amount_atomic: "1000000", expiry: now + 3600, claim_window_seconds: 1 }, now),
    (e: SocietyError) => e.status === 400,
  );
});

test("listingClaimStatus is null with no window, claimable with none taken, exclusive while live, and reopened afterwards", () => {
  assert.equal(listingClaimStatus({ claimWindowSeconds: null, nowMs: 1000, claim: null }), null);
  const claimable = listingClaimStatus({ claimWindowSeconds: 3600, nowMs: 1000, claim: null });
  assert.equal(claimable?.state, "claimable");
  assert.equal(claimable?.claimant, null);
  const live = listingClaimStatus({
    claimWindowSeconds: 3600,
    nowMs: 1500,
    claim: { handle: "li-nuwa", citizen_id: 2, claimed_at: 1000, expires_at: 2000 },
  });
  assert.equal(live?.state, "exclusive");
  assert.equal(live?.claimant, "li-nuwa");
  assert.equal(live?.remaining_ms, 500);
  const done = listingClaimStatus({
    claimWindowSeconds: 3600,
    nowMs: 2000,
    claim: { handle: "li-nuwa", citizen_id: 2, claimed_at: 1000, expires_at: 2000 },
  });
  assert.equal(done?.state, "reopened");
  assert.equal(done?.remaining_ms, 0);
  assert.equal(done?.claimant, "li-nuwa");
});

test("a listing that omits claim_window_seconds keeps the historical v2 recipe and stays open to every submission", async () => {
  const { env } = fullEnv();
  const posted = await createListing(env, FUNDER as never, { title: TITLE, condition: CONDITION, amount_atomic: "1000000", expiry: expiry() });
  assert.equal(posted.claim_window_seconds, null);
  assert.deepEqual(posted.payload_hash_recipe.fields, [...LISTING_HASH_FIELDS_V2]);
  assert.equal(reproduce(posted as never), posted.payload_hash);
  await assert.rejects(
    createListingClaim(env, PAYEE as never, posted.id!),
    (e: SocietyError) => e.status === 400 && /did not declare a claim window/.test(e.message) && e.message.includes(CLAIM_WINDOW_NOTE.slice(0, 40)),
  );
  const sub = await createSubmission(env, PAYEE as never, posted.id!, { artifact: "https://example.invalid/pr/1" });
  assert.equal(sub.submitted, true);
  const view = await getListing(env, posted.id!);
  assert.equal(view.claim, null);
  assert.equal(view.claim_window_note, null);
  assert.equal(view.claim_window_seconds, null);
  assert.equal(reproduce(view as never), view.payload_hash);
});

test("the default path never references listing_claims, so dropping that table still accepts a submission on a listing with no window", async () => {
  const { env, db } = fullEnv();
  db.exec("DROP TABLE listing_claims");
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE name = 'listing_claims'").get() as { name: string } | undefined;
  assert.equal(tables, undefined, "this test is only a guard if the claims table is actually absent");
  const posted = await createListing(env, FUNDER as never, { title: TITLE, condition: CONDITION, amount_atomic: "1000000", expiry: expiry() });
  const sub = await createSubmission(env, PAYEE as never, posted.id!, { artifact: "https://example.invalid/pr/1" });
  assert.equal(sub.submitted, true);
});

test("a declared claim window is hashed into the listing, and the published recipe reproduces the hash", async () => {
  const { env } = fullEnv();
  const posted = await createListing(env, FUNDER as never, {
    title: TITLE,
    condition: CONDITION,
    amount_atomic: "1000000",
    expiry: expiry(),
    claim_window_seconds: 3600,
  });
  assert.equal(posted.claim_window_seconds, 3600);
  assert.deepEqual(posted.payload_hash_recipe.fields, [...LISTING_HASH_FIELDS_V2_CLAIM]);
  assert.equal(LISTING_HASH_FIELDS_V2_CLAIM.at(-3), "claim_window_seconds");
  assert.deepEqual(LISTING_HASH_FIELDS_V2_CLAIM.slice(-2), ["commit_nonce", "created_at"]);
  assert.equal(reproduce(posted as never), posted.payload_hash);
  // KILLING MUTATION: serving a different window than the one hashed would
  // fail this, and so would hashing under the historical v2 recipe.
  const underV2 = createHash("sha256")
    .update(JSON.stringify(LISTING_HASH_FIELDS_V2.map((f) => (posted as Record<string, unknown>)[f])), "utf8")
    .digest("hex");
  assert.notEqual(underV2, posted.payload_hash);
  const view = await getListing(env, posted.id!);
  assert.equal(view.claim?.state, "claimable");
  assert.equal(view.claim_window_note, CLAIM_WINDOW_NOTE);
  assert.equal(reproduce(view as never), view.payload_hash);
  assert.deepEqual(listingHashFields(2, null), [...LISTING_HASH_FIELDS_V2]);
  assert.deepEqual(listingHashFields(2, 3600), [...LISTING_HASH_FIELDS_V2_CLAIM]);
  assert.deepEqual(listingHashFields(3, 3600), [...LISTING_HASH_FIELDS_V3_CLAIM]);
  assert.deepEqual(listingHashFields(3, null), [...LISTING_HASH_FIELDS_V3]);
  // settlement_version is not bumped: version 3 still means escrow-backed.
  // A promise listing with a claim window stays on the v2 recipe plus the field.
  const stored = await getListing(env, posted.id!);
  assert.notEqual(stored.settlement_version, 3);
  assert.ok((stored.settlement_version ?? 2) < 3);
  assert.deepEqual(stored.payload_hash_recipe.fields, [...LISTING_HASH_FIELDS_V2_CLAIM]);
});

test("a refused claim_window_seconds writes no listing", async () => {
  const { env, db } = fullEnv();
  await assert.rejects(
    createListing(env, FUNDER as never, { title: TITLE, condition: CONDITION, amount_atomic: "1000000", expiry: expiry(), claim_window_seconds: 60 }),
    (e: SocietyError) => e.status === 400,
  );
  const row = db.prepare("SELECT COUNT(*) AS n FROM listings").get() as { n: number };
  assert.equal(row.n, 0);
});

test("the first qualified claimant gets the exclusive window, a second claim is refused, and only the claimant may submit until it elapses", async () => {
  const { env, db } = fullEnv();
  const posted = await createListing(env, FUNDER as never, {
    title: TITLE,
    condition: CONDITION,
    amount_atomic: "1000000",
    expiry: expiry(),
    claim_window_seconds: 3600,
  });
  await assert.rejects(
    createSubmission(env, PAYEE as never, posted.id!, { artifact: "https://example.invalid/pr/1" }),
    (e: SocietyError) => e.status === 409 && /claim it first/.test(e.message),
  );
  await assert.rejects(createListingClaim(env, FUNDER as never, posted.id!), (e: SocietyError) => e.status === 400 && /own listing/.test(e.message));
  await assert.rejects(createListingClaim(env, NOKEY as never, posted.id!), (e: SocietyError) => e.status === 400 && /active key/.test(e.message));
  await assert.rejects(createListingClaim(env, PAYEE as never, 99), (e: SocietyError) => e.status === 404);

  const claimed = await createListingClaim(env, PAYEE as never, posted.id!);
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.already_held, false);
  assert.equal(claimed.handle, "li-nuwa");
  assert.equal(claimed.claim_window_seconds, 3600);
  assert.equal(claimed.expires_at, claimed.claimed_at + 3600 * 1000);
  assert.equal(reproduce(claimed as never), claimed.payload_hash);
  assert.deepEqual(claimed.payload_hash_recipe.fields, [...CLAIM_HASH_FIELDS]);
  assert.equal(claimed.claim?.state, "exclusive");
  assert.match(String(claimed.chained), /^[0-9a-f]{64}$/);
  assert.match(claimed.note, /not an award/);
  const events = db.prepare("SELECT kind FROM identity_events WHERE kind = 'listing-claim'").all() as { kind: string }[];
  assert.equal(events.length, 1);

  const again = await createListingClaim(env, PAYEE as never, posted.id!);
  assert.equal(again.already_held, true);
  assert.equal(again.payload_hash, claimed.payload_hash);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'listing-claim'").get() as { n: number }).n, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM listing_claims").get() as { n: number }).n, 1);

  await assert.rejects(
    createListingClaim(env, OTHER as never, posted.id!),
    (e: SocietyError) => e.status === 409 && /li-nuwa's exclusive claim window/.test(e.message),
  );
  await assert.rejects(
    createSubmission(env, OTHER as never, posted.id!, { artifact: "https://example.invalid/pr/2" }),
    (e: SocietyError) => e.status === 409 && /li-nuwa's exclusive claim window/.test(e.message),
  );
  const sub = await createSubmission(env, PAYEE as never, posted.id!, { artifact: "https://example.invalid/pr/1" });
  assert.equal(sub.submitted, true);
  const view = await getListing(env, posted.id!);
  assert.equal(view.claim?.state, "exclusive");
  assert.equal(view.claim?.claimant, "li-nuwa");
});

test("a citizen may hold only one active exclusive claim at a time", async () => {
  const { env } = fullEnv();
  const first = await createListing(env, FUNDER as never, {
    title: TITLE,
    condition: CONDITION,
    amount_atomic: "1000000",
    expiry: expiry(),
    claim_window_seconds: 3600,
  });
  const second = await createListing(env, FUNDER as never, {
    title: "A second listing with a claim window too",
    condition: CONDITION,
    amount_atomic: "1000000",
    expiry: expiry(),
    claim_window_seconds: 7200,
  });
  await createListingClaim(env, PAYEE as never, first.id!);
  await assert.rejects(
    createListingClaim(env, PAYEE as never, second.id!),
    (e: SocietyError) => e.status === 409 && /one active claim at a time/.test(e.message) && new RegExp(`listing ${first.id}`).test(e.message),
  );
  // The other worker can still take the second listing.
  const other = await createListingClaim(env, OTHER as never, second.id!);
  assert.equal(other.handle, "unspent");
});

test("when the exclusive window elapses the listing reopens: anyone may submit, and no second exclusive claim is taken", async () => {
  const realNow = Date.now;
  let frozen = realNow();
  Date.now = () => frozen;
  try {
    const { env } = fullEnv();
    const posted = await createListing(env, FUNDER as never, {
      title: TITLE,
      condition: CONDITION,
      amount_atomic: "1000000",
      expiry: Math.floor(frozen / 1000) + 7 * 86400,
      claim_window_seconds: 3600,
    });
    const claimed = await createListingClaim(env, PAYEE as never, posted.id!);
    assert.equal(claimed.claim?.state, "exclusive");
    frozen = claimed.expires_at as number;
    // expires_at is exclusive: now === expires_at is already reopened.
    await assert.rejects(
      createListingClaim(env, OTHER as never, posted.id!),
      (e: SocietyError) => e.status === 409 && /has reopened/.test(e.message) && /no second exclusive claim/.test(e.message),
    );
    const fromOther = await createSubmission(env, OTHER as never, posted.id!, { artifact: "https://example.invalid/pr/3" });
    assert.equal(fromOther.submitted, true);
    const fromClaimant = await createSubmission(env, PAYEE as never, posted.id!, { artifact: "https://example.invalid/pr/4" });
    assert.equal(fromClaimant.submitted, true);
    const view = await getListing(env, posted.id!);
    assert.equal(view.claim?.state, "reopened");
    assert.equal(view.claim?.claimant, "li-nuwa");
    assert.equal(view.claim?.remaining_ms, 0);
    assert.equal(reproduce(view as never), view.payload_hash);
  } finally {
    Date.now = realNow;
  }
});

test("after a citizen's exclusive window elapses they may claim a different listing", async () => {
  const realNow = Date.now;
  let frozen = realNow();
  Date.now = () => frozen;
  try {
    const { env } = fullEnv();
    const first = await createListing(env, FUNDER as never, {
      title: TITLE,
      condition: CONDITION,
      amount_atomic: "1000000",
      expiry: Math.floor(frozen / 1000) + 7 * 86400,
      claim_window_seconds: 3600,
    });
    const second = await createListing(env, FUNDER as never, {
      title: "A second listing with a claim window too",
      condition: CONDITION,
      amount_atomic: "1000000",
      expiry: Math.floor(frozen / 1000) + 7 * 86400,
      claim_window_seconds: 3600,
    });
    const claimed = await createListingClaim(env, PAYEE as never, first.id!);
    frozen = (claimed.expires_at as number) + 1;
    const next = await createListingClaim(env, PAYEE as never, second.id!);
    assert.equal(next.already_held, false);
    assert.equal(next.listing_id, second.id);
    assert.equal(next.claim?.state, "exclusive");
  } finally {
    Date.now = realNow;
  }
});
