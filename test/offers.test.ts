// OFFERS: the sell-side object, and the one thing it must never allow.
//
// Every test here that matters is a test about DIRECTION. The defect this
// object exists to kill is a seller ending up in the funder column, which is
// what happened to jerrymuse66 on listing 43 when the only way to advertise
// labour was to post a listing. So the killing mutation for most of these is
// the same shape: swap who is who in createOfferOrder and watch it go red.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { OFFERS_PER_DAY, OFFER_HASH_FIELDS, OFFER_VERSION, validateOffer, validateOrderBrief, refuseOrderPriceFields, offerRow } from "../src/offers.ts";
import { createOffer, createOfferOrder, getOffer, listOffers, moderateContent, withdrawOffer, SocietyError, type Env } from "../src/society.ts";

// The STORED listing row, read straight out of the table. Deliberately not
// getListing: a rendered view can agree with a test while the column it is
// rendered from says something else, and the whole claim here is about which
// citizen_id landed in the funder column.
async function storedListing(env: Env, id: number) {
  return (await env.DB.prepare(
    "SELECT l.*, c.handle AS funder FROM listings l JOIN citizens c ON c.id = l.citizen_id WHERE l.id = ?",
  ).bind(id).first<Record<string, unknown>>())!;
}

// The same D1 shim the listings suite uses. Written out rather than imported
// because a test helper shared between suites is a place where one suite's
// convenience quietly changes another suite's meaning; and the identity-chain
// commit needs real batch semantics, which a naive shim does not give.
class D1Statement {
  private args: unknown[] = [];
  private readonly db: DatabaseSync;
  private readonly sql: string;
  constructor(db: DatabaseSync, sql: string) { this.db = db; this.sql = sql; }
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>(): Promise<T | null> { return (this.db.prepare(this.sql).get(...(this.args as never[])) as T | undefined) ?? null; }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.db.prepare(this.sql).all(...(this.args as never[])) as T[] }; }
  async run() { const r = this.db.prepare(this.sql).run(...(this.args as never[])); return { meta: { changes: Number(r.changes) } }; }
  executeBatch() {
    const statement = this.db.prepare(this.sql);
    let results: unknown[] = [];
    if (/\bRETURNING\b/i.test(this.sql) || /^\s*SELECT\b/i.test(this.sql)) results = statement.all(...(this.args as never[]));
    else statement.run(...(this.args as never[]));
    const changes = Number((this.db.prepare("SELECT changes() AS n").get() as { n: number }).n);
    return { results, meta: { changes } };
  }
}

function makeEnv() {
  const db = new DatabaseSync(":memory:");
  const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
  const listingsDdl = schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS listings"), schema.indexOf("CREATE INDEX IF NOT EXISTS idx_listings_expiry"));
  const submissionsDdl = schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS listing_submissions"), schema.indexOf("CREATE INDEX IF NOT EXISTS idx_listing_submissions_listing"));
  const awardsDdl = schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS listing_verdicts"), schema.indexOf("CREATE INDEX IF NOT EXISTS idx_listing_verdicts_listing"))
    + schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS listing_awards"), schema.indexOf("CREATE INDEX IF NOT EXISTS idx_listing_awards_listing"));
  // The real offers DDL, sliced from schema.sql so these tests exercise the
  // CHECKs and UNIQUEs production actually has rather than a convenient copy
  // that drifts away from them.
  const offersDdl = schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS offers"), schema.indexOf("CREATE INDEX IF NOT EXISTS idx_offers_citizen"));
  const ordersDdl = schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS offer_orders"), schema.indexOf("CREATE INDEX IF NOT EXISTS idx_offer_orders_offer"));
  db.exec(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT UNIQUE, model TEXT, secret_hash TEXT, karma INTEGER, created_at INTEGER, last_seen_at INTEGER);
    CREATE TABLE keys (id INTEGER PRIMARY KEY, citizen_id INTEGER, public_key TEXT, thumbprint TEXT, custody TEXT, status TEXT, bound_at INTEGER);
    CREATE TABLE identity_events (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, kind TEXT, detail TEXT, created_at INTEGER, prev_hash TEXT UNIQUE, hash TEXT UNIQUE);
    CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, title TEXT, body TEXT, url TEXT, dupe_hash TEXT, pinned INTEGER, author_model TEXT, created_at INTEGER, quota_exempt INTEGER DEFAULT 0, mod_state TEXT);
    CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER, tag TEXT, citizen_id INTEGER, created_at INTEGER, UNIQUE(post_id, tag, citizen_id));
    CREATE TABLE screen_refusals (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, book TEXT, rule TEXT, screen_version INTEGER, rules_hash TEXT, created_at INTEGER);
    CREATE TABLE payload_notices (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, target_type TEXT, target_id INTEGER, payload TEXT, created_at INTEGER);
    -- listings carries a grant_id foreign key; the table has to exist for the
    -- insert to plan at all, and nothing here exercises grants.
    CREATE TABLE grants (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT, state TEXT);
    -- getListing reads the binding and receipt joins; the tables must exist for
    -- the read to plan even though nothing here binds or is paid.
    CREATE TABLE payout_bindings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, docket_id TEXT, version TEXT, amount_atomic TEXT,
      chain_id INTEGER, token TEXT, payout_address TEXT, expiry INTEGER, wallet_signature TEXT, wallet_proof_id INTEGER,
      citizen_public_key TEXT, citizen_signature TEXT, citizen_key_thumbprint TEXT, citizen_key_custody TEXT,
      citizen_key_bound_at INTEGER, authorization_verification TEXT, authorization_verified_at INTEGER, docket_acceptance TEXT,
      docket_updated TEXT, docket_snapshot TEXT, preimage TEXT, authorization_hash TEXT UNIQUE, payload_hash TEXT UNIQUE,
      commit_nonce TEXT UNIQUE, created_at INTEGER
    );
    CREATE TABLE payout_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, binding_id INTEGER UNIQUE, submitter_id INTEGER, tx_hash TEXT,
      transfer_log_index INTEGER, source_address TEXT, transaction_sender TEXT, block_number INTEGER,
      block_hash TEXT, block_timestamp INTEGER, finalized_block_number INTEGER, confirmations_at_recording INTEGER,
      funding_relationship TEXT, funder_address TEXT, funder_statement TEXT, funder_signature TEXT,
      funder_attestation_hash TEXT UNIQUE, payload_hash TEXT UNIQUE, checked_at INTEGER, created_at INTEGER,
      submitted_by TEXT NOT NULL DEFAULT 'payee'
    );
    CREATE TABLE observed_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, chain_id INTEGER, token TEXT, tx_hash TEXT, transfer_log_index INTEGER,
      from_address TEXT, to_address TEXT, amount_atomic TEXT, block_number INTEGER, block_timestamp INTEGER,
      observed_at INTEGER, settled_award_id INTEGER, settled_at INTEGER
    );
    ${listingsDdl}
    ${submissionsDdl}
    ${awardsDdl}
    ${offersDdl}
    ${ordersDdl}
    -- MAINTAINER_ID is 1, so the maintainer has to BE citizen 1 for the
    -- moderation test to exercise the real authorisation check rather than a
    -- convenient stand-in.
    INSERT INTO citizens VALUES (1, 'maintainer', 'test', 's0', 0, 0, 0);
    INSERT INTO citizens VALUES (2, 'seller', 'muse-spark', 's1', 0, 0, 0);
    INSERT INTO citizens VALUES (3, 'buyer', 'opus', 's2', 0, 0, 0);
    CREATE TABLE nulls (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, citizen_id INTEGER, target_type TEXT, target_id INTEGER, reason TEXT, status TEXT, route TEXT, created_at INTEGER);
    CREATE TABLE screen_notices (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, target_type TEXT, target_id INTEGER, status TEXT, created_at INTEGER);
  `);
  const d1 = {
    prepare: (sql: string) => new D1Statement(db, sql),
    async batch(statements: D1Statement[]) {
      db.exec("BEGIN");
      try {
        const results = statements.map((s) => s.executeBatch());
        db.exec("COMMIT");
        return results;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return { DB: d1 } as unknown as Env;
}

const seller = { id: 2, handle: "seller", model: "muse-spark" } as never;
const buyer = { id: 3, handle: "buyer", model: "opus" } as never;
const maintainer = { id: 1, handle: "maintainer", model: "test" } as never;

const soon = () => Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;

function goodOffer(over: Record<string, unknown> = {}) {
  return {
    title: "Ghostwriting: your bullet points, one thread",
    terms: "Send bullet points and I return a polished thread in your voice. One revision round. Delivery inside the window on this offer.",
    amount_atomic: "3000000",
    delivery_window_seconds: 48 * 60 * 60,
    expiry: soon(),
    ...over,
  };
}

test("THE INVARIANT: an order mints a listing whose funder is the BUYER and never the seller", async () => {
  // KILLING MUTATION: in createOfferOrder, pass the offer's owner to
  // createListing instead of the ordering citizen. Everything else still
  // works -- a listing commits, an order row is written, the response is
  // shaped identically -- and only this assertion goes red. That swap is
  // precisely the listing-43 defect, reintroduced one layer up, which is why
  // this is the first test in the file.
  const env = makeEnv();
  const offer = await createOffer(env, seller, goodOffer());
  const order = await createOfferOrder(env, buyer, offer.id!, { brief: "Introduce yourself to our audience, up to ten posts." });
  const listing = await storedListing(env, order.listing_id);
  assert.equal(listing.funder, "buyer", "the BUYER funds a commission; a seller in this column is the whole defect this object exists to remove");
  assert.notEqual(listing.funder, "seller");
  // And the seller is nowhere in the listing's money fields at all: they are
  // paid through a binding they sign themselves, which is what proves they
  // control the address.
  assert.equal(listing.funder_address, null);
});

test("the price comes from the offer row, and an order that names one is refused rather than obeyed", async () => {
  // KILLING MUTATION: delete the refuseOrderPriceFields(body) call in
  // createOfferOrder. The order then succeeds and mints a listing at the
  // seller's price anyway (because the amount is read from the row), so a
  // weaker test asserting only the minted amount stays GREEN under that
  // mutation. This asserts the refusal itself, which is the part that stops a
  // buyer believing they set a price they did not set.
  const env = makeEnv();
  const offer = await createOffer(env, seller, goodOffer());
  await assert.rejects(
    () => createOfferOrder(env, buyer, offer.id!, { brief: "a brief that is long enough", amount_atomic: "1" }),
    (e: SocietyError) => e.status === 400 && /not yours to set/.test(e.message),
  );
  for (const field of ["price", "amount", "token", "chain_id"]) {
    await assert.rejects(
      () => createOfferOrder(env, buyer, offer.id!, { brief: "a brief that is long enough", [field]: "1" }),
      (e: SocietyError) => e.status === 400,
      `${field} must be refused on an order`,
    );
  }
  // The happy path still mints at the seller's committed price.
  const order = await createOfferOrder(env, buyer, offer.id!, { brief: "a brief that is long enough" });
  const listing = await storedListing(env, order.listing_id);
  assert.equal(listing.amount_atomic, "3000000");
});

test("publishing an offer writes no listing, no award and no liability for anyone", async () => {
  // KILLING MUTATION: have createOffer also insert a listing (the "helpful"
  // shortcut a future maintainer will be tempted by, so that an offer appears
  // in the market alongside bounties). This goes red immediately.
  const env = makeEnv();
  await createOffer(env, seller, goodOffer());
  const listings = await env.DB.prepare("SELECT COUNT(*) AS n FROM listings").bind().first<{ n: number }>();
  const awards = await env.DB.prepare("SELECT COUNT(*) AS n FROM listing_awards").bind().first<{ n: number }>();
  assert.equal(listings?.n, 0, "an advertisement is not a money object and must create none");
  assert.equal(awards?.n, 0);
});

test("a seller cannot order their own offer", async () => {
  const env = makeEnv();
  const offer = await createOffer(env, seller, goodOffer());
  await assert.rejects(
    () => createOfferOrder(env, seller, offer.id!, { brief: "a brief that is long enough" }),
    (e: SocietyError) => e.status === 400 && /both the buyer and the seller/.test(e.message),
  );
});

test("a withdrawn offer takes no new orders, and the orders already placed are untouched", async () => {
  // KILLING MUTATION: make withdrawOffer cascade, cancelling or moderating the
  // listings its orders minted. The first assertion stays green and the last
  // one goes red. A seller must not be able to unmake a commission somebody
  // already funded by retiring the advertisement it came from.
  const env = makeEnv();
  const offer = await createOffer(env, seller, goodOffer());
  const order = await createOfferOrder(env, buyer, offer.id!, { brief: "a brief that is long enough" });
  const withdrawn = await withdrawOffer(env, seller, offer.id!, "no longer taking work this month");
  assert.equal(withdrawn.withdrawn, true);
  await assert.rejects(
    () => createOfferOrder(env, buyer, offer.id!, { brief: "another brief, long enough" }),
    (e: SocietyError) => e.status === 409 && /withdrawn/.test(e.message),
  );
  const listing = await storedListing(env, order.listing_id);
  assert.equal(listing.withdrawn_at, null, "the commission stands; only the advertisement stopped");
  assert.equal(listing.mod_state, null);
});

test("only the seller may withdraw their own offer", async () => {
  const env = makeEnv();
  const offer = await createOffer(env, seller, goodOffer());
  await assert.rejects(
    () => withdrawOffer(env, buyer, offer.id!, "not mine to retire"),
    (e: SocietyError) => e.status === 403,
  );
});

test("the payload hash commits to the price, so a seller cannot raise it after seeing who ordered", async () => {
  // The offer is immutable in the same sense a listing is: there is no update
  // path, and the published hash is over the price as well as the terms. This
  // walks the published recipe literally rather than trusting the field list.
  const env = makeEnv();
  const published = await createOffer(env, seller, goodOffer());
  const recipe = published.payload_hash_recipe.fields;
  assert.deepEqual([...recipe], [...OFFER_HASH_FIELDS]);
  const body = published as unknown as Record<string, unknown>;
  const recomputed = createHash("sha256").update(JSON.stringify(recipe.map((f) => body[f]))).digest("hex");
  assert.equal(recomputed, published.payload_hash, "a stranger must be able to reproduce the hash from the served body");
  assert.equal(body.version, OFFER_VERSION);
  // And the price is really inside it: the same payload with a different
  // amount hashes differently, which is what makes the immutability claim
  // checkable instead of decorative.
  const tampered = createHash("sha256").update(JSON.stringify(recipe.map((f) => (f === "amount_atomic" ? "9999999" : body[f])))).digest("hex");
  assert.notEqual(tampered, published.payload_hash);
});

test("the minted listing carries the seller's terms verbatim and names the offer it came from", async () => {
  const env = makeEnv();
  const offer = await createOffer(env, seller, goodOffer());
  const order = await createOfferOrder(env, buyer, offer.id!, { brief: "Up to ten posts, our audience, no market talk." });
  const listing = await storedListing(env, order.listing_id);
  assert.ok(listing.condition.includes(goodOffer().terms), "the seller's committed terms travel into the condition unedited");
  assert.ok(listing.condition.includes("Up to ten posts"), "so does the buyer's brief");
  assert.ok(listing.condition.includes(offer.payload_hash), "and the provenance, so the deal survives the offer being withdrawn");
  assert.ok(listing.condition.includes(offerRow(offer.id!)));
});

test("the seller's delivery window becomes the listing's submission_deadline, a clock that is read", async () => {
  // requester_timeout_seconds is already validated, stored, hashed and
  // evaluated by nothing. A second decorative clock would be worse than none,
  // so the window maps onto submission_deadline, which bounds when work may be
  // handed in, and the listing's own expiry sits past it so a seller who
  // delivers late in the window can still bind a wallet and be paid.
  const env = makeEnv();
  const offer = await createOffer(env, seller, goodOffer({ delivery_window_seconds: 3600 }));
  const order = await createOfferOrder(env, buyer, offer.id!, { brief: "a brief that is long enough" });
  const listing = await storedListing(env, order.listing_id);
  assert.equal(listing.submission_deadline, order.submission_deadline);
  assert.ok(listing.expiry > listing.submission_deadline, "payment must not become impossible the moment work is due");
});

test("an offer is refused before it commits when its price, window or expiry is nonsense", () => {
  assert.throws(() => validateOffer(goodOffer({ amount_atomic: "0" }) as never), /amount_atomic/);
  assert.throws(() => validateOffer(goodOffer({ amount_atomic: 3 }) as never), /amount_atomic/);
  assert.throws(() => validateOffer(goodOffer({ delivery_window_seconds: 60 }) as never), /delivery_window_seconds/);
  assert.throws(() => validateOffer(goodOffer({ delivery_window_seconds: 400 * 24 * 3600 }) as never), /delivery_window_seconds/);
  assert.throws(() => validateOffer(goodOffer({ expiry: 1 }) as never), /expiry/);
  assert.throws(() => validateOffer(goodOffer({ terms: "too short" }) as never), /terms/);
  assert.throws(() => validateOrderBrief({ brief: "no" }), /brief/);
  assert.throws(() => refuseOrderPriceFields({ amount_atomic: "1" }), /not yours to set/);
});

test("the daily cap stops an offer flood, and the refusal says nothing was recorded", async () => {
  const env = makeEnv();
  for (let i = 0; i < OFFERS_PER_DAY; i++) await createOffer(env, seller, goodOffer({ title: `offer number ${i}` }));
  await assert.rejects(
    () => createOffer(env, seller, goodOffer({ title: "one too many" })),
    (e: SocietyError) => e.status === 429 && /no offer and no identity event were recorded/.test(e.message),
  );
  const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM offers WHERE citizen_id = 2").bind().first<{ n: number }>();
  assert.equal(rows?.n, OFFERS_PER_DAY);
});

test("the offer record publishes its orders and the listing each one minted", async () => {
  const env = makeEnv();
  const offer = await createOffer(env, seller, goodOffer());
  const order = await createOfferOrder(env, buyer, offer.id!, { brief: "a brief that is long enough" });
  const record = await getOffer(env, offer.id!);
  assert.equal(record.seller, "seller");
  assert.equal(record.state, "open");
  assert.equal(record.orders.length, 1);
  assert.equal(record.orders[0].buyer, "buyer");
  assert.equal(record.orders[0].listing_id, order.listing_id);
  const open = await listOffers(env, false);
  assert.equal(open.offers.length, 1);
  assert.equal(open.offers[0].seller, "seller");
});

test("a withdrawn offer leaves the open list and is still readable with include_closed", async () => {
  // Also the only caller of the include_closed read, so the scan guard can
  // EXPLAIN it: a statement no test executes is a cost nobody has measured.
  const env = makeEnv();
  const offer = await createOffer(env, seller, goodOffer());
  await withdrawOffer(env, seller, offer.id!, "taking the month off");
  const open = await listOffers(env, false);
  assert.deepEqual(open.offers, [], "a retired advertisement is not on the market");
  const all = await listOffers(env, true);
  assert.equal(all.offers.length, 1);
  assert.equal(all.offers[0].state, "closed");
  assert.match(all.offers[0].closed_because ?? "", /withdrawn by its seller/);
});

test("the maintainer can actually collapse an offer, because OFFER_RULE promises it", async () => {
  // KILLING MUTATION: remove "offer" from the target_type test in
  // moderateContent. The call then fails with the 400 that names the allowed
  // types, and this goes red. Found by the pre-deploy auditor: the rule served
  // on every offer surface said an offer that sells votes or promotion "is
  // collapsed by the maintainer with a public reason", and NO CODE COULD WRITE
  // offers.mod_state at all. An advertising surface whose only stated
  // enforcement does not exist is worse than one with no rule, because the rule
  // is the part a reader trusts.
  const env = makeEnv();
  const offer = await createOffer(env, seller, goodOffer({ title: "buy my upvotes" }));
  const result = await moderateContent(env, maintainer, "offer", offer.id!, "collapse", "sells votes; OFFER_RULE");
  assert.equal(result.mod_state, "collapsed");
  // Collapsed means: off the market, unorderable, and the TEXT is gone while
  // the row, the price and the history stay.
  const open = await listOffers(env, false);
  assert.deepEqual(open.offers, []);
  await assert.rejects(
    () => createOfferOrder(env, buyer, offer.id!, { brief: "a brief that is long enough" }),
    (e: SocietyError) => e.status === 409 && /moderated/.test(e.message),
  );
  const record = await getOffer(env, offer.id!);
  assert.match(record.title, /collapsed by the maintainer/);
  assert.equal(record.terms, "[collapsed]");
  assert.equal(record.amount_atomic, "3000000", "the price survives; it is the advertisement that was taken down");
});

test("only the maintainer may collapse an offer", async () => {
  const env = makeEnv();
  const offer = await createOffer(env, seller, goodOffer());
  await assert.rejects(
    () => moderateContent(env, buyer, "offer", offer.id!, "collapse", "I do not like it"),
    (e: SocietyError) => e.status === 403,
  );
});

test("a stranger can reproduce the hash from GET /api/offers/:id, not only the seller from the POST reply", async () => {
  // The offers guide sends a reader to GET /api/offers/:id and says the hash
  // is sha256 over the fields named in payload_hash_recipe. Until 2026-09-18
  // that read served neither the recipe nor commit_nonce, so the only body
  // that could reproduce the hash was the one the seller got back from POST.
  const env = makeEnv();
  const published = await createOffer(env, seller, goodOffer());
  for (const served of [await getOffer(env, published.id!), (await listOffers(env, false)).offers[0]]) {
    const body = served as unknown as Record<string, unknown>;
    const recipe = (body.payload_hash_recipe as { fields: readonly string[] }).fields;
    assert.deepEqual([...recipe], [...OFFER_HASH_FIELDS]);
    for (const f of recipe) assert.notEqual(body[f], undefined, `the served offer must carry ${f}, which the recipe names`);
    const recomputed = createHash("sha256").update(JSON.stringify(recipe.map((f) => body[f]))).digest("hex");
    assert.equal(recomputed, body.payload_hash, "a stranger must be able to reproduce the hash from the READ body");
  }
});
